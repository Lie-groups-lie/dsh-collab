import { createHash } from 'node:crypto';
import { fingerprint } from './schedules.mjs';

export const digestText = text => createHash('sha256').update(text).digest('hex');
export function accountingView(root) {
  const ledger = root?.ledger;
  if (!ledger) return { available: false };
  return { available: true, scope: 'shared-root-cumulative', rootId: root.id,
    requests: ledger.requests ?? null, inputTokens: ledger.inputTokens ?? null,
    outputTokens: ledger.outputTokens ?? null, toolCalls: ledger.toolCalls ?? null,
    children: ledger.children ?? null, currency: ledger.currency || null,
    configuredCostMicros: ledger.currency ? ledger.costMicros ?? null : null,
    usageMissing: ledger.usageMissing === true, inFlightRequests: Object.keys(ledger.reservations || {}).length,
    basis: ledger.usageMissing ? 'includes-conservative-reservations-not-provider-invoice' : 'recorded-usage-not-provider-invoice' };
}

export function retainedAnswer(value) {
  if (!value || typeof value.text !== 'string') return { available: false };
  return { available: true, characters: value.text.length, sha256: digestText(value.text),
    sourceTruncated: value.truncated === true, source: 'retained-visible-output',
    note: 'Retained output can include intermediate work; its presence is not acceptance.' };
}

export function deliveryEvidence({ graph, records, answers, artifacts, execution, root, stable, observedAt = Date.now() }) {
  const recordMap = new Map(records.map(row => [row.id, row]));
  const nodes = graph.nodes.slice(0, 64).map(node => {
    const record = recordMap.get(node.sessionId);
    return { sessionId: node.sessionId, parentSessionId: node.parentSessionId, title: node.title, role: node.role,
      turn: node.turn, running: node.running, state: node.state, nativeAvailable: node.nativeAvailable,
      receipt: node.submission ? { id: node.submission.id, turn: node.submission.turn,
        state: node.submission.state, outcome: node.submission.outcome?.kind || (typeof node.submission.outcome === 'string' ? node.submission.outcome : null) } : null,
      originalTaskSha256: record?.originalTask ? digestText(record.originalTask) : null,
      latestTaskSha256: record?.latestTask ? digestText(record.latestTask) : null,
      executionBuild: record?.executionBuild ? { buildId: record.executionBuild.buildId ?? null,
        sourceDigest: record.executionBuild.sourceDigest ?? null } : null,
      retainedOutput: answers.get(node.sessionId) || { available: false },
      receiptHistoryCount: record?.receiptHistory?.length || 0,
      refs: { result: { tool: 'deepseek_task_result', session_id: node.sessionId },
        trace: { tool: 'deepseek_task_trace', session_id: node.sessionId } } };
  });
  const warnings = [...graph.warnings];
  if (graph.nodes.length > nodes.length) warnings.push({ code: 'FAMILY_COVERAGE_LIMIT', included: nodes.length, total: graph.nodes.length });
  if (!stable) warnings.push({ code: 'TASK_CHANGED_DURING_READ' });
  const running = nodes.some(n => n.running === true);
  const unsettled = nodes.filter(n => n.receipt?.state !== 'settled').length;
  const failed = nodes.filter(n => ['failed', 'error', 'interrupted', 'abandoned', 'blocked'].includes(n.state)).length;
  const value = { schema: 1, kind: 'dsh-collab-delivery-evidence', observedAt, rootId: graph.rootId,
    selectedSessionId: graph.selectedId, stable, scope: 'current-family-receipts-and-current-workspace-files',
    coverage: { includedTasks: nodes.length, totalTasks: graph.nodes.length, historicalTurnsIncluded: false },
    executionState: running ? 'running' : unsettled || failed || warnings.length ? 'needs-attention' : 'settled',
    acceptance: { state: 'not-validated', note: 'Tool success and model completion are execution evidence, not proof that requirements or tests passed.' },
    summary: { running: nodes.filter(n => n.running).length, unsettled, failed,
      retainedOutputs: nodes.filter(n => n.retainedOutput.available).length,
      hashedArtifacts: artifacts.filter(a => a.state === 'hashed').length, requestedArtifacts: artifacts.length },
    tasks: nodes, artifacts, execution, accounting: accountingView(root), warnings,
    modelCalls: 0, taskMutations: 0, automaticReplay: false,
    privacy: 'Contains task titles, task IDs and relative artifact paths; inspect these before sharing. File bodies, full prompts, credential configuration and reasoning are not exported.' };
  return { ...value, digest: fingerprint(value), digestAlgorithm: 'sha256-canonical-json-excluding-digest-fields' };
}

export function recoveryPreview({ plan, records, graph, deadline, now = Date.now() }) {
  const recordMap = new Map(records.map(r => [r.id, r])), names = new Map(graph.nodes.map(n => [n.sessionId, n.title]));
  const preserved = [], interrupted = [], failures = [];
  for (const row of plan.sessions) {
    const record = recordMap.get(row.sessionId), outcome = record?.dispatch?.outcome;
    const item = { sessionId: row.sessionId, title: names.get(row.sessionId) || row.sessionId,
      turn: row.dispatch?.turn ?? null, receiptId: row.dispatch?.id ?? null, state: row.dispatch?.state ?? 'unknown' };
    if (row.unresolved) interrupted.push(item);
    else if (row.dispatch?.state === 'settled') {
      preserved.push(item);
      if (['failed', 'error', 'abandoned', 'interrupted', 'blocked'].includes(outcome?.kind || outcome)) failures.push(item);
    }
  }
  const holds = new Map((plan.recoveryHolds || []).filter(h => !h.resolution).map(h => [`${h.sessionId}:${h.callId}`, h]));
  const safeReads = [];
  for (const row of plan.sessions.filter(s => s.unresolved)) for (const tool of row.uncertainTools || []) {
    if (tool.readOnly) safeReads.push({ sessionId: tool.sessionId, callId: tool.callId, name: tool.name });
    else holds.set(`${tool.sessionId}:${tool.callId}`, tool);
  }
  const uncertain = [...holds.values()].map(h => ({ sessionId: h.sessionId, callId: h.callId,
    name: h.name, argumentsHash: h.argumentsHash, filePath: h.filePath || null }));
  const expired = deadline.at !== null && now >= deadline.at;
  const canPrepare = plan.canRecover === true && !expired;
  return { schema: 1, kind: 'dsh-collab-recovery-preview', sessionId: graph.selectedId, rootId: plan.rootId,
    observedAt: now, expectedDigest: plan.digest, canPrepare,
    state: !canPrepare ? 'blocked' : uncertain.length ? 'verification-required' : interrupted.length ? 'ready-to-prepare' : 'no-recovery-needed',
    preserved, interrupted, failures, uncertainSideEffects: uncertain, retryableReads: safeReads,
    blockers: [...plan.blockers, ...(expired ? [{ sessionId: plan.rootId, reason: 'shared-or-scheduled-deadline-expired' }] : [])],
    deadline, accounting: accountingView(recordMap.get(plan.rootId)),
    steps: [ 'Read and reuse retained results; settled branches are preserved, not rerun.',
      ...(uncertain.length ? ['Verify unknown side effects before retrying; this preview does not resolve them.'] : []),
      ...(interrupted.length ? ['Prepare supported recovery using a fresh inspection digest; keep history and cumulative usage.'] : []),
      'Continue only the remaining authorized work in the same session; execution rechecks policy, budget and deadline.' ],
    limits: ['Preview is not execution admission.', 'It cannot restore unpersisted model state or establish unknown external side effects.', 'Failed settled branches are retained as failures, not accepted deliverables.'],
    modelCalls: 0, taskMutations: 0, writesReplayed: 0, budgetsReset: false };
}
