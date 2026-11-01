import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const RESULT_MAX_CHARS = 1000000;
export class ResultStore {
  constructor(directory) { this.directory = path.join(directory, 'results'); }
  filename(id, turn) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id) || !Number.isSafeInteger(turn) || turn < 1) throw new Error('Invalid result identity');
    return path.join(this.directory, `${id}.${turn}.json`);
  }
  get(id, turn) {
    try { return JSON.parse(fs.readFileSync(this.filename(id, turn), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  record(id, event) {
    if (!['assistant/message', 'assistant/attempt'].includes(event.type)) return;
    const { turn, step } = event.data;
    if (!Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(step)) return;
    let visible = (event.data.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
    if (!visible) for (const part of event.data.stream || []) if (part.type === 'text-chunks') for (const text of part.texts || []) visible += text;
    const value = this.get(id, turn) || { sessionId: id, turn, steps: {}, truncated: false };
    const previous = value.steps[step];
    if (!visible && previous?.text) return; // failure cannot erase a partial
    const others = Object.entries(value.steps).filter(([key]) => Number(key) !== step).reduce((n, [, v]) => n + v.text.length + 2, 0);
    const capacity = Math.max(0, RESULT_MAX_CHARS - others);
    value.steps[step] = { text: visible.slice(0, capacity), seq: event.seq, committed: event.type === 'assistant/message' };
    value.truncated ||= visible.length > capacity;
    value.text = Object.entries(value.steps).sort(([a], [b]) => Number(a) - Number(b)).map(([, v]) => v.text).filter(Boolean).join('\n\n');
    value.revision = createHash('sha256').update(value.text).digest('hex');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.filename(id, turn), temporary = `${filename}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
  }
  page(id, turn, { offset = 0, limit = 12000, revision } = {}) {
    const value = this.get(id, turn);
    if (!value) return null;
    if (revision && revision !== value.revision) throw new Error('Result changed; restart pagination at offset 0');
    return { revision: value.revision, text: value.text.slice(offset, offset + limit), totalChars: value.text.length,
      nextOffset: offset + limit < value.text.length ? offset + limit : null, sourceTruncated: value.truncated };
  }
}
