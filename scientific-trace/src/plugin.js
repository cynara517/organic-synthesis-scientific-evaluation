import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runScientificAgent} from './core.js';
import {PythonTools} from './python-tools.js';
import {containedTask, loadTask} from './task.js';
import {harnessModel} from './host-model.js';

export const name = 'scientific-agent';
export const inject = ['tools', 'llm'];

export function apply(ctx, config = {}) {
  const active = new Set();
  ctx.effect(() => async () => {
    for (const job of active) job.controller.abort(new Error('Scientific plugin unloaded'));
    await Promise.allSettled([...active].map(job => job.finished));
  });
  ctx.tools.register({
    name: 'scientific_run',
    description: 'Run a trusted local scientific task through experience planning, iterative planning/tool selection, real tool execution, and checkpoint/routing. Writes scientific and ATIF traces. Task code executes in a local Python worker; use an external container for untrusted tasks. Requires taskRoot and logRoot to be configured in the plugin row.',
    parameters: {type: 'object', properties: {
      task: {type: 'string', description: 'Task directory relative to the configured trusted taskRoot.'},
      run_id: {type: 'string', description: 'An existing run UUID to resume; omit for a new run.'},
    }, required: ['task'], additionalProperties: false},
    output: {schema: {type: 'object', additionalProperties: true}, render(_args, value) {
      return [{type: 'text', text: JSON.stringify(value)}];
    }},
    async execute(args, exec) {
      if (!args || typeof args.task !== 'string' || !args.task.trim()) throw new Error('task is required');
      if (Object.keys(args).some(key => !['task', 'run_id'].includes(key))) throw new Error('Undeclared argument');
      if (args.run_id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.run_id)) throw new Error('Invalid run_id');
      if (!config.logRoot || !config.taskRoot) {
        const missing = [!config.taskRoot && 'taskRoot', !config.logRoot && 'logRoot'].filter(Boolean);
        throw new Error(`scientific_run is not configured yet: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} unset. `
          + 'Add a row override to your profile\'s cordis.patch.yml:\n'
          + '- id: scientific-agent\n'
          + '  config:\n'
          + '    taskRoot: /absolute/path/to/trusted-tasks\n'
          + '    logRoot: /absolute/path/to/scientific-logs\n'
          + 'taskRoot holds task directories; logRoot receives the run traces and must be writable. '
          + 'Copy examples/minimal/ from this package into taskRoot to try it once.');
      }
      const taskDir = await containedTask(config.taskRoot, args.task);
      const task = await loadTask(taskDir);
      const runId = args.run_id ?? randomUUID();
      const logDir = resolve(config.logRoot, runId);
      // Use the calling agent's current host route; never read or copy credentials.
      const selection = config.provider && config.model
        ? {provider: config.provider, model: config.model, ...(config.reasoningEffort ? {reasoningEffort: config.reasoningEffort} : {})}
        : exec.agent?.model?.current();
      const complete = harnessModel(ctx.llm, selection, {maxTokens: config.maxTokens ?? 16384,
        requestTimeoutMs: config.requestTimeoutMs ?? 300000, sessionId: exec.agent?.id});
      const controller = new AbortController();
      const signal = AbortSignal.any([exec.signal, controller.signal,
        AbortSignal.timeout(config.runTimeoutMs ?? 1800000)].filter(Boolean));
      let done;
      const job = {controller, finished: new Promise(r => { done = r; })};
      active.add(job);
      const worker = new PythonTools(taskDir, {python: config.python ?? 'python3',
        timeoutMs: config.toolTimeoutMs ?? 120000, signal});
      try {
        await worker.ready;
        const trace = await runScientificAgent({...task, complete,
          execute: (name, params) => worker.execute(name, params), signal, logDir,
          model: `${selection.provider}/${selection.model}`, traceId: runId,
          executionMode: config.executionMode ?? 'live',
          maxIterations: config.maxIterations ?? 15, parseRetries: config.parseRetries ?? 3,
          resume: args.run_id !== undefined});
        return {run_id: runId, status: trace.status, final_answer: trace.final_answer,
          answer_correct: null, total_steps: trace.total_steps,
          scientific_trace: resolve(logDir, 'scientific_trace.json'),
          trajectory: resolve(logDir, 'trajectory.json'),
          events: resolve(logDir, 'science-events.jsonl')};
      } finally { await worker.close(); done(); active.delete(job); }
    }
  });
}
