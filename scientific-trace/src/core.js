import {appendFile, mkdir, open, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {defaultPrompts, describeTools, fillTemplate} from './prompts.js';
import {validateArguments} from './python-tools.js';

export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('Model response must be text');
  let s = text.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  if (start < 0) throw new Error('No JSON object in model response');
  let quoted = false, escaped = false, depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      const value = JSON.parse(s.slice(start, i + 1));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
      return value;
    }
  }
  throw new Error('Truncated JSON object');
}

async function atomicJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

function count(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }
function abort(signal) { signal?.throwIfAborted(); }

export async function runScientificAgent(options) {
  const {instruction, tools, complete, execute, signal, taskFingerprint,
    model = 'unspecified', metadata = {}, cases = [], maxIterations = 15,
    parseRetries = 3, resume = false, requiredArtifacts = [], taskDir,
    prompts = defaultPrompts} = options;
  if (!instruction?.trim() || !Array.isArray(tools) || !tools.length) throw new Error('Instruction and tools are required');
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 1000) throw new Error('maxIterations must be between 1 and 1000');
  if (!Number.isInteger(parseRetries) || parseRetries < 0 || parseRetries > 10) throw new Error('Invalid parseRetries');
  if (typeof complete !== 'function' || typeof execute !== 'function') throw new Error('Model and tool executors are required');
  const names = new Set(tools.map(t => t.name));
  if (names.size !== tools.length) throw new Error('Duplicate tool name');
  const logDir = resolve(options.logDir);
  await mkdir(logDir, {recursive: true, mode: 0o700});
  const lockPath = join(logDir, 'run.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST' || !resume) throw new Error('Run directory is locked; use a distinct directory');
    const old = JSON.parse(await readFile(lockPath, 'utf8'));
    let alive = true;
    try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('The previous run is still active');
    await rm(lockPath);
    lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(JSON.stringify({pid: process.pid}));
  let trace, atif;
  const tracePath = join(logDir, 'scientific_trace.json');
  const checkpointPath = join(logDir, 'checkpoint.json');
  const journalPath = join(logDir, 'science-events.jsonl');
  const now = () => new Date().toISOString();
  async function event(type, payload) {
    await appendFile(journalPath, JSON.stringify({type, trace_id: trace.trace_id, timestamp: now(), ...payload}) + '\n', {mode: 0o600});
  }
  async function checkpoint() {
    const executions = trace.execution_trace;
    const distribution = {};
    for (const item of executions) distribution[item.selected_tool] = (distribution[item.selected_tool] ?? 0) + 1;
    trace.total_steps = executions.length;
    Object.assign(trace.summary_metrics, {
      total_tool_calls: executions.length, unique_tools_used: Object.keys(distribution),
      tool_call_distribution: distribution,
      plan_adjustments_count: trace.scientific_planning_trace.filter(p => p.plan_adjustment).length,
    });
    // The checkpoint is authoritative. Other files are materialized projections.
    await atomicJson(checkpointPath, {format: 1, taskFingerprint, maxIterations, trace, atif});
    await atomicJson(tracePath, trace);
    await atomicJson(join(logDir, 'trajectory.json'), atif);
    await writeFile(join(logDir, 'answer.txt'), trace.final_answer ?? '', {mode: 0o600});
  }
  try {
    abort(signal);
    let existing = null;
    try { existing = JSON.parse(await readFile(checkpointPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing && !resume) throw new Error('Run already exists; choose a new logDir or request resume');
    if (resume) {
      if (!existing || existing.format !== 1) throw new Error('No compatible checkpoint to resume');
      if (!taskFingerprint || existing.taskFingerprint !== taskFingerprint) throw new Error('Task fingerprint changed; cannot resume');
      if (existing.maxIterations !== maxIterations || existing.trace.agent_model !== model) throw new Error('Model or iteration budget changed; start a new run');
      if (existing.trace.status === 'completed') throw new Error('Run is already completed');
      trace = existing.trace; atif = existing.atif;
      // Do not repeat a possibly side-effecting call whose completion is unknown.
      const journal = (await readFile(journalPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const starts = new Set(journal.filter(e => e.type === 'tool/start').map(e => e.call_id));
      for (const e of journal) if (e.type === 'tool/end') starts.delete(e.call_id);
      if (starts.size) throw new Error('A tool was interrupted with unknown outcome; inspect artifacts and start a new run');
      trace.status = 'running'; trace.partial = true; trace.error = null; trace.final_answer = null;
      trace.resume_count = (trace.resume_count ?? 0) + 1;
      await event('run/resume', {tool_session_restarted: true});
    } else {
      trace = {
        schema_version: 'scientific-trace/0.1', trace_id: options.traceId ?? randomUUID(),
        agent_model: model, execution_mode: options.executionMode ?? 'live', task_domain: metadata.taskDomain ?? 'scientific_computing',
        task_type: metadata.taskType ?? 'dataset_analysis', timestamp_start: now(), timestamp_end: null,
        status: 'running', partial: true, total_steps: 0, final_answer: null,
        experience_planning: null, scientific_planning_trace: [], tool_selection_trace: [], execution_trace: [],
        llm_attempts: [],
        summary_metrics: {total_llm_calls: 0, total_input_tokens: 0, total_output_tokens: 0,
          total_cache_read_tokens: 0, total_cache_write_tokens: 0, total_llm_latency_ms: 0,
          answer_correct: null},
        evaluator: {kind: 'checkpoint_and_routing', independent_scientific_evaluation: false},
      };
      atif = {schema_version: 'ATIF-v1.0', session_id: trace.trace_id,
        agent: {name: 'scientific-agent', version: '0.1.0-dev.1', model_name: model}, steps: [],
        extra: {scientific_trace: 'scientific_trace.json'}};
      await event('run/start', {model, taskFingerprint});
    }
    await checkpoint();
    const toolDescriptions = describeTools(tools);
    const caseIds = cases.map(c => c.id);
    const casesContent = cases.length ? JSON.stringify(cases, null, 2) : 'No reference cases are available.';

    async function ask(phase, basePrompt, validate) {
      let lastError;
      let prompt = basePrompt;
      for (let attempt = 0; attempt <= parseRetries; attempt++) {
        abort(signal);
        const started = performance.now();
        const entry = {phase, step: trace.execution_trace.length + 1, attempt,
          llm_prompt: prompt, timestamp: now(), accepted: false};
        await event('llm/start', {phase, attempt});
        let response;
        try { response = await complete({prompt, phase, attempt, signal}); }
        catch (error) {
          Object.assign(entry, {error: error.message, llm_latency_ms: performance.now() - started});
          trace.llm_attempts.push(entry); trace.summary_metrics.total_llm_calls++;
          await event('llm/error', {phase, attempt, error: error.message});
          await checkpoint(); throw error;
        }
        const text = response.text;
        const usage = response.usage ?? {};
        Object.assign(entry, {llm_response_raw: text, llm_latency_ms: performance.now() - started,
          input_tokens: count(usage.inputTokens), output_tokens: count(usage.outputTokens)});
        trace.summary_metrics.total_llm_calls++;
        trace.summary_metrics.total_input_tokens += entry.input_tokens;
        trace.summary_metrics.total_output_tokens += entry.output_tokens;
        trace.summary_metrics.total_cache_read_tokens += count(usage.cacheReadTokens);
        trace.summary_metrics.total_cache_write_tokens += count(usage.cacheWriteTokens);
        trace.summary_metrics.total_llm_latency_ms += entry.llm_latency_ms;
        atif.steps.push({step_id: atif.steps.length + 1, source: 'user', message: prompt});
        const step = {step_id: atif.steps.length + 1, source: 'agent', message: text ?? '',
          extra: {science: {phase, attempt}}};
        atif.steps.push(step);
        let data;
        try {
          if (response.finishReason && !['stop', 'completed'].includes(response.finishReason)) throw new Error(`Model finished with ${response.finishReason}`);
          data = extractJson(text); validate(data); entry.accepted = true;
        } catch (error) { lastError = error; entry.error = error.message; }
        trace.llm_attempts.push(entry);
        await event('llm/end', {phase, attempt, accepted: entry.accepted, atif_step_id: step.step_id});
        await checkpoint();
        if (entry.accepted) return {data, entry, step};
        if (response.finishReason === 'refusal') throw new Error('Model refused the request');
        prompt = basePrompt + `\n\nYour previous response was invalid: ${lastError.message}. Return one valid JSON object. Valid tools: ${JSON.stringify([...names])}.`;
      }
      throw new Error(`Invalid ${phase} response after ${parseRetries + 1} attempts: ${lastError.message}`);
    }

    if (!trace.experience_planning) {
      const prompt = fillTemplate(prompts.experience, {instruction, tool_descriptions: toolDescriptions, cases_content: casesContent});
      const {data, entry} = await ask('experience', prompt, d => {
        if (typeof d.initial_plan !== 'string' || !d.initial_plan.trim()) throw new Error('initial_plan is required');
        if (!Array.isArray(d.reference_cases_used ?? [])) throw new Error('reference_cases_used must be an array');
        if ((d.reference_cases_used ?? []).some(id => !caseIds.includes(id))) throw new Error('Unknown reference case ID');
      });
      trace.experience_planning = {...data, reference_cases_available: caseIds, ...entry};
      await event('science/experience-planned', {case_ids: data.reference_cases_used ?? []});
      await checkpoint();
    }

    let warnedOfRestart = false;
    while (trace.execution_trace.length < maxIterations) {
      abort(signal);
      let observations = trace.execution_trace.slice(-3).map(e => `[Step ${e.step}] Tool: ${e.selected_tool} | Result: ${e.result_summary.slice(0, 4000)}`).join('\n') || 'None yet.';
      if (resume && !warnedOfRestart) observations += '\nTOOL SESSION RESTARTED: prior Python variables are gone. Completed calls will not be replayed. Rebuild needed state safely from original inputs and existing artifacts.';
      const prompt = fillTemplate(prompts.planning, {instruction, initial_plan: trace.experience_planning.initial_plan,
        tool_descriptions: toolDescriptions, step_number: trace.execution_trace.length + 1,
        max_steps: maxIterations, previous_observations: observations});
      const {data, entry, step} = await ask('planning', prompt, d => {
        if (typeof d.final_answer === 'string' && d.final_answer.trim()) return;
        if (!names.has(d.selected_tool)) throw new Error('selected_tool must name an available tool');
        validateArguments(tools.find(t => t.name === d.selected_tool).parameters, d.call_params);
      });
      warnedOfRestart = true;
      const number = trace.execution_trace.length + 1;
      trace.scientific_planning_trace.push({...data, ...entry, step: number});
      if (typeof data.final_answer === 'string' && data.final_answer.trim()) {
        for (const relative of requiredArtifacts) {
          const path = resolve(taskDir, relative);
          if (!path.startsWith(resolve(taskDir) + '/') || !relative.endsWith('.json')) throw new Error('Invalid required artifact path');
          JSON.parse(await readFile(path, 'utf8'));
        }
        trace.final_answer = data.final_answer; trace.status = 'completed'; trace.partial = false; break;
      }
      const callId = `science-${randomUUID()}`;
      trace.tool_selection_trace.push({step: number, candidate_tools: [...names], selected_tool: data.selected_tool,
        selection_reasoning: data.selection_reasoning ?? '', alternative_considered: data.alternative_considered ?? null,
        call_params: data.call_params, call_id: callId, timestamp: now()});
      step.tool_calls = [{tool_call_id: callId, function_name: data.selected_tool, arguments: data.call_params}];
      await event('tool/start', {call_id: callId, name: data.selected_tool, arguments: data.call_params});
      await checkpoint();
      const started = performance.now();
      let outcome;
      try { outcome = await execute(data.selected_tool, data.call_params, {signal, callId}); }
      catch (error) {
        // Interrupted/terminated workers have uncertain side effects: leave tool/start open.
        if (signal?.aborted || /timeout|worker exited|Aborted/i.test(error.message)) throw error;
        outcome = {value: null, error: error.message, stdout: ''};
      }
      abort(signal);
      const valueText = typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value);
      const content = outcome.error ? `ERROR: ${outcome.error}\n${valueText ?? ''}` : valueText;
      const result = (outcome.stdout ? outcome.stdout + '\n' : '') + content;
      const execution = {step: number, trace_id: trace.trace_id, call_id: callId, selected_tool: data.selected_tool,
        call_params: data.call_params, result_summary: result.slice(0, 6000), result_truncated: result.length > 6000,
        runtime_metrics: {latency_ms: performance.now() - started, error: outcome.error ?? null}, timestamp: now()};
      trace.execution_trace.push(execution);
      step.observation = {results: [{source_call_id: callId, content: result}]};
      await event('tool/end', {call_id: callId, name: data.selected_tool, ...outcome});
      await checkpoint(); // evaluator in the original graph: checkpoint and routing.
    }
    if (trace.status === 'running') { trace.status = 'iteration_limit'; trace.partial = true; }
    trace.timestamp_end = now();
    await event('run/end', {status: trace.status});
    await checkpoint();
    return trace;
  } catch (error) {
    if (trace) {
      trace.status = signal?.aborted ? 'aborted' : 'failed'; trace.error = error.message;
      trace.partial = true; trace.timestamp_end = now();
      await event('run/error', {status: trace.status, error: error.message});
      await checkpoint();
    }
    throw error;
  } finally {
    await lock.close(); await rm(lockPath, {force: true});
  }
}
