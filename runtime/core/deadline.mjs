// A child policy with no local duration does not erase the shared root deadline.
// Scheduled dispatch windows are additional ceilings, never a budget reset.
export function deadlineFor(store, id) {
  const root = store.root(id), limits = [];
  if (root.policy?.maxDurationSeconds != null) limits.push({
    source: 'shared-budget', sessionId: root.id,
    at: root.createdAt + root.policy.maxDurationSeconds * 1000,
  });
  const seen = new Set();
  let task = store.get(id);
  while (task && !seen.has(task.id)) {
    seen.add(task.id);
    if (Number.isFinite(task.dispatch?.deadlineAt)) limits.push({
      source: 'schedule-window', sessionId: task.id, at: task.dispatch.deadlineAt,
    });
    task = task.parentId ? store.get(task.parentId) : null;
  }
  limits.sort((a, b) => a.at - b.at);
  return { rootId: root.id, rootCreatedAt: root.createdAt, at: limits[0]?.at ?? null,
    iso: limits.length ? new Date(limits[0].at).toISOString() : null, limits };
}

export function assertDeadline(store, id, now = Date.now()) {
  const deadline = deadlineFor(store, id);
  if (deadline.at !== null && now >= deadline.at) throw new Error('Task deadline exhausted (shared budget or scheduled execution window)');
  return deadline;
}

export function unresolved(record) {
  return ['pending', 'running', 'unknown'].includes(record?.dispatch?.state)
    || Object.values(record?.finalizations || {}).some(item => ['running', 'unknown'].includes(item.status))
    || ['unknown', 'continuing'].includes(record?.completion?.state);
}
