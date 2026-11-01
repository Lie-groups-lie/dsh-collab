// Compatibility guard for DSH 0.2.1-rc.2. Lifecycle disposal is not a user
// cancellation. Keep the native durable inbox; never replay or copy messages.
const guarded = new WeakSet();
export function preserveInboxOnDisposal(agent) {
  const owner = agent?.[Symbol.for('cordis.original')] || agent;
  if (!owner || guarded.has(owner)) return;
  if (typeof owner.cancel !== 'function' || !owner.inbox || !owner.phase) {
    throw new Error('Unsupported Agent lifecycle: cannot safely preserve pending inbox on disposal');
  }
  const cancel = owner.cancel;
  Object.defineProperty(owner, 'cancel', { configurable: true, writable: true, value(cause, options) {
    if (cause?.kind !== 'disposed') return cancel.call(owner, cause, options);
    // keepInbox alone leaves a pre-existing wakeRequested set. The native kick
    // finally block would start another driver during shutdown in that case.
    if (owner.phase.kind !== 'idle') owner.phase.wakeRequested = false;
    return cancel.call(owner, cause, { ...options, keepInbox: true });
  } });
  guarded.add(owner);
}

export function mountInboxLifecycle(ctx) {
  ctx.on('agent/created', ({ agent }) => preserveInboxOnDisposal(agent), { global: true, prepend: true });
  for (const agent of ctx.agents.list()) preserveInboxOnDisposal(agent);
  // Per-instance wrappers intentionally live until that instance is disposed;
  // unmounting this plugin must not clear an inbox during the same teardown.
  return { revision: 1, disposal: 'preserve-native-inbox', explicitCancel: 'native', automaticReplay: false };
}
