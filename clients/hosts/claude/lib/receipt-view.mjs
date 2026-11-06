import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

// Client presentation only. Durable ledgers, admission and DSH UI stay unchanged.
export const RECEIPT_TOOLS = new Set(['deepseek_flash', 'deepseek_lead', 'deepseek_flash_status',
  'deepseek_lead_status', 'deepseek_tasks_start', 'deepseek_task_result']);
export const CONDITIONAL_READ_TOOLS = new Set(['deepseek_flash_status', 'deepseek_lead_status', 'deepseek_task_result']);

export function progressView(value, detail = 'compact') {
  if (detail === 'full' || !value || typeof value !== 'object') return value;
  const out = { ...value };
  for (const key of ['partialAnswer', 'reasoning']) if (typeof out[key] === 'string') {
    out[`${key}PreviewChars`] = out[key].length; delete out[key];
  }
  if (Array.isArray(out.toolCalls)) {
    out.toolCallCount = out.toolCalls.length;
    const last = out.toolCalls.at(-1);
    out.lastTool = last ? { callId: last.callId, name: last.name, status: last.status } : null;
    delete out.toolCalls;
  }
  return out;
}

function reservationTotals(reservations) {
  const entries = Object.values(reservations);
  const total = key => {
    const values = entries.map(item => typeof item === 'number' ? (key === 'output' ? item : null) : item?.[key]);
    return values.every(value => Number.isFinite(value) && value >= 0) ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  return { count: entries.length, inputTokens: total('input'), outputTokens: total('output'), costMicros: total('cost') };
}

function taskView(value, name, args) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value }, omitted = {}, refs = {};
  if (value.budgetLedger && typeof value.budgetLedger === 'object') {
    const ledger = { ...value.budgetLedger };
    if (ledger.settled && typeof ledger.settled === 'object') {
      omitted['budgetLedger.settled'] = Object.keys(ledger.settled).length;
      ledger.settledRequestCount = omitted['budgetLedger.settled']; delete ledger.settled;
    }
    if (ledger.reservations && typeof ledger.reservations === 'object') {
      ledger.pendingReservations = reservationTotals(ledger.reservations);
      omitted['budgetLedger.reservations'] = ledger.pendingReservations.count; delete ledger.reservations;
    }
    out.budgetLedger = ledger;
  }
  // A reference means exact equality, never "close enough" or requested == granted.
  for (const key of ['budgetPolicy', 'requestedPolicy', 'policy']) {
    if (value.effectivePolicy && isDeepStrictEqual(value[key], value.effectivePolicy)) {
      delete out[key]; refs[key] = 'effectivePolicy';
    }
  }
  const stripCalls = (source, target, prefix) => {
    if (Array.isArray(source.toolCalls) && source.toolCalls.length) {
      omitted[`${prefix}toolCalls`] = source.toolCalls.length;
      delete target.toolCalls;
      const byStatus = Object.create(null);
      for (const call of source.toolCalls) { const status = typeof call?.status === 'string' ? call.status : 'unknown'; byStatus[status] = (byStatus[status] || 0) + 1; }
      const last = source.toolCalls.at(-1);
      target.toolCallSummary = { observedCount: source.toolCalls.length, byStatus,
        last: last ? { callId: last.callId, name: last.name, status: last.status } : null };
    }
  };
  stripCalls(value, out, '');
  if (value.progress && typeof value.progress === 'object') {
    out.progress = { ...value.progress };
    stripCalls(value.progress, out.progress, 'progress.');
    if (value.answer && value.progress.partialAnswer === value.answer) {
      delete out.progress.partialAnswer; refs['progress.partialAnswer'] = 'answer';
    }
    if (value.reasoning && value.progress.reasoning === value.reasoning) {
      delete out.progress.reasoning; refs['progress.reasoning'] = 'reasoning';
    }
  }
  if (Array.isArray(value.activity) && value.activity.length) {
    omitted.activity = value.activity.length; delete out.activity;
  }
  if (value.answer && value.finalization?.answer === value.answer) {
    out.finalization = { ...value.finalization }; delete out.finalization.answer; refs['finalization.answer'] = 'answer';
  }
  if (Array.isArray(value.children)) out.children = value.children.map(child => taskView(child, 'deepseek_flash_status', {}));
  const { session_id, ...pageArgs } = args;
  const full = name === 'deepseek_task_result'
    ? { tool: name, arguments: { ...pageArgs, task_session_id: value.sessionId, response_detail: 'full' } }
    : name === 'deepseek_lead' || name === 'deepseek_lead_status'
      ? { tool: 'deepseek_lead_status', arguments: { lead_id: value.sessionId, response_detail: 'full' } }
      : { tool: 'deepseek_task_result', arguments: { task_session_id: value.sessionId, response_detail: 'full', include_task: true,
        ...(Number.isSafeInteger(value.turnId) && value.turnId > 0 ? { expected_turn: value.turnId } : {}) } };
  out.receiptView = { mode: 'compact', omitted, refs,
    ...(value.sessionId ? { full, trace: { tool: 'deepseek_task_trace', arguments: { task_session_id: value.sessionId } } } : {}),
    note: 'Presentation only; stored history and fees unchanged. References are exact copies. Read trace for work details; full reads never resubmit work.' };
  return out;
}

export function receiptView(name, value, args = {}, detail = 'compact', previousRevision) {
  if (detail === 'full' || !RECEIPT_TOOLS.has(name)) return value;
  if (name === 'deepseek_tasks_start' && Array.isArray(value?.results)) return {
    ...value, results: value.results.map(item => item.result
      ? { ...item, result: taskView(item.result, 'deepseek_flash_status', {}) } : item),
  };
  const out = taskView(value, name, args);
  if (!out || typeof out !== 'object' || !CONDITIONAL_READ_TOOLS.has(name)) return out;
  const responseRevision = createHash('sha256').update(name + '\n' + JSON.stringify(out)).digest('hex');
  if (previousRevision === responseRevision) return {
    sessionId: out.sessionId, turnId: out.turnId, status: out.status, running: out.running,
    completion: out.completion, childrenPending: out.childrenPending, warnings: out.warnings,
    error: out.error, failure: out.failure, admission: out.admission, admissionBlock: out.admissionBlock,
    nextOffset: out.nextOffset, totalChars: out.totalChars, responseRevision, unchanged: true,
    note: 'Same visible receipt as your previous revision; reuse that result. No answer was cleared. No task was submitted.',
  };
  return { ...out, responseRevision };
}
