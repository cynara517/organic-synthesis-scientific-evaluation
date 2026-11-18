#!/usr/bin/env node
// Standalone runner for the scientific-trace core (no DeepSeek Harness host).
// Reads config from env, loads the task dir, calls an OpenAI-compatible
// chat/completions endpoint, runs runScientificAgent, and writes a
// legacy-compatible run directory (scientific_trace.json / trajectory.json /
// answer.txt / run_meta.json / agent_status.json / run.log).
//
// Env:
//   SCI_PLUGIN_DIR   path to scientific-trace checkout (contains src/, python/)
//   SCI_TASK_DIR     task directory (instruction.md, tool_definitions.json, tools.py)
//   SCI_LOG_DIR      output directory for traces
//   SCI_MODEL        wire model name sent to the API
//   SCI_MODEL_KEY    human-readable model key for run_meta (default = SCI_MODEL)
//   SCI_BASE_URL     OpenAI-compatible base URL, e.g. https://host/v1
//   SCI_API_KEY      bearer token
//   SCI_MAX_ITER     max planning iterations (default 250)
//   SCI_RUN_TIMEOUT_SEC   whole-run timeout (default 21000)
//   SCI_TOOL_TIMEOUT_SEC  per tool call (default 7200)
//   SCI_REQ_TIMEOUT_SEC   per model request (default 600)
//   SCI_MAX_TOKENS   max output tokens (default 16384)
//   SCI_REASONING_EFFORT  optional, forwarded as reasoning_effort
//   SCI_PYTHON       python interpreter (default python3)
//   SCI_QUESTION     question label for run_meta (default = task dir name)

import {appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, basename} from 'node:path';
import {pathToFileURL} from 'node:url';

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const pluginDir = env('SCI_PLUGIN_DIR');
const taskDir = env('SCI_TASK_DIR');
const logDir = env('SCI_LOG_DIR');
const model = env('SCI_MODEL');
const modelKey = env('SCI_MODEL_KEY', model);
const baseUrl = (env('SCI_BASE_URL', '') || '').replace(/\/+$/, '');
const apiKey = env('SCI_API_KEY', '');
const maxIterations = Number(env('SCI_MAX_ITER', '250'));
const runTimeoutSec = Number(env('SCI_RUN_TIMEOUT_SEC', '21000'));
const toolTimeoutSec = Number(env('SCI_TOOL_TIMEOUT_SEC', '7200'));
const reqTimeoutSec = Number(env('SCI_REQ_TIMEOUT_SEC', '600'));
const maxTokens = Number(env('SCI_MAX_TOKENS', '16384'));
const reasoningEffort = env('SCI_REASONING_EFFORT', '');
const python = env('SCI_PYTHON', 'python3');
const question = env('SCI_QUESTION', basename(taskDir || 'task'));

for (const [k, v] of Object.entries({SCI_PLUGIN_DIR: pluginDir, SCI_TASK_DIR: taskDir, SCI_LOG_DIR: logDir, SCI_MODEL: model, SCI_BASE_URL: baseUrl})) {
  if (!v) { console.error(`missing env ${k}`); process.exit(2); }
}

mkdirSync(logDir, {recursive: true});
const runLog = resolve(logDir, 'run.log');
const log = line => { const s = `[${new Date().toISOString()}] ${line}\n`; appendFileSync(runLog, s); process.stderr.write(s); };

const {runScientificAgent} = await import(pathToFileURL(resolve(pluginDir, 'src/core.js')).href);
const {PythonTools} = await import(pathToFileURL(resolve(pluginDir, 'src/python-tools.js')).href);
const {loadTask} = await import(pathToFileURL(resolve(pluginDir, 'src/task.js')).href);

let llmTimeouts = 0, llmBlanks = 0, llmStallSec = 0, stepCounter = 0;

async function complete({prompt, phase, signal}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('request timeout')), reqTimeoutSec * 1000);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, {once: true});
  const body = {model, messages: [{role: 'user', content: prompt}], max_tokens: maxTokens, stream: false};
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  let lastErr;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST', signal: ctrl.signal,
          headers: {'content-type': 'application/json', ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {})},
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
          log(`[llm] ${phase} attempt=${attempt} ${lastErr.message}`);
          await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 2000)}`);
        const data = await res.json();
        const choice = data.choices?.[0];
        const msg = choice?.message ?? {};
        let text = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content) ? msg.content.map(p => p.text ?? '').join('') : '';
        if (!text && msg.reasoning_content) text = '';
        const usage = data.usage ?? {};
        const fr = choice?.finish_reason;
        const finishReason = fr === 'stop' || fr === 'end_turn' || fr === undefined || fr === null ? 'stop'
          : fr === 'length' ? 'length' : fr === 'content_filter' ? 'refusal' : fr;
        const sec = (Date.now() - started) / 1000;
        if (phase === 'planning') stepCounter++;
        if (!text.trim()) llmBlanks++;
        log(`[llm] step=${stepCounter} ${sec.toFixed(1)}s in=${usage.prompt_tokens ?? 0} out=${usage.completion_tokens ?? 0} chars=${text.length}`);
        return {text, finishReason, usage: {
          inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0,
          cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0, cacheWriteTokens: 0}};
      } catch (e) {
        if (ctrl.signal.aborted) {
          if (!signal?.aborted) { llmTimeouts++; llmStallSec += (Date.now() - started) / 1000; }
          throw e;
        }
        lastErr = e; log(`[llm] ${phase} attempt=${attempt} error ${e.message}`);
        await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error('model request failed');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

const started = Date.now() / 1000;
const task = await loadTask(taskDir);
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(runTimeoutSec * 1000)]);
const worker = new PythonTools(taskDir, {python, timeoutMs: toolTimeoutSec * 1000, signal});
let trace, outcome = 'ok', errorMsg = null, timedOut = false;
const agentStarted = Date.now() / 1000;
try {
  await worker.ready;
  trace = await runScientificAgent({...task, complete, execute: (n, p) => worker.execute(n, p), signal, logDir,
    model: modelKey, traceId: `${modelKey}__${question}__run1`, maxIterations, parseRetries: 3});
  if (trace.status === 'iteration_limit') outcome = 'step_limit';
} catch (e) {
  errorMsg = e.message; outcome = signal.aborted ? 'timeout' : 'error'; timedOut = signal.aborted && /timeout/i.test(String(signal.reason?.message ?? signal.reason ?? ''));
  log(`[run] failed: ${e.message}`);
  try { trace = JSON.parse(readFileSync(resolve(logDir, 'scientific_trace.json'), 'utf8')); } catch {}
} finally { await worker.close(); }

const finished = Date.now() / 1000;
const steps = trace?.execution_trace?.length ?? 0;
let answerPreview = '';
try { answerPreview = String(readFileSync(resolve(logDir, 'answer.txt'), 'utf8')).slice(0, 200); } catch {}
writeFileSync(resolve(logDir, 'run_meta.json'), JSON.stringify({
  model_key: modelKey, wire_model: model, effort: reasoningEffort || 'default', question, run: 1,
  sandbox_id: env('HOSTNAME', 'harbor'), max_iterations: maxIterations, started, agent_started: agentStarted, finished,
  wall_sec: +(finished - started).toFixed(1), agent_sec: +(finished - agentStarted).toFixed(1),
  timeout_sec: runTimeoutSec, timed_out: timedOut, outcome, steps_used: steps, hit_step_limit: steps >= maxIterations,
  action: 'keep', llm_timeouts: llmTimeouts, llm_stall_sec: +llmStallSec.toFixed(1), stall_fraction: null, answer_preview: answerPreview,
}, null, 2) + '\n');
writeFileSync(resolve(logDir, 'agent_status.json'), JSON.stringify({
  end_reason: outcome, steps_used: steps, max_iterations: maxIterations, hit_step_limit: steps >= maxIterations,
  agent_model: modelKey, timestamp_end: trace?.timestamp_end ?? new Date().toISOString(),
  llm_timeouts: llmTimeouts, llm_stall_sec: +llmStallSec.toFixed(1), llm_blanks: llmBlanks, error: errorMsg,
}, null, 2) + '\n');
log(`[run] done outcome=${outcome} steps=${steps}`);
process.exit(outcome === 'ok' || outcome === 'step_limit' ? 0 : 1);
