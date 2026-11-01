// Browser operations use the same validated task facade as MCP. No new task engine.
import { callTool } from '../service/index.mjs';

export const UI_OPERATIONS = new Set(['deepseek_tasks_list', 'deepseek_task_result',
  'deepseek_task_trace', 'deepseek_task_tree',
  'deepseek_flash_status', 'deepseek_task_cancel', 'deepseek_session_archive',
  'deepseek_watch', 'deepseek_notifications', 'deepseek_task_reconcile',
  'deepseek_schedule_list', 'deepseek_schedule_history']);

export async function browserOperation(payload, runtime, signal, invoke = callTool) {
  if (!payload || Object.keys(payload).some((key) => !['operation', 'arguments'].includes(key))
      || !UI_OPERATIONS.has(payload.operation)) throw new Error('Unsupported collaboration UI operation');
  return invoke(payload.operation, payload.arguments || {}, { runtime, signal });
}

export function mountBrowserApi(ctx, runtime) {
  // Connection admits owner Peers and applies the official Host/Origin and auth fence.
  // Never mount an unauthenticated webServer route or expose launch credentials.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-collab', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response('JSON required', { status: 415 });
        const text = await request.text();
        if (text.length > 16384) return new Response('Request too large', { status: 413 });
        const value = await browserOperation(JSON.parse(text), runtime(), request.signal);
        return Response.json(value, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return Response.json({ error: error.message }, { status: 400, headers: { 'cache-control': 'no-store' } });
      }
    },
  }));
}
