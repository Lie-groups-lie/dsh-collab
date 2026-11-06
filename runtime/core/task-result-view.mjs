// One projection for the paged result used by the DSH UI and external hosts.
// Keep policy diagnostics even when callers omit the original task text.
export function taskResultView(result, { offset = 0, limit = 12000, artifact = null, includeTask = false, originalTask = null } = {}) {
  const text = result.answer || '';
  return { sessionId: result.sessionId, turnId: result.turnId, status: result.status, running: result.running,
    childrenPending: result.childrenPending, text: text.slice(offset, offset + limit), totalChars: text.length,
    nextOffset: offset + limit < text.length ? offset + limit : null,
    sourceTruncated: result.answerTruncated, ...(!result.finalization?.answer && artifact?.totalChars ? artifact : {}),
    finalization: result.finalization, usage: result.usage, error: result.error, failure: result.failure,
    diagnostic: result.diagnostic, admission: result.admission, admissionBlock: result.admissionBlock,
    effectiveDeadline: result.effectiveDeadline, reconciliation: result.reconciliation,
    recovery: result.recovery, recoveryHolds: result.recoveryHolds,
    warnings: result.warnings || [], delegation: result.delegation ?? null, messaging: result.messaging ?? null,
    childCapabilities: result.childCapabilities ?? null, exposedTools: result.exposedTools ?? [],
    model: result.model, provider: result.provider, permission: result.permission,
    finishReason: result.finishReason, toolCalls: result.progress?.toolCalls || [],
    activity: result.activity, activityTruncated: result.activityTruncated, completion: result.completion,
    progress: { step: result.progress?.step, turn: result.turnId }, budgetLedger: result.budgetLedger, budgetPolicy: result.budgetPolicy,
    ...(includeTask ? { originalTask, effectivePolicy: result.effectivePolicy } : {}) };
}
