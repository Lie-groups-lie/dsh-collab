import fs from 'node:fs';
import path from 'node:path';
import { TaskStore } from './task-store.mjs';

// Read-only projection index. Revalidate atomic file identity on every read.
// Native policy/budget enforcement never consumes this cache.
export class TaskIndex {
  constructor(directory, { limit = 1024 } = {}) {
    this.directory = path.resolve(directory); this.store = new TaskStore(directory);
    this.cache = new Map(); this.limit = limit;
  }
  identities(ids) { return this.list(ids, { identityOnly: true }); }
  list(ids, { identityOnly = false } = {}) {
    let files;
    try { files = fs.readdirSync(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const available = new Set(files.filter(name => /^[a-zA-Z0-9_-]{1,160}\.json$/.test(name)).map(name => name.slice(0, -5)));
    for (const id of this.cache.keys()) if (!available.has(id)) this.cache.delete(id);
    const result = [];
    for (const id of ids || available) {
      if (!available.has(id)) continue;
      let stat;
      try { stat = fs.statSync(this.store.filename(id), { bigint: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      let entry = this.cache.get(id);
      if (entry?.stamp !== stamp) {
        const record = this.store.get(id);
        const row = record?.policy ? {
          id, rootId: record.rootId, parentId: record.parentId, role: record.role,
          title: record.originalTask?.slice(0, 96) || '', createdAt: record.createdAt,
          revision: record.revision, dispatch: record.dispatch, lastTurn: record.lastTurn,
          completion: record.completion && { state: record.completion.state, reason: record.completion.reason },
          recovery: record.recovery && { id: record.recovery.id, state: record.recovery.state, preservedSessions: record.recovery.preservedSessions },
          finalizations: Object.values(record.finalizations || {}).map(value => ({ status: value.status, sessionId: value.sessionId })),
        } : null;
        entry = { stamp, row, identity: record ? { id, role: record.role, parentId: record.parentId } : null };
      }
      this.cache.delete(id); this.cache.set(id, entry);
      const value = identityOnly ? entry.identity : entry.row;
      if (value) result.push(value);
    }
    while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
    return result;
  }
}

const indexes = new Map();
export function taskIndex(directory) {
  const key = path.resolve(directory);
  let index = indexes.get(key);
  if (!index) { index = new TaskIndex(key); indexes.set(key, index); }
  while (indexes.size > 8) indexes.delete(indexes.keys().next().value);
  return index;
}
