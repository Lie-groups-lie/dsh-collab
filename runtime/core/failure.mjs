// Only public failure facts, never request headers, response bodies or stacks.
export function failureInfo(value, source, turn) {
  const message = typeof value === 'string' ? value : value?.message;
  return {
    message: typeof message === 'string' && message.trim() ? message.slice(0, 2000) : 'Task failed; the runtime did not retain a detailed error.',
    code: typeof value?.code === 'string' ? value.code.slice(0, 100) : 'UNKNOWN',
    ...(Number.isInteger(value?.status) ? { status: value.status } : {}), source, turn,
  };
}

export function turnFailure(events, turn) {
  const current = events.filter(e => !turn || e.data?.turn === turn);
  const end = current.findLast(e => e.type === 'turn/end');
  const reason = end?.data?.reason;
  if (end && (reason?.kind || reason) !== 'error') return null;
  if (reason?.error || reason?.failure) return failureInfo(reason.error || reason.failure, 'turn/end', turn);
  for (let i = current.length - 1; i >= 0; i--) {
    const event = current[i];
    if (['agent/error', 'turn/error'].includes(event.type)) return failureInfo(event.data?.error || event.data?.message, event.type, turn);
    if (event.type === 'assistant/message' && !end) break; // A later successful attempt supersedes an earlier failure.
    if (event.type !== 'assistant/attempt') continue;
    const stream = event.data?.stream || [];
    for (let j = stream.length - 1; j >= 0; j--) {
      const chunk = stream[j].chunk;
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') return failureInfo(chunk.reason.failure || chunk.reason.error, 'assistant/attempt', turn);
      if (chunk?.type === 'error') return failureInfo(chunk.error || chunk, 'assistant/attempt', turn);
    }
  }
  return end ? failureInfo(null, 'turn/end', turn) : null;
}
