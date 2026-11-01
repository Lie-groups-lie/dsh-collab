const { randomUUID } = require('node:crypto');
const Socket = require('../vendor/ws');
const { RemoteMux } = require('./remote-mux.cjs');
const { connected } = require('../runtime/connection.cjs');
const cookies = new Map();
const muxes = new Map();
// Process-local binding, never serialized into discovery files or MCP results.
// Native consumers reuse the official Host services, not the browser listener.
const nativeAdapters = new WeakMap();
function bindNative(runtime, adapter) {
  nativeAdapters.set(runtime, adapter);
  return () => nativeAdapters.delete(runtime);
}

async function authCookie(runtime) {
  const key = runtime.launchUrl || runtime.url;
  if (cookies.has(key)) return cookies.get(key);
  if (!runtime.launchUrl || !new URL(runtime.launchUrl).searchParams.has('token')) {
    throw new Error('新版 DSH 缺少认证启动凭据，请从新版 EXE 重新启动 runtime。');
  }
  const exchange = (async () => {
    const response = await fetch(runtime.launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    if (response.status !== 303 || !cookie) {
      const error = new Error(`[DSH_RUNTIME_AUTH] DSH 启动认证失败（HTTP ${response.status}）；未自动重发任务。请核对当前实例连接记录。`);
      error.code = 'DSH_RUNTIME_AUTH'; throw error;
    }
    return cookie;
  })();
  cookies.set(key, exchange);
  try { return await exchange; } catch (error) { cookies.delete(key); throw error; }
}

function modernRuntime(runtime) {
  return /^0\.(?:[2-9]|\d{2,})\./.test(runtime.dshVersion || runtime.version || '');
}

function wireRequest(method, payload) {
  if (method === 'commands/execute') return { endpoint: method, payload: {
    agentId: payload.agentId, line: payload.line, submittedAttachments: payload.submittedAttachments || payload.images || [],
  } };
  if (method === 'session.list') return { endpoint: 'session/list', payload: { _request: payload } };
  if (method === 'session.models') return { endpoint: 'session/modelCatalog', payload: {} };
  if (method === 'agentPreset.list') return { endpoint: 'agentPresets/list', payload: {} };
  if (method === 'agentPreset.select') return { endpoint: 'agentPresets/select', payload: {
    agentId: payload.sessionId, agentPreset: payload.agentPreset,
  } };
  if (method === 'subagent.interrupt') return { endpoint: 'subagents/interruptByParent', payload };
  if (method === 'settings.update') return { endpoint: 'settings/update', payload };
  if (method.includes('/')) return { endpoint: method, payload };
  return { endpoint: method.replace('.', '/'), payload: { request: {
    ...payload, ...(method === 'session.prompt' && !payload.requestId ? { requestId: randomUUID() } : {}),
  } } };
}

async function rpc(runtime, endpoint, payload, timeoutMs = 20000) {
  const native = nativeAdapters.get(runtime);
  if (native) return native.rpc(endpoint, payload, AbortSignal.timeout(timeoutMs));
  const cookie = await authCookie(runtime);
  const rpcId = `desktop-${randomUUID()}`;
  const response = await fetch(new URL(`/api/${endpoint}`, runtime.url), {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: payload } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      cookies.delete(runtime.launchUrl || runtime.url);
      const error = new Error(`[DSH_RUNTIME_AUTH] DSH 请求认证失败（HTTP ${response.status}）；未自动重发任务。`);
      error.code = 'DSH_RUNTIME_AUTH'; throw error;
    }
    throw new Error(`${endpoint}: HTTP ${response.status}`);
  }
  const message = await response.json();
  if (message.rpcId !== rpcId) throw new Error(`${endpoint}: rpcId mismatch`);
  if (!message.result?.ok) {
    const error = new Error(message.result?.error?.message || `${endpoint} failed`);
    error.code = message.result?.error?.code;
    throw error;
  }
  return message.result.value;
}

async function firstStreamValue(runtime, endpoint, payload, timeoutMs = 20000) {
  const native = nativeAdapters.get(runtime);
  if (native) return native.first(endpoint, payload, AbortSignal.timeout(timeoutMs));
  const cookie = await authCookie(runtime);
  const key = runtime.launchUrl || runtime.url;
  let mux = muxes.get(key);
  if (!mux || mux.socket.readyState >= 2) {
    const url = new URL('/api/remote.mux', runtime.url);
    url.protocol = 'ws:';
    mux = new RemoteMux(Socket, url, cookie, () => { if (muxes.get(key) === mux) muxes.delete(key); });
    muxes.set(key, mux);
  }
  return mux.first(endpoint, payload, timeoutMs);
}

async function request(runtime, method, payload = {}, timeoutMs = 20000) {
  if (method === 'workspace.list') {
    const baseline = await firstStreamValue(runtime, 'workspace/follow', {}, timeoutMs);
    return baseline.value;
  }
  if (method === 'session.history' || method === 'session.trace') {
    const session = payload.session || (await request(runtime, 'session.list', {}, timeoutMs)).items.find((item) => item.sessionId === payload.sessionId);
    if (!session) throw new Error(`DSH session not found: ${payload.sessionId}`);
    const parentSessionId = payload.parentSessionId || session.parentSessionId;
    const address = parentSessionId
      ? { kind: 'subagent', parentSessionId, childSessionId: payload.sessionId, mode: 'continuable' }
      : { kind: 'session', sessionId: payload.sessionId };
    if (method !== 'session.trace' && session.running && payload.beforeSeq === undefined) {
      const snapshot = await firstStreamValue(runtime, 'session/follow', { request: {
        address, maxMessages: payload.maxMessages || 4, assistantStream: true,
        turnWindow: { minMessages: 1, minTurns: 1 },
      } }, timeoutMs);
      const active = snapshot.assistantStream?.activeAttempt;
      return { ...snapshot, events: [...(snapshot.records || []), ...(active ? [{ event: {
        type: 'assistant/attempt', seq: snapshot.cursor + 1, time: Date.now(),
        data: { turn: active.turn, step: active.step, stream: active.stream },
      } }] : [])] };
    }
    // Projection/page reads do not activate a cold Agent or replay its inbox.
    const projections = parentSessionId ? session.projections
      : await rpc(runtime, 'session/projections', { request: { sessionId: payload.sessionId } }, timeoutMs);
    if (projections?.kind === 'migration-required') throw new Error('旧会话需要由 DSH 原生界面执行迁移后才能读取。');
    const page = await rpc(runtime, 'session/page', { request: {
      address, throughSeq: payload.throughSeq ?? projections?.asOfSeq ?? -1, maxMessages: payload.maxMessages || 4,
      ...(payload.beforeSeq === undefined ? {} : { beforeSeq: payload.beforeSeq }),
      turnWindow: { minMessages: 1, minTurns: 1 },
    } }, timeoutMs);
    return { events: page.records, projections, hasMore: page.hasMore, throughSeq: payload.throughSeq ?? projections?.asOfSeq ?? -1 };
  }
  const wire = wireRequest(method, payload);
  const result = await rpc(runtime, wire.endpoint, wire.payload, timeoutMs);
  if (method === 'session.list') return { ...result, items: (result.items || []).map((item) => ({
    ...item, agentPreset: item.projections?.values?.agentPreset || item.agentPreset || '',
  })) };
  return result;
}

async function backgroundRequest(runtime, operation, args, signal) {
  const native = nativeAdapters.get(runtime);
  if (native) return native.background(operation, args, signal);
  const cookie = await authCookie(runtime);
  const response = await fetch(new URL('/api/dsh-collab-background', runtime.url), {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ operation, arguments: args }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = typeof body?.error === 'string' ? body.error.slice(0, 1000) : 'check matching native extensions';
    throw new Error(`Background service HTTP ${response.status}: ${detail} (no automatic replay)`);
  }
  const result = await response.json(); return result;
}
const readMethods = new Set(['session.list', 'session.models', 'agentPreset.list', 'workspace.list',
  'session.history', 'session.trace', 'session/projections', 'session/page']);
const readOperations = new Set(['deepseek_runtime_status', 'deepseek_capabilities', 'deepseek_schedule_list',
  'deepseek_schedule_history', 'deepseek_notifications']);
module.exports = { modernRuntime, wireRequest, bindNative,
  request: (runtime, method, ...args) => connected(runtime, readMethods.has(method), () => request(runtime, method, ...args)),
  firstStreamValue: (runtime, ...args) => connected(runtime, true, () => firstStreamValue(runtime, ...args)),
  backgroundRequest: (runtime, operation, args, signal) => connected(runtime,
    readOperations.has(operation) || operation === 'deepseek_task_reconcile' && (!args.action || args.action === 'inspect'),
    () => backgroundRequest(runtime, operation, args, signal)),
};
