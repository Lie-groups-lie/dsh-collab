import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TaskStore } from './task-store.mjs';
import { canonical } from './tool-registry.mjs';

export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const text = (maxLength = 160) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const localTime = { time: text(32), time_zone: text(100) };
export const scheduleSelectors = {
  at: { ...text(64), description: 'Absolute RFC3339 instant with Z or explicit UTC offset; never infer a timezone.' },
  local_at: object({ date: text(10), ...localTime }, ['date', 'time', 'time_zone']),
  after_seconds: { type: 'integer', minimum: 1, maximum: 31536000 },
  every_seconds: { type: 'integer', minimum: 60, maximum: 31536000 },
  daily: object(localTime, ['time', 'time_zone']),
  weekly: object({ ...localTime, weekdays: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } } }, ['time', 'time_zone', 'weekdays']),
  cron: object({ expression: text(100), time_zone: text(100) }, ['expression', 'time_zone']),
};
const binding = { lead_id: text(), schedule_id: text() };
export const scheduleWindows = {
  expires_at: { ...text(64), description: 'Absolute RFC3339 end of authorization (explicit Z/offset). No admission or continued execution at/after it.' },
  max_lateness_seconds: { type: 'integer', minimum: 0, maximum: 31536000, default: 300,
    description: 'Maximum admission delay after each native occurrence, default 300 seconds. Late occurrences are consumed as expired, never replayed.' },
};
export function windowPolicy(args, previous = {}) {
  if (args.expires_at !== undefined && (!/(?:Z|[+-]\d{2}:\d{2})$/.test(args.expires_at) || !Number.isFinite(Date.parse(args.expires_at)))) {
    throw new Error('expires_at requires a valid absolute RFC3339 instant with Z or UTC offset');
  }
  return { expiresAt: args.expires_at === undefined ? previous.expiresAt ?? null : Date.parse(args.expires_at),
    maxLatenessSeconds: args.max_lateness_seconds ?? previous.maxLatenessSeconds ?? 300 };
}
export function occurrenceWindow(record, occurrence, sharedDeadline, now = Date.now()) {
  const policy = record.window || windowPolicy({}), at = Date.parse(occurrence.at);
  const ceilings = [policy.expiresAt, sharedDeadline].filter(Number.isFinite);
  const deadlineAt = ceilings.length ? Math.min(...ceilings) : null;
  const delayMs = Math.max(0, now - at);
  const reason = deadlineAt !== null && now >= deadlineAt ? 'Execution authorization window expired'
    : delayMs > policy.maxLatenessSeconds * 1000 ? 'Occurrence exceeded maximum delivery lateness' : null;
  return { deadlineAt, admissionAt: now, scheduledAt: occurrence.at, delayMs, reason };
}
export const scheduleTools = [
  { name: 'deepseek_schedule_create', description: 'Authorize native DSH to continue an existing root Lead at a specified time or recurring interval. Captures its current policy and retains its cumulative budget; cannot target a child. Requires an explicit user scheduling request. Backend must be running; no Codex timer is created.',
    inputSchema: object({ lead_id: text(), title: text(120), task: text(4000), request_key: text(), ...scheduleSelectors, ...scheduleWindows }, ['lead_id', 'title', 'task', 'request_key']) },
  { name: 'deepseek_schedule_list', description: 'Read Collab-owned native DSH schedules, next delivery, and execution states without waking a Lead. Does not list or alter Codex reminders.',
    inputSchema: object({ lead_id: text(), offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }) },
  { name: 'deepseek_schedule_update', description: 'Compare-and-update a Collab native schedule. Get revision from list first. Explicit refresh_policy re-authorizes the current Lead policy; otherwise policy changes block future execution. An inactive one-shot needs a new create, not replay.',
    inputSchema: object({ ...binding, expected_revision: { type: 'integer', minimum: 1 }, request_key: text(), title: text(120), task: text(4000), refresh_policy: { type: 'boolean' },
      ...Object.fromEntries(Object.entries(scheduleSelectors).filter(([key]) => key !== 'after_seconds')), ...scheduleWindows }, ['lead_id', 'schedule_id', 'expected_revision', 'request_key']) },
  { name: 'deepseek_schedule_delete', description: 'Cancel a Collab native schedule and reject its not-yet-admitted queued deliveries. An already running Lead is NOT interrupted; use task_cancel separately if authorized. Keeps bounded execution audit, not native delivery history.',
    inputSchema: object(binding, ['lead_id', 'schedule_id']) },
  { name: 'deepseek_schedule_history', description: 'Read bounded execution audit plus native delivery receipts. Delivery acknowledgement is not execution success. Unknown outcomes after a crash are never blindly replayed.',
    inputSchema: object({ ...binding, limit: { type: 'integer', minimum: 1, maximum: 100 }, before: text() }, ['lead_id', 'schedule_id']) },
].map(tool => ({ ...tool, annotations: { readOnlyHint: /_(list|history)$/.test(tool.name), destructiveHint: false, idempotentHint: true, openWorldHint: !/_(list|history)$/.test(tool.name) }, outputSchema: { type: 'object', additionalProperties: true } }));

export function timing(args, required = true) {
  const keys = Object.keys(scheduleSelectors).filter(key => args[key] !== undefined);
  if (keys.length !== (required ? 1 : keys.length ? 1 : 0)) throw new Error('Exactly one scheduling selector is required');
  if (!keys.length) return null;
  const key = keys[0];
  if (key === 'at' && !/(?:Z|[+-]\d{2}:\d{2})$/.test(args.at)) throw new Error('at requires an explicit UTC offset or Z; use local_at for a named timezone');
  return { [key === 'local_at' ? 'at' : key]: args[key] };
}

export function schedulePrompt(id, task) { return `[COLLAB SCHEDULE ${id}]\n${task}`; }

// Parse only native-origin messages, never user text pretending to be a control command.
export function nativeOccurrences(message) {
  if (message?.source?.kind !== 'schedule') return null;
  const value = (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  try {
    if (value.startsWith('[SCHEDULE REMINDER BATCH]\n')) {
      const items = JSON.parse(value.split('\n').find(line => line.startsWith('reminders_json: '))?.slice(16));
      if (!Array.isArray(items) || items.length > 100) return [];
      return items.map(item => ({ nativeId: item.schedule_id, at: item.occurrence_at, prompt: item.reminder_prompt }));
    }
    if (!value.startsWith('[SCHEDULE REMINDER]\n')) return [];
    const field = name => value.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2);
    return [{ nativeId: JSON.parse(field('schedule_id_json')), at: field('occurrence_at'), prompt: JSON.parse(field('reminder_prompt_json')) }];
  } catch { return []; }
}

// Uses the runtime's existing single-writer ownership. Bounded audit + monotone
// occurrence watermark keep dedupe durable without retaining entire transcripts.
export class ScheduleStore {
  constructor(root) {
    this.store = new TaskStore(path.join(root, 'schedules'));
    fs.mkdirSync(this.store.directory, { recursive: true, mode: 0o700 });
  }
  get(id) { return this.store.get(id); }
  put(value) { return this.store.put(value); }
  list() { return fs.readdirSync(this.store.directory).filter(name => /^collab-schedule-[a-f0-9]{64}\.json$/.test(name)).map(name => this.get(name.slice(0, -5))); }
  bind(args, policy) {
    const id = `collab-schedule-${fingerprint([args.lead_id, args.request_key])}`;
    const spec = fingerprint(args), previous = this.get(id);
    if (previous) {
      if (previous.fingerprint !== spec) throw new Error('Schedule request_key reused with different arguments');
      return previous;
    }
    return this.put({ id, role: 'schedule', leadId: args.lead_id, fingerprint: spec, request: args,
      task: args.task, title: args.title, window: windowPolicy(args), policyHash: fingerprint(policy), state: 'creating', history: [], createdAt: Date.now() });
  }
  audit(id, entry) {
    const record = this.get(id);
    const history = [...record.history, { ...entry, recordedAt: Date.now() }];
    return this.put({ ...record, history: history.slice(-100), historyTruncated: record.historyTruncated || history.length > 100 });
  }
  claim(id, occurrence, turn) {
    const record = this.get(id);
    if (record.watermark && Date.parse(occurrence.at) <= Date.parse(record.watermark)) return false;
    this.put({ ...record, watermark: occurrence.at, execution: { state: 'admitted', at: occurrence.at, turn, startedAt: Date.now() } });
    return true;
  }
  finish(id, state, detail = {}) {
    let record = this.get(id);
    record = this.put({ ...record, execution: { ...record.execution, state, ...detail } });
    return this.audit(id, record.execution);
  }
  recover() {
    for (const record of this.list()) if (['admitted', 'continuing'].includes(record.execution?.state)) {
      this.finish(record.id, 'unknown', { reason: 'Runtime restarted during execution; no automatic replay' });
    }
  }
}
