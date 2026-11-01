export const reconciliationTool = {
  name: 'deepseek_task_reconcile',
  description: 'Inspect or recover an interrupted task in the same session, preserving completed children, native history, files and cumulative budgets. Recover prepares safe continuation without model execution or replay; unknown side effects require verified tool_resolutions. Abandon is only for explicitly unwanted work, never required for ordinary recovery.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['session_id'],
    properties: {
      session_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,160}$' },
      action: { type: 'string', enum: ['inspect', 'recover', 'abandon'], default: 'inspect' },
      expected_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      request_key: { type: 'string', minLength: 1, maxLength: 160 },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
      tool_resolutions: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false,
        required: ['session_id', 'call_id', 'outcome', 'evidence'], properties: {
          session_id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,160}$' },
          call_id: { type: 'string', minLength: 1, maxLength: 200 },
          outcome: { type: 'string', enum: ['verified-completed', 'verified-not-executed'] },
          evidence: { type: 'string', minLength: 1, maxLength: 2000 },
        } } },
    } },
  outputSchema: { type: 'object', additionalProperties: true },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

// Counts only. No prompt/transcript is copied into the audit or API response.
export function inboxCounts(events) {
  const inbox = pendingInbox(events);
  return Object.fromEntries(Object.entries(inbox).map(([key, value]) => [key, value.length]));
}

export function pendingInbox(events) {
  const inbox = { 'next-turn': [], 'next-step': [] };
  for (const e of events) if (e.type === 'agent/inbox/spliced') {
    const d = e.data, removed = d.removedCount ?? 0, current = inbox[d.target];
    if (!Array.isArray(current) || !Number.isSafeInteger(d.start) || d.start < 0 || d.start > current.length
        || !Number.isSafeInteger(removed) || removed < 0 || d.start + removed > current.length || !Array.isArray(d.inserted)) {
      throw new Error('Native inbox prefix is incomplete; reconciliation refused');
    }
    current.splice(d.start, removed, ...d.inserted.map(message => ({ id: message.id, source: message.source })));
  }
  return inbox;
}
