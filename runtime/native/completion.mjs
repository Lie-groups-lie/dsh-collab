import { randomUUID, createHash } from 'node:crypto';
import { assertDeadline } from '../core/deadline.mjs';
import { turnFailure } from '../core/failure.mjs';

// A short promise to start work is not a final answer. Do not classify ordinary
// short answers (numbers, yes/no, concise conclusions) by length alone.
export function isPreamble(text) {
  const value = String(text || '').trim();
  if (value.length >= 240 || /[\n]|(?:结论|结果|答案)[：:]|\b(?:answer|result) is\b/i.test(value)) return false;
  return /^(?:(?:我(?:先|来|会)|让我(?:先)?)(?:把|读|看|检查|查阅|查看|分析|研究|检索|搜索|核对|梳理|运行|验证|测试)|稍等|I(?:'ll| will) (?:first |now )?(?:read|check|inspect|look)|Let me (?:first )?(?:read|check|inspect|look))[^\n]*[。.!！]?$/i.test(value);
}

export function recordActivity(store, session, event) {
  if (!['turn/start', 'turn/end', 'request/header', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result'].includes(event.type)) return;
  const record = store.get(session.id);
  if (!record?.policy) return;
  const data = event.data || {};
  const item = { seq: event.seq, time: event.time, type: event.type, turn: data.turn, step: data.step };
  if (event.type === 'tool/call') Object.assign(item, { name: data.name, callId: data.callId });
  if (event.type === 'tool/result') item.callId = data.callId;
  if (event.type === 'turn/end') item.reason = data.reason?.kind || data.reason;
  if (data.usage) item.outputTokens = data.usage.outputTokens;
  const activity = [...(record.activity || []), item];
  const observation = {};
  if (event.type === 'turn/start') {
    observation.failure = null;
    observation.completion = { ...record.completion, state: 'running', reason: null, turn: data.turn };
  }
  if (event.type === 'assistant/attempt') observation.failure = turnFailure([event], data.turn);
  if (event.type === 'turn/end') {
    const reason = data.reason?.kind || data.reason;
    observation.completion = { ...record.completion, state: reason === 'completed' ? 'answered' : 'stopped', reason, turn: data.turn };
    observation.failure = turnFailure([event], data.turn);
    if (observation.failure?.code === 'UNKNOWN' && record.failure?.turn === data.turn) observation.failure = record.failure;
  }
  if (event.type === 'request/header') {
    const config = data.header?.config || {};
    observation.requestHeader = { config: Object.fromEntries(['model', 'provider', 'reasoningEffort', 'maxTokens']
      .filter(key => config[key] !== undefined).map(key => [key, config[key]])),
      exposedTools: (data.header?.tools || []).map(tool => tool.name || tool.function?.name).filter(Boolean) };
  }
  if (['assistant/message', 'assistant/attempt'].includes(event.type) && record.requestHeader) {
    // DSH reuses epoch headers. Retain only observed fields, not requested policy
    // or tool schemas, when a bounded history no longer contains that header.
    observation.observedRequest = { ...record.requestHeader, turn: data.turn };
  }
  store.update(session.id, { ...observation, activity: activity.slice(-128), activityTruncated: record.activityTruncated || activity.length > 128 });
}

// Continue through the native inbox, not a polling model call or a synthetic
// replacement of the provider's finish reason. Claim synchronously before the
// turn/end observer returns, so waiters cannot mistake the gap for completion.
export function continueUntilAnswer({ ctx, store, session, event, reopenLead }) {
  if (event.type !== 'turn/end') return false;
  const record = store.get(session.id);
  if (!record?.policy?.continueUntilAnswer || record.role === 'finalizer') return false;
  const reason = event.data.reason?.kind || event.data.reason;
  const work = record.work?.turn === event.data.turn ? record.work : null;
  const needsMore = reason === 'max-tokens' || reason === 'completed' && (!work?.lastText?.trim() || isPreamble(work.lastText));
  if (!needsMore) {
    store.update(record.id, { completion: { ...record.completion, state: reason === 'completed' ? 'answered' : 'stopped', reason } });
    return false;
  }
  if (record.completion?.afterTurn === event.data.turn) return true;
  const agent = ctx.agents.get(record.id);
  const root = store.root(record.id);
  const signature = createHash('sha256').update(JSON.stringify([work?.lastText || '', work?.clue || '', root.ledger.toolCalls])).digest('hex');
  let blocked;
  if (!agent) blocked = 'Agent unavailable; continuation was not replayed';
  else if (signature === record.completion?.signature) blocked = 'no-progress: repeated identical output with no additional tool work';
  else if (root.policy.maxRequests != null && root.ledger.requests >= root.policy.maxRequests) blocked = 'Task request budget exhausted';
  else if (root.policy.maxDurationSeconds != null && Date.now() >= root.createdAt + root.policy.maxDurationSeconds * 1000) blocked = 'Task deadline exhausted';
  else {
    try { assertDeadline(store, record.id); store.outputAllowance(record.id, record.policy.maxOutputTokens); } catch (error) { blocked = error.message; }
  }
  if (blocked) {
    store.update(record.id, { completion: { ...record.completion, state: 'blocked', reason: blocked, afterTurn: event.data.turn } });
    return false;
  }
  const messageId = randomUUID();
  const completion = { state: 'continuing', reason, afterTurn: event.data.turn, signature, messageId,
    continuations: (record.completion?.continuations || 0) + 1 };
  store.beginDispatch(record.id, { preserveDeadline: true });
  store.update(record.id, { completion });
  queueMicrotask(async () => { try {
    // Session append observers cannot append another inbox event reentrantly.
    // The durable pending claim above remains visible throughout this boundary.
    await agent.whenIdle?.();
    const current = store.get(record.id);
    if (current?.completion?.messageId !== messageId || current.completion.state !== 'continuing' || current.dispatch?.state !== 'pending') return;
    reopenLead?.(record);
    const text = [
      'Continue the same authorized task. The preceding response was truncated or was only a preamble, not a final answer.',
      'Use the existing evidence and native conversation context; do not restart the investigation or repeat completed tool work.',
      'Continue necessary work, then give the actual answer. If blocked or unable to solve it, explicitly report what is established, what remains unresolved, and the blocker. Do not promise to work and then stop.',
      'Original full task (unchanged):', record.originalTask,
      ...(record.latestTask && record.latestTask !== record.originalTask ? ['Latest user follow-up:', record.latestTask] : []),
    ].join('\n\n');
    if (record.role !== 'lead' && record.parentId && ctx.subagents?.prompt) {
      // Reactivation through the subagent service preserves final-result delivery
      // to the actual parent; a bare inbox message would run but lose that callback.
      await ctx.subagents.prompt({ requestId: messageId, parentSessionId: record.parentId, childSessionId: record.id,
        mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal);
    } else {
      agent.followup(Object.freeze({ id: messageId, role: 'user', source: Object.freeze({ kind: 'user' }),
        content: Object.freeze([Object.freeze({ type: 'text', text })]) }));
    }
  } catch (error) {
    store.update(record.id, { completion: { ...completion, state: 'unknown', reason: error.message },
      dispatch: { ...store.get(record.id).dispatch, state: 'unknown' } });
  } });
  return true;
}
