import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Explicit relative files only; no directory scan, terminal, imports or writes.
export async function hashArtifacts(cwd, files, signal) {
  if (!path.isAbsolute(cwd || '')) throw new Error('Native workspace identity is unavailable');
  const root = await fs.realpath(cwd), results = []; let total = 0;
  for (const relative of files) {
    signal?.throwIfAborted();
    if (path.isAbsolute(relative) || /^[a-z]:|\\|:/i.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Artifacts require normalized workspace-relative paths');
    let handle;
    try {
      let target = root;
      for (const component of relative.split('/')) {
        target = path.join(target, component);
        if ((await fs.lstat(target)).isSymbolicLink()) throw Object.assign(new Error(), { code: 'SYMLINK' });
      }
      const real = await fs.realpath(target);
      const within = path.relative(root, real);
      if (!within || within.startsWith('..') || path.isAbsolute(within)) throw Object.assign(new Error(), { code: 'OUTSIDE' });
      const before = await fs.stat(real);
      if (!before.isFile() || before.nlink > 1) throw Object.assign(new Error(), { code: 'NOT_REGULAR' });
      if (before.size > 16 * 1024 * 1024 || total + before.size > 64 * 1024 * 1024) {
        results.push({ path: relative, state: 'size-limit' }); continue;
      }
      handle = await fs.open(real, 'r');
      const opened = await handle.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw Object.assign(new Error(), { code: 'CHANGED' });
      const hash = createHash('sha256'), chunk = Buffer.alloc(65536); let bytes = 0;
      while (true) {
        signal?.throwIfAborted();
        const read = await handle.read(chunk, 0, chunk.length, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead; total += read.bytesRead;
        if (bytes > 16 * 1024 * 1024 || total > 64 * 1024 * 1024) throw Object.assign(new Error(), { code: 'CHANGED' });
        hash.update(chunk.subarray(0, read.bytesRead));
      }
      const after = await handle.stat(), current = await fs.stat(real);
      const stable = before.size === bytes && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
        && current.ino === after.ino && current.dev === after.dev && current.size === after.size
        && current.mtimeMs === after.mtimeMs && current.ctimeMs === after.ctimeMs;
      results.push({ path: relative, state: stable ? 'hashed' : 'changed-during-read', ...(stable ? { bytes, sha256: hash.digest('hex') } : {}),
        source: 'current-workspace-snapshot', causalAttribution: 'not-established' });
    } catch (error) {
      signal?.throwIfAborted();
      results.push({ path: relative, state: error.code === 'ENOENT' ? 'missing' : error.code === 'CHANGED' ? 'changed-during-read' : 'unreadable-or-disallowed' });
    } finally { await handle?.close(); }
  }
  return results;
}
