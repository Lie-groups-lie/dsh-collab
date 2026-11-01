import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import ws from '../vendor/ws/index.js';
import { STREAM_ENDPOINTS, checkRpc } from './native-transport.mjs';

const BODY_LIMIT = 2 * 1024 * 1024;
const FRAME_LIMIT = 16 * 1024 * 1024;
function failure(error) {
  const value = { code: typeof error?.code === 'string' ? error.code : 'COLLAB_REQUEST_FAILED',
    message: String(error?.message || 'Collab request failed').slice(0, 1500) };
  const pick = (object, keys) => Object.fromEntries(keys.filter(key => ['string', 'boolean', 'number'].includes(typeof object?.[key]) || object?.[key] === null)
    .map(key => [key, typeof object[key] === 'string' ? object[key].slice(0, 1500) : object[key]]));
  if (error?.code === 'DSH_RUNTIME_CONTRACT_MISMATCH' && error.details) {
    value.compatibility = { compatible: false,
      actual: pick(error.details.actual, ['dshVersion', 'bridgeVersion']),
      expected: pick(error.details.expected, ['dshVersion', 'bridgeVersion']),
      issues: (error.details.issues || []).slice(0, 8).map(issue => pick(issue, ['component', 'actual', 'expected', 'olderSide', 'message'])) };
  }
  if (error?.runtimeDiagnostic) value.runtimeDiagnostic = pick(error.runtimeDiagnostic,
    ['instanceId', 'pid', 'processState', 'transportCode', 'exitCode', 'outcome']);
  return value;
}
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// One listener in the existing Host, independent of the desktop's browser gate.
// Legacy MCP envelopes remain supported so already-open Codex chats need no restart.
// The listener exposes only Collab's bounded command/read surface, never arbitrary
// DSH RPC, settings, credentials, shell execution or model tool authorization.
export async function startLocalEndpoint(adapter, { background, invokeTool } = {}) {
  const token = randomBytes(32).toString('base64url');
  const session = randomBytes(32).toString('base64url');
  const cookieName = `dsh_collab_${randomBytes(8).toString('hex')}`;
  const sockets = new Set(), controllers = new Set();
  let origin, active = true, inFlight = 0;
  function trusted(req) {
    return req.headers.host === new URL(origin).host
      && (!req.headers.origin || req.headers.origin === new URL(origin).origin)
      && req.headers['sec-fetch-site'] !== 'cross-site';
  }
  function authenticated(req) {
    const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`));
    return equal(cookie?.slice(cookieName.length + 1), session);
  }
  function send(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > FRAME_LIMIT) return send(res, 413, { error: 'Collab response exceeds transport limit; request a smaller page' });
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  }
  const server = http.createServer(async (req, res) => {
    if (!active) return send(res, 503, { error: 'Collab host is stopping' });
    if (!trusted(req)) return send(res, 403, { error: 'Collab request origin is not admitted' });
    let url;
    try { url = new URL(req.url, origin); } catch { return send(res, 400, { error: 'Invalid Collab URL' }); }
    if (req.method === 'GET' && url.pathname === '/') {
      if (!equal(url.searchParams.get('token'), token)) return send(res, 401, { error: 'Collab generation credential is invalid' });
      res.writeHead(303, { location: './', 'cache-control': 'no-store',
        'set-cookie': `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict` });
      return res.end();
    }
    if (!authenticated(req)) return send(res, 401, { error: 'Collab authentication required' });
    if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON POST required' });
    if (inFlight >= 64) return send(res, 429, { error: 'Too many simultaneous Collab requests' });
    inFlight++;
    const controller = new AbortController(); controllers.add(controller);
    const streaming = url.pathname === '/api/dsh-collab-stream';
    const timer = setTimeout(() => controller.abort(), streaming ? 7200000 : 120000); timer.unref();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_LIMIT) { send(res, 413, { error: 'Collab request too large' }); req.resume(); return; }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      controller.signal.throwIfAborted();
      if (streaming) {
        if (!payload || Object.keys(payload).some(k => !['operation', 'arguments'].includes(k))) throw new Error('Invalid Collab request');
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        const frame = value => {
          if (res.destroyed || res.writableEnded) return;
          const body = JSON.stringify(value) + '\n';
          if (Buffer.byteLength(body) > FRAME_LIMIT || res.writableLength > FRAME_LIMIT) {
            controller.abort(); res.destroy(); return;
          }
          res.write(body);
        };
        const heartbeat = setInterval(() => frame({ type: 'heartbeat' }), 15000); heartbeat.unref();
        try {
          const value = await invokeTool(payload.operation, payload.arguments || {}, controller.signal,
            value => frame({ type: 'progress', value }));
          frame({ type: 'result', value });
        } catch (error) { frame({ type: 'error', error: failure(error) }); }
        finally { clearInterval(heartbeat); if (!res.destroyed) res.end(); }
        return;
      }
      if (url.pathname === '/api/dsh-collab-background' || url.pathname === '/api/dsh-collab') {
        if (!payload || Object.keys(payload).some(k => !['operation', 'arguments'].includes(k))) throw new Error('Invalid Collab request');
        const value = url.pathname === '/api/dsh-collab-background'
          ? await background(payload.operation, payload.arguments || {}, controller.signal)
          : await invokeTool(payload.operation, payload.arguments || {}, controller.signal);
        return send(res, 200, value);
      }
      const endpoint = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : '';
      if (payload?.type !== 'client-request' || payload.method !== endpoint || typeof payload.rpcId !== 'string'
        || payload.rpcId.length > 200 || !payload.payload?.args) throw new Error('Invalid Collab RPC envelope');
      try {
        checkRpc(endpoint, payload.payload.args);
        const value = await adapter.rpc(endpoint, payload.payload.args, controller.signal);
        send(res, 200, { type: 'server-response', rpcId: payload.rpcId, result: { ok: true, value } });
      } catch (error) { send(res, 200, { type: 'server-response', rpcId: payload.rpcId, result: { ok: false, error: failure(error) } }); }
    } catch (error) { send(res, 400, { error: failure(error).message, code: failure(error).code }); }
    finally { clearTimeout(timer); controllers.delete(controller); inFlight--; res.removeListener('close', disconnected); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  const streams = new ws.WebSocketServer({ noServer: true, maxPayload: BODY_LIMIT, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (!active || !trusted(req) || !authenticated(req) || req.url !== '/api/remote.mux' || streams.clients.size >= 16) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    streams.handleUpgrade(req, socket, head, client => streams.emit('connection', client));
  });
  streams.on('connection', client => {
    const pending = new Map(); let alive = true;
    client.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) return client.terminate(); alive = false; client.ping(); }, 15000); heartbeat.unref();
    function frame(value) {
      if (client.readyState !== ws.OPEN) return;
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > FRAME_LIMIT || client.bufferedAmount > FRAME_LIMIT) { client.close(1009, 'Collab stream requires smaller pages'); return; }
      client.send(body);
    }
    client.on('message', data => {
      let message;
      try { message = JSON.parse(String(data)); } catch { client.close(1008, 'Invalid Collab stream frame'); return; }
      const id = message?.streamId;
      if (typeof id !== 'string' || id.length > 200) { client.close(1008, 'Invalid stream id'); return; }
      if (message.type === 'cancel') { pending.get(id)?.abort(); return; }
      if (message.type !== 'open' || pending.has(id) || pending.size >= 16 || !STREAM_ENDPOINTS.has(message.endpoint)) {
        frame({ type: 'error', streamId: id, error: { code: 'COLLAB_STREAM_DENIED', message: 'Stream is not admitted' } }); return;
      }
      const controller = new AbortController(); pending.set(id, controller); controllers.add(controller);
      (async () => {
        try {
          const iterable = await adapter.stream(message.endpoint, message.payload, controller.signal);
          for await (const value of iterable) {
            if (controller.signal.aborted) break;
            frame({ type: 'item', streamId: id, value });
          }
          if (!controller.signal.aborted) frame({ type: 'end', streamId: id });
        } catch (error) { if (!controller.signal.aborted) frame({ type: 'error', streamId: id, error: failure(error) }); }
        finally { pending.delete(id); controllers.delete(controller); controller.abort(); }
      })();
    });
    client.on('error', () => client.terminate());
    client.on('close', () => { clearInterval(heartbeat); for (const c of pending.values()) c.abort(); pending.clear(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  // Later listener errors do not become uncaught Host exceptions.
  server.on('error', () => { active = false; });
  origin = `http://127.0.0.1:${server.address().port}/`;
  let closing;
  return { descriptor: { url: origin, launchUrl: `${origin}?token=${token}`, localControlApi: 2,
    transportGeneration: randomUUID() },
    async close() {
      if (closing) return closing;
      active = false;
      for (const c of controllers) c.abort();
      for (const client of streams.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      closing = Promise.all([new Promise(resolve => streams.close(resolve)), new Promise(resolve => server.close(resolve))]);
      await closing;
    } };
}
