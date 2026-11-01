import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Read only the discovery pointer. The client never opens the task/fee database,
// owns a runtime, or retries a potentially accepted submission.
export function readRuntime(env = process.env) {
  const explicit = env.DSH_DESKTOP_RUNTIME_FILE;
  const files = explicit ? [explicit] : [
    path.join(env.APPDATA || path.join(os.homedir(), '.config'), 'DeepSeek Harness', 'runtime.json'),
    path.join(process.cwd(), '.dsh-desktop', 'runtime.json'),
  ];
  const found = files.flatMap(file => {
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (r.controlUrl) { r.url = r.controlUrl; r.launchUrl = r.controlLaunchUrl; }
      const url = new URL(r.url), launch = new URL(r.launchUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
        || url.username || url.password || url.search || url.hash || launch.origin !== url.origin || launch.pathname !== '/'
        || launch.username || launch.password || !launch.searchParams.get('token')) return [];
      return [{ ...r, runtimeFile: file, modified: fs.statSync(file).mtimeMs }];
    } catch { return []; }
  }).sort((a, b) => b.modified - a.modified);
  if (!found.length) throw new Error('DSH_DISCOVERY_MISSING: start the configured DSH host; no runtime was started or request replayed.');
  const runtime = found[0];
  if (runtime.localControlApi !== 2) throw new Error(`DSH_CONTROL_VERSION: runtime control API ${runtime.localControlApi ?? 'missing'} is older/incompatible; client requires 2. Update the native Runtime when idle, not the window settings.`);
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
