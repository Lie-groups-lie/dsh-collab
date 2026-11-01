import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { processIdentity } from './process-identity.mjs';
import { assertDeadline } from './deadline.mjs';
import { atomicReplaceSync } from './atomic-replace.mjs';

// Only the native runtime writes this store. MCP/UI are consumers, never owners.
// Each replacement is atomic; incomplete requests keep their reservation after a crash.
export class TaskStore {
  constructor(directory, { identifyProcess = processIdentity } = {}) {
    this.directory = path.resolve(directory);
    this.identifyProcess = identifyProcess;
  }
  claimWriter() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, '.writer.lock');
    const recovery = path.join(this.directory, '.writer-recovery.lock');
    // Serialize stale-lock inspection too: two restarting runtimes must not
    // unlink a lock that the other just replaced. A crashed recovery fails closed.
    const recoveryFd = fs.openSync(recovery, 'wx', 0o600);
    try {
    const self = this.identifyProcess(process.pid);
    if (self.state !== 'alive' || !self.identity) {
      throw new Error('Cannot verify runtime process identity; check the packaged process-identity helper and OS permissions. No writer lock was replaced.');
    }
    if (fs.existsSync(filename)) {
      const owner = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid task-store writer lock');
      const observed = this.identifyProcess(owner.pid, owner.identity);
      if (observed.state === 'unknown' || observed.state === 'alive' && !observed.identity) {
        throw new Error(`Cannot verify task-store writer PID ${owner.pid}; no lock was replaced. Check OS permissions.`);
      }
      if (observed.state === 'alive') {
        if (!owner.identity) {
          throw new Error(`Legacy task-store writer lock for PID ${owner.pid} has no process birth identity. Verify whether the original runtime still exists before recovering this lock; do not terminate a process by saved PID alone.`);
        }
        if (observed.identity === owner.identity) throw new Error('Task store already has a live runtime writer');
        // Same PID, different birth: the original writer is gone. The recovery
        // mutex serializes this check/replacement against all other writers.
      } else if (observed.state !== 'dead' && !(observed.state === 'replaced' && owner.identity)) throw new Error('Invalid process identity probe result');
      fs.unlinkSync(filename);
    }
    const fd = fs.openSync(filename, 'wx', 0o600);
    const token = randomUUID();
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: self.identity, token }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).token === token) fs.unlinkSync(filename); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    } finally { fs.closeSync(recoveryFd); fs.unlinkSync(recovery); }
  }
  recover() {
    for (const filename of fs.readdirSync(this.directory)) {
      if (!/^[a-zA-Z0-9_-]{1,160}\.json$/.test(filename)) continue;
      const record = this.get(filename.slice(0, -5));
      let changed = false;
      for (const value of Object.values(record.finalizations || {})) if (value.status === 'running') {
        value.status = 'unknown'; value.error = 'Runtime restarted; finalization is not replayed automatically'; changed = true;
      }
      if (record.lease === 'active') { record.lease = 'closed'; changed = true; }
      if (['pending', 'running'].includes(record.dispatch?.state)) {
        record.dispatch.state = 'unknown'; changed = true;
      }
      if (record.completion?.state === 'continuing') {
        record.completion.state = 'unknown'; record.completion.reason = 'Runtime restarted; continuation requires reconciliation'; changed = true;
      }
      if (changed) this.put(record);
    }
  }
  filename(id) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('Invalid task identity');
    return path.join(this.directory, `${id}.json`);
  }
  get(id) {
    try {
      const value = JSON.parse(fs.readFileSync(this.filename(id), 'utf8'));
      if (value.schema !== 1 || value.id !== id) throw new Error('Unsupported task record');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  put(record) {
    const filename = this.filename(record.id);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const previous = this.get(record.id);
    const changedExecution = previous?.dispatch && record.dispatch &&
      (previous.dispatch.id !== record.dispatch.id || previous.dispatch.turn !== record.dispatch.turn && previous.dispatch.turn != null);
    const receiptHistory = changedExecution ? [...(previous.receiptHistory || []),
      { ...previous.dispatch, executionBuild: previous.executionBuild || null, recordedAt: previous.updatedAt }]
      : previous?.receiptHistory;
    const value = { ...record, ...(receiptHistory ? { receiptHistory } : {}),
      ...(record.dispatch && this.executionBuild && previous?.dispatch?.id !== record.dispatch.id ? { executionBuild: this.executionBuild } : {}),
      schema: 1, revision: (previous?.revision || 0) + 1, updatedAt: Date.now() };
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { atomicReplaceSync(temporary, filename); } catch (error) { fs.unlinkSync(temporary); throw error; }
    return value;
  }
  create({ id, rootId = id, parentId = '', role = 'child', policy, originalTask = '', lease = 'closed' }) {
    if (this.get(id)) throw new Error('Task already exists');
    return this.put({ id, rootId, parentId, role, policy, originalTask, lease, createdAt: Date.now(),
      ledger: { requests: 0, toolCalls: 0, children: 0, outputTokens: 0, inputTokens: 0,
        usageMissing: false, reservations: {}, settled: {} } });
  }
  update(id, patch) {
    const record = this.get(id);
    if (!record) throw new Error('Managed task policy is missing');
    return this.put({ ...record, ...patch, id, rootId: record.rootId, originalTask: record.originalTask || patch.originalTask || '' });
  }
  beginDispatch(id, { preserveDeadline = false } = {}) {
    const record = this.get(id);
    if (!record) throw new Error('Managed task policy is missing');
    if (record.dispatch?.state === 'unknown') throw new Error('Previous submission outcome is unknown; inspect/cancel it or start a new task, never implicitly replay');
    if (['pending', 'running'].includes(record.dispatch?.state)
      || Object.values(record.finalizations || {}).some((item) => item.status === 'running')) {
      throw new Error('Task already has an active submission; wait or stop it before continuing');
    }
    const recoveryId = record.recovery?.state === 'ready' ? record.recovery.id : preserveDeadline ? record.dispatch?.recoveryId : null;
    return this.update(id, { ...(recoveryId ? { recovery: { ...record.recovery, state: 'continuing' } } : {}),
      dispatch: { id: randomUUID(), state: 'pending', afterTurn: record.lastTurn || 0,
      ...(recoveryId ? { recoveryId } : {}),
      ...(preserveDeadline && Number.isFinite(record.dispatch?.deadlineAt) ? { deadlineAt: record.dispatch.deadlineAt } : {}) } }).dispatch;
  }
  observeLifecycle(id, event) {
    if (!['turn/start', 'turn/end'].includes(event.type)) return;
    const record = this.get(id);
    if (!record?.policy) return;
    const turn = Number(event.data.turn);
    const nativeAdmission = event.type === 'turn/start' && (!record.dispatch?.id || !['pending', 'running'].includes(record.dispatch.state));
    this.update(id, { lastTurn: turn, dispatch: {
      ...(nativeAdmission ? { id: randomUUID(), source: 'native-turn', observedAt: Date.now() } : record.dispatch), turn,
      ...(event.type === 'turn/end' && event.data.reason ? { outcome: event.data.reason.kind || event.data.reason } : {}),
      state: event.type === 'turn/start' ? 'running' : 'settled' } });
  }
  root(id) {
    const record = this.get(id);
    if (!record) throw new Error('Managed task policy is missing');
    const root = record.rootId === id ? record : this.get(record.rootId);
    if (!root) throw new Error('Task budget root is missing');
    return root;
  }
  claimSubmission(scope, key, spec) {
    const previous = this.findSubmission(scope, key, spec);
    if (previous) return previous;
    const digest = (value) => createHash('sha256').update(value).digest('hex');
    const id = `request-${digest(`${scope}\n${key}`)}`;
    const fingerprint = digest(JSON.stringify(spec));
    this.put({ id, role: 'submission', fingerprint, createdAt: Date.now() });
    return { id, receipt: null };
  }
  findSubmission(scope, key, spec) {
    const digest = (value) => createHash('sha256').update(value).digest('hex');
    const id = `request-${digest(`${scope}\n${key}`)}`;
    const fingerprint = digest(JSON.stringify(spec));
    const previous = this.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Idempotency key reused with a different task or policy');
      if (!previous.receipt) throw new Error('Submission outcome is uncertain; inspect the existing task, do not replay');
      return { id, receipt: previous.receipt };
    }
    return null;
  }
  completeSubmission(id, receipt) {
    const record = this.get(id);
    this.put({ ...record, receipt });
  }
  outputAllowance(id, requested) {
    const root = this.root(id);
    const pending = Object.values(root.ledger.reservations).reduce((a, b) => a + (typeof b === 'number' ? b : b.output), 0);
    const remaining = root.policy.maxTotalOutputTokens == null ? Infinity : root.policy.maxTotalOutputTokens - root.ledger.outputTokens - pending;
    if (remaining < 64) throw new Error('Task output budget exhausted');
    return Math.min(requested, remaining);
  }
  reserve(id, key, requested, options = {}) {
    const root = this.root(id), ledger = root.ledger, budget = root.policy;
    if (ledger.reservations[key] !== undefined || ledger.settled[key]) throw new Error('Duplicate model request');
    assertDeadline(this, id);
    if (budget.maxRequests != null && ledger.requests >= budget.maxRequests) throw new Error('Task request budget exhausted');
    const pending = Object.values(ledger.reservations);
    if (pending.length >= (budget.maxConcurrentRequests ?? 4)) throw new Error('Task concurrency budget exhausted');
    const cap = this.outputAllowance(id, requested);
    if (options.requireFull && cap !== requested) throw new Error('Concurrent reservation changed the available output budget; request not sent');
    const input = options.inputTokens || 0;
    const pendingInput = pending.reduce((n, value) => n + (typeof value === 'number' ? 0 : value.input), 0);
    if (budget.maxTotalInputTokens != null && ledger.inputTokens + pendingInput + input > budget.maxTotalInputTokens) throw new Error('Task input budget exhausted');
    const rates = options.rates;
    if (rates?.currency && ledger.currency && ledger.currency !== rates.currency) throw new Error('Task pricing currency cannot change within one budget ledger');
    const cost = rates ? Math.ceil((input * rates.input + cap * rates.output) / 1000000) : null;
    if (budget.maxCostMicros !== undefined) {
      if (!rates) throw new Error('A cost cap requires administrator-configured pricing ceilings');
      if ((ledger.costMicros || 0) + pending.reduce((n, v) => n + (v.cost || 0), 0) + cost > budget.maxCostMicros) throw new Error('Task configured-cost budget exhausted');
    }
    ledger.requests += 1;
    if (rates?.currency) ledger.currency = rates.currency;
    ledger.reservations[key] = { taskId: id, output: cap, input, cost, rates, purpose: options.purpose || 'conversation' };
    this.put(root);
    return cap;
  }
  settle(id, key, usage) {
    const root = this.root(id), ledger = root.ledger;
    if (ledger.settled[key]) return;
    const reserved = ledger.reservations[key];
    if (reserved === undefined) return;
    // Missing usage is charged at the entire reservation, never treated as free.
    const ceiling = typeof reserved === 'number' ? { output: reserved, input: 0 } : reserved;
    const validOutput = Number.isSafeInteger(usage?.outputTokens) && usage.outputTokens >= 0;
    const inputFields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
    const reportedInput = inputFields.reduce((n, field) => n + (usage?.[field] ?? 0), 0);
    const validInput = Number.isSafeInteger(usage?.inputTokens) && inputFields.every((field) => usage?.[field] === undefined
      || Number.isSafeInteger(usage[field]) && usage[field] >= 0) && Number.isSafeInteger(reportedInput);
    const actual = validOutput ? usage.outputTokens : ceiling.output;
    const input = validInput ? reportedInput : ceiling.input;
    ledger.outputTokens += actual;
    ledger.inputTokens += input;
    ledger.usageMissing ||= !validOutput || !validInput;
    if (ceiling.rates) ledger.costMicros = (ledger.costMicros || 0) + Math.ceil((input * ceiling.rates.input + actual * ceiling.rates.output) / 1000000);
    delete ledger.reservations[key];
    ledger.settled[key] = true;
    this.put(root);
  }
  tool(id, { child = false } = {}) {
    const root = this.root(id), ledger = root.ledger;
    assertDeadline(this, id);
    if (root.policy.maxToolCallsTotal != null && ledger.toolCalls >= root.policy.maxToolCallsTotal) throw new Error('Task tool budget exhausted');
    if (child && ledger.children >= (root.policy.maxChildrenTotal ?? 0)) throw new Error('Task child budget exhausted');
    ledger.toolCalls += 1;
    if (child) ledger.children += 1;
    this.put(root);
  }
}
