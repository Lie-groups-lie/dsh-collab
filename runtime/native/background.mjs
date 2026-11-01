import { BackgroundReports } from '../core/notifications.mjs';
import { ResultStore } from '../core/result-store.mjs';
import { TaskIndex } from '../core/task-index.mjs';

// Lives in the existing DSH process. No shell, extra Node window or model poll.
export function mountBackground(ctx, taskStore, runtime) {
  const results = new ResultStore(taskStore.directory);
  const index = new TaskIndex(taskStore.directory);
  let inventory, previews = new Map(), budgets = new Map();
  const reports = new BackgroundReports({ directory: taskStore.directory, prepareSnapshot() {
    inventory = null; previews = new Map(); budgets = new Map();
  }, snapshot(ids) {
    const records = inventory ||= index.list();
    for (const id of ids) if (!records.some(r => r.id === id)) throw new Error('Watch target is not a managed task');
    const selected = new Set(ids);
    let changed;
    do { changed = false; for (const r of records) if (selected.has(r.parentId) && !selected.has(r.id)) { selected.add(r.id); changed = true; } } while (changed);
    const tasks = records.filter(r => selected.has(r.id)).map(r => {
      const finals = Object.values(r.finalizations || {});
      const state = finals.some(f => f.status === 'unknown') ? 'unknown' : finals.some(f => f.status === 'running') ? 'finalizing' : r.dispatch?.state || 'unknown';
      return { sessionId: r.id, parentId: r.parentId, state, turn: r.lastTurn || 0 };
    });
    const displayed = tasks.slice(0, 32).map(task => {
      const key = `${task.sessionId}:${task.turn}`;
      if (!previews.has(key)) {
        const result = task.turn ? results.get(task.sessionId, task.turn) : null;
        previews.set(key, { visiblePreview: result?.text?.slice(0, 500) || '', resultTruncated: result?.truncated || false });
      }
      return { ...task, ...previews.get(key) };
    });
    const roots = [...new Set(records.filter(r => selected.has(r.id)).map(r => r.rootId))].slice(0, 32).map(id => {
      if (budgets.has(id)) return budgets.get(id);
      const r = taskStore.root(id), { reservations, settled, ...usage } = r.ledger;
      const budget = { rootId: id, usage, inFlightRequests: Object.keys(reservations).length };
      budgets.set(id, budget); return budget;
    });
    return { settled: tasks.every(t => t.state === 'settled'), tasks: displayed, tasksTruncated: tasks.length > 32, budgets: roots };
  } });
  const jobs = new Map(), operations = new Map(); let ticking = false, stopped = false;
  const service = { reports, runtime, invoke(operation, args = {}) {
    return operations.has(operation) ? operations.get(operation)(args) : reports.operation(operation, args);
  }, registerOperation(name, operation) {
    if (operations.has(name)) throw new Error('Background operation already registered');
    operations.set(name, operation);
    return () => operations.delete(name);
  }, register(name, job, operation) {
    if (jobs.has(name)) throw new Error('Background extension already registered');
    jobs.set(name, job); if (operation) operations.set(name, operation);
    return () => { jobs.delete(name); operations.delete(name); };
  } };
  ctx.provide('dshCollabBackground', service);
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-collab-background', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try {
      if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response('JSON required', { status: 415 });
      const body = await request.text(); if (body.length > 65536) return new Response('Too large', { status: 413 });
      const payload = JSON.parse(body);
      if (!payload || Object.keys(payload).some(k => !['operation', 'arguments'].includes(k))) throw new Error('Invalid background request');
      const value = await service.invoke(payload.operation, payload.arguments || {});
      return Response.json(value, { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return Response.json({ error: String(error.message).slice(0, 1000) }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
  } }));
  ctx.effect(() => {
    const tick = async () => {
      if (stopped) return;
      try { reports.tick(); }
      catch (error) { ctx.logger?.warn?.('Collab report check failed: %s', error.message); }
      // Extension work must not delay ordinary report delivery.
      if (ticking) return; ticking = true;
      try { for (const job of jobs.values()) { if (stopped) break; await job(); } }
      catch (error) { ctx.logger?.warn?.('Collab background check failed; no request replayed: %s', error.message); }
      finally { ticking = false; }
    };
    const timer = setInterval(tick, 2000); timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
  });
  return service;
}
