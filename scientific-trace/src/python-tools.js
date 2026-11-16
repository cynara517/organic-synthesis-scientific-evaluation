import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

export function validateArguments(schema, value, path = 'arguments') {
  const type = schema?.type;
  const okay = type === undefined ||
    (type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (type === 'integer' && Number.isInteger(value)) ||
    (type === 'null' && value === null);
  if (!okay) throw new Error(`${path} must have type ${type}`);
  if (schema?.enum && !schema.enum.includes(value)) throw new Error(`${path} is not an allowed value`);
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties?.[key]) validateArguments(schema.properties[key], v, `${path}.${key}`);
      else if (schema.additionalProperties !== true) throw new Error(`${path}.${key} is undeclared`);
    }
  }
  if (type === 'array' && schema.items) value.forEach((v, i) => validateArguments(schema.items, v, `${path}[${i}]`));
}

export class PythonTools {
  constructor(taskDir, {python = 'python3', timeoutMs = 120_000, signal} = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.counter = 0;
    this.failure = null;
    this.ready = new Promise((resolve, reject) => { this.onReady = resolve; this.onReadyError = reject; });
    this.child = spawn(python, ['-u', fileURLToPath(new URL('../python/worker.py', import.meta.url)), taskDir], {
      cwd: taskDir, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      // Model credentials stay in the host; task imports receive no env secrets.
      env: Object.fromEntries(['PATH', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'LANG', 'LC_ALL',
        'VIRTUAL_ENV', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))
    });
    this.exited = new Promise(resolve => this.child.once('close', (code, sig) => {
      this.fail(new Error(`Python worker exited (${code ?? sig})`)); resolve();
    }));
    this.lines = createInterface({input: this.child.stdout});
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Invalid worker protocol output')); return; }
      if (message.type === 'ready') { this.tools = message.tools; this.onReady(message.tools); return; }
      if (message.type === 'startup_error') { this.fail(new Error(message.error)); return; }
      const entry = this.pending.get(message.id);
      if (entry) { this.pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message); }
    });
    // Bounded diagnostic tail; never include it in an automatic error response.
    this.stderrTail = '';
    this.child.stderr.on('data', b => { this.stderrTail = (this.stderrTail + b.toString()).slice(-4096); });
    this.child.on('error', e => this.fail(e));
    this.child.stdin.on('error', e => this.fail(e));
    this.signal = signal;
    this.onAbort = () => this.fail(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    signal?.addEventListener('abort', this.onAbort, {once: true});
    this.startupTimer = setTimeout(() => this.fail(new Error('Python worker startup timeout')), timeoutMs);
    this.ready.then(() => clearTimeout(this.startupTimer), () => clearTimeout(this.startupTimer));
    if (signal?.aborted) this.onAbort();
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    this.onReadyError(error);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.killWorker();
  }

  killWorker() {
    if (!this.child.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-this.child.pid, 'SIGKILL');
      else this.child.kill('SIGKILL');
    } catch (error) {
      if (error.code === 'EPERM') {
        // Some embedded hosts allow signalling a child but deny process groups.
        // Always terminate and await the owned worker. Container runtimes own
        // descendant cleanup when the host cannot signal its process group.
        this.groupKillUnsupported = true;
        this.child.kill('SIGKILL');
      } else if (error.code !== 'ESRCH') throw error;
    }
  }

  async execute(name, args) {
    await this.ready;
    if (this.failure) throw this.failure;
    const definition = this.tools.find(t => t.name === name);
    if (!definition) throw new Error(`Unknown tool: ${name}`);
    validateArguments(definition.parameters, args);
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Tool timeout: ${name}`)), this.timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({id, name, arguments: args}) + '\n', e => { if (e) this.fail(e); });
    });
  }

  async close() {
    clearTimeout(this.startupTimer);
    this.signal?.removeEventListener('abort', this.onAbort);
    if (this.child.exitCode === null && this.child.signalCode === null) this.killWorker();
    await this.exited;
    this.lines.close();
  }
}
