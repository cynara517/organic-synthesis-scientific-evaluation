// Real Cordis, LLM service, tool registry and native executor. Deterministic
// adapter responses are fixtures, not a claim of fresh model inference.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

if (!process.env.DSH_HOST_DIR) throw new Error('Set DSH_HOST_DIR to an installation of @deepseek-ai/dsh@0.2.2-rc.1');
const hostRequire = createRequire(resolve(process.env.DSH_HOST_DIR, 'package.json'));
const load = name => import(pathToFileURL(hostRequire.resolve(name)));
const {Context} = await load('@deepseek-ai/cordis');
const {default: SystemPrompt} = await load('@deepseek-ai/dsh-system-prompt');
const {default: Tools} = await load('@deepseek-ai/dsh-tools');
const {LlmRuntime, LlmAdapter} = await load('@deepseek-ai/dsh-llm');
const executor = await load('@deepseek-ai/dsh-tool-executor-native');
const plugin = await import(process.env.SCIENCE_PLUGIN_ENTRY
  ? pathToFileURL(resolve(process.env.SCIENCE_PLUGIN_ENTRY)) : new URL('../src/plugin.js', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'science-real-host-'));
const task = join(root, 'task');
await mkdir(task);
await writeFile(join(task, 'instruction.md'), 'Calculate 6 * 7 in Python, write results/value.json, then answer 42.');
await writeFile(join(task, 'tools.py'), `import json\nfrom pathlib import Path\ndef calculate(x, y):\n    Path('results').mkdir(exist_ok=True)\n    value = x * y\n    Path('results/value.json').write_text(json.dumps({'value': value}))\n    return value\n`);
await writeFile(join(task, 'tool_definitions.json'), JSON.stringify([{name: 'multiply', description: 'Multiply numbers',
  module: 'tools', function_name: 'calculate', parameters: {type: 'object', properties: {
    x: {type: 'number'}, y: {type: 'number'}}, required: ['x','y']}}]));
await writeFile(join(task, 'scientific-agent.json'), JSON.stringify({requiredArtifacts: ['results/value.json']}));

const completions = [
  {initial_plan: 'Calculate and check the written artifact.', reference_cases_used: []},
  {selected_tool: 'multiply', call_params: {x: 6, y: 7}, planning_rationale: 'Calculate from inputs'},
  {final_answer: '42'}
];
let requests = 0;
class FixtureAdapter extends LlmAdapter {
  async *stream(options) {
    assert.equal(options.provider, 'science-test-fixture');
    const value = completions[requests++];
    assert.ok(value, 'Unexpected model request');
    yield {type: 'block-end', index: 0, block: {type: 'text', text: JSON.stringify(value)}};
    yield {type: 'usage', usage: {inputTokens: 10, outputTokens: 3}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }
}
const ctx = new Context();
const fibers = [];
try {
  for (const dependency of [SystemPrompt, Tools, LlmRuntime, executor]) fibers.push(await ctx.plugin(dependency));
  fibers.push(await ctx.plugin({name: 'science-fixture-adapter', inject: ['llm'], apply(c) {
    c.llm.registerAdapter(['science-test-fixture'], new FixtureAdapter());
  }}));
  const pluginFiber = await ctx.plugin(plugin, {taskRoot: root, logRoot: join(root, 'logs'),
    provider: 'science-test-fixture', model: 'recorded-fixture', executionMode: 'synthetic_test',
    python: process.env.SCIENCE_PYTHON ?? 'python3'});
  fibers.push(pluginFiber);
  assert.ok(ctx.tools.get('scientific_run'));
  const signal = new AbortController().signal;
  const response = await ctx.tools.execute({signal,
    calls: [{type: 'tool-call', id: 'science-host-call-1', name: 'scientific_run', arguments: JSON.stringify({task: 'task'})}]});
  const result = response.results[0].result;
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.status, 'completed'); assert.equal(result.value.final_answer, '42');
  assert.deepEqual(JSON.parse(await readFile(join(task, 'results/value.json'))), {value: 42});
  const trace = JSON.parse(await readFile(result.value.scientific_trace));
  assert.equal(trace.execution_mode, 'synthetic_test');
  assert.equal(trace.summary_metrics.total_llm_calls, 3);
  assert.equal(trace.summary_metrics.total_tool_calls, 1);
  const denied = await ctx.tools.execute({signal,
    calls: [{type: 'tool-call', id: 'science-host-call-2', name: 'scientific_run', arguments: JSON.stringify({task: '../'})}]});
  assert.equal(denied.results[0].result.isError, true);
  await pluginFiber.dispose();
  assert.equal(ctx.tools.get('scientific_run'), undefined);
  console.log(JSON.stringify({status: 'passed', host: '@deepseek-ai/dsh@0.2.2-rc.1',
    mode: 'synthetic_test', checks: ['real plugin activation', 'host LLM service dispatch',
      'native tool execution', 'Python artifact', 'task-root rejection', 'plugin unload']}, null, 2));
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
  await rm(root, {recursive: true, force: true});
}
