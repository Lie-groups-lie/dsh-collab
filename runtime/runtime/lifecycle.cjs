// Bounded process evidence, independent of Electron/MCP pipes. No timer, model,
// retry, exception suppression, raw stderr, environment or conversation capture.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const KEY = Symbol.for('dsh.collab.lifecycle');

function readEvidence(file) {
  try {
    if (!file || fs.statSync(file).size > 96 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.schema === 1 && typeof value.instanceId === 'string' ? value : null;
  } catch { return null; }
}
function writeEvidence(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function errorFacts(error) {
  // Never serialize arbitrary rejection objects, error messages or stack headers.
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  return {
    name: /^[A-Za-z]+Error$/.test(error?.name || '') ? error.name : 'Error',
    code: /^[A-Z0-9_]{1,60}$/.test(error?.code || '') ? error.code : null,
    messageHash: createHash('sha256').update(String(error?.message || error)).digest('hex'),
    frames: stack.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 12)
      .map(line => line.trim().replace(/\?[^\s)]+/g, '?[redacted]').slice(0, 500)),
  };
}
function install({ file, instanceId, port }) {
  if (globalThis[KEY]) return globalThis[KEY];
  const state = { schema: 1, instanceId, pid: process.pid, parentPid: process.ppid,
    port: Number(port), startedAt: Date.now(), status: 'starting', events: [] };
  const record = (type, detail = {}) => {
    try {
      state.events.push({ type, at: Date.now(), ...detail });
      state.events = state.events.slice(-32);
      writeEvidence(file, state);
    } catch { /* Diagnostic failure must not alter runtime execution. */ }
  };
  const lifecycle = { file, instanceId, record, ready(identity) {
    state.status = 'ready'; state.processIdentity = identity; record('ready');
  } };
  globalThis[KEY] = lifecycle;
  record('starting', { nodeVersion: process.version });
  process.on('uncaughtExceptionMonitor', (error, origin) => record('fatal-exception', { origin, ...errorFacts(error) }));
  // The official fail-loud handler logs handled fatal rejections to stderr and
  // exits. Observe its fatal marker without adding an unhandledRejection listener
  // (which would change Node's default behavior) or retaining the raw message.
  const stderrWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      if (/^dsh: fatal (?:load failure|uncaught exception):/.test(text)) {
        record('dsh-fatal', { kind: text.startsWith('dsh: fatal load') ? 'unhandled-rejection' : 'uncaught-exception',
          ...errorFacts({ stack: text, message: text }) });
      }
    } catch {}
    return stderrWrite.call(this, chunk, ...args);
  };
  process.once('beforeExit', code => record('event-loop-drained', { code }));
  process.once('exit', code => { state.status = 'exited'; state.exitCode = code; state.exitedAt = Date.now(); record('exit', { code }); });
  return lifecycle;
}
function observeExit(file, instanceId, code, signal) {
  // Separate observer file: no racing read-modify-write of the child's evidence.
  try { writeEvidence(`${file}.owner`, { schema: 1, instanceId, observedAt: Date.now(), exitCode: code, signal, status: 'exited' }); } catch {}
}
function pruneEvidence(directory) {
  // Rotate only our closed lifecycle records, never task stores or live records.
  try {
    const files = fs.readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
      .map(name => ({ name, value: readEvidence(path.join(directory, name)) }))
      .filter(item => item.value?.status === 'exited').sort((a, b) => b.value.startedAt - a.value.startedAt);
    for (const item of files.slice(20)) {
      fs.unlinkSync(path.join(directory, item.name));
      try { fs.unlinkSync(path.join(directory, `${item.name}.owner`)); } catch {}
    }
  } catch {}
}
module.exports = { KEY, readEvidence, writeEvidence, errorFacts, install, observeExit, pruneEvidence };
if (process.env.DSH_RUNTIME_EVIDENCE_FILE && process.env.DSH_RUNTIME_INSTANCE) {
  install({ file: process.env.DSH_RUNTIME_EVIDENCE_FILE, instanceId: process.env.DSH_RUNTIME_INSTANCE, port: process.env.DSH_RUNTIME_PORT });
  // Do not inject lifecycle identity/preloads into model-launched child tools.
  delete process.env.DSH_RUNTIME_EVIDENCE_FILE; delete process.env.DSH_RUNTIME_INSTANCE; delete process.env.DSH_RUNTIME_PORT;
  if (process.platform !== 'win32') {
    if (process.env.DSH_COLLAB_ORIGINAL_NODE_OPTIONS) process.env.NODE_OPTIONS = process.env.DSH_COLLAB_ORIGINAL_NODE_OPTIONS;
    else delete process.env.NODE_OPTIONS;
    delete process.env.DSH_COLLAB_ORIGINAL_NODE_OPTIONS;
  }
}
