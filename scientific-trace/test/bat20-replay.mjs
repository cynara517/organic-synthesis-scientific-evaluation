// Historical responses are input fixtures. Tools execute again on fresh CSVs.
// This is NOT a fresh model solve. All fixtures stay outside the distributable.
import {readFile, mkdir, cp, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import assert from 'node:assert/strict';
import {runScientificAgent} from '../src/core.js';
import {loadTask} from '../src/task.js';
import {PythonTools} from '../src/python-tools.js';

const [fixtureDir, responsesPath, destination, python] = process.argv.slice(2);
if (!python) throw new Error('Usage: node test/bat20-replay.mjs FIXTURE RESPONSES DESTINATION PYTHON');
const taskDir = resolve(destination, 'task');
await mkdir(taskDir, {recursive: true});
await cp(resolve(fixtureDir), taskDir, {recursive: true});
await rm(join(taskDir, 'results'), {force: true, recursive: true});
const task = await loadTask(taskDir);
const recorded = JSON.parse(await readFile(responsesPath, 'utf8'));
let cursor = 0;
const worker = new PythonTools(taskDir, {python: resolve(python), timeoutMs: 120000});
const start = performance.now();
try {
  await worker.ready;
  const trace = await runScientificAgent({...task, logDir: resolve(destination, 'logs'),
    maxIterations: 30, executionMode: 'historical_response_replay',
    model: 'recorded-response-replay/claude-fable-5-1',
    async complete({prompt}) {
      const entry = recorded[cursor++];
      if (!entry) throw new Error('Recorded completions exhausted');
      // Token totals are zero: no new inference or spend occurs during replay.
      return {text: entry.llm_response_raw, usage: {inputTokens: 0, outputTokens: 0}, finishReason: 'stop'};
    }, execute: (name, args) => worker.execute(name, args)});
  assert.equal(trace.status, 'completed');
  assert.equal(trace.execution_mode, 'historical_response_replay');
  const outputs = {};
  for (const artifact of task.requiredArtifacts) outputs[artifact] = JSON.parse(await readFile(join(taskDir, artifact)));
  const errors = trace.execution_trace.filter(e => e.runtime_metrics.error || /Traceback \(most recent call last\)/.test(e.result_summary));
  assert.equal(errors.length, 0, 'Every replayed tool must execute without error');
  assert.equal(outputs['results/learning_curve_fits.json'].fits.length, 3);
  console.log(JSON.stringify({mode: trace.execution_mode, status: trace.status,
    recorded_responses_consumed: cursor, actual_tool_calls: trace.total_steps,
    final_answer: trace.final_answer, elapsed_ms: performance.now() - start,
    log_dir: resolve(destination, 'logs'), task_dir: taskDir}, null, 2));
} finally { await worker.close(); }
