// All callers converge on the public Gateway and the existing policy services.
// No HTTP, browser cookie, Electron capability or separate session database.
export const RPC_ENDPOINTS = new Set([
  'session/list', 'session/modelCatalog', 'session/create', 'session/rename',
  'session/selectModel', 'session/cancel', 'session/projections', 'session/page',
  'agentPresets/list', 'agentPresets/select', 'workspace/create', 'workspace/archiveSession', 'workspace/unarchiveSession',
  'subagents/interruptByParent', 'commands/execute',
]);
export const STREAM_ENDPOINTS = new Set(['workspace/follow', 'session/follow']);
const COMMANDS = new Set(['permission', 'codex-subagent', 'codex-subagent-followup',
  'codex-lead-open', 'codex-lead-close', 'codex-lead-policy']);

export function checkRpc(endpoint, args) {
  if (!RPC_ENDPOINTS.has(endpoint)) throw Object.assign(new Error('Collab endpoint is not admitted'), { code: 'COLLAB_ENDPOINT_DENIED' });
  if (endpoint === 'commands/execute' && !COMMANDS.has(/^\/([^\s]+)/.exec(args?.line || '')?.[1])) {
    throw Object.assign(new Error('Collab command is not admitted'), { code: 'COLLAB_COMMAND_DENIED' });
  }
}

export function createNativeTransport(ctx, background) {
  const connection = ctx.connection, gateway = ctx.typertGateway;
  if (!connection?.createPeer || !gateway?.invoke || !gateway?.wireStream?.open) {
    throw Object.assign(new Error('This DSH lacks the public native transport API required by Collab'), { code: 'DSH_NATIVE_API_UNAVAILABLE' });
  }
  // Installation authorizes a local operator adapter. No synthetic model Peer,
  // no approval answerer: native agent tool/permission guards remain unchanged.
  const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  const empty = { async *[Symbol.asyncIterator]() {} };
  return {
    rpc(endpoint, args, signal) {
      checkRpc(endpoint, args);
      const [namespace, method] = endpoint.split('/');
      return gateway.invoke({ namespace, method, args, peer, signal });
    },
    async stream(endpoint, payload, signal) {
      if (!STREAM_ENDPOINTS.has(endpoint)) throw Object.assign(new Error('Collab stream is not admitted'), { code: 'COLLAB_ENDPOINT_DENIED' });
      return gateway.wireStream.open(endpoint, payload, empty, peer, signal);
    },
    async first(endpoint, args, signal) {
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        const iterable = await this.stream(endpoint, { args }, combined);
        for await (const value of iterable) { controller.abort(); return value; }
        throw new Error('DSH native stream ended without a snapshot');
      } finally { controller.abort(); }
    },
    background(operation, args, signal) {
      signal?.throwIfAborted();
      return background.invoke(operation, args);
    },
  };
}
