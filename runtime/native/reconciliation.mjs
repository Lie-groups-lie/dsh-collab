import { TaskIndex } from '../core/task-index.mjs';
import { fingerprint } from '../core/schedules.mjs';
import { unresolved } from '../core/deadline.mjs';
import { reconciliationTool, inboxCounts, pendingInbox } from '../core/reconciliation.mjs';
import { validateInput } from '../core/schema.mjs';
import { recoveryEvidence } from '../core/recovery.mjs';
import { archiveAdmission, assertArchiveAdmission } from '../core/archive-admission.mjs';

export function mountReconciliation(ctx, store, background) {
  const index = new TaskIndex(store.directory);
  let queue = Promise.resolve();
  async function inspect(id) {
    const root = store.root(id);
    const records = index.list().filter(row => row.rootId === root.id).map(row => store.get(row.id));
    const rows = [], blockers = [];
    const native = (await ctx.sessionController.list({})).items;
    const admission = archiveAdmission(id, native, ctx.workspaceRegistry?.archivedSessionIds);
    if (admission.blocked) blockers.push({ ...admission, reason: 'native-session-archived' });
    const selected = new Set(records.map(row => row.id));
    let changed;
    do {
      changed = false;
      for (const row of native) if (selected.has(row.parentSessionId) && !selected.has(row.sessionId)) {
        selected.add(row.sessionId); changed = true;
      }
    } while (changed);
    for (const task of records) for (const final of Object.values(task.finalizations || {})) if (final.sessionId) selected.add(final.sessionId);
    for (const sessionId of [...selected].sort()) {
      const record = store.get(sessionId), listed = native.find(row => row.sessionId === sessionId);
      const agent = ctx.agents.get(sessionId);
      let evidence;
      try {
        const inspected = await ctx.sessionController.inspect(sessionId);
        const events = inspected.events;
        const counts = inboxCounts(events);
        const pending = Object.values(pendingInbox(events)).flat().map(message => ({ id: message.id,
          kind: message.source?.kind, senderSessionId: message.source?.senderSessionId }));
        const completedNoticesOnly = pending.every(message => {
          const child = message.senderSessionId && store.get(message.senderSessionId);
          return ['subagent-settled', 'subagent-report'].includes(message.kind) && child?.parentId === sessionId
            && child.dispatch?.state === 'settled' && !unresolved(child);
        });
        evidence = { throughSeq: events.at(-1)?.seq ?? -1, inbox: counts, pendingNotices: pending,
          lastTurnEnd: events.findLast(e => e.type === 'turn/end')?.data?.turn ?? null,
          ...(record?.policy ? recoveryEvidence(events, record, inspected.meta?.cwd || listed?.cwd || '') : {}) };
        if (Object.values(counts).some(Boolean)) blockers.push({ sessionId, reason: 'native-inbox-not-empty', recoverableNotices: completedNoticesOnly });
      } catch { blockers.push({ sessionId, reason: 'native-inspection-unavailable' }); }
      if (listed?.running || agent && agent.status !== 'idle') blockers.push({ sessionId, reason: 'native-agent-not-idle' });
      if (['pending', 'running'].includes(record?.dispatch?.state)
          || Object.values(record?.finalizations || {}).some(f => f.status === 'running')) {
        blockers.push({ sessionId, reason: 'live-dispatch-or-finalization' });
      }
      rows.push({ sessionId, revision: record?.revision ?? null, nativeRunning: Boolean(listed?.running),
        dispatch: record?.dispatch || null, unresolved: unresolved(record), ...evidence });
    }
    const plan = { rootId: root.id, sessions: rows, blockers, admission,
      reservationKeys: Object.keys(root.ledger.reservations).sort(),
      budgetRevision: root.revision, recoveryHolds: root.recoveryHolds || [] };
    return { ...plan, digest: fingerprint(plan), canRecover: blockers.every(b => b.recoverableNotices), canAbandon: blockers.length === 0,
      semantics: 'Recover interrupted execution without abandoning the task; preserve native history, completed children and budgets. Uncertain side effects require verification, never blind replay.' };
  }
  async function operation(args) {
    validateInput(args, reconciliationTool.inputSchema);
    if ((args.action || 'inspect') === 'inspect') return inspect(args.session_id);
    if (!args.expected_digest || !args.request_key || !args.reason) throw new Error('recover/abandon requires expected_digest, request_key and reason');
    if (args.action === 'recover') return recover(args);
    if (args.tool_resolutions?.length) throw new Error('tool_resolutions is only supported by recover');
    const id = `reconcile-${fingerprint([args.session_id, args.request_key])}`;
    let journal = store.get(id);
    if (journal && journal.fingerprint !== fingerprint(args)) throw new Error('Reconciliation key reused with different arguments');
    if (journal?.receipt) return { ...journal.receipt, replayed: true };
    const plan = await inspect(args.session_id);
    if (!plan.canAbandon) throw new Error(`Reconciliation blocked: ${plan.blockers.map(b => `${b.sessionId}:${b.reason}`).join(', ')}`);
    if (!journal && plan.digest !== args.expected_digest) throw new Error('Reconciliation evidence changed; inspect again before abandonment');
    if (journal) {
      const original = new Map(journal.originalPlan.sessions.map(row => [row.sessionId, row]));
      if (original.size !== plan.sessions.length || plan.reservationKeys.some(key => !journal.originalPlan.reservationKeys.includes(key))) {
        throw new Error('Task tree changed since interrupted reconciliation; no additional work will be abandoned');
      }
      for (const row of plan.sessions) {
        const prior = original.get(row.sessionId), record = store.get(row.sessionId);
        if (!prior || row.throughSeq !== prior.throughSeq || row.dispatch?.id !== prior.dispatch?.id
            || row.revision !== prior.revision && record?.reconciliation?.id !== journal.id) {
          throw new Error('Task changed since interrupted reconciliation; explicit inspection is required');
        }
      }
    }
    // After the await boundary recheck live owners and revisions synchronously.
    for (const row of plan.sessions) {
      const agent = ctx.agents.get(row.sessionId);
      if (agent && agent.status !== 'idle' || (store.get(row.sessionId)?.revision ?? null) !== row.revision) {
        throw new Error('Task changed during inspection; reconciliation refused');
      }
    }
    if (!journal) journal = store.put({ id, role: 'reconciliation', fingerprint: fingerprint(args), state: 'committing',
      originalPlan: plan, reason: args.reason, createdAt: Date.now() });
    for (const row of plan.sessions) {
      const record = store.get(row.sessionId);
      if (!record?.policy || !unresolved(record)) continue;
      const finalizations = Object.fromEntries(Object.entries(record.finalizations || {}).map(([turn, f]) =>
        [turn, f.status === 'unknown' ? { ...f, status: 'abandoned', previousStatus: f.status } : f]));
      store.update(record.id, { lease: 'closed', finalizations,
        dispatch: { ...record.dispatch, state: 'settled', outcome: 'abandoned' },
        completion: { state: 'abandoned', reason: args.reason },
        reconciliation: { id, at: Date.now(), previousDispatch: record.dispatch, previousCompletion: record.completion || null,
          evidenceDigest: args.expected_digest } });
    }
    // Entire shared-budget tree was checked. Missing usage is never refunded.
    for (const key of Object.keys(store.root(args.session_id).ledger.reservations)) store.settle(args.session_id, key, null);
    const receipt = { reconciliationId: id, rootId: plan.rootId, state: 'settled', outcome: 'abandoned',
      sessions: plan.sessions.filter(row => row.unresolved).map(row => row.sessionId),
      nativeEventsChanged: false, modelCalls: 0, replayedWrites: 0, budgetsReset: false };
    store.put({ ...journal, state: 'committed', receipt });
    return receipt;
  }
  const serial = fn => {
    const job = queue.then(fn);
    queue = job.catch(() => {});
    return job;
  };
  async function recover(args) {
    const id = `recovery-${fingerprint([args.session_id, args.request_key])}`;
    let journal = store.get(id);
    if (journal && journal.fingerprint !== fingerprint(args)) throw new Error('Recovery key reused with different arguments');
    if (journal?.receipt) return { ...journal.receipt, replayed: true };
    const plan = await inspect(args.session_id);
    if (!plan.canRecover) throw new Error(`Recovery blocked: ${plan.blockers.map(b => `${b.sessionId}:${b.reason}`).join(', ')}`);
    if (!journal && plan.digest !== args.expected_digest) throw new Error('Recovery evidence changed; inspect again');
    if (journal) {
      const prior = new Map(journal.originalPlan.sessions.map(row => [row.sessionId, row]));
      if (prior.size !== plan.sessions.length || plan.reservationKeys.some(key => !journal.originalPlan.reservationKeys.includes(key))) throw new Error('Task tree changed during interrupted recovery');
      for (const row of plan.sessions) {
        const old = prior.get(row.sessionId), record = store.get(row.sessionId);
        if (!old || old.throughSeq !== row.throughSeq || old.dispatch?.id !== row.dispatch?.id
          || old.revision !== row.revision && record?.recovery?.id !== id) throw new Error('Task changed during interrupted recovery');
      }
    }
    const original = journal?.originalPlan || plan;
    const uncertainTools = original.sessions.filter(row => row.unresolved).flatMap(row => row.uncertainTools || []);
    const holdMap = new Map([...uncertainTools.filter(t => !t.readOnly), ...(store.root(args.session_id).recoveryHolds || [])]
      .map(hold => [`${hold.sessionId}:${hold.callId}`, hold]));
    for (const resolution of args.tool_resolutions || []) {
      const key = `${resolution.session_id}:${resolution.call_id}`, hold = holdMap.get(key);
      if (!hold) throw new Error('Resolution does not match an uncertain side effect');
      holdMap.set(key, { ...hold, resolution: { outcome: resolution.outcome, evidence: resolution.evidence, at: Date.now() } });
    }
    // No await from the last revision check through commit. Journals retain old
    // receipts/usage and make a process interruption during recovery resumable.
    for (const row of plan.sessions) if ((store.get(row.sessionId)?.revision ?? null) !== row.revision
      || ctx.agents.get(row.sessionId) && ctx.agents.get(row.sessionId).status !== 'idle') throw new Error('Task changed during recovery inspection');
    if (!journal) journal = store.put({ id, role: 'recovery', fingerprint: fingerprint(args), arguments: args, state: 'committing',
      originalPlan: plan, originalRecords: plan.sessions.filter(row => row.unresolved).map(row => store.get(row.sessionId)),
      originalLedger: store.root(args.session_id).ledger, reason: args.reason, createdAt: Date.now() });
    const preservedSessions = original.sessions.filter(row => !row.unresolved && row.dispatch?.state === 'settled').map(row => row.sessionId);
    for (const row of original.sessions.filter(row => row.unresolved)) {
      const record = store.get(row.sessionId);
      if (!record?.policy || record.recovery?.id === id) continue;
      store.update(record.id, { lease: 'closed', lastTurn: Math.max(record.lastTurn || 0, row.lastTurn || 0),
        dispatch: { ...record.dispatch, state: 'settled', outcome: 'interrupted', nativeOutcome: row.nativeOutcome },
        completion: { state: 'interrupted', reason: 'Recovered interrupted execution; existing results preserved, no replay' },
        finalizations: Object.fromEntries(Object.entries(record.finalizations || {}).map(([turn, value]) => [turn,
          value.status === 'unknown' ? { ...value, status: 'interrupted' } : value])),
        recovery: { id, state: 'ready', at: Date.now(), previousDispatch: record.dispatch, preservedSessions, uncertainTools } });
    }
    const root = store.root(args.session_id);
    store.update(root.id, { recoveryHolds: [...holdMap.values()],
      recovery: { ...root.recovery, id, state: 'ready', preservedSessions, uncertainTools } });
    for (const key of original.reservationKeys) store.settle(args.session_id, key, null);
    const receipt = { reconciliationId: id, rootId: original.rootId, state: 'ready', outcome: 'recovered-interruption',
      sessions: original.sessions.filter(row => row.unresolved).map(row => row.sessionId), preservedSessions, uncertainTools,
      unresolvedSideEffects: [...holdMap.values()].filter(hold => !hold.resolution),
      nativeEventsChanged: false, modelCalls: 0, replayedWrites: 0, budgetsReset: false,
      usageNote: 'Prior reported usage is unchanged. Missing in-flight usage is separately auditable and conservatively reserved, not a provider billing claim.' };
    store.put({ ...journal, state: 'committed', receipt });
    return receipt;
  }
  background.registerOperation(reconciliationTool.name, args => serial(() => operation(args)));
  return {
    continuation: (id, admit) => serial(async () => {
      const native = (await ctx.sessionController.list({})).items;
      assertArchiveAdmission(archiveAdmission(id, native, ctx.workspaceRegistry?.archivedSessionIds));
      const record = store.get(id);
      if (record?.recovery?.state === 'ready') {
        const journal = store.get(record.recovery.id);
        if (!journal) throw new Error('Recovery journal is unavailable; inspect the task before continuing');
        if (journal.receipt) {
          const current = await inspect(id);
          if (!current.canRecover || current.sessions.some(row => row.unresolved)) throw new Error('Task changed after recovery preparation; inspect current work before continuing');
        }
        return admit(journal.receipt || await recover(journal.arguments));
      }
      if (!record || !unresolved(record) || record.dispatch?.state !== 'unknown' && record.completion?.state !== 'unknown') return admit(null);
      const plan = await inspect(id);
      const requestKey = `continue-${record.dispatch?.id || record.dispatch?.turn || plan.digest}`;
      const journal = store.get(`recovery-${fingerprint([id, requestKey])}`);
      const receipt = await recover(journal?.arguments || { session_id: id, action: 'recover', expected_digest: plan.digest,
        request_key: requestKey, reason: 'Explicit continuation of the same interrupted task; preserve completed work' });
      return admit(receipt);
    }),
  };
}
