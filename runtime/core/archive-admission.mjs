// Match DSH's native archive gate. Forks are independent; durable Collab
// budget/parent relationships must not be substituted for native headers.
export function archiveAdmission(sessionId, sessions, archivedIds) {
  const archived = new Set(archivedIds || []);
  const rows = sessions instanceof Map ? sessions : new Map(sessions.map(row => [row.sessionId || row.id, row]));
  const chain = [], seen = new Set();
  let id = sessionId;
  while (id && !seen.has(id)) {
    chain.push(id); seen.add(id);
    if (archived.has(id)) {
      const row = rows.get(id), scope = id === sessionId ? 'self' : 'ancestor';
      return { blocked: true, code: 'DSH_SESSION_ARCHIVED', source: 'native-archive-gate', sessionId,
        blockingSessionId: id, blockingTitle: row?.projections?.values?.title || row?.title || id, scope, chain,
        message: `DSH ${scope === 'self' ? '会话' : '父级会话'} ${id} 已归档，原生规则阻止继续执行。请明确恢复该会话的归档；恢复不会发送消息或重跑任务。` };
    }
    const row = rows.get(id);
    if (row?.origin !== 'subagent') break;
    id = row.parentSessionId || row.parentSession;
  }
  return { blocked: false, source: 'native-archive-gate', sessionId, chain };
}

export function assertArchiveAdmission(admission) {
  if (admission.blocked) throw Object.assign(new Error(admission.message), { code: admission.code, admission });
}

// Read only already-loaded native sessions, exactly as the native gate does.
// Do not hydrate agents, rewrite receipts or silently unarchive an ancestor.
export function liveArchiveAdmission(ctx, session) {
  const rows = new Map(), seen = new Set();
  let header = session?.header;
  while (header && !seen.has(header.id)) {
    seen.add(header.id); rows.set(header.id, header);
    if (header.origin !== 'subagent' || !header.parentSession) break;
    header = ctx.sessions.get(header.parentSession)?.header;
  }
  return archiveAdmission(session.id || session.header.id, rows, ctx.workspaceRegistry.archivedSessionIds);
}
