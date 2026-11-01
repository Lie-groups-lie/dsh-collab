const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const lifecycle = require('./lifecycle.cjs');
const { inspectProcess, runtimeEntryPresent } = require('./connection.cjs');
const { withLaunchTransaction, launchError, readJson, writeJson } = require('./launch-transaction.cjs');

function versionKey(version = '0') {
  return (String(version).match(/\d+/g) || [0]).map(Number);
}

function compareVersions(left, right) {
  const a = versionKey(left);
  const b = versionKey(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function packageCandidate(packageJson) {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    if (parsed.name !== '@deepseek-ai/dsh') return null;
    const relativeBin = parsed.bin && parsed.bin.dsh;
    if (typeof relativeBin !== 'string') return null;
    const entry = path.resolve(path.dirname(packageJson), relativeBin);
    if (!fs.existsSync(entry)) return null;
    return { entry, version: String(parsed.version || 'unknown') };
  } catch {
    return null;
  }
}

function findNode() {
  if (process.env.DSH_DESKTOP_NODE && fs.existsSync(process.env.DSH_DESKTOP_NODE)) {
    return process.env.DSH_DESKTOP_NODE;
  }
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const first = probe.status === 0 ? probe.stdout.split(/\r?\n/).find(Boolean) : null;
  return first || 'node';
}

function hiddenSpawnNodeOptions(existing = process.env.NODE_OPTIONS || '') {
  if (process.platform !== 'win32') return existing;
  const preload = path.join(__dirname, 'windows-hide-spawn.cjs').replaceAll('\\', '/');
  const quoted = `--require="${preload}"`;
  return [existing, quoted].filter(Boolean).join(' ');
}

function findDsh(options = {}) {
  const explicit = options.explicit || process.env.DSH_DESKTOP_DSH_PATH;
  if (explicit) {
    const entry = path.resolve(explicit.replace(/^"|"$/g, ''));
    const packageInfo = packageCandidate(path.resolve(path.dirname(entry), '..', 'package.json'));
    if (packageInfo?.entry === entry) return { ...packageInfo, source: '显式 DSH 入口' };
    throw new Error('Explicit DSH entry must belong to an installed @deepseek-ai/dsh package.');
  }

  const roots = [];
  const bundled = packageCandidate(path.resolve(__dirname, '..', '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  if (bundled) return { ...bundled, source: '固定运行时依赖' };
  roots.push(path.join(options.cwd || process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const npxRoot = path.join(localAppData, 'npm-cache', '_npx');
    try {
      for (const cacheId of fs.readdirSync(npxRoot)) {
        roots.push(path.join(npxRoot, cacheId, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
      }
    } catch {
      // The npx cache is optional.
    }
  }

  const candidates = roots.map(packageCandidate).filter(Boolean);
  // A shipped/tested runtime takes precedence over unrelated npx caches.
  const pinned = packageCandidate(roots[0]);
  if (pinned) return { ...pinned, source: '项目依赖' };
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  if (candidates.length > 0) {
    return { ...candidates[0], source: candidates[0].entry.includes(`${path.sep}_npx${path.sep}`) ? 'npm 缓存' : '项目依赖' };
  }
  return null;
}

function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function writeBridgePatch(options = {}) {
  const plugin = path.resolve(options.bridgePlugin || path.resolve(__dirname, '..', 'native', 'index.mjs'));
  if (!fs.existsSync(plugin)) return null;
  const directory = path.join(os.tmpdir(), 'deepseek-harness-desktop');
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `bridge-${process.pid}-${Date.now()}.patch.yml`);
  const pluginUrl = pathToFileURL(plugin).href;
  const extensions = options.extensions || [];
  const items = extensions.map((entry, index) => {
    const resolved = fs.realpathSync(entry);
    return `    - id: collab-extension-${index}\n      name: ${JSON.stringify(pathToFileURL(resolved).href)}\n`;
  }).join('');
  fs.writeFileSync(filename, `- insert:\n    - id: codex-subagent-bridge\n      name: ${JSON.stringify(pluginUrl)}\n${items}`, 'utf8');
  return filename;
}

function checkStartupFailure(handshakeFile) {
  if (!handshakeFile) return;
  const filename = `${handshakeFile}.error`;
  if (!fs.existsSync(filename)) return;
  if (fs.statSync(filename).size > 4096) throw new Error('DSH 启动诊断文件异常');
  const failure = JSON.parse(fs.readFileSync(filename, 'utf8'));
  throw new Error(`DSH 启动失败 [${failure.code}]: ${failure.message}`);
}

async function waitForReady(url, child, timeoutMs = 45_000, authenticated = false, handshakeFile) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    checkStartupFailure(handshakeFile);
    if (child.startError) throw child.startError;
    if (child.exitCode !== null) {
      throw new Error(`DSH 已退出（代码 ${child.exitCode}）${lastError ? `：${lastError}` : ''}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.ok || authenticated && response.status === 401) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error(`等待 DSH 启动超时${lastError ? `：${lastError}` : ''}`);
}

async function startDsh(options = {}) {
  const located = findDsh(options);
  if (!located) {
    throw new Error('未找到本机 DeepSeek Harness。请先运行 npx @deepseek-ai/dsh web 完成安装。');
  }
  const port = options.port || (await getFreePort());
  const url = `http://127.0.0.1:${port}/`;
  const node = findNode();
  const logs = [];
  const bridgePatch = options.bridgePatch || writeBridgePatch(options);
  const dshArgs = [located.entry, 'web'];
  if (fs.existsSync(bridgePatch)) dshArgs.push('--patch', bridgePatch);
  dshArgs.push('--no-open', '--port', String(port));
  const durable = options.durable !== false;
  const instanceId = randomUUID();
  const evidenceDirectory = options.evidenceDirectory || path.join(process.env.DSH_HOME || process.env.APPDATA || os.tmpdir(), 'dsh-runtime-diagnostics');
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  lifecycle.pruneEvidence(evidenceDirectory);
  const lifecycleFile = path.join(evidenceDirectory, `${instanceId}.json`);
  const handshakeFile = path.join(os.tmpdir(), `dsh-desktop-handshake-${process.pid}-${Date.now()}.json`);
  // Write intent before spawn. A killed launcher must leave enough identity to
  // adopt its child, rather than either duplicate it or permanently block startup.
  options.launchTransaction?.reset({ phase: 'spawning', ownerPid: process.pid, instanceId,
    lifecycleFile, handshakeFile, entry: located.entry, dshVersion: located.version,
    url, port, workspace: options.cwd || process.cwd(), launchAt: Date.now() });
  const child = spawn(node, dshArgs, {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      DSH_CWD: options.cwd || process.cwd(),
      DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED || '1',
      NODE_OPTIONS: `${hiddenSpawnNodeOptions()} --require="${path.join(__dirname, 'lifecycle.cjs').replaceAll('\\', '/')}"`.trim(),
      DSH_COLLAB_ORIGINAL_NODE_OPTIONS: process.env.NODE_OPTIONS || '',
      DSH_DESKTOP_HANDSHAKE_FILE: handshakeFile,
      DSH_RUNTIME_EVIDENCE_FILE: lifecycleFile,
      DSH_RUNTIME_INSTANCE: instanceId,
      DSH_RUNTIME_PORT: String(port),
    },
    detached: durable,
    stdio: durable ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.once('error', (error) => { child.startError = error; });
  child.once('exit', (code, signal) => {
    lifecycle.observeExit(lifecycleFile, instanceId, code, signal);
    options.onExit?.({ code, signal, instanceId, lifecycleFile, pid: child.pid });
  });
  options.launchTransaction?.update({ phase: 'spawned', dshPid: child.pid || null });

  const record = (stream, chunk) => {
    const text = String(chunk).replace(/\x1b\[[0-9;]*m/g, '').replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').trim();
    if (!text) return;
    logs.push(`[${stream}] ${text}`);
    if (logs.length > 80) logs.splice(0, logs.length - 80);
    options.onLog?.(stream, text);
  };
  child.stdout?.on('data', (chunk) => record('stdout', chunk));
  child.stderr?.on('data', (chunk) => record('stderr', chunk));

  try {
    await waitForReady(url, child, 45_000, compareVersions(located.version, '0.2.0') >= 0, handshakeFile);
    if (compareVersions(located.version, '0.2.0') >= 0) {
      const deadline = Date.now() + 30000;
      while (!fs.existsSync(handshakeFile) && Date.now() < deadline) {
        checkStartupFailure(handshakeFile);
        if (child.startError) throw child.startError;
        if (child.exitCode !== null) throw new Error(`DSH 已退出（代码 ${child.exitCode}）`);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!fs.existsSync(handshakeFile)) throw new Error('DSH 新版桥接认证握手未就绪');
    }
  } catch (error) {
    stopProcessTree(child);
    options.launchTransaction?.update({ phase: child.pid ? 'startup-failed' : 'spawn-failed' });
    if (bridgePatch && !options.bridgePatch) fs.rmSync(bridgePatch, { force: true });
    fs.rmSync(`${handshakeFile}.error`, { force: true });
    fs.rmSync(handshakeFile, { force: true });
    const tail = logs.slice(-8).join('\n');
    throw new Error(`${error.message}${tail ? `\n\n${tail}` : ''}`);
  }

  if (durable) child.unref();
  const handshake = fs.existsSync(handshakeFile) ? JSON.parse(fs.readFileSync(handshakeFile, 'utf8')) : {};
  if (handshake.pid && handshake.pid !== child.pid) throw new Error('DSH handshake PID mismatch');
  options.launchTransaction?.update({ phase: 'ready', processIdentity: handshake.processIdentity });
  // Retain the handshake until runtime.json is durably published.
  if (!options.launchTransaction && fs.existsSync(handshakeFile)) fs.unlinkSync(handshakeFile);
  fs.rmSync(`${handshakeFile}.error`, { force: true });
  return {
    child,
    instanceId,
    lifecycleFile,
    processIdentity: handshake.processIdentity,
    startedAt: handshake.startedAt || Date.now(),
    dshPid: child.pid,
    entry: located.entry,
    version: located.version,
    dshVersion: located.version,
    bridgeVersion: handshake.bridgeVersion,
    source: located.source,
    port,
    url,
    launchUrl: handshake.launchUrl || url,
    collabStateDirectory: handshake.collabStateDirectory,
    toolRegistry: handshake.toolRegistry,
    capabilitiesApi: handshake.capabilitiesApi,
    schedulingApi: handshake.schedulingApi,
    reconciliationApi: handshake.reconciliationApi,
    recoveryApi: handshake.recoveryApi,
    projectionBinding: handshake.projectionBinding,
    build: handshake.build,
    processInstance: handshake.processInstance,
    inboxLifecycle: handshake.inboxLifecycle,
    collabVersion: handshake.collabVersion,
    localControlApi: handshake.localControlApi,
    controlUrl: handshake.controlUrl,
    controlLaunchUrl: handshake.controlLaunchUrl,
    transportGeneration: handshake.transportGeneration,
    logs,
    attached: false,
    durable,
    stop() {
      stopProcessTree(child);
      if (bridgePatch && !options.bridgePatch) fs.rmSync(bridgePatch, { force: true });
    },
  };
}

async function attachDsh(runtimeFile, options = {}) {
  try {
    const saved = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (saved.processIdentity && (await inspectProcess(saved)).state !== 'alive') return null;
    if (typeof saved.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(saved.url)) return null;
    const response = await fetch(saved.url, { signal: AbortSignal.timeout(options.timeoutMs || 1800) });
    const transport = require('../mcp/dsh-transport.cjs');
    if (!response.ok && !(transport.modernRuntime(saved) && response.status === 401)) return null;
    const authenticatedList = response.status === 401
      ? await transport.request(saved, 'session.list', {}, options.timeoutMs || 5000) : null;
    let updatePending = false;
    const expected = findDsh({ cwd: options.cwd || process.cwd() });
    if (options.bridgeVersion && saved.bridgeVersion !== options.bridgeVersion
      || expected && compareVersions(expected.version, saved.dshVersion) > 0) {
      try {
        const listed = authenticatedList || (transport.modernRuntime(saved)
          ? await transport.request(saved, 'session.list', {}, options.timeoutMs || 5000)
          : await fetch(new URL('/api/session.list', saved.url), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: `desktop-version-${Date.now()}`, method: 'session.list', payload: {} }),
            signal: AbortSignal.timeout(options.timeoutMs || 5000),
          }).then((response) => response.json()).then((value) => {
            if (!value.result?.ok) throw new Error('Cannot prove old DSH idle');
            return value.result.value;
          }));
        if (!Array.isArray(listed.items)) throw new Error('Invalid DSH session list');
        // A saved PID is not sufficient evidence to terminate a process. Keep
        // the old runtime attached until the user explicitly performs migration.
        updatePending = true;
      } catch {
        // Preserve the known-good runtime when its activity cannot be proven idle.
        updatePending = true;
      }
    }
    const located = runtimeEntryPresent(saved)
      ? { entry: saved.entry, version: saved.dshVersion || 'unknown', source: saved.source || '后台 runtime' }
      : findDsh({ cwd: options.cwd || process.cwd() });
    if (!located) return null;
    const port = Number(new URL(saved.url).port);
    return {
      child: null,
      runtimeFile,
      instanceId: saved.instanceId,
      lifecycleFile: saved.lifecycleFile,
      processIdentity: saved.processIdentity,
      startedAt: saved.startedAt,
      dshPid: Number(saved.dshPid || 0) || null,
      entry: located.entry,
      version: saved.dshVersion || located.version,
      source: '已连接的后台 runtime',
      port,
      url: saved.url,
      launchUrl: saved.launchUrl || saved.url,
      collabStateDirectory: saved.collabStateDirectory,
      toolRegistry: saved.toolRegistry,
      capabilitiesApi: saved.capabilitiesApi,
      schedulingApi: saved.schedulingApi,
      reconciliationApi: saved.reconciliationApi,
      recoveryApi: saved.recoveryApi,
      projectionBinding: saved.projectionBinding,
      build: saved.build,
      processInstance: saved.processInstance,
      inboxLifecycle: saved.inboxLifecycle,
      collabVersion: saved.collabVersion,
      localControlApi: saved.localControlApi,
      controlUrl: saved.controlUrl,
      controlLaunchUrl: saved.controlLaunchUrl,
      transportGeneration: saved.transportGeneration,
      logs: [],
      attached: true,
      durable: true,
      updatePending,
      bridgeVersion: saved.bridgeVersion,
      stop() {
        throw new Error('Attached runtime is not owned by this process; stop it through its verified owner.');
      },
    };
  } catch {
    return null;
  }
}

// Only an explicit desktop/CLI startup or recovery action calls this. No retry
// loop and no automatic task replay. One publication lock for all host surfaces.
async function connectOrStart(runtimeFile, options = {}) {
  runtimeFile = path.resolve(runtimeFile);
  return withLaunchTransaction(runtimeFile, async transaction => {
    const recovered = await recoverLaunch(runtimeFile, transaction, options);
    if (recovered) return recovered;
    const attached = await attachDsh(runtimeFile, options);
    if (attached) { transaction.update({ phase: 'published', instanceId: attached.instanceId }); return attached; }
    if (fs.existsSync(runtimeFile)) {
      let saved;
      try { saved = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); } catch { throw new Error('Runtime connection record is unreadable; preserve it for inspection.'); }
      const state = await inspectProcess(saved);
      if (!['dead', 'replaced'].includes(state.state)) throw new Error('DSH runtime is unreachable but its process is alive or unverified. Refusing a second backend; inspect diagnostics.');
      if (saved.hostManaged) throw Object.assign(new Error('This connection is managed by a DSH desktop. Open that desktop to restore it; the legacy launcher will not start a replacement backend.'), { code: 'DSH_HOST_START_REQUIRED' });
    }
    if (options.attachOnly) throw launchError('未找到可安全接管的后台');
    const started = await startDsh({ ...options, launchTransaction: transaction });
      const record = { url: started.url, launchUrl: started.launchUrl, entry: started.entry, source: started.source,
        instanceId: started.instanceId, processIdentity: started.processIdentity, lifecycleFile: started.lifecycleFile,
        startedAt: started.startedAt, dshPid: started.dshPid, dshVersion: started.dshVersion,
        collabStateDirectory: started.collabStateDirectory, bridgeVersion: started.bridgeVersion,
        collabVersion: started.collabVersion, capabilitiesApi: started.capabilitiesApi, schedulingApi: started.schedulingApi,
        reconciliationApi: started.reconciliationApi, recoveryApi: started.recoveryApi, projectionBinding: started.projectionBinding,
        build: started.build, processInstance: started.processInstance, inboxLifecycle: started.inboxLifecycle,
        localControlApi: started.localControlApi, controlUrl: started.controlUrl,
        controlLaunchUrl: started.controlLaunchUrl, transportGeneration: started.transportGeneration,
        toolRegistry: started.toolRegistry, workspace: options.cwd, durable: true };
      writeJson(runtimeFile, record);
      transaction.update({ phase: 'published' });
      try { fs.unlinkSync(transaction.record.handshakeFile); } catch {}
      return { ...started, runtimeFile };
    // Publication failures preserve the live child and its journal for adoption.
  }, { timeoutMs: options.lockTimeoutMs || 30000 });
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}
function recoverLegacy(transaction, saved, options) {
  const record = transaction.record;
  const directory = options.handshakeDirectory || os.tmpdir();
  const evidenceDirectory = options.evidenceDirectory || path.join(process.env.DSH_HOME || process.env.APPDATA || os.tmpdir(), 'dsh-runtime-diagnostics');
  const candidates = [];
  // Only this dead owner's handshake names from the lock's startup interval.
  // Never scan another application's runtime/credentials or arbitrary profiles.
  const pattern = new RegExp(`^dsh-desktop-handshake-${record.legacyOwner}-(\\d+)\\.json$`);
  for (const name of fs.readdirSync(directory)) {
    const match = pattern.exec(name);
    if (!match || Math.abs(Number(match[1]) - record.legacyLockTime) > 120000) continue;
    const handshakeFile = path.join(directory, name), handshake = readJson(handshakeFile);
    if (!/^[0-9a-f-]{36}$/.test(handshake?.instanceId || '')) throw launchError('旧启动握手身份异常');
    const lifecycleFile = path.join(evidenceDirectory, `${handshake.instanceId}.json`);
    const evidence = lifecycle.readEvidence(lifecycleFile);
    if (!evidence || evidence.parentPid !== record.legacyOwner || evidence.pid !== handshake.pid
      || evidence.instanceId !== handshake.instanceId || evidence.processIdentity !== handshake.processIdentity
      || Math.abs(evidence.startedAt - record.legacyLockTime) > 120000
      || !samePath(saved?.collabStateDirectory, handshake.collabStateDirectory)) throw launchError('旧启动证据不匹配');
    candidates.push({ phase: 'ready', ownerPid: record.legacyOwner, launchAt: evidence.startedAt,
      instanceId: handshake.instanceId, dshPid: handshake.pid, processIdentity: handshake.processIdentity,
      lifecycleFile, handshakeFile, port: evidence.port, url: `http://127.0.0.1:${evidence.port}/`,
      entry: saved.entry, dshVersion: saved.dshVersion, workspace: saved.workspace, legacyRecovered: true });
  }
  if (candidates.length !== 1) throw launchError('旧版启动结果尚不明确，需要核验关联后台，不能直接删锁');
  transaction.update(candidates[0]);
}

async function recoverLaunch(runtimeFile, transaction, options) {
  const saved = readJson(runtimeFile);
  if (transaction.record.phase === 'legacy') {
    const attached = await attachDsh(runtimeFile, options);
    // A legacy lock can also survive after successful publication.
    if (attached && saved?.pid === transaction.record.legacyOwner) {
      transaction.update({ phase: 'published' }); return attached;
    }
    recoverLegacy(transaction, saved, options);
  }
  const record = transaction.record;
  if (['idle', 'published', 'spawn-failed', 'verified-dead'].includes(record.phase)) return null;
  const evidence = lifecycle.readEvidence(record.lifecycleFile);
  const pid = record.dshPid || evidence?.pid;
  if (!pid) throw launchError('启动请求已记录但进程结果未知，请保留启动日志');
  if (evidence && (evidence.instanceId !== record.instanceId || evidence.pid !== pid || evidence.parentPid !== record.ownerPid)) throw launchError('后台启动证据身份冲突');
  const identity = record.processIdentity || evidence?.processIdentity;
  const actual = await inspectProcess({ dshPid: pid, processIdentity: identity });
  if (['dead', 'replaced'].includes(actual.state)) { transaction.update({ phase: 'verified-dead' }); return null; }
  if (actual.state !== 'alive' || !identity || actual.identity !== identity) throw launchError('后台仍在启动或身份未核验，请稍后重试');
  if (saved && saved.instanceId !== record.instanceId && !['dead', 'replaced'].includes((await inspectProcess(saved)).state)) throw launchError('旧后台仍存活或身份未核验，拒绝覆盖连接');
  if (saved?.instanceId === record.instanceId) {
    const attached = await attachDsh(runtimeFile, options);
    if (!attached) throw launchError('已发布后台暂不可达');
    transaction.update({ phase: 'published' }); return attached;
  }
  const handshake = readJson(record.handshakeFile);
  const origin = new URL(handshake?.url || 'about:blank');
  const launch = new URL(handshake?.launchUrl || 'about:blank');
  const candidate = typeof record.entry === 'string' ? packageCandidate(path.resolve(path.dirname(record.entry), '..', 'package.json')) : null;
  if (handshake?.pid !== pid || handshake.instanceId !== record.instanceId || handshake.processIdentity !== identity
    || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(record.url || '')
    || `${origin.origin}/` !== record.url || launch.origin !== origin.origin || !launch.searchParams.has('token')
    || saved?.collabStateDirectory && !samePath(saved.collabStateDirectory, handshake.collabStateDirectory)
    || options.bridgeVersion && handshake.bridgeVersion !== options.bridgeVersion
    || !candidate || !samePath(candidate.entry, record.entry) || candidate.version !== record.dshVersion
    || !evidence || evidence.status !== 'ready' || evidence.port !== Number(origin.port)) throw launchError('后台握手、版本或状态目录不一致');
  const recovered = { ...(saved || {}), ...handshake, url: record.url, dshPid: pid, pid: process.pid,
    entry: record.entry, dshVersion: record.dshVersion, instanceId: record.instanceId,
    processIdentity: identity, lifecycleFile: record.lifecycleFile, workspace: record.workspace,
    durable: true, source: '已核验的中断启动恢复' };
  // Authenticate through the normal DSH transport, read only. Never a model request.
  const transport = require('../mcp/dsh-transport.cjs');
  await transport.request(recovered, 'session.models', {}, options.timeoutMs || 10000);
  if ((await inspectProcess(recovered)).state !== 'alive') throw launchError('核验过程中后台退出');
  writeJson(runtimeFile, recovered);
  transaction.update({ phase: 'published', recoveredAt: Date.now() });
  try { fs.unlinkSync(record.handshakeFile); } catch {}
  const attached = await attachDsh(runtimeFile, options);
  if (!attached) throw launchError('后台连接已发布，但当前暂不可达');
  return { ...attached, recovered: true };
}

function stopPidTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // Process has already ended.
  }
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill();
    } catch {
      // Process has already ended.
    }
  }
}

module.exports = {
  checkStartupFailure,
  compareVersions,
  findDsh,
  getFreePort,
  hiddenSpawnNodeOptions,
  writeBridgePatch,
  attachDsh,
  connectOrStart,
  recoverLaunch,
  startDsh,
  stopProcessTree,
};
