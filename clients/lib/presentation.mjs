// Host-neutral readable text. Full machine data remains in structuredContent.
// This does not register DSH Agents as native Codex/Claude subagents.
const clean = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\\`*_<>\[\]]/g, '\\$&').slice(0, 200);
const state = value => ({ running: '运行中', completed: '已完成', settled: '已结算', unknown: '待核验', blocked: '被阻断', failed: '失败', unavailable: '会话不可用', pending: '待执行' })[value?.kind || value] || clean(value?.kind || value || '未提供');
const role = value => ({ lead: '主任务', child: '子任务', direct: '独立任务', relay: '工作区中转' })[value] || '任务';
export function toolText(name, value) {
  // Some hosts consume only text. Compact receipts must still expose exact IDs,
  // blockers, pagination and totals even when an answer is present.
  if (value?.receiptView?.mode === 'compact' || name === 'deepseek_tasks_start' && value?.results?.some(item => item.result?.receiptView)) return JSON.stringify(value);
  if (name === 'deepseek_task_preflight' && value?.mode === 'prospective-policy-only') {
    const summary = ['派发前预检（未创建任务）', `工作区：${clean(value.cwd)}`,
      `计划模型：${clean(value.plannedModel?.model)} · 实际可用性尚未检查`,
      `策略允许的内置工具：${(value.candidateBuiltinTools || []).map(clean).join('、') || '无'}`,
      `派发子代理：${value.delegation?.policyAllows ? '策略允许，仍需原生准入' : '策略不允许'}`,
      `被排除的内置工具：${(value.excludedBuiltinTools || []).map(clean).join('、') || '无'}`];
    if (value.child) summary.push(`子任务工具：${value.child.candidateBuiltinTools.map(clean).join('、') || '无'}`, `子任务交付：${value.child.messaging.delivery === 'final-answer' ? '最终答复' : '消息或最终答复'}`);
    for (const warning of value.warnings || []) summary.push(`[${clean(warning.scope)} / ${clean(warning.code)}] ${warning.message}`);
    summary.push('仅检查新任务的策略；未核验连接、已有会话、剩余额度或实际工具。预检不授予权限。');
    return summary.join('\n');
  }
  if (value?.reasoning) return JSON.stringify(value); // Explicit reasoning opt-in unchanged.
  if (name !== 'deepseek_task_tree' || !Array.isArray(value?.nodes)) {
    const answer = value?.answer || JSON.stringify(value);
    return value?.answer && value?.warnings?.length
      ? `${value.warnings.map(warning => `[${warning.code}] ${warning.message}`).join('\n')}\n\n${answer}` : answer;
  }
  const nodes = value.nodes, ids = new Set(nodes.map(n => n.sessionId)), children = new Map(), seen = new Set();
  for (const node of nodes) { const list = children.get(node.parentSessionId) || []; list.push(node); children.set(node.parentSessionId, list); }
  const lines = ['任务关系', `${nodes.length} 个任务 · ${value.summary?.running ?? '未知'} 个运行中 · ${value.summary?.unresolved ?? '未知'} 个待结算`, ''];
  let shown = 0;
  const walk = start => {
    const stack = [{node:start,depth:0}];
    while (stack.length && shown < 200) {
      const {node,depth} = stack.pop(); if (seen.has(node.sessionId)) continue;
      seen.add(node.sessionId); shown++;
      const title = node.title && node.title !== node.sessionId ? node.title : `未命名${role(node.role)}`;
      lines.push(`${'  '.repeat(Math.min(depth, 8))}- ${clean(title)} · ${role(node.role)} · ${state(node.state)}${node.archived ? ' · 已归档' : ''}${node.sessionId === value.selectedId ? ' · 当前任务' : ''}`);
      for (const child of (children.get(node.sessionId) || []).slice().reverse()) stack.push({node:child,depth:depth+1});
    }
  };
  nodes.filter(n => !ids.has(n.parentSessionId)).forEach(walk);
  nodes.forEach(n => { if (!seen.has(n.sessionId)) walk(n); });
  if (shown < nodes.length) lines.push(`仅展示前 ${shown} 个节点，完整关系保留在结构化结果中。`);
  if (value.warnings?.length) lines.push('部分关系或会话待核验，不能把缺失节点视为已完成。');
  lines.push('', `当前会话 ID：${clean(value.selectedId)}`, '已结算不代表执行成功；精确 ID、父关系与回执见结构化结果。');
  return lines.join('\n');
}
