import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PythonTools} from '../src/python-tools.js';

async function task(t, code) {
  const root = await mkdtemp(join(tmpdir(), 'science-python-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'tools.py'), code);
  await writeFile(join(root, 'tool_definitions.json'), JSON.stringify([{name: 'run', module: 'tools', function_name: 'run',
    description: 'test', parameters: {type: 'object', properties: {code: {type: 'string'}}, required: ['code']}}]));
  const worker = new PythonTools(root, {python: process.env.SCIENCE_PYTHON ?? 'python3', timeoutMs: 1000});
  t.after(() => worker.close());
  await worker.ready;
  return worker;
}

test('Python tool uses a persistent namespace and captures printed protocol-like text', async t => {
  const worker = await task(t, `ns = {}\ndef run(code):\n    print('{"type":"ready"}')\n    exec(code, ns)\n    return ns.get('x')\n`);
  assert.equal((await worker.execute('run', {code: 'x = 40'})).value, 40);
  const result = await worker.execute('run', {code: 'x += 2'});
  assert.equal(result.value, 42); assert.match(result.stdout, /ready/);
  await assert.rejects(worker.execute('run', {code: 'x=0', unknown: 1}), /undeclared/);
});

test('Python bridge isolates credential environment variables', async t => {
  process.env.SCIENCE_TEST_SECRET = 'must-not-cross';
  t.after(() => delete process.env.SCIENCE_TEST_SECRET);
  const worker = await task(t, `import os\ndef run(code):\n    return os.environ.get('SCIENCE_TEST_SECRET')\n`);
  assert.equal((await worker.execute('run', {code: ''})).value, null);
});

test('hanging Python tool is terminated and its owned process is awaited', async t => {
  const worker = await task(t, `import time\ndef run(code):\n    time.sleep(60)\n`);
  await assert.rejects(worker.execute('run', {code: ''}), /timeout/);
  await worker.close();
  assert.notEqual(worker.child.signalCode, null);
});

test('legacy tools returning traceback text are marked as errors without losing the evidence', async t => {
  const worker = await task(t, `def run(code):\n    return 'Traceback (most recent call last):\\nValueError: bad input'\n`);
  const value = await worker.execute('run', {code: ''});
  assert.match(value.error, /reported an error/);
  assert.match(value.value, /ValueError: bad input/);
});
