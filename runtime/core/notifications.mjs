import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateInput } from './schema.mjs';

const identity = { type: 'string', pattern: '^(?!__proto__$|constructor$|prototype$)[a-zA-Z0-9_-]{1,160}$', maxLength: 160 };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const tool = (name, description, properties, required, readOnly = false) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  outputSchema: { type: 'object', additionalProperties: true },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
export const notificationTools = [
  tool('deepseek_watch', 'Persist a zero-model periodic task report in the DSH runtime. This does not itself wake Codex; use an explicitly authorized host heartbeat to consume notifications.', {
    watch_id: { ...identity, pattern: '^watch-[a-zA-Z0-9_-]{1,100}$' }, action: { type: 'string', enum: ['start', 'stop', 'status'] },
    session_ids: { type: 'array', items: identity, uniqueItems: true, minItems: 1, maxItems: 32 },
    interval_seconds: integer(60, 86400), duration_seconds: integer(60, 604800),
  }, ['watch_id', 'action']),
  tool('deepseek_notifications', 'Read durable bounded reports, replay after disconnection, or list channels. Reading never acknowledges or generates model calls. Check gap before consuming.', {
    channel: identity, consumer: identity, after_seq: integer(0, Number.MAX_SAFE_INTEGER), limit: integer(1, 100),
  }, [], true),
  tool('deepseek_notifications_ack', 'Acknowledge through a sequence ONLY after its report has been delivered. Cursor is per consumer; no task is cancelled or resumed.', {
    channel: identity, consumer: identity, through_seq: integer(0, Number.MAX_SAFE_INTEGER),
  }, ['channel', 'consumer', 'through_seq']),
];

function atomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`, fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, filename); } catch (error) { fs.unlinkSync(temporary); throw error; }
}
export class ReportStore {
  constructor(directory, { retention = 256, now = Date.now } = {}) {
    this.directory = path.join(directory, 'reports'); this.retention = retention; this.now = now;
    this.index = null; this.corruptions = [];
  }
  file(id) { validateInput(id, identity, 'channel'); return path.join(this.directory, `${id}.json`); }
  get(id) { try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  summary(record) { return { id: record.id, seq: record.seq, updatedAt: record.updatedAt, watch: record.watch, latestType: record.events.at(-1)?.type }; }
  list() {
    // One native writer. Keep only metadata in memory, not every report body.
    // An idle tick must not reparse all historical report files.
    if (!this.index) {
      this.index = new Map();
      for (const file of fs.existsSync(this.directory) ? fs.readdirSync(this.directory) : []) {
        if (!/^[a-zA-Z0-9_-]+\.json$/.test(file)) continue;
        try { const record = this.get(file.slice(0, -5)); this.index.set(record.id, this.summary(record)); }
        catch { this.corruptions.push({ channel: file.slice(0, -5), error: 'Unreadable report channel; preserved for inspection' }); }
      }
    }
    return [...this.index.values()];
  }
  save(record) { this.list(); atomic(this.file(record.id), record); this.index.set(record.id, this.summary(record)); return record; }
  emit(id, type, snapshot, patch = {}) {
    const existing = this.get(id);
    const record = existing || { id, seq: 0, events: [], consumers: {}, createdAt: this.now() };
    if (!existing && this.list().length >= 512) throw new Error('Report channel limit reached; explicit retention maintenance required');
    const event = { seq: record.seq + 1, time: this.now(), type, snapshot };
    if (JSON.stringify(event).length > 65536) throw new Error('Report exceeds bounded snapshot size');
    Object.assign(record, patch, { seq: event.seq, updatedAt: this.now() }); record.events.push(event);
    record.events = record.events.slice(-this.retention); return this.save(record);
  }
  read({ channel, consumer = 'codex', after_seq, limit = 20 } = {}) {
    validateInput(consumer, identity);
    if (!channel) return { channels: this.list().map(({ id, seq, ...rest }) => ({ channel: id, latestSeq: seq, ...rest })), errors: this.corruptions };
    const record = this.get(channel); if (!record) throw new Error('Unknown notification channel');
    const cursor = after_seq ?? record.consumers[consumer] ?? 0;
    if (cursor > record.seq) throw new Error('Cursor is ahead of this channel');
    const first = record.events[0]?.seq ?? record.seq + 1;
    const events = record.events.filter(e => e.seq > cursor).slice(0, limit);
    return { channel, consumer, events, nextCursor: events.at(-1)?.seq ?? cursor, latestSeq: record.seq,
      gap: cursor < first - 1 ? { from: cursor + 1, through: first - 1, reason: 'bounded-retention; inspect latest task state' } : null,
      acknowledgedThrough: record.consumers[consumer] ?? 0, delivery: 'at-least-once-until-explicit-ack' };
  }
  ack({ channel, consumer, through_seq }) {
    validateInput(consumer, identity);
    validateInput(through_seq, integer(0, Number.MAX_SAFE_INTEGER));
    const record = this.get(channel); if (!record || through_seq > record.seq) throw new Error('Invalid acknowledgement');
    if (!Object.hasOwn(record.consumers, consumer) && Object.keys(record.consumers).length >= 32) throw new Error('Consumer limit reached');
    record.consumers[consumer] = Math.max(record.consumers[consumer] || 0, through_seq); this.save(record);
    return { channel, consumer, acknowledgedThrough: record.consumers[consumer] };
  }
}

export class BackgroundReports {
  constructor({ directory, snapshot, prepareSnapshot = () => {}, now = Date.now }) {
    this.store = new ReportStore(directory, { now }); this.snapshot = snapshot; this.now = now;
    this.prepareSnapshot = prepareSnapshot;
    this.dirty = true; // Reconcile accepted watches immediately after a runtime restart.
  }
  operation(name, args) {
    const definition = notificationTools.find(t => t.name === name); if (!definition) throw new Error('Unsupported notification operation');
    validateInput(args, definition.inputSchema);
    if (name === 'deepseek_notifications') return this.store.read(args);
    if (name === 'deepseek_notifications_ack') return this.store.ack(args);
    const existing = this.store.get(args.watch_id);
    if (args.action === 'status') return { channel: args.watch_id, watch: existing?.watch || null };
    if (args.action === 'stop') {
      if (!existing?.watch) throw new Error('Unknown watch');
      if (existing.watch.state !== 'stopped') this.store.emit(args.watch_id, 'watch.stopped', {}, { watch: { ...existing.watch, state: 'stopped' } });
      return { channel: args.watch_id, state: 'stopped', tasksCancelled: false };
    }
    if (!args.session_ids) throw new Error('start requires session_ids');
    const spec = { sessionIds: args.session_ids, intervalSeconds: args.interval_seconds ?? 300, durationSeconds: args.duration_seconds ?? 86400 };
    if (existing) {
      if (JSON.stringify(existing.watch?.spec) !== JSON.stringify(spec)) throw new Error('Watch ID already has a different immutable specification');
      return { channel: args.watch_id, watch: existing.watch, hostWakeup: 'requires-authorized-host-heartbeat' };
    }
    if (this.store.list().filter(c => c.watch?.state === 'active').length >= 64) throw new Error('Active watch limit reached');
    this.prepareSnapshot();
    const snapshot = this.snapshot(spec.sessionIds); // validate managed identities before persisting
    const attention = snapshot.tasks?.some(t => t.state === 'unknown');
    const watch = { spec, state: attention ? 'needs_attention' : snapshot.settled ? 'completed' : 'active', nextAt: this.now() + spec.intervalSeconds * 1000,
      expiresAt: this.now() + spec.durationSeconds * 1000 };
    this.store.emit(args.watch_id, attention ? 'tasks.needs_attention' : snapshot.settled ? 'tasks.settled' : 'watch.started', snapshot, { watch });
    return { channel: args.watch_id, watch, hostWakeup: 'requires-authorized-host-heartbeat', modelCalls: 0 };
  }
  tick() {
    this.prepareSnapshot(); // one coherent task inventory shared by all due watches
    for (const record of this.store.list().filter(c => c.watch?.state === 'active')) {
      const watch = record.watch;
      if (!this.dirty && this.now() < Math.min(watch.nextAt, watch.expiresAt)) continue;
      try {
        const snapshot = this.snapshot(watch.spec.sessionIds), expired = this.now() >= watch.expiresAt;
        const attention = snapshot.tasks?.some(t => t.state === 'unknown');
        if (!snapshot.settled && !attention && !expired && this.now() < watch.nextAt) continue;
        const missedIntervals = Math.max(0, Math.floor((this.now() - watch.nextAt) / (watch.spec.intervalSeconds * 1000)));
        const state = attention ? 'needs_attention' : snapshot.settled ? 'completed' : expired ? 'expired' : 'active';
        this.store.emit(record.id, attention ? 'tasks.needs_attention' : snapshot.settled ? 'tasks.settled' : expired ? 'watch.expired' : 'tasks.progress',
          { ...snapshot, missedIntervals }, { watch: { ...watch, state, nextAt: this.now() + watch.spec.intervalSeconds * 1000 } });
      } catch (error) {
        this.store.emit(record.id, 'watch.needs_attention', { message: String(error.message).slice(0, 1000) }, { watch: { ...watch, state: 'needs_attention' } });
      }
    }
    this.dirty = false;
  }
}
