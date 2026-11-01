import readline from 'node:readline';
import fs from 'node:fs';
import { callRemote } from './client.mjs';
import { toolText } from './presentation.mjs';

export function startServer(tools, manifest) {
let build = null;
try { const value = JSON.parse(fs.readFileSync(new URL('../build.json', import.meta.url), 'utf8'));
  build = { buildId: value.buildId, sourceDigest: value.sourceDigest, packageDigest: value.packageDigest };
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const active = new Map();
const send = value => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + '\n'); };
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
    if (!tools.some(t => t.name === message.params?.name)) throw new Error('Unknown tool');
    let progress = 0;
    const token = message.params?._meta?.progressToken;
    const value = await callRemote(message.params.name, message.params.arguments || {}, {
      signal: controller.signal,
      onProgress: token === undefined ? undefined : value => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: JSON.stringify(value) } }),
    });
    if (message.params.name === 'deepseek_runtime_status') value.client = { name: manifest.name, version: manifest.version, build };
    reply({ content: [{ type: 'text', text: toolText(message.params.name, value) }], structuredContent: value });
  } catch (error) { reply({ content: [{ type: 'text', text: error.message }], isError: true,
    ...(error.code ? { structuredContent: { code: error.code,
      ...(error.compatibility ? { compatibility: error.compatibility } : {}),
      ...(error.runtimeDiagnostic ? { runtimeDiagnostic: error.runtimeDiagnostic } : {}) } } : {}) }); }
  finally { active.delete(message.id); }
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > 2 * 1024 * 1024) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
  try { void handle(JSON.parse(line)).catch(() => {}); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); }
});
lines.on('close', () => { for (const controller of active.values()) controller.abort(); });

return { close: () => lines.close() };
}
