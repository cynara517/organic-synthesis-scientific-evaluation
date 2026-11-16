import {readFile, readdir, realpath, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, sep} from 'node:path';
import {defaultPrompts} from './prompts.js';

export async function loadTask(taskDir) {
  taskDir = await realpath(taskDir);
  const digest = createHash('sha256');
  async function input(relative, optional = false, returnText = true) {
    const target = resolve(taskDir, relative);
    if (!target.startsWith(taskDir + sep)) throw new Error('Input path leaves task directory');
    let path;
    try { path = await realpath(target); }
    catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
    if (!path.startsWith(taskDir + sep)) throw new Error(`Task input symlink leaves task directory: ${relative}`);
    digest.update(relative + '\0');
    if (returnText) {
      const value = await readFile(path);
      digest.update(value); digest.update('\0');
      return value.toString('utf8');
    }
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    digest.update('\0');
    return null;
  }
  const instruction = await input('instruction.md');
  const tools = JSON.parse(await input('tool_definitions.json'));
  if (!Array.isArray(tools) || !tools.length) throw new Error('Expected nonempty tool_definitions.json array');
  for (const tool of tools) {
    if (typeof tool.module !== 'string' || !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(tool.module)) throw new Error('Invalid tool module');
    await input(tool.module.replaceAll('.', '/') + '.py');
  }
  async function dataFiles(relative) {
    let children;
    try { children = await readdir(resolve(taskDir, relative), {withFileTypes: true}); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative + '/' + entry.name;
      if (entry.isDirectory()) await dataFiles(name);
      else await input(name, false, false);
    }
  }
  await dataFiles('data');
  const custom = await input('prompt_templates.json', true);
  const casesText = await input('reference_cases.json', true);
  const settingsText = await input('scientific-agent.json', true);
  const prompts = custom ? JSON.parse(custom) : defaultPrompts;
  if (typeof prompts.experience !== 'string' || typeof prompts.planning !== 'string') throw new Error('Invalid prompt_templates.json');
  const cases = casesText ? JSON.parse(casesText) : [];
  if (!Array.isArray(cases) || cases.some(c => typeof c.id !== 'string' || !c.id)) throw new Error('Invalid reference_cases.json');
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Duplicate reference case ID');
  const settings = settingsText ? JSON.parse(settingsText) : {};
  if (!Array.isArray(settings.requiredArtifacts ?? [])) throw new Error('requiredArtifacts must be an array');
  return {taskDir, instruction, tools, prompts, cases, metadata: settings,
    requiredArtifacts: settings.requiredArtifacts ?? [], taskFingerprint: digest.digest('hex')};
}

export async function containedTask(root, relative) {
  if (!root) throw new Error('Configure taskRoot with the directory of trusted tasks before running scientific_run');
  const base = await realpath(root);
  const path = await realpath(resolve(base, relative));
  if (path !== base && !path.startsWith(base + sep)) throw new Error('Task is outside configured taskRoot');
  if (!(await stat(path)).isDirectory()) throw new Error('Task must be a directory');
  return path;
}
