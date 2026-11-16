import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractJson, runScientificAgent} from '../src/core.js';

const tools = [{name: 'calculate', description: 'Calculate a value', parameters: {
  type: 'object', properties: {x: {type: 'number'}}, required: ['x']}}];
const exp = JSON.stringify({initial_plan: 'Calculate and validate.', reference_cases_used: []});
const plan = x => JSON.stringify({selected_tool: 'calculate', call_params: {x}, planning_rationale: 'Check evidence'});
const answer = JSON.stringify({final_answer: '42'});
async function fixture(t) {
  const logDir = await mkdtemp(join(tmpdir(), 'science-test-'));
  t.after(() => rm(logDir, {recursive: true, force: true}));
  return {instruction: 'Calculate the answer', logDir, tools, taskFingerprint: 'fixture-v1',
    model: 'test/model', maxIterations: 3, execute: async (_n, a) => ({value: a.x * 2, error: null})};
}
function responses(values, seen = []) {
  let i = 0;
  return async request => {
    seen.push(request);
    const text = values[i++];
    if (text === undefined) throw new Error('No test completion remains');
    if (text instanceof Error) throw text;
    return {text, usage: {inputTokens: 10, outputTokens: 4}, finishReason: 'stop'};
  };
}

test('JSON parsing respects braces and escapes inside executable code', () => {
  const original = {call_params: {code: 'print("}")\nx = {"s": "\\\\"}'}};
  assert.deepEqual(extractJson('```json\n' + JSON.stringify(original) + '\n```'), original);
  assert.throws(() => extractJson('{"x":"unfinished'), /Truncated/);
});

test('four-stage run links real dispatch to both trace formats and counts retries', async t => {
  const options = await fixture(t);
  const calls = [];
  const trace = await runScientificAgent({...options, complete: responses([exp, '{}', plan(21), answer]),
    execute: async (name, args) => { calls.push({name, args}); return {value: args.x * 2}; }});
  assert.equal(trace.status, 'completed');
  assert.equal(trace.final_answer, '42');
  assert.equal(trace.summary_metrics.total_llm_calls, 4);
  assert.equal(trace.summary_metrics.total_input_tokens, 40);
  assert.equal(trace.summary_metrics.answer_correct, null);
  assert.deepEqual(calls, [{name: 'calculate', args: {x: 21}}]);
  assert.equal(trace.execution_trace[0].result_summary, '42');
  const atif = JSON.parse(await readFile(join(options.logDir, 'trajectory.json')));
  const step = atif.steps.find(s => s.tool_calls);
  assert.equal(step.tool_calls[0].tool_call_id, step.observation.results[0].source_call_id);
  assert.deepEqual(atif.steps.map(s => s.step_id), atif.steps.map((_, i) => i + 1));
  assert.equal(await readFile(join(options.logDir, 'answer.txt'), 'utf8'), '42');
});

test('unknown tools and undeclared parameters never reach execution', async t => {
  for (const bad of [JSON.stringify({selected_tool: 'missing', call_params: {}}),
    JSON.stringify({selected_tool: 'calculate', call_params: {x: 1, surprise: 2}})]) {
    const options = await fixture(t);
    let calls = 0;
    await assert.rejects(runScientificAgent({...options, parseRetries: 1,
      complete: responses([exp, bad, bad]), execute: async () => { calls++; }}), /Invalid planning/);
    assert.equal(calls, 0);
    const trace = JSON.parse(await readFile(join(options.logDir, 'scientific_trace.json')));
    assert.equal(trace.status, 'failed'); assert.equal(trace.partial, true);
    assert.equal(trace.llm_attempts.length, 3);
  }
});

test('reference-case claims must identify a case actually supplied', async t => {
  const options = await fixture(t);
  const good = JSON.stringify({initial_plan: 'Use known method', reference_cases_used: ['case-1']});
  const bad = JSON.stringify({initial_plan: 'Invent case', reference_cases_used: ['not-supplied']});
  const trace = await runScientificAgent({...options, cases: [{id: 'case-1', lesson: 'Validate output'}],
    complete: responses([bad, good, answer])});
  assert.equal(trace.experience_planning.reference_cases_used[0], 'case-1');
  assert.equal(trace.llm_attempts[0].accepted, false);
});

test('resume preserves completed tools and total budget, and warns that REPL state restarted', async t => {
  const options = await fixture(t);
  let executed = 0;
  const execute = async () => { executed++; return {value: 'computed'}; };
  await assert.rejects(runScientificAgent({...options, execute,
    complete: responses([exp, plan(1), new Error('gateway disconnected')])}), /gateway/);
  const seen = [];
  const trace = await runScientificAgent({...options, resume: true, execute, complete: responses([answer], seen)});
  assert.equal(executed, 1);
  assert.equal(trace.total_steps, 1);
  assert.equal(trace.summary_metrics.total_llm_calls, 4);
  assert.match(seen[0].prompt, /TOOL SESSION RESTARTED/);
  assert.equal(trace.resume_count, 1);
  await assert.rejects(runScientificAgent({...options, resume: true, complete: responses([])}), /already completed/);
});

test('changed task cannot resume or overwrite its checkpoint', async t => {
  const options = await fixture(t);
  await assert.rejects(runScientificAgent({...options, complete: responses([exp, new Error('offline')])}));
  const before = await readFile(join(options.logDir, 'checkpoint.json'), 'utf8');
  await assert.rejects(runScientificAgent({...options, taskFingerprint: 'different', resume: true,
    complete: responses([])}), /fingerprint/);
  assert.equal(await readFile(join(options.logDir, 'checkpoint.json'), 'utf8'), before);
});

test('interrupted tool is not silently replayed on resume', async t => {
  const options = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(runScientificAgent({...options, signal: controller.signal,
    complete: responses([exp, plan(1)]), execute: async () => {
      controller.abort(new Error('interrupted')); return {value: 'may have written a file'};
    }}), /interrupted/);
  let calls = 0;
  await assert.rejects(runScientificAgent({...options, resume: true, complete: responses([answer]),
    execute: async () => { calls++; }}), /unknown outcome/);
  assert.equal(calls, 0);
});

test('iteration limit is not completion and resume does not replenish the budget', async t => {
  const options = {...await fixture(t), maxIterations: 1};
  const first = await runScientificAgent({...options, complete: responses([exp, plan(2)])});
  assert.equal(first.status, 'iteration_limit'); assert.equal(first.final_answer, null);
  let called = false;
  const resumed = await runScientificAgent({...options, resume: true, complete: async () => { called = true; }});
  assert.equal(resumed.status, 'iteration_limit'); assert.equal(called, false);
});

test('missing required artifacts prevent a claimed final answer becoming completion', async t => {
  const options = await fixture(t);
  await assert.rejects(runScientificAgent({...options, taskDir: options.logDir,
    requiredArtifacts: ['results/required.json'], complete: responses([exp, answer])}), /ENOENT/);
  const trace = JSON.parse(await readFile(join(options.logDir, 'scientific_trace.json')));
  assert.equal(trace.status, 'failed'); assert.equal(trace.final_answer, null);
});

test('empty refusal is terminal and retains the model response', async t => {
  const options = await fixture(t);
  let calls = 0;
  await assert.rejects(runScientificAgent({...options, complete: async () => {
    calls++; return {text: '', finishReason: 'refusal'};
  }}), /refused/);
  assert.equal(calls, 1);
});
