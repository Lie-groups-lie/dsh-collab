import path from 'node:path';
import { fingerprint } from './schedules.mjs';

const READS = new Set(['read', 'glob', 'grep', 'read_image', 'web_search', 'list_agents', 'job_list', 'job_output']);
function argsOf(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { return {}; }
}
export function recoveryEvidence(events, record, cwd = '') {
  const turn = record.dispatch?.turn ?? (record.dispatch?.afterTurn || 0) + 1;
  const calls = new Map();
  let lastTurn = 0, end = null;
  for (const event of events) {
    const d = event.data || {};
    if (Number.isInteger(d.turn)) lastTurn = Math.max(lastTurn, d.turn);
    if (d.turn !== turn) continue;
    if (event.type === 'turn/end') end = d.reason?.kind || d.reason;
    if (event.type === 'tool/call') calls.set(d.callId, { sessionId: record.id, callId: d.callId,
      name: d.name, turn, seq: event.seq, argumentsHash: fingerprint(argsOf(d.arguments)),
      ...(argsOf(d.arguments).file_path ? { filePath: path.resolve(cwd, String(argsOf(d.arguments).file_path)) } : {}) });
    if (event.type === 'tool/result') {
      const id = d.message?.source?.callId || d.message?.toolCallId || d.callId;
      if (!['TOOL_OUTCOME_UNKNOWN'].includes(d.error?.code)) calls.delete(id);
    }
  }
  return { turn, lastTurn, nativeOutcome: end || 'interrupted',
    uncertainTools: [...calls.values()].map(call => ({ ...call, readOnly: READS.has(call.name) })) };
}

// Evidence is linked, not copied into a new task or flattened into a lossy transcript.
export function recoveryPrompt(record, receipt) {
  return [
    'RECOVER_EXISTING_COLLAB_TASK: Continue this same Lead and original authorized project after a process interruption.',
    'Do not restart the investigation, recreate completed children, or repeat completed tools. Reuse their native results and existing files.',
    'First synthesize the completed work, then perform only the remaining authorized steps. This is a continuation, not a replay of the interrupted request.',
    `Recovery receipt: ${receipt.reconciliationId}`,
    `Preserved completed child session IDs: ${receipt.preservedSessions.join(', ') || '(none)'}`,
    `Uncertain tool calls (not proof of success): ${JSON.stringify(receipt.uncertainTools)}`,
    'Read-only interrupted operations may be retried. Uncertain writes/external operations must first be verified; matching side effects remain host-blocked until a supported recovery resolution is recorded.',
    'Original full task (unchanged):', record.originalTask || '',
    ...(record.latestTask && record.latestTask !== record.originalTask ? ['Previous follow-up:', record.latestTask] : []),
  ].join('\n\n');
}

export function recoveryToolDenial(store, taskId, name, rawArgs, cwd = '') {
  const root = store.root(taskId), args = argsOf(rawArgs);
  const holds = (root.recoveryHolds || []).filter(hold => !hold.resolution);
  for (const hold of holds) {
    if (READS.has(name)) continue;
    if (['bash', 'exec', 'pwsh', 'run_code', 'shell', 'terminal'].includes(name)) {
      return `Recovery holds terminal access until uncertain side effect ${hold.callId} is verified; existing terminal policy is not expanded.`;
    }
    if (hold.filePath && ['write', 'edit'].includes(name) && args.file_path) {
      const normalize = p => { const v = path.resolve(cwd, p); return process.platform === 'win32' ? v.toLowerCase() : v; };
      if (normalize(hold.filePath) !== normalize(String(args.file_path))) continue;
    } else if (name !== hold.name) continue;
    return `Recovery requires verification of uncertain ${hold.name} call ${hold.callId}; this side effect was not replayed. Inspect/resume via deepseek_task_reconcile with verified tool_resolutions.`;
  }
  if (root.dispatch?.recoveryId && ['send_message', 'subagent', 'subagent_fork'].includes(name)) {
    const targetIds = new Set(root.recovery?.preservedSessions || []);
    if (Object.values(args).some(value => typeof value === 'string' && targetIds.has(value))) {
      return 'Recovery preserves this completed child. Read its existing result instead of rerunning it.';
    }
  }
  return null;
}
