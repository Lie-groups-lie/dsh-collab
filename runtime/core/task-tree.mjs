import { archiveAdmission } from './archive-admission.mjs';
// Durable lineage is independent of the live Agent ownership tree. Never load
// a cold Agent to draw a tree. Missing/native-only parents remain explicit.
export function taskTree(records, sessions, selectedId, archived = new Set()) {
  const rows = new Map(records.map(row => [row.id, row]));
  const selected = rows.get(selectedId);
  if (!selected) throw new Error('Target is not a managed task');
  const rootId = selected.rootId || selected.id;
  const native = new Map(sessions.map(row => [row.sessionId, row]));
  const members = records.filter(row => (row.rootId || row.id) === rootId);
  const nodes = members.map(row => {
    const current = native.get(row.id), submission = row.dispatch || null;
    const rawOutcome = submission?.outcome || row.completion?.reason;
    const outcome = rawOutcome?.kind || rawOutcome;
    const state = current?.running ? 'running' : !current ? 'unavailable'
      : submission?.state === 'settled' ? (outcome === 'completed' ? 'completed' : outcome || 'settled')
        : submission?.state || 'unknown';
    return { sessionId: row.id, rootId, parentSessionId: row.parentId || '',
      nativeParentSessionId: current?.parentSessionId || '', role: row.role,
      title: current?.projections?.values?.title || current?.title || row.title || row.id,
      cwd: current?.cwd || '', archived: archived.has(row.id), admission: archiveAdmission(row.id, native, archived), running: current?.running ?? null,
      state, submission, turn: submission?.turn ?? row.lastTurn ?? null,
      recovery: row.recovery || null, revision: row.revision,
      parentAvailable: !row.parentId || rows.has(row.parentId), nativeAvailable: Boolean(current) };
  });
  const ids = new Set(nodes.map(n => n.sessionId));
  const edges = nodes.filter(n => n.parentSessionId).map(n => ({ parent: n.parentSessionId, child: n.sessionId,
    kind: 'durable-parent', external: !ids.has(n.parentSessionId) }));
  const warnings = [];
  if (!ids.has(rootId)) warnings.push({ code: 'ROOT_MISSING', sessionId: rootId });
  for (const node of nodes) {
    const seen = new Set([node.sessionId]); let parent = node.parentSessionId;
    while (parent && ids.has(parent)) {
      if (seen.has(parent)) { warnings.push({ code: 'LINEAGE_CYCLE', sessionId: node.sessionId }); break; }
      seen.add(parent); parent = rows.get(parent)?.parentId;
    }
    if (!node.nativeAvailable) warnings.push({ code: 'NATIVE_SESSION_UNAVAILABLE', sessionId: node.sessionId });
  }
  return { rootId, selectedId, observedAt: Date.now(), nodes, edges, warnings,
    summary: { total: nodes.length, running: nodes.filter(n => n.running === true).length,
      unresolved: nodes.filter(n => n.submission?.state !== 'settled').length,
      settled: nodes.filter(n => n.submission?.state === 'settled').length },
    historySource: 'durable-task-index', wakesAgents: false };
}
