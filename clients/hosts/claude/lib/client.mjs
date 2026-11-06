import fs from 'node:fs';
import { runtimeCandidates } from './discovery.mjs';

// Read only the discovery pointer. The client never opens the task/fee database,
// owns a runtime, or retries a potentially accepted submission.
function scanRuntimeRecords(env, options) {
  const records = [];
  const found = runtimeCandidates(env, options).flatMap((file, candidate) => {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) { records.push({ candidate, state: 'invalid-record' }); return []; }
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (r.controlUrl) { r.url = r.controlUrl; r.launchUrl = r.controlLaunchUrl; }
      const url = new URL(r.url), launch = new URL(r.launchUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
        || url.username || url.password || url.search || url.hash || launch.origin !== url.origin || launch.pathname !== '/'
        || launch.username || launch.password || !launch.searchParams.get('token')) { records.push({ candidate, state: 'invalid-record' }); return []; }
      records.push({ candidate, state: r.localControlApi === 2 ? 'valid-record' : 'incompatible-control-api' });
      return [{ ...r, runtimeFile: file, modified: stat.mtimeMs, discoveryCandidate: candidate }];
    } catch (error) { records.push({ candidate, state: error.code === 'ENOENT' ? 'missing' : ['EACCES', 'EPERM'].includes(error.code) ? 'unreadable' : 'invalid-record' }); return []; }
  }).sort((a, b) => b.modified - a.modified);
  return { found, records };
}

// Safe to paste into an issue: no paths, URLs, credentials, PID or session data.
// Valid discovery does NOT establish process liveness or authentication success.
export function inspectConnection(env = process.env, options) {
  const { found, records } = scanRuntimeRecords(env, options), selected = found.length === 1 ? found[0] : null;
  return { schema: 1, mode: 'offline-discovery-only', explicitSelection: Boolean(env.DSH_DESKTOP_RUNTIME_FILE),
    records, selectedCandidate: selected?.discoveryCandidate ?? null,
    discoveryValid: found.length > 0, controlCompatible: selected ? selected.localControlApi === 2 : null,
    multipleRecords: found.length > 1, reachable: null, authenticated: null, modelCalls: 0,
    nextAction: found.length > 1 ? 'Multiple valid records exist. Set DSH_DESKTOP_RUNTIME_FILE explicitly before submitting work; no host was selected.' : !selected
      ? records.some(r => r.state !== 'missing') ? 'Inspect the selected connection record format and local file permissions. No alternate host was started.' : 'Configure the active DSH profile to publish a connection record; both sides must select the same path.'
      : selected.localControlApi !== 2 ? 'The selected native Runtime control API is incompatible; this client requires 2. Update only in an idle maintenance window.'
      : 'Discovery is readable. Use the registered deepseek_runtime_status tool to check the live connection; no task has been submitted.' };
}

export function readRuntime(env = process.env, options) {
  const { found, records } = scanRuntimeRecords(env, options);
  if (!found.length) {
    if (records.some(record => record.state === 'unreadable')) throw new Error('DSH_DISCOVERY_UNREADABLE: connection record cannot be read; inspect file permissions. No runtime started or request replayed.');
    if (records.some(record => record.state === 'invalid-record')) throw new Error('DSH_DISCOVERY_INVALID: connection record exists but is malformed, unsafe or oversized; check the configured instance. No runtime started or request replayed.');
    throw new Error('DSH_DISCOVERY_MISSING: start the configured DSH host; no runtime was started or request replayed.');
  }
  if (found.length > 1) throw new Error('DSH_DISCOVERY_AMBIGUOUS: multiple valid connection records exist. Set DSH_DESKTOP_RUNTIME_FILE to the intended instance; no host was selected or task submitted.');
  const runtime = found[0];
  if (runtime.localControlApi !== 2) throw new Error('DSH_CONTROL_VERSION: selected native Runtime control API is incompatible; client requires 2. Update the native Runtime when idle, not the window settings.');
  return runtime;
}

export async function callRemote(name, args = {}, { runtime = readRuntime(), signal, onProgress, timeoutMs = 7200000 } = {}) {
  // Authentication is exchanged per call: no indefinitely cached cookie from an old Host generation.
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  let accepted = false;
  try {
    const auth = await fetch(runtime.launchUrl, { redirect: 'manual', signal: AbortSignal.any([combined, AbortSignal.timeout(10000)]) });
    const cookie = auth.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
    if (auth.status !== 303 || !cookie) throw new Error(`DSH_RUNTIME_AUTH: local control authentication returned HTTP ${auth.status}; no task submitted.`);
    accepted = true; // A failed network send cannot prove that the Host did not accept it.
    const response = await fetch(new URL('/api/dsh-collab-stream', runtime.url), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ operation: name, arguments: args }), signal: combined,
    });
    if (!response.ok) throw new Error(`DSH_CONTROL_HTTP_${response.status}: inspect the original receipt; no automatic replay.`);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (Buffer.byteLength(pending) > 32 * 1024 * 1024) throw new Error('DSH_CONTROL_FRAME_LIMIT: use paged results.');
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.type === 'progress') await onProgress?.(frame.value);
          else if (frame.type === 'result') return frame.value;
          else if (frame.type === 'error') {
            const error = new Error(frame.error?.message || 'DSH operation failed');
            error.code = frame.error?.code; error.compatibility = frame.error?.compatibility;
            error.runtimeDiagnostic = frame.error?.runtimeDiagnostic; throw error;
          }
        }
        if (done) throw new Error('DSH_CONTROL_INTERRUPTED: response ended before a result; inspect the original receipt.');
      }
    } finally { await reader.cancel().catch(() => {}); }
  } catch (error) {
    if (combined.aborted) throw new Error('DSH_OBSERVATION_CANCELLED: stopped waiting; accepted task continues. Use its existing handle to inspect or explicitly cancel.');
    if (/fetch failed|ECONN|terminated/i.test(error.message)) throw new Error(`DSH_RUNTIME_UNREACHABLE: ${accepted ? 'submission outcome may be unknown; inspect the original handle/request_key' : 'authentication did not complete'}; no automatic restart or replay.`);
    throw error;
  } finally { controller.abort(); }
}
