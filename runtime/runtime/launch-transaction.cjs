// Runtime startup coordination only. Never reclaim a session-operation lock.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function launchError(message) {
  return Object.assign(new Error(`DSH 启动恢复：${message}。未启动第二个后台，未重放任务。`), { code: 'DSH_RUNTIME_LAUNCH_UNRESOLVED' });
}
function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw launchError('启动记录格式异常，请保留现场');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function launchPaths(runtimeFile) {
  runtimeFile = path.resolve(runtimeFile);
  const directory = path.join(path.dirname(runtimeFile), 'runtime-launch-locks');
  const key = hash(JSON.stringify(runtimeFile)); // Same marker name as older desktop versions.
  const real = path.join(fs.realpathSync(path.dirname(runtimeFile)), path.basename(runtimeFile));
  const leaseKey = hash(process.platform === 'win32' ? real.toLowerCase() : real);
  // Kernel-owned leases disappear even after a crash. No timer evicts a live owner.
  const endpoint = process.platform === 'win32' ? { path: `\\\\.\\pipe\\dsh-collab-launch-${leaseKey}` }
    : process.platform === 'linux' ? { path: `\0dsh-collab-launch-${leaseKey}` }
      : { host: '127.0.0.1', port: 49152 + (parseInt(leaseKey.slice(0, 8), 16) % 16384), exclusive: true };
  return { directory, marker: path.join(directory, `${key}.lock`), journal: path.join(directory, `${key}.launch.json`), endpoint };
}
async function acquire(endpoint, deadline) {
  while (true) {
    const server = net.createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
      return server;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline) throw launchError('另一启动入口仍持有启动租约，请稍后重试');
      await pause(100);
    }
  }
}
async function withLaunchTransaction(runtimeFile, operation, { timeoutMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true, mode: 0o700 });
  const paths = launchPaths(runtimeFile), deadline = Date.now() + timeoutMs;
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const lease = await acquire(paths.endpoint, deadline);
  let token;
  try {
    const { processIdentity } = await import('../core/process-identity.mjs');
    let previous;
    while ((previous = readJson(paths.marker))) {
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw launchError('启动锁身份不可读');
      const owner = processIdentity(previous.pid, previous.identity);
      if (owner.state === 'dead' || owner.state === 'replaced' && previous.identity
        || owner.state === 'alive' && previous.identity && previous.identity !== owner.identity) break;
      if (owner.state !== 'alive') throw launchError('无法核验启动锁持有者身份');
      if (Date.now() >= deadline) throw launchError('旧版启动入口仍在运行，请等待它结束');
      await pause(100);
    }
    let record = readJson(paths.journal);
    if (record && (record.schema !== 1 || record.runtimeFile !== path.resolve(runtimeFile))) throw launchError('启动日志不属于此连接');
    if (!record) {
      record = { schema: 1, runtimeFile: path.resolve(runtimeFile), phase: previous ? 'legacy' : 'idle',
        ...(previous ? { legacyOwner: previous.pid, legacyLockTime: fs.statSync(paths.marker).mtimeMs } : {}) };
      writeJson(paths.journal, record); // Persist migration context before replacing the old marker.
    }
    const self = processIdentity(process.pid);
    if (self.state !== 'alive' || !self.identity) throw launchError('无法核验当前启动进程身份');
    token = randomUUID();
    writeJson(paths.marker, { schema: 2, pid: process.pid, identity: self.identity, token });
    const transaction = {
      get record() { return record; },
      update(fields) { record = { ...record, ...fields, updatedAt: Date.now() }; writeJson(paths.journal, record); },
      reset(fields) { record = { schema: 1, runtimeFile: path.resolve(runtimeFile), ownerIdentity: self.identity, ...fields, updatedAt: Date.now() }; writeJson(paths.journal, record); },
    };
    return await operation(transaction);
  } finally {
    try { if (token && readJson(paths.marker)?.token === token) fs.unlinkSync(paths.marker); } catch {}
    await new Promise(resolve => lease.close(resolve));
  }
}

module.exports = { withLaunchTransaction, launchPaths, launchError, readJson, writeJson };
