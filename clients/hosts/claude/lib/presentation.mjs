// Host-neutral readable text. Full machine data remains in structuredContent.
// This does not register DSH Agents as native Codex/Claude subagents.
const clean = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\\`*_<>\[\]]/g, '\\$&').slice(0, 200);
const state = value => ({ running: '运行中', completed: '已完成', settled: '已结算', unknown: '待核验', blocked: '被阻断', failed: '失败', unavailable: '会话不可用', pending: '待执行' })[value?.kind || value] || clean(value?.kind || value || '未提供');
const role = value => ({ lead: '主任务', child: '子任务', direct: '独立任务', relay: '工作区中转' })[value] || '任务';
export function toolText(name, value) {
  if (value?.reasoning) return JSON.stringify(value); // Explicit reasoning opt-in unchanged.
  if (name !== 'deepseek_task_tree' || !Array.isArray(value?.nodes)) return value?.answer || JSON.stringify(value);
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
