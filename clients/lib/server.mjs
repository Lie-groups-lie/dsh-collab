import readline from 'node:readline';
import fs from 'node:fs';
import { callRemote } from './client.mjs';
import { toolText } from './presentation.mjs';
import { hostTools, hostArguments } from './host-contract.mjs';
import { receiptView, progressView } from './receipt-view.mjs';

// Optional smaller host tool surface for everyday task flow. Default stays
// 'full' for compatibility. 'core' keeps dispatch, continuation, waiting,
// results, cancellation, recovery and archive/restore; it hides scheduling,
// notifications, policy updates and legacy per-kind status/stop tools.
export const DAILY_TOOLS = new Set(['deepseek_runtime_status', 'deepseek_flash', 'deepseek_lead', 'deepseek_lead_list',
  'deepseek_lead_status', 'deepseek_tasks_start', 'deepseek_tasks_wait', 'deepseek_tasks_list', 'deepseek_task_result',
  'deepseek_task_tree', 'deepseek_task_trace', 'deepseek_task_cancel', 'deepseek_task_reconcile',
  'deepseek_session_archive', 'deepseek_capabilities']);
export function toolProfile(raw = process.env.DSH_COLLAB_TOOL_PROFILE) {
  const value = String(raw ?? 'full').trim().toLowerCase() || 'full';
  if (value === 'full' || value === 'core') return { profile: value, ignored: null };
  return { profile: 'full', ignored: String(raw) };
}
export function selectTools(tools, profile = toolProfile().profile) {
  return profile === 'core' ? tools.filter(tool => DAILY_TOOLS.has(tool.name)) : tools;
}
export function startServer(allTools, manifest, { input = process.stdin, output = process.stdout, diagnostic = process.stderr, remote = callRemote } = {}) {
const { profile, ignored } = toolProfile();
if (ignored !== null) diagnostic.write(`dsh-collab: unknown DSH_COLLAB_TOOL_PROFILE ${JSON.stringify(ignored)}; using full.\n`);
const tools = selectTools(hostTools(allTools), profile);
let build = null;
try { const value = JSON.parse(fs.readFileSync(new URL('../build.json', import.meta.url), 'utf8'));
  build = { buildId: value.buildId, sourceDigest: value.sourceDigest, packageDigest: value.packageDigest };
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const active = new Map();
let transportClosed = false;
const lines = readline.createInterface({ input, crlfDelay: Infinity });
const stopObserving = () => { for (const controller of active.values()) controller.abort(); };
// Never log the raw exception, request or response: they can contain task text or credentials.
const report = code => { try { diagnostic.write(`${code}: inspect the original receipt; no task was replayed or cancelled.\n`); } catch {} };
const transportFailure = () => {
  if (transportClosed) return;
  transportClosed = true; report('DSH_MCP_OUTPUT_CLOSED');
  stopObserving(); lines.close();
};
output.on('error', transportFailure);
output.on('close', transportFailure);
const send = value => {
  if (transportClosed) return;
  if (output.destroyed || output.writableEnded) { transportFailure(); return; }
  const line = JSON.stringify(value) + '\n';
  try { output.write(line, error => { if (error) transportFailure(); }); }
  catch { transportFailure(); }
};
async function handle(message) {
  if (message?.jsonrpc !== '2.0') return;
  if (message.method === 'notifications/cancelled') { active.get(message.params?.requestId)?.abort(); return; }
  if (message.id === undefined) return;
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: manifest.name, version: manifest.version } });
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools });
  if (message.method !== 'tools/call') return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  if (active.has(message.id)) return send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Duplicate request id' } });
  const controller = new AbortController(); active.set(message.id, controller);
  try {
    if (!tools.some(t => t.name === message.params?.name)) {
      const hidden = allTools.some(t => t.name === message.params?.name);
      const error = new Error(hidden
        ? `${message.params.name} is hidden by DSH_COLLAB_TOOL_PROFILE=core. Set it to full and reconnect this MCP server; core has no substitute for this tool.`
        : 'Unknown tool');
      if (hidden) error.code = 'DSH_TOOL_HIDDEN_BY_PROFILE';
      throw error;
    }
    let progress = 0;
    let lastProgress;
    const token = message.params?._meta?.progressToken;
    const request = hostArguments(allTools.find(tool => tool.name === message.params.name), message.params.arguments || {});
    const value = await remote(message.params.name, request.arguments, {
      signal: controller.signal,
      onProgress: token === undefined ? undefined : value => {
        const message = JSON.stringify(progressView(value, request.detail));
        if (message === lastProgress) return;
        lastProgress = message;
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message } });
      },
    });
    if (message.params.name === 'deepseek_runtime_status') value.client = { name: manifest.name, version: manifest.version, build, toolProfile: profile, hiddenTools: allTools.length - tools.length };
    const presented = receiptView(message.params.name, value, request.arguments, request.detail, request.previousRevision);
    reply({ content: [{ type: 'text', text: toolText(message.params.name, presented) }], structuredContent: presented });
  } catch (error) { reply({ content: [{ type: 'text', text: error.message }], isError: true,
    ...(error.code ? { structuredContent: { code: error.code,
      ...(error.compatibility ? { compatibility: error.compatibility } : {}),
      ...(error.runtimeDiagnostic ? { runtimeDiagnostic: error.runtimeDiagnostic } : {}) } } : {}) }); }
  finally { active.delete(message.id); }
}
lines.on('line', line => {
  if (transportClosed) return;
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > 2 * 1024 * 1024) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
  let message;
  try { message = JSON.parse(line); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
  void handle(message).catch(() => {
    report('DSH_MCP_RESPONSE_FAILED');
    send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: 'Response could not be encoded; inspect the original receipt before resubmitting.' } });
  });
});
lines.on('close', stopObserving);

return { close: () => lines.close() };
}
