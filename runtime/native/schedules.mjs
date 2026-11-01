import { randomUUID } from 'node:crypto';
import { ScheduleStore, fingerprint, nativeOccurrences, schedulePrompt, scheduleTools, timing, windowPolicy, occurrenceWindow } from '../core/schedules.mjs';
import { validateInput } from '../core/schema.mjs';

// Native DSH owns time, persistence and delivery. This adapter only owns admission
// and its audit; it never polls a model or installs a second scheduling timer.
export function mountSchedules(ctx, tasks, background, admitLead) {
  const store = new ScheduleStore(tasks.directory);
  store.recover();
  const leads = new Set(store.list().map(record => record.leadId));
  const previous = new Map();
  let chain = Promise.resolve();
  const serialize = work => { const job = chain.then(work, work); chain = job.catch(() => {}); return job; };
  const service = () => {
    if (!ctx.get('schedule')) throw new Error('Native DSH schedule service is not installed; install the official dsh-schedule component. No fallback timer was created.');
    return ctx.schedule;
  };
  function lead(id, header) {
    const record = tasks.get(id);
    if (!record?.policy || record.role !== 'lead' || record.parentId || record.rootId !== id
        || header?.parentSession || Number(header?.delegationDepth || 0) > 0) throw new Error('Scheduling requires an existing managed root Lead; child/Relay sessions cannot be promoted or scheduled');
    if (ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(id)) throw new Error('Lead is archived; scheduling does not unarchive it');
    return record;
  }
  function owned(args) {
    const record = store.get(args.schedule_id);
    if (!record || record.leadId !== args.lead_id) throw new Error('Collab schedule not found for this Lead');
    return record;
  }
  async function reconcile(record, catalog) {
    if (record.state !== 'creating') return record;
    const matches = catalog.filter(item => item.sessionId === record.leadId && item.prompt === schedulePrompt(record.id, record.task));
    if (matches.length !== 1) return record;
    return store.put({ ...record, state: 'active', nativeId: matches[0].id });
  }
  function view(record, catalog) {
    const native = catalog.find(item => item.id === record.nativeId && item.sessionId === record.leadId) || null;
    const execution = record.execution || null;
    return { scheduleId: record.id, leadId: record.leadId, revision: record.revision,
      state: record.state === 'active' && !native ? 'removed-by-native'
        : record.state === 'active' && native.status === 'inactive' ? execution?.state || 'delivered-awaiting-admission' : record.state,
      bindingState: record.state, window: record.window || windowPolicy({}),
      deliveryState: native?.lastDelivery ? 'delivered' : 'not-confirmed',
      executionState: execution?.state || 'not-started',
      title: record.title, task: record.task, policyHash: record.policyHash, native,
      execution, historyTruncated: record.historyTruncated || false,
      semantics: 'native delivery is at-least-once; Collab admits each occurrence at most once. Unknown executions require inspection, never blind replay.' };
  }
  async function operation(name, args) {
    validateInput(args, scheduleTools.find(tool => tool.name === name).inputSchema);
    const native = service();
    if (name === 'deepseek_schedule_create') {
      const selector = timing(args);
      const window = windowPolicy(args);
      if (window.expiresAt !== null && window.expiresAt <= Date.now()) throw new Error('Schedule authorization has already expired');
      if (args.at && window.expiresAt !== null && Date.parse(args.at) >= window.expiresAt) throw new Error('Scheduled instant is outside the authorization window');
      const record = lead(args.lead_id);
      // Read-only inspection also rejects cold delegated sessions, rather than
      // relying on the native service's live-agent-only routing check.
      const inspected = await ctx.sessionController.inspect(args.lead_id);
      lead(args.lead_id, inspected.meta);
      const existed = store.get(`collab-schedule-${fingerprint([args.lead_id, args.request_key])}`);
      let binding = store.bind(args, record.policy);
      leads.add(args.lead_id);
      if (existed) {
        const catalog = await native.catalog();
        binding = await reconcile(binding, catalog);
        if (binding.state === 'creating') throw new Error('Schedule creation outcome is unknown; inspect native schedules, do not create a duplicate with a new key');
        return { ...view(binding, catalog), replayed: true };
      }
      const created = await native.create(args.lead_id, { ...selector, title: args.title, prompt: schedulePrompt(binding.id, args.task) });
      binding = store.put({ ...binding, nativeId: created.id, state: 'active' });
      return view(binding, await native.catalog());
    }
    if (name === 'deepseek_schedule_list') {
      const catalog = await native.catalog(), rows = [];
      for (let record of store.list()) {
        if (args.lead_id && record.leadId !== args.lead_id) continue;
        // Listing is read-only: creation recovery is done at admission or retry.
        rows.push(view(record, catalog));
      }
      const offset = args.offset || 0, limit = args.limit || 50;
      return { schedules: rows.slice(offset, offset + limit), total: rows.length,
        nextOffset: offset + limit < rows.length ? offset + limit : null, scheduler: 'native-dsh', codexTimersChanged: false };
    }
    let record = owned(args);
    if (name === 'deepseek_schedule_history') return {
      ...view(record, await native.catalog()), executions: record.history.slice(-(args.limit || 50)).reverse(),
      delivery: record.nativeId ? await native.history({ sessionId: record.leadId, id: record.nativeId, limit: args.limit || 50, ...(args.before ? { before: args.before } : {}) }) : null,
    };
    if (name === 'deepseek_schedule_delete') {
      // Recover an owned timer created just before a crash, then cancel it.
      if (record.state === 'creating') record = await reconcile(record, await native.catalog());
      // Persist cancellation first, so native delivery already in the inbox is
      // denied too. Do not cancel a running task or touch another schedule.
      if (record.state !== 'deleted') record = store.put({ ...record, state: 'deleted' });
      const result = record.nativeId ? await native.delete({ sessionId: record.leadId, id: record.nativeId }) : null;
      return { scheduleId: record.id, deleted: true, native: result, runningTaskInterrupted: false };
    }
    const selector = timing(args, false);
    const key = tasks.claimSubmission(`schedule-update:${record.id}`, args.request_key, args);
    if (key.receipt) return { ...key.receipt, replayed: true };
    if (record.state !== 'active' || record.revision !== args.expected_revision) throw new Error('Schedule revision conflict or inactive binding; read list again before editing');
    if (!selector && args.title === undefined && args.task === undefined && !args.refresh_policy
        && args.expires_at === undefined && args.max_lateness_seconds === undefined) throw new Error('No schedule change supplied');
    const window = windowPolicy(args, record.window);
    const policy = lead(record.leadId).policy;
    const catalog = await native.catalog(), current = catalog.find(item => item.id === record.nativeId);
    if (!current || current.status !== 'active') throw new Error('Native schedule has ended or was removed; create a new explicitly authorized schedule');
    const { sessionId, status, lastDelivery, ...expected } = current;
    const changed = selector ? { change: { kind: selector.at !== undefined ? 'at' : Object.keys(selector)[0].replace('_seconds', ''), ...selector } } : {};
    const result = await native.update({ sessionId: record.leadId, id: record.nativeId, expected, ...changed,
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.task === undefined ? {} : { prompt: schedulePrompt(record.id, args.task) }) });
    if (!result.record) throw new Error(`Native schedule update refused: ${result.code}`);
    record = store.put({ ...record, title: args.title ?? record.title, task: args.task ?? record.task,
      window,
      ...(args.refresh_policy ? { policyHash: fingerprint(policy) } : {}) });
    const receipt = view(record, await native.catalog());
    tasks.completeSubmission(key.id, receipt);
    return receipt;
  }
  for (const tool of scheduleTools) background.registerOperation(tool.name, args => serialize(() => operation(tool.name, args)));

  // Capture prior admission before the general lifecycle observer marks the
  // native turn running. A restart-unknown dispatch must not become permission.
  function beforeEvent(session, event) {
    if (event.type === 'turn/start' && leads.has(session.id)) previous.set(session.id, tasks.get(session.id)?.dispatch);
  }
  function afterEvent(session, event, continuing) {
    if (event.type !== 'turn/end' || !leads.has(session.id)) return;
    for (const binding of store.list()) {
      if (binding.leadId !== session.id || !['admitted', 'continuing'].includes(binding.execution?.state)) continue;
      const reason = event.data.reason?.kind || event.data.reason;
      store.finish(binding.id, continuing ? 'continuing' : reason === 'completed' ? 'completed' : 'stopped',
        { lastTurn: event.data.turn, reason, error: tasks.get(session.id)?.failure || null });
    }
    if (previous.get(session.id)?.state === 'unknown') tasks.update(session.id, { dispatch: previous.get(session.id), lease: 'closed' });
    previous.delete(session.id);
  }
  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    if (tasks.get(agent.id)?.role !== 'lead' || !messages.some(message => message.source?.kind === 'schedule')) return next();
    const allowed = [], rejected = new Set();
    const catalog = await service().catalog();
    for (const message of messages) {
      const occurrences = nativeOccurrences(message);
      if (occurrences === null) continue;
      rejected.add(message.id);
      for (const occurrence of occurrences) {
        const id = /^\[COLLAB SCHEDULE (collab-schedule-[a-f0-9]{64})\]\n/.exec(occurrence.prompt)?.[1];
        let binding = id && store.get(id);
        if (!binding || binding.leadId !== agent.id) continue;
        binding = await reconcile(binding, catalog);
        let reason, window;
        try {
          const current = lead(agent.id, agent.session.header);
          // Ignore the prior dispatch window when scheduling a new occurrence;
          // the cumulative root budget still applies from its ORIGINAL creation.
          const root = tasks.root(agent.id);
          const shared = root.policy.maxDurationSeconds == null ? null : root.createdAt + root.policy.maxDurationSeconds * 1000;
          window = occurrenceWindow(binding, occurrence, shared);
          if (binding.state !== 'active' || binding.nativeId !== occurrence.nativeId) reason = 'Schedule canceled or not owned';
          else if (!catalog.some(item => item.id === occurrence.nativeId && item.sessionId === agent.id)) reason = 'Native schedule removed';
          else if (occurrence.prompt !== schedulePrompt(binding.id, binding.task)) reason = 'Queued schedule content changed; delivery not authorized';
          else if (!Number.isFinite(Date.parse(occurrence.at)) || Date.parse(occurrence.at) > Date.now() + 1000) reason = 'Invalid native occurrence';
          else if (window.reason) reason = window.reason;
          else if (fingerprint(current.policy) !== binding.policyHash) reason = 'Lead policy changed; explicitly refresh_policy before future occurrences';
          else if (previous.get(agent.id)?.state === 'unknown') reason = 'Previous Lead execution is unknown; no automatic replay';
          else if (Object.values(current.finalizations || {}).some(item => ['running', 'unknown'].includes(item.status))) reason = 'Finalization is still running or unknown';
          else if (current.completion?.state === 'continuing' && previous.get(agent.id)?.state === 'pending') reason = 'Lead continuation is pending; scheduled occurrence not admitted';
        } catch (error) { reason = error.message; }
        if (binding.watermark && Date.parse(occurrence.at) <= Date.parse(binding.watermark)) continue;
        if (reason) {
          // Consume the occurrence, but never count a rejection as execution.
          if (Number.isFinite(Date.parse(occurrence.at))) store.claim(binding.id, occurrence, turn);
          store.finish(binding.id, window?.reason ? 'expired' : 'blocked', { ...window, at: occurrence.at, turn, reason, modelStarted: false });
          continue;
        }
        if (!store.claim(binding.id, occurrence, turn)) continue;
        store.put({ ...store.get(binding.id), execution: { ...store.get(binding.id).execution, ...window } });
        allowed.push({ binding, occurrence, window, messageId: message.id });
      }
    }
    if (allowed.length) {
      const task = allowed.map(({ binding, occurrence }) => `Scheduled task (${binding.title}; ${occurrence.at}):\n${binding.task}`).join('\n\n');
      const deadlines = allowed.map(item => item.window.deadlineAt).filter(Number.isFinite);
      try { admitLead(agent, { task, policy: tasks.get(agent.id).policy }, { turn, deadlineAt: deadlines.length ? Math.min(...deadlines) : null }); }
      catch (error) { for (const item of allowed) store.finish(item.binding.id, 'blocked', { reason: error.message }); throw error; }
      const decision = await next();
      if (decision.kind !== 'enter') {
        for (const item of allowed) store.finish(item.binding.id, 'blocked', { reason: 'Native pre-step admission rejected' });
        return decision;
      }
      return { ...decision, messages: [...decision.messages.filter(message => !rejected.has(message.id)),
        Object.freeze({ id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'schedule' }),
          content: Object.freeze([Object.freeze({ type: 'text', text: `${task}\n\nContinue in this Lead's existing workspace and context. The existing Lead/child policies and cumulative budgets still apply.` })]) })] };
    }
    if (messages.every(message => rejected.has(message.id))) return { kind: 'reject' };
    const decision = await next();
    return decision.kind === 'enter' ? { ...decision, messages: decision.messages.filter(message => !rejected.has(message.id)) } : decision;
  }, { global: true, prepend: true });
  return { beforeEvent, afterEvent, store };
}
