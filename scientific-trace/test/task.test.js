import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadTask, containedTask} from '../src/task.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'science-task-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const task = join(root, 'task'); await mkdir(join(task, 'data'), {recursive: true});
  await writeFile(join(task, 'instruction.md'), 'Analyze data.');
  await writeFile(join(task, 'tools.py'), 'def run(): return 1');
  await writeFile(join(task, 'tool_definitions.json'), JSON.stringify([{name: 'run', module: 'tools',
    function_name: 'run', description: 'test', parameters: {type: 'object'}}]));
  return {root, task};
}

test('fingerprint covers actual binary input bytes and tool source', async t => {
  const {task} = await fixture(t);
  await writeFile(join(task, 'data/input.bin'), Buffer.from([0xff]));
  const first = await loadTask(task);
  await writeFile(join(task, 'data/input.bin'), Buffer.from([0xfe]));
  const second = await loadTask(task);
  assert.notEqual(first.taskFingerprint, second.taskFingerprint);
  await writeFile(join(task, 'tools.py'), 'def run(): return 2');
  assert.notEqual(second.taskFingerprint, (await loadTask(task)).taskFingerprint);
});

test('task-root and input symlink escapes are rejected', async t => {
  const {root, task} = await fixture(t);
  await assert.rejects(containedTask(task, '..'), /outside/);
  await writeFile(join(root, 'external.csv'), 'outside');
  await symlink(join(root, 'external.csv'), join(task, 'data/outside.csv'));
  await assert.rejects(loadTask(task), /symlink leaves/);
});
