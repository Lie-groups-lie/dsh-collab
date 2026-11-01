// Human-readable projection of native evidence, not a reconstruction of private
// reasoning or invented progress. Individual long records are read in chunks.
const labels = { 'user/message': '任务 / 消息', 'assistant/message': '模型输出', 'assistant/attempt': '未完成的模型输出',
  'tool/call': '工具调用', 'tool/result': '工具返回', 'turn/start': '开始执行', 'turn/end': '本轮结束', 'request/header': '模型与工具配置',
  'agent/inbox/spliced': '待处理消息队列' };
function text(blocks) { return (blocks || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n'); }
export function traceEvent(entry, { offset = 0, limit = 12000 } = {}) {
  const event = entry?.event || entry;
  if (!event || !labels[event.type]) return null;
  const d = event.data || {};
  let body = '';
  if (['user/message', 'assistant/message', 'assistant/attempt'].includes(event.type)) {
    body = text(d.message?.content || d.content);
    if (!body) body = (d.stream || []).filter(part => part.type === 'text-chunks').map(part => (part.texts || []).join('')).join('\n');
    if (!body && event.type !== 'user/message') body = '本次没有可见文本（可能只有推理或工具请求）；这不表示任务完成。';
  } else if (event.type === 'tool/call') body = JSON.stringify(d.arguments ?? {}, null, 2);
  else if (event.type === 'tool/result') body = text(d.message?.content || d.content) || JSON.stringify({ error: d.error || null, meta: d.meta || null }, null, 2);
  else if (event.type === 'request/header') body = JSON.stringify({ config: d.header?.config, tools: (d.header?.tools || []).map(tool => tool.name) }, null, 2);
  else if (event.type === 'turn/end') body = JSON.stringify(d.reason ?? {}, null, 2);
  else if (event.type === 'agent/inbox/spliced') body = JSON.stringify({ target: d.target, start: d.start, removedCount: d.removedCount,
    outcome: d.outcome || 'queued', inserted: (d.inserted || []).map(message => ({ id: message.id, source: message.source })) }, null, 2);
  return { seq: event.seq, time: event.time, type: event.type, label: labels[event.type], turn: d.turn, step: d.step,
    source: d.source?.kind || d.message?.source?.kind, name: d.name, callId: d.callId || d.message?.callId,
    isError: Boolean(d.message?.isError || d.isError || d.error || event.type === 'turn/end' && (d.reason?.kind || d.reason) === 'error'), text: body.slice(offset, offset + limit), totalChars: body.length,
    offset, nextOffset: offset + limit < body.length ? offset + limit : null };
}
