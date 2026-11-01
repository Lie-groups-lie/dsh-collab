import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonical } from './canonical.mjs';

export const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// Coordinates local MCP processes, separately from the native-only policy store.
// A live owner is never evicted by a timeout; uncertain writes are never replayed.
export async function withOperationLock(directory, scope, operation, timeoutMs = 30000) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${digest(scope)}.lock`);
  const token = randomUUID(), deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(filename, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch {}
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (failure) {
          if (failure.code === 'ESRCH') throw new Error('A crashed client left a workspace lock; inspect its operation journal before explicit recovery');
          if (failure.code !== 'EPERM') throw failure;
        }
      }
      if (Date.now() >= deadline) throw new Error('Workspace operation is busy or has an unreadable lock; no submission was repeated');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try { return await operation(); }
  finally { if (JSON.parse(fs.readFileSync(filename, 'utf8')).token === token) fs.unlinkSync(filename); }
}

export async function journaledOperation(directory, key, spec, operation) {
  const filename = path.join(directory, `${digest(key)}.json`), fingerprint = digest(spec);
  if (fs.existsSync(filename)) {
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (record.fingerprint !== fingerprint) throw new Error('Idempotency key reused with a different creation request');
    if (!record.receipt) throw new Error('Session creation outcome is uncertain; inspect the workspace before retrying with a new key');
    return record.receipt;
  }
  const write = (value) => {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
  };
  write({ fingerprint, createdAt: Date.now() });
  const receipt = await operation();
  write({ fingerprint, receipt });
  return receipt;
}
