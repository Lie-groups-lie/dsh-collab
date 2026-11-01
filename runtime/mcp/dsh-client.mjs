import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import contract from '../runtime-contract.json' with { type: 'json' };
import transport from './dsh-transport.cjs';
import { TaskStore } from '../core/task-store.mjs';
import { ResultStore } from '../core/result-store.mjs';
import { allowedTools } from '../core/capabilities.mjs';
import { withOperationLock, journaledOperation } from '../core/operation-lock.mjs';
import { createReadBatcher } from '../core/observation.mjs';
import { taskIndex } from '../core/task-index.mjs';
import { coordinatorRoleForSession, LEGACY_LEAD_TITLE, normalizeLeadName } from '../core/session-identity.mjs';
import { requireCompatibleRuntime } from '../core/runtime-compatibility.mjs';
import { turnFailure, failureInfo } from '../core/failure.mjs';
import { deadlineFor, unresolved } from '../core/deadline.mjs';
import { archiveAdmission, assertArchiveAdmission } from '../core/archive-admission.mjs';

export function nativeTaskState(runtime, sessionId) {
  if (!runtime.collabStateDirectory) return null;
  const store = new TaskStore(runtime.collabStateDirectory);
  const task = store.get(sessionId);
  if (!task || task.role === 'relay') return task;
  const root = task.rootId === sessionId ? task : store.get(task.rootId);
  if (!root) throw new Error('Task budget root is missing');
  return { ...task, budgetLedger: root.ledger, budgetPolicy: root.policy, effectiveDeadline: deadlineFor(store, sessionId) };
}

export function requireManagedRuntime(runtime) {
  requireCompatibleRuntime(runtime, contract);
}

export const FLASH_MODEL = Object.freeze({
  provider: contract.provider,
  model: contract.flashModel,
  reasoningEffort: 'high',
});

export const RELAY_TITLE = 'Codex Relay';
export const LEGACY_RELAY_TITLE = 'Codex 协作';
export const BRIDGE_TITLE = RELAY_TITLE;
export const LEAD_TITLE_PATTERN = LEGACY_LEAD_TITLE;
export const HISTORY_MAX_MESSAGES = 4;
export const PARTIAL_ANSWER_MAX_CHARS = 32000;
export const REASONING_PREVIEW_MAX_CHARS = 12000;
export const TOOL_CALLS_MAX_RECORDS = 64;
export const TRANSCRIPT_SAFE_TOKENS = contract.defaultMaxTranscriptTokens;

export function runtimeCandidates(env = process.env, cwd = process.cwd()) {
  const candidates = [];
  if (env.DSH_DESKTOP_RUNTIME_FILE) candidates.push(env.DSH_DESKTOP_RUNTIME_FILE);
  if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'DeepSeek Harness', 'runtime.json'));
  candidates.push(path.join(cwd, '.dsh-desktop', 'runtime.json'));
  return [...new Set(candidates)];
}

export function readRuntime(options = {}) {
  const explicit = (options.env || process.env).DSH_DESKTOP_RUNTIME_FILE;
  const found = [];
  for (const candidate of explicit ? [explicit] : runtimeCandidates(options.env, options.cwd)) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (typeof value.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(value.url)) {
        const stat = fs.statSync(candidate);
        found.push({
          ...value,
          runtimeFile: candidate,
          runtimeFileModifiedAt: stat.mtimeMs,
        });
      }
    } catch {
      // Try the next known local runtime location.
    }
  }
  if (found.length > 0) {
    found.sort((left, right) => {
      const startedDelta = Number(right.startedAt || 0) - Number(left.startedAt || 0);
      return startedDelta || right.runtimeFileModifiedAt - left.runtimeFileModifiedAt;
    });
    return found[0];
  }
  throw new Error(explicit ? '指定的 runtime 文件无效；不会自动切换到其他 runtime。' : 'DeepSeek Harness runtime 未就绪，请先启动本地 runtime。');
}

function refreshRuntimePointer(runtime) {
  try {
    const latest = readRuntime({ env: { DSH_DESKTOP_RUNTIME_FILE: runtime.runtimeFile } });
    if (latest.entry !== runtime.entry) return false;
    if (latest.url === runtime.url) return false;
    Object.assign(runtime, latest);
    return true;
  } catch {
    return false;
  }
}

async function fetchRuntime(runtime, endpoint, options, timeoutMs) {
  const firstUrl = runtime.url;
  try {
    return await fetch(new URL(endpoint, firstUrl), options);
  } catch (error) {
    if (options.readOnly && isTransientApiError(error) && refreshRuntimePointer(runtime)) {
      return fetch(new URL(endpoint, runtime.url), {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    const detail = error?.message || String(error);
    throw new Error(
      `DeepSeek Harness runtime 无法连接（${firstUrl}）。桌面 runtime 可能已退出或记录已过期：${detail}`,
      { cause: error },
    );
  }
}

const readFlights = new Map();
const sessionObservations = createReadBatcher();
export async function api(runtime, method, payload = {}, timeoutMs = 20_000) {
  const readOnly = ['session.list', 'session.history', 'session.models', 'agentPreset.list', 'workspace.list'].includes(method);
  if (!readOnly) {
    sessionObservations.clear();
    try { return await apiRequest(runtime, method, payload, timeoutMs); }
    finally { sessionObservations.clear(); }
  }
  const key = JSON.stringify([runtime.launchUrl || runtime.url, method, payload]);
  if (readFlights.has(key)) return readFlights.get(key);
  const flight = apiRequest(runtime, method, payload, timeoutMs);
  readFlights.set(key, flight);
  try { return await flight; } finally { if (readFlights.get(key) === flight) readFlights.delete(key); }
}

async function apiRequest(runtime, method, payload = {}, timeoutMs = 20_000) {
  const readOnly = ['session.list', 'session.history', 'session.models', 'agentPreset.list', 'workspace.list'].includes(method);
  if (transport.modernRuntime(runtime)) {
    return transport.request(runtime, method, payload, timeoutMs);
  }
  const rpcId = `codex-${randomUUID()}`;
  const response = await fetchRuntime(runtime, `/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
    readOnly,
  }, timeoutMs);
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const message = await response.json();
  if (message?.rpcId !== rpcId) throw new Error(`${method}: rpcId mismatch`);
  if (!message?.result?.ok) {
    const error = message?.result?.error;
    throw new Error(error?.message || error?.code || `${method} failed`);
  }
  return message.result.value;
}

export async function remoteApi(runtime, endpoint, args, timeoutMs = 20_000) {
  sessionObservations.clear();
  try { return await remoteApiRequest(runtime, endpoint, args, timeoutMs); }
  finally { sessionObservations.clear(); }
}

async function remoteApiRequest(runtime, endpoint, args, timeoutMs = 20_000) {
  if (transport.modernRuntime(runtime)) return transport.request(runtime, endpoint, args, timeoutMs);
  const rpcId = `codex-${randomUUID()}`;
  const response = await fetchRuntime(runtime, `/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }, timeoutMs);
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  const message = await response.json();
  if (message?.rpcId !== rpcId) throw new Error(`${endpoint}: rpcId mismatch`);
  if (!message?.result?.ok) {
    const error = message?.result?.error;
    throw new Error(error?.message || error?.code || `${endpoint} failed`);
  }
  return message.result.value;
}

function isTransientApiError(error) {
  return error?.name === 'TimeoutError'
    || error?.name === 'AbortError'
    || /timeout|aborted|fetch failed|ECONNRESET|ECONNREFUSED/i.test(error?.message || '');
}

async function retryTransient(operation, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientApiError(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function recentSessions(runtime) {
  const value = await retryTransient(() => api(runtime, 'session.list', {}, 30_000));
  return (value.items || []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function observeSessions(runtime) {
  return sessionObservations.read(runtime.launchUrl || runtime.url, () => recentSessions(runtime));
}

export function unwrapEvents(history) {
  const events = (history?.events || history?.records || []).map((entry) => entry?.event || entry).filter(Boolean);
  const expanded = [];
  for (const event of events) {
    expanded.push(event);
    if (!['assistant/message', 'assistant/attempt'].includes(event.type)) continue;
    for (const record of event.data?.stream || []) {
      if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
        expanded.push({ ...event, type: 'assistant/chunk', data: { ...event.data, stream: undefined,
          chunk: { type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', text: record.texts.join('') } } });
      } else if (record.type === 'chunk') {
        expanded.push({ ...event, type: 'assistant/chunk', time: record.time, data: {
          turn: event.data.turn, step: event.data.step, chunk: record.chunk,
        } });
      }
    }
  }
  return expanded;
}

export function messageText(content) {
  return (content || [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function summarizeHistory(history) {
  // Headers/final messages do not require unpacking the reasoning stream.
  const events = (history?.events || history?.records || []).map(entry => entry?.event || entry).filter(Boolean);
  const turn = events.reduce((n, event) => Math.max(n, Number(event.data?.turn) || 0), 0);
  const current = events.filter((event) => !turn || event.data?.turn === turn);
  const assistantMessages = current.filter((event) => event.type === 'assistant/message');
  const latest = [...assistantMessages].reverse().find((event) => messageText(event?.data?.message?.content));
  // v4 headers are epoch snapshots, not turn-tagged events; unchanged headers
  // can be reused by later responses. A new turn rejected before a request must
  // not present that old epoch as evidence that a model request happened.
  const start = events.findLastIndex((event) => event.type === 'turn/start' && event.data?.turn === turn);
  const hasResponse = current.some((event) => ['assistant/message', 'assistant/attempt', 'assistant/chunk'].includes(event.type));
  const hasHeaderInTurn = start >= 0 && events.slice(start + 1).some((event) => event.type === 'request/header');
  const latestRequest = !turn || hasResponse || hasHeaderInTurn
    ? events.filter((event) => event.type === 'request/header').at(-1) : undefined;
  const failure = turnFailure(events, turn);
  const sandboxMode = events.filter((event) => event.type === 'sandbox/mode').at(-1)?.data?.mode || '';
  const approvalPolicy = events.filter((event) => event.type === 'approval/policy').at(-1)?.data?.policy || '';
  return {
    turn,
    answer: messageText(latest?.data?.message?.content),
    model: latest?.data?.message?.source?.model || '',
    provider: latest?.data?.message?.source?.provider || '',
    responseUsage: latest?.data?.usage || {},
    requestConfig: latestRequest?.data?.header?.config || {},
    headerObserved: Boolean(latestRequest),
    exposedTools: (latestRequest?.data?.header?.tools || [])
      .map((tool) => tool?.name || tool?.function?.name)
      .filter(Boolean),
    error: failure?.message || '',
    failure,
    sandboxMode,
    approvalPolicy,
    projections: history?.projections?.values || {},
  };
}

function boundedPieces(pieces, limit) {
  let totalChars = 0;
  let retainedChars = 0;
  const retained = [];
  for (const piece of pieces) {
    const text = String(piece || '');
    totalChars += text.length;
    if (retainedChars >= limit) continue;
    const slice = text.slice(0, limit - retainedChars);
    retained.push(slice);
    retainedChars += slice.length;
  }
  return { text: retained.join(''), totalChars, truncated: totalChars > retainedChars };
}

function chunkText(events, type, step, limit = PARTIAL_ANSWER_MAX_CHARS) {
  return boundedPieces(events
    .filter((event) => event.type === 'assistant/chunk'
      && (step === undefined || event.data?.step === step)
      && event.data?.chunk?.type === type)
    .map((event) => event.data.chunk.text), limit);
}

function toolResultCallId(event) {
  return event?.data?.callId
    || event?.data?.message?.source?.callId
    || event?.data?.message?.content?.find((block) => block?.type === 'tool-result')?.toolCallId
    || '';
}

function visibleTurnText(events, limit = PARTIAL_ANSWER_MAX_CHARS) {
  const steps = [...new Set(events
    .filter((event) => event.type === 'assistant/message' || event.type === 'assistant/chunk')
    .map((event) => Number(event.data?.step || 0)))]
    .sort((left, right) => left - right);
  let totalChars = 0;
  const pieces = steps.map((step) => {
    const completed = events
      .filter((event) => event.type === 'assistant/message' && Number(event.data?.step || 0) === step)
      .map((event) => messageText(event.data?.message?.content))
      .filter(Boolean)
      .join('\n');
    if (completed) {
      totalChars += completed.length;
      return completed.slice(0, limit);
    }
    const chunks = chunkText(events, 'text-delta', step, limit);
    totalChars += chunks.totalChars;
    return chunks.text;
  });
  const bounded = boundedPieces(pieces, limit);
  const text = bounded.text.trim();
  return { text, totalChars, truncated: totalChars > text.length };
}

export function summarizeProgress(history, options = {}) {
  const events = unwrapEvents(history);
  const latestTurn = events.reduce((n, event) => Math.max(n, Number(event.data?.turn) || 0), 0);
  const turnEvents = latestTurn
    ? events.filter((event) => Number(event.data?.turn || 0) === latestTurn || event.type === 'turn/start' && event.data?.turn === latestTurn)
    : events;
  const latestStep = turnEvents.reduce((maximum, event) => Math.max(maximum, Number(event.data?.step || 0)), 0);
  const allCalls = turnEvents.filter((event) => event.type === 'tool/call');
  const resultEvents = new Map(turnEvents.filter((event) => event.type === 'tool/result')
    .map((event) => [toolResultCallId(event), event]));
  const results = new Set(resultEvents.keys());
  const calls = allCalls.slice(-TOOL_CALLS_MAX_RECORDS);
  const latest = turnEvents.at(-1);
  const ended = turnEvents.findLast?.((event) => event.type === 'turn/end')
    || [...turnEvents].reverse().find((event) => event.type === 'turn/end');
  let stage = 'accepted';
  if (ended) {
    const reason = ended.data?.reason;
    const reasonName = typeof reason === 'string' ? reason : reason?.kind || reason?.type || 'stopped';
    stage = reasonName === 'completed' ? 'completed' : String(reasonName);
  }
  else if (allCalls.some((event) => !results.has(event.data?.callId))) stage = 'running_tool';
  else if (latest?.type === 'assistant/chunk') stage = 'generating';
  else if (latest?.type === 'request/header' || latest?.type === 'request/context') stage = 'requesting_model';
  else if (latestTurn) stage = 'running';
  const partial = visibleTurnText(turnEvents, PARTIAL_ANSWER_MAX_CHARS);
  const reasoningLimit = Number.isSafeInteger(options.reasoningMaxChars)
    ? Math.min(options.reasoningMaxChars, REASONING_PREVIEW_MAX_CHARS)
    : REASONING_PREVIEW_MAX_CHARS;
  const reasoningSummary = boundedPieces(turnEvents
    .filter((event) => event.type === 'assistant/chunk' && event.data?.chunk?.type === 'reasoning-delta')
    .map((event) => event.data.chunk.text), reasoningLimit);
  const reasoning = options.includeReasoning ? reasoningSummary.text : undefined;
  return {
    stage,
    turn: latestTurn,
    step: latestStep,
    latestSeq: Number(latest?.seq || 0),
    lastActivityAt: Number(latest?.time || 0),
    partialAnswer: partial.text,
    partialAnswerChars: partial.totalChars,
    partialAnswerTruncated: partial.truncated,
    reasoningChars: reasoningSummary.totalChars,
    ...(reasoning === undefined ? {} : {
      reasoning,
      reasoningTruncated: reasoningSummary.truncated,
    }),
    toolCallsTruncated: allCalls.length > calls.length,
    toolCalls: calls.map((event) => ({
      callId: event.data?.callId || '',
      name: event.data?.name || '',
      status: !results.has(event.data?.callId)
        ? 'running'
        : /deny|denied|block|forbidden|not allowed/i.test(JSON.stringify(resultEvents.get(event.data?.callId)?.data || {}))
          ? 'blocked_before_execution'
          : 'completed',
    })),
  };
}

function effectivePermission(summary, preset) {
  if (summary.sandboxMode === 'read-only') return 'read-only';
  if (summary.sandboxMode === 'workspace-write') return 'workspace-write';
  if (summary.sandboxMode === 'danger-full-access') return 'danger-full-access';
  return preset || summary.sandboxMode || '';
}

function sameWorkspace(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export function leadPolicyDirectory(runtime, env = process.env) {
  if (env.APPDATA) return path.join(env.APPDATA, 'DeepSeek Harness', 'lead-policies');
  const runtimeFile = runtime?.runtimeFile || '';
  return runtimeFile ? path.join(path.dirname(runtimeFile), 'lead-policies') : '';
}

function leadPolicyFilename(runtime, sessionId, env = process.env) {
  if (!/^session-[a-z0-9-]+$/i.test(String(sessionId || ''))) return '';
  const directory = leadPolicyDirectory(runtime, env);
  return directory ? path.join(directory, `${sessionId}.json`) : '';
}

function publishLeadPolicy(runtime, state, env = process.env) {
  const filename = leadPolicyFilename(runtime, state?.sessionId, env);
  if (!filename) return;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), 'utf8');
  fs.renameSync(temporary, filename);
}

export async function configureBridgeParent(runtime, sessionId, options = {}) {
  const selection = {
    sessionId,
    provider: FLASH_MODEL.provider,
    model: FLASH_MODEL.model,
    reasoningEffort: options.reasoningEffort || FLASH_MODEL.reasoningEffort,
  };
  await api(runtime, 'session.selectModel', selection);
  const permission = options.permission || 'read-only';
  const command = await remoteApi(runtime, 'commands/execute', {
    agentId: sessionId,
    line: `/permission ${permission}`,
    images: [],
  });
  if (command?.result?.kind === 'error') {
    throw new Error(command.result.text || `无法切换权限为 ${permission}`);
  }
  return { selection, permission, command };
}

function sessionTitle(session) {
  return session?.projections?.values?.title || '';
}

export function coordinatorRoles(runtime, sessions) {
  const roots = sessions.filter(item => !item.parentSessionId);
  const metadata = new Map((runtime.collabStateDirectory
    ? taskIndex(runtime.collabStateDirectory).identities(roots.map(item => item.sessionId)) : []).map(item => [item.id, item]));
  return new Map(roots.map(item => [item.sessionId, coordinatorRoleForSession(item, metadata.get(item.sessionId))]));
}

export function isRelaySession(session, metadata) {
  return coordinatorRoleForSession(session, metadata) === 'relay';
}

export function isLeadSession(session, metadata) {
  return coordinatorRoleForSession(session, metadata) === 'lead';
}

export function nextLeadTitle(sessions, cwd) {
  const used = new Set((sessions || [])
    .filter((item) => !item.parentSessionId && sameWorkspace(item.cwd, cwd))
    .map((item) => LEAD_TITLE_PATTERN.exec(sessionTitle(item))?.[1])
    .filter(Boolean)
    .map(Number));
  let number = 1;
  while (used.has(number)) number += 1;
  return `Codex Lead ${number}`;
}

function encodeBridgePayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function bridgeResult(command, name) {
  if (!command) throw new Error(`${name} 未注册；请重启新版 DeepSeek Harness 桌面程序。`);
  if (command.result?.kind === 'error') throw new Error(command.result.text || `${name} failed`);
  try {
    return JSON.parse(command.result?.text || '');
  } catch {
    throw new Error(`${name} 返回了无法识别的结果`);
  }
}

function operationDirectory(runtime) {
  requireManagedRuntime(runtime);
  return `${runtime.collabStateDirectory}-client-operations`;
}
function workspaceKey(cwd) { return process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd); }
function canonicalWorkspace(value) {
  if (!path.isAbsolute(value)) throw new Error('cwd must be an absolute existing workspace directory');
  const cwd = fs.realpathSync(value);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');
  return cwd;
}

export async function ensureBridgeParent(runtime, options = {}) {
  const cwd = canonicalWorkspace(options.cwd || runtime.workspace || process.cwd());
  return withOperationLock(operationDirectory(runtime), workspaceKey(cwd), () => ensureBridgeParentUnlocked(runtime, { ...options, cwd }));
}

async function ensureBridgeParentUnlocked(runtime, options = {}) {
  const cwd = path.resolve(options.cwd || runtime.workspace || process.cwd());
  const sessions = await recentSessions(runtime);
  const roles = coordinatorRoles(runtime, sessions);
  let parent = sessions.find((item) => !item.parentSessionId
    && item.agentPreset === 'standard'
    && sameWorkspace(item.cwd, cwd)
    && roles.get(item.sessionId) === 'relay');
  if (parent) {
    const workspace = await api(runtime, 'workspace.list');
    assertArchiveAdmission(archiveAdmission(parent.sessionId, sessions, workspace.archivedSessionIds));
  }
  if (parent && sessionTitle(parent) === LEGACY_RELAY_TITLE) {
    await api(runtime, 'session.rename', { sessionId: parent.sessionId, title: RELAY_TITLE });
    parent = { ...parent, projections: { ...parent.projections, values: { ...parent.projections?.values, title: RELAY_TITLE } } };
  }
  if (!parent) {
    // An uncertain create is not repeated, even after another MCP process starts.
    return journaledOperation(operationDirectory(runtime), `relay:${workspaceKey(cwd)}`, { cwd }, async () => {
    const workspace = await api(runtime, 'workspace.create', { path: cwd });
    const created = await api(runtime, 'session.create', {
      workspaceId: workspace.workspace.workspaceId,
      agentPreset: 'standard',
    });
    await api(runtime, 'session.rename', { sessionId: created.sessionId, title: RELAY_TITLE });
    parent = {
      sessionId: created.sessionId,
      cwd,
      agentPreset: created.agentPreset || 'standard',
      projections: { values: { title: RELAY_TITLE, sessionStats: { turns: 0 } } },
    };
    await configureBridgeParent(runtime, parent.sessionId, options);
    return parent;
    });
  }
  await configureBridgeParent(runtime, parent.sessionId, options);
  return parent;
}

export async function createLead(runtime, options = {}) {
  options = { ...options, name: normalizeLeadName(options.name) };
  const cwd = canonicalWorkspace(options.cwd || runtime.workspace || process.cwd());
  return withOperationLock(operationDirectory(runtime), workspaceKey(cwd), () => journaledOperation(
    operationDirectory(runtime), `lead:${workspaceKey(cwd)}:${options.requestKey || randomUUID()}`, { cwd, name: options.name || '' },
    () => createLeadUnlocked(runtime, { ...options, cwd })));
}

async function createLeadUnlocked(runtime, options = {}) {
  const cwd = options.cwd;
  const sessions = await recentSessions(runtime);
  const title = options.name ?? nextLeadTitle(sessions, cwd);
  if (sessions.some((item) => sameWorkspace(item.cwd, cwd) && sessionTitle(item) === title)) throw new Error('A Lead with this name already exists; continue it by lead_id');
  const workspace = await api(runtime, 'workspace.create', { path: cwd });
  const created = await api(runtime, 'session.create', {
    workspaceId: workspace.workspace.workspaceId,
    agentPreset: 'standard',
  });
  await api(runtime, 'session.rename', { sessionId: created.sessionId, title });
  await configureBridgeParent(runtime, created.sessionId, options);
  return { sessionId: created.sessionId, cwd, title, created: true };
}

export async function resolveLead(runtime, options = {}) {
  if (!options.leadId) return createLead(runtime, options);
  const sessions = await recentSessions(runtime);
  const roles = coordinatorRoles(runtime, sessions);
  const lead = sessions.find((item) => item.sessionId === options.leadId && roles.get(item.sessionId) === 'lead');
  if (!lead) throw new Error(`找不到 Codex Lead：${options.leadId}`);
  if (options.cwd && !sameWorkspace(lead.cwd, path.resolve(options.cwd))) {
    throw new Error(`Codex Lead 工作区不匹配：${lead.cwd}`);
  }
  // Native submission applies policy atomically. A read/resolve must not reset
  // another in-flight task's permission or model before admission succeeds.
  return { sessionId: lead.sessionId, cwd: lead.cwd, title: sessionTitle(lead), created: false };
}

function leadPrompt(task, limits = {}) {
  const child = limits.childPolicy || {};
  return [
    'You are a persistent Codex Lead inside DeepSeek Harness.',
    'Complete the delegated project task and return a concrete result to Codex.',
    'You may delegate bounded independent work to DSH subagents when useful, but keep ownership of synthesis and verification.',
    `Do not create more than ${limits.maxChildren ?? 4} direct child agents in this turn. Do not ask the user questions; state any blocking assumption explicitly.`,
    `Every child is host-locked to provider ${child.provider || FLASH_MODEL.provider}, model ${child.model || FLASH_MODEL.model}, permission ${child.permission || 'read-only'}, reasoning ${child.reasoningEffort || 'high'}, terminal ${child.allowTerminal ? 'allowed' : 'denied'}, and further delegation denied.`,
    'Plan child tasks so they can finish inside that enforced policy. Never request or assume a stronger child model or tool permission.',
    '',
    'Codex task:',
    String(task || '').trim(),
  ].join('\n');
}

async function executeBridgeCommand(runtime, sessionId, name, payload, timeoutMs = 30_000) {
  const suffix = payload === undefined ? '' : ` ${encodeBridgePayload(payload)}`;
  const command = await remoteApi(runtime, 'commands/execute', {
    agentId: sessionId,
    line: `/${name}${suffix}`,
    images: [],
  }, timeoutMs);
  return bridgeResult(command, name);
}

export async function startLeadTurn(runtime, lead, task, policy = {}, metadata = {}) {
  requireManagedRuntime(runtime);
  const opened = await executeBridgeCommand(runtime, lead.sessionId, 'codex-lead-open', {
    policy, task, prompt: leadPrompt(task, policy), requestKey: metadata.requestKey || randomUUID(),
  });
  publishLeadPolicy(runtime, { ...opened, sessionId: lead.sessionId });
  return { ...lead, ...opened, accepted: true };
}

export async function closeLeadLease(runtime, sessionId) {
  const closed = await executeBridgeCommand(runtime, sessionId, 'codex-lead-close');
  let previous = {};
  const filename = leadPolicyFilename(runtime, sessionId);
  try { previous = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch {}
  publishLeadPolicy(runtime, { ...previous, ...closed, sessionId, lease: 'closed' });
  return closed;
}

export function markLeadLeaseState(runtime, sessionId, lease, env = process.env) {
  const previous = readLeadPolicy(runtime, sessionId, env) || {};
  publishLeadPolicy(runtime, { ...previous, sessionId, lease }, env);
  return { ...previous, sessionId, lease };
}

export async function updateLeadPolicy(runtime, options = {}, policy = {}) {
  requireManagedRuntime(runtime);
  const lead = await resolveLead(runtime, options);
  const applied = await executeBridgeCommand(runtime, lead.sessionId, 'codex-lead-policy', { policy });
  publishLeadPolicy(runtime, { ...applied, sessionId: lead.sessionId, policy });
  return { ...lead, applied, lease: applied.lease };
}

export function readLeadPolicy(runtime, sessionId, env = process.env) {
  const filename = leadPolicyFilename(runtime, sessionId, env);
  if (!filename) return null;
  try {
    const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (state?.sessionId !== sessionId || !state.policy || typeof state.policy !== 'object') return null;
    return state;
  } catch {
    return null;
  }
}

export function policyToolView(policy = {}, { lead = false } = {}) {
  const names = allowedTools(policy, { lead });
  return names.length ? names : ['无工具（直接返回结果）'];
}

export async function leadResult(runtime, sessionId, options = {}) {
  const sessions = await recentSessions(runtime);
  const roles = coordinatorRoles(runtime, sessions);
  const lead = sessions.find((item) => item.sessionId === sessionId && roles.get(item.sessionId) === 'lead');
  if (!lead) throw new Error(`找不到 Codex Lead：${sessionId}`);
  const [result, policyState] = await Promise.all([
    sessionResult(runtime, sessionId, { ...options, sessions }),
    Promise.resolve(readLeadPolicy(runtime, sessionId)),
  ]);
  const allDirectChildren = sessions.filter((item) => item.parentSessionId === sessionId);
  const directChildren = allDirectChildren.slice(0, 12);
  const children = options.includeChildren === false ? [] : await Promise.all(directChildren.map(async (child) => {
    try {
      const childResult = await sessionResult(runtime, child.sessionId, { ...options, sessions, includeReasoning: false });
      if (childResult.answer.length > 8000) {
        childResult.answer = childResult.answer.slice(0, 8000);
        childResult.answerTruncated = true;
      }
      return childResult;
    } catch (error) {
      return { sessionId: child.sessionId, parentSessionId: sessionId, status: 'unknown', stale: true, error: error.message };
    }
  }));
  const policy = result.effectivePolicy || policyState?.policy || null;
  return {
    ...result,
    role: 'lead',
    title: sessionTitle(lead),
    policy,
    policySource: result.effectivePolicy ? 'native-enforced' : policy ? 'legacy-requested-unverified' : 'unknown',
    policyView: policy ? {
      leadTools: policyToolView(policy, { lead: true }),
      childTools: policyToolView(policy.childPolicy),
    } : null,
    children,
    childrenTruncated: allDirectChildren.length > directChildren.length,
    totalDirectChildren: allDirectChildren.length,
  };
}

export async function listLeads(runtime, cwd, { includeArchived = false } = {}) {
  const target = cwd ? path.resolve(cwd) : null;
  const [sessions, workspace] = await Promise.all([recentSessions(runtime), api(runtime, 'workspace.list')]);
  const archived = new Set(workspace.archivedSessionIds || []);
  const roles = coordinatorRoles(runtime, sessions);
  return sessions
    .filter((item) => roles.get(item.sessionId) === 'lead' && (!target || sameWorkspace(item.cwd, target)))
    .filter((item) => includeArchived || !archived.has(item.sessionId))
    .map((item) => ({
      sessionId: item.sessionId,
      title: sessionTitle(item),
      cwd: item.cwd || '',
      running: Boolean(item.running),
      archived: archived.has(item.sessionId),
      turns: Number(item.projections?.values?.sessionStats?.turns || 0),
      updatedAt: item.updatedAt,
    }));
}

export async function archiveSession(runtime, sessionId, action = 'archive') {
  if (!['archive', 'restore'].includes(action)) throw new Error('Invalid archive action');
  const result = await api(runtime, action === 'restore' ? 'workspace.unarchiveSession' : 'workspace.archiveSession', { sessionId });
  return { sessionId, archived: action === 'archive', action, modelCalls: 0,
    archivedSessionIds: result.archivedSessionIds || [],
    semantics: action === 'restore' ? 'Only this session is restored. No prompt, replay or ancestor restoration. Inspect remaining admission blockers.'
      : 'Records are preserved. Native subagent descendants cannot run while this ancestor is archived.' };
}

export async function startFlashSubagent(runtime, parent, task, policy = {}, metadata = {}) {
  requireManagedRuntime(runtime);
  const line = `/codex-subagent ${encodeBridgePayload({ task, policy, ...metadata })}`;
  const command = await remoteApi(runtime, 'commands/execute', {
    agentId: parent.sessionId,
    line,
    images: [],
  }, 30_000);
  return bridgeResult(command, 'codex-subagent');
}

export function originalTaskFromHistory(history) {
  const original = unwrapEvents(history).find((event) => event.type === 'user/message'
    && event.data?.source?.kind === 'user'
    && messageText(event.data?.content));
  return messageText(original?.data?.content);
}

export async function continueFlashSubagent(runtime, sessionId, task, policy = {}, metadata = {}) {
  requireManagedRuntime(runtime);
  const managed = nativeTaskState(runtime, sessionId);
  const [sessions, history] = await Promise.all([
    recentSessions(runtime),
    managed?.originalTask ? null : retryTransient(() => api(runtime, 'session.history', { sessionId, maxMessages: 32 }, 30_000)),
  ]);
  const child = sessions.find((item) => item.sessionId === sessionId && item.parentSessionId);
  if (!child) throw new Error(`找不到 DSH 原生子 Agent：${sessionId}`);
  if (!managed?.originalTask && history?.hasMore) throw new Error('Cannot establish the original task from a partial legacy history; start an explicit new task');
  const originalTask = managed?.originalTask || originalTaskFromHistory(history);
  if (!originalTask) throw new Error('Original task is unavailable; refusing to replace it with a continuation prompt');
  const line = `/codex-subagent-followup ${encodeBridgePayload({
    childSessionId: sessionId,
    originalTask,
    task,
    policy,
    requestKey: metadata.requestKey || randomUUID(),
  })}`;
  const command = await remoteApi(runtime, 'commands/execute', {
    agentId: child.parentSessionId,
    line,
    images: [],
  }, 30_000);
  return { child, ...bridgeResult(command, 'codex-subagent-followup') };
}

export function pendingDescendants(sessions, sessionId, managed = () => null) {
  const selected = new Set([sessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) if (selected.has(session.parentSessionId) && !selected.has(session.sessionId)) {
      selected.add(session.sessionId); changed = true;
    }
  }
  return sessions.filter((session) => session.sessionId !== sessionId && selected.has(session.sessionId)
    && (session.running || unresolved(managed(session.sessionId))));
}

export async function waitForTurn(runtime, sessionId, baselineTurns, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let nextProgressAt = 0;
  const completed = (sessions) => {
    const session = sessions.find(item => item.sessionId === sessionId);
    if (!session) return false;
    const state = nativeTaskState(runtime, sessionId);
    return !session.running && !unresolved(state)
      && Math.max(Number(session.projections?.values?.sessionStats?.turns || 0), state?.lastTurn || 0) > baselineTurns
      && pendingDescendants(sessions, sessionId, id => nativeTaskState(runtime, id)).length === 0;
  };
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    let sessions;
    try {
      sessions = await observeSessions(runtime);
    } catch (error) {
      if (!isTransientApiError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    latest = sessions.find((item) => item.sessionId === sessionId);
    if (!latest) throw new Error(`DSH 会话在运行期间消失：${sessionId}`);
    if (completed(sessions)) {
      const fresh = await recentSessions(runtime);
      if (completed(fresh)) return { completed: true, session: fresh.find(item => item.sessionId === sessionId) };
    }
    if (options.onProgress && Date.now() >= nextProgressAt) {
      nextProgressAt = Date.now() + 3000;
      try {
        const history = await retryTransient(() => api(runtime, 'session.history', { sessionId, session: latest, maxMessages: HISTORY_MAX_MESSAGES }, 30_000), 2);
        await options.onProgress(summarizeProgress(history));
      } catch {
        // Progress is best effort; final result retrieval remains authoritative.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return { completed: false, session: latest };
}

export async function sessionResult(runtime, sessionId, options = {}) {
  const sessions = options.sessions || await recentSessions(runtime);
  const session = sessions.find((item) => item.sessionId === sessionId);
  if (!session) throw new Error(`找不到 DSH 会话：${sessionId}`);
  const history = await retryTransient(() => api(runtime, 'session.history', { sessionId, session, maxMessages: HISTORY_MAX_MESSAGES }, 30_000));
  const managed = nativeTaskState(runtime, sessionId);
  let admission;
  try {
    const workspace = options.workspace || await api(runtime, 'workspace.list');
    admission = archiveAdmission(sessionId, sessions, workspace.archivedSessionIds);
  } catch (error) {
    admission = { blocked: null, source: 'native-archive-gate', checkFailed: true, message: `无法核验归档准入：${error.message}` };
  }
  const result = presentSessionResult(session, history, managed, { ...options, sessions,
    admission,
    managedState: id => nativeTaskState(runtime, id), finalizationManaged: Boolean(runtime.collabStateDirectory) });
  if (runtime.collabStateDirectory && result.turnId > 0 && managed?.dispatch?.state !== 'pending' && !result.finalization?.answer) {
    const artifact = new ResultStore(runtime.collabStateDirectory).page(sessionId, result.turnId, { limit: PARTIAL_ANSWER_MAX_CHARS });
    if (artifact?.totalChars) { result.answer = artifact.text; result.answerTruncated = artifact.nextOffset !== null || artifact.sourceTruncated; }
  }
  return result;
}

// Pure presentation shared by MCP and the desktop; observing never runs a model.
export function presentSessionResult(session, history, managed = null, options = {}) {
  const sessionId = session.sessionId;
  const sessions = options.sessions || [];
  const summary = summarizeHistory(history);
  const observed = managed?.observedRequest?.turn === summary.turn ? managed.observedRequest : null;
  const requestConfig = summary.headerObserved ? summary.requestConfig : observed?.config || {};
  const awaitingTurn = managed?.dispatch?.state === 'pending';
  const finalization = managed?.finalizations?.[summary.turn];
  const progress = summarizeProgress(history, options);
  const usage = summary.projections.tokenUsage || session.projections?.values?.tokenUsage || {};
  const reasoningTokens = Number.isSafeInteger(summary.responseUsage.reasoningTokens) ? summary.responseUsage.reasoningTokens : null;
  const outputTokens = Number(usage.outputTokens || summary.responseUsage.outputTokens || 0);
  const reusable = Number(usage.cacheReadTokens || 0) + Number(usage.uncachedInputTokens || 0);
  const permissionPreset = session.projections?.values?.permissions?.currentValue || '';
  const permission = effectivePermission(summary, permissionPreset);
  const pressure = summary.projections.contextPressure || session.projections?.values?.contextPressure || {};
  const childrenPending = pendingDescendants(sessions, sessionId, options.managedState).map((item) => item.sessionId);
  const status = managed?.completion?.state === 'abandoned' ? 'abandoned'
    : awaitingTurn ? 'accepted' : managed?.dispatch?.state === 'unknown' || finalization?.status === 'unknown' ? 'unknown'
    : managed?.completion?.state === 'interrupted' && !session.running ? 'interrupted'
    : managed?.completion?.state === 'blocked' && !session.running ? 'blocked'
    : finalization?.status === 'running' ? 'finalizing' : !session.running && childrenPending.length ? 'waiting_children' : session.running
    ? 'running'
    : summary.error || progress.stage === 'error'
      ? 'failed'
      : progress.stage === 'completed'
        ? 'completed'
        : progress.stage;
  return {
    sessionId,
    admission: options.admission || null,
    admissionBlock: managed?.admissionBlock?.turn === summary.turn ? managed.admissionBlock : null,
    turnId: summary.turn,
    submission: managed?.dispatch || null,
    lease: managed?.lease || 'unknown',
    effectivePolicy: managed?.policy || null,
    budgetLedger: managed?.budgetLedger || null,
    budgetPolicy: managed?.budgetPolicy || null,
    effectiveDeadline: managed?.effectiveDeadline || null,
    reconciliation: managed?.reconciliation || null,
    recovery: managed?.recovery || null,
    recoveryHolds: managed?.recoveryHolds || [],
    diagnostic: managed?.failureDiagnostic?.turn === summary.turn ? managed.failureDiagnostic : null,
    // Older hosts persisted the preceding stop reason into the next running turn.
    // Normalize reads without rewriting historical receipts or task records.
    completion: session.running ? { ...managed?.completion, state: 'running', reason: null, turn: summary.turn }
      : awaitingTurn ? { state: 'pending', reason: null, afterTurn: managed.dispatch.afterTurn }
        : managed?.completion || null,
    activity: managed?.activity || [],
    activityTruncated: Boolean(managed?.activityTruncated),
    finalization: awaitingTurn ? null : finalization || null,
    finalizationManaged: options.finalizationManaged ?? Boolean(managed),
    childrenPending,
    parentSessionId: session.parentSessionId || '',
    nativeSubagent: summary.projections.subagent || session.projections?.values?.subagent || null,
    status,
    finishReason: status === 'abandoned' ? 'abandoned' : awaitingTurn ? 'accepted' : progress.stage,
    running: Boolean(session.running),
    cwd: session.cwd || '',
    preset: session.agentPreset || '',
    model: awaitingTurn ? '' : summary.model || requestConfig.model || '',
    provider: awaitingTurn ? '' : summary.provider || requestConfig.provider || '',
    reasoningEffort: awaitingTurn ? '' : requestConfig.reasoningEffort || '',
    maxOutputTokens: !awaitingTurn && Number.isSafeInteger(requestConfig.maxTokens) ? requestConfig.maxTokens : null,
    exposedTools: awaitingTurn ? [] : summary.headerObserved ? summary.exposedTools : observed?.exposedTools || [],
    permission,
    permissionPreset,
    sandboxMode: summary.sandboxMode,
    approvalPolicy: summary.approvalPolicy,
    transcript: {
      projectedTokens: Number(pressure.projectedTokens || 0),
      pressureTokens: Number(pressure.pressureTokens || 0),
      contextWindow: Number(pressure.contextWindow || 0),
      safetyLimit: managed?.policy?.maxTranscriptTokens ?? TRANSCRIPT_SAFE_TOKENS,
      safetyLimited: (managed?.policy?.maxTranscriptTokens ?? TRANSCRIPT_SAFE_TOKENS) > 0
        && Number(pressure.projectedTokens || 0) >= (managed?.policy?.maxTranscriptTokens ?? TRANSCRIPT_SAFE_TOKENS),
    },
    turns: Number(session.projections?.values?.sessionStats?.turns || summary.projections.sessionStats?.turns || 0),
    answer: awaitingTurn ? '' : finalization?.answer || (status === 'completed' && summary.answer ? summary.answer : progress.partialAnswer || summary.answer || ''),
    answerTruncated: status === 'completed' && summary.answer ? false : Boolean(progress.partialAnswerTruncated),
    error: awaitingTurn ? '' : summary.error || (managed?.failure?.turn === summary.turn ? managed.failure.message : '')
      || (status === 'blocked' ? managed?.completion?.reason || 'blocked' : '')
      || (status === 'failed' ? failureInfo(null, 'status', summary.turn).message : ''),
    failure: awaitingTurn ? null : summary.failure || (managed?.failure?.turn === summary.turn ? managed.failure : null)
      || (status === 'failed' ? failureInfo(null, 'status', summary.turn) : null),
    progress: awaitingTurn ? { stage: 'accepted', turn: 0, partialAnswer: '', toolCalls: [] } : progress,
    ...(options.includeReasoning ? {
      reasoning: awaitingTurn ? '' : progress.reasoning || '',
      reasoningTruncated: Boolean(progress.reasoningTruncated),
    } : {}),
    usage: {
      available: Object.keys(usage).length > 0 || Object.keys(summary.responseUsage).length > 0,
      scope: 'session',
      uncachedInputTokens: Number(usage.uncachedInputTokens || 0),
      cacheReadTokens: Number(usage.cacheReadTokens || 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens || 0),
      outputTokens,
      reasoningTokens,
      reasoningScope: 'latest-response',
      visibleOutputTokens: reasoningTokens === null || !Number.isSafeInteger(summary.responseUsage.outputTokens)
        ? null : Math.max(0, summary.responseUsage.outputTokens - reasoningTokens),
      visibleOutputScope: 'latest-response',
      cacheHitRate: reusable > 0 ? Number(usage.cacheReadTokens || 0) / reusable : 0,
    },
  };
}
