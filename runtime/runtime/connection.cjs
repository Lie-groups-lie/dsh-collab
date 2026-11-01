const fs = require('node:fs');
const { readEvidence } = require('./lifecycle.cjs');
const identityModule = () => import('../core/process-identity.mjs');

function runtimeEntryPresent(runtime) {
  if (typeof runtime.entry !== 'string') return false;
  if (fs.existsSync(runtime.entry)) return true;
  // A normal Node MCP process cannot stat files inside Electron ASAR archives.
  // This is a diagnostic only, never permission to execute an arbitrary entry.
  const match = runtime.hostManaged && runtime.hostRegistrationApi === 1 && /^(.*\.asar)[\\/]/i.exec(runtime.entry);
  return Boolean(match && fs.existsSync(match[1]) && fs.statSync(match[1]).isFile());
}

async function inspectProcess(runtime) {
  const pid = runtime.dshPid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  const actual = (await identityModule()).processIdentity(pid, runtime.processIdentity);
  if (actual.state === 'alive' && runtime.processIdentity && actual.identity !== runtime.processIdentity) return { state: 'replaced' };
  return actual;
}
function refreshPointer(runtime) {
  try {
    if (!runtime.runtimeFile) return false;
    const next = JSON.parse(fs.readFileSync(runtime.runtimeFile, 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(next.url || '')
      || next.collabStateDirectory !== runtime.collabStateDirectory
      || (next.url === runtime.url && next.launchUrl === runtime.launchUrl && next.instanceId === runtime.instanceId)) return false;
    Object.assign(runtime, next); return true;
  } catch { return false; }
}
async function connectionError(runtime, cause, { readOnly = false } = {}) {
  if (String(cause?.code || '').startsWith('DSH_')) return cause;
  const code = cause?.cause?.code || cause?.code;
  const isNetwork = /fetch failed|WebSocket connection|stream closed|timeout|aborted/i.test(cause?.message || '')
    || ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT'].includes(code);
  if (!isNetwork) return cause;
  const identity = await inspectProcess(runtime);
  const evidence = readEvidence(runtime.lifecycleFile);
  const ownEvidence = evidence?.instanceId === runtime.instanceId ? evidence : null;
  const owner = readEvidence(runtime.lifecycleFile ? `${runtime.lifecycleFile}.owner` : null);
  const dead = ['dead', 'replaced'].includes(identity.state);
  const timeout = /timeout|timed out/i.test(cause?.message || '') || cause?.name === 'TimeoutError';
  const error = new Error(`[${dead ? 'DSH_RUNTIME_EXITED' : timeout ? 'DSH_RUNTIME_TIMEOUT' : 'DSH_RUNTIME_UNREACHABLE'}] `
    + `${dead ? 'DSH 后台已退出或进程身份已变化' : timeout ? 'DSH 后台响应超时，不能据此认定任务失败' : 'DSH 后台连接中断'}（${runtime.url}）。`
    + (readOnly ? '本次只读查询未启动任务。' : '提交结果可能不确定；请按原任务句柄/request_key 核对，不要重复提交。')
    + '没有自动重启或重放任务。', { cause });
  error.code = dead ? 'DSH_RUNTIME_EXITED' : timeout ? 'DSH_RUNTIME_TIMEOUT' : 'DSH_RUNTIME_UNREACHABLE';
  error.runtimeDiagnostic = { instanceId: runtime.instanceId || null, pid: runtime.dshPid || null,
    processState: identity.state, transportCode: /^[A-Z0-9_]+$/.test(code || '') ? code : null,
    exitCode: ownEvidence?.exitCode ?? (owner && owner.instanceId === runtime.instanceId ? owner.exitCode : null),
    evidenceFile: runtime.lifecycleFile || null, outcome: readOnly ? 'read-failed' : 'unknown' };
  return error;
}
async function connected(runtime, readOnly, operation) {
  try { return await operation(); }
  catch (error) {
    const transient = /fetch failed|WebSocket connection|stream closed|timeout|aborted/i.test(error?.message || '');
    if (readOnly && transient && refreshPointer(runtime)) {
      try { return await operation(); } catch (retryError) { throw await connectionError(runtime, retryError, { readOnly }); }
    }
    throw await connectionError(runtime, error, { readOnly });
  }
}
module.exports = { connected, connectionError, inspectProcess, refreshPointer, runtimeEntryPresent };
