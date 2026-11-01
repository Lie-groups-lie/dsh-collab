import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import contract from '../runtime-contract.json' with { type: 'json' };
import packageInfo from '../package.json' with { type: 'json' };
import { TaskStore } from '../core/task-store.mjs';
import { archiveAdmission, assertArchiveAdmission, liveArchiveAdmission } from '../core/archive-admission.mjs';
import { processIdentity } from '../core/process-identity.mjs';
import { allowedTools, budgetPolicy, continuedPolicy, optionalLimit } from '../core/capabilities.mjs';
import { scheduleConclusion, recordWork } from './finalization.mjs';
import { continueUntilAnswer, recordActivity } from './completion.mjs';
import { budgetedStream, readPricing } from './model-budget.mjs';
import { ToolRegistry } from '../core/tool-registry.mjs';
import { ResultStore } from '../core/result-store.mjs';
import { mountBrowserApi } from '../web/host.mjs';
import { mountBackground } from './background.mjs';
import { coordinatorRoleForSession } from '../core/session-identity.mjs';
import { inspectCapabilities } from './capabilities.mjs';
import { mountSchedules } from './schedules.mjs';
import { bindProjectionRegistry, errorDiagnostic } from './projection-binding.mjs';
import { mountInboxLifecycle } from './inbox-lifecycle.mjs';
import { readBuildInfo } from '../core/build-info.mjs';
import { assertDeadline } from '../core/deadline.mjs';
import { mountReconciliation } from './reconciliation.mjs';
import { recoveryPrompt, recoveryToolDenial } from '../core/recovery.mjs';
import { mountHostDiscovery, hostRuntimeInfo } from './host-discovery.mjs';
import { createNativeTransport } from './native-transport.mjs';
import { startLocalEndpoint } from './local-endpoint.mjs';
import transport from '../mcp/dsh-transport.cjs';
import { callTool } from '../service/index.mjs';

const BRIDGE_PROVIDER = 'deepseek-official';
const BRIDGE_MODEL = contract.flashModel;
const CHILD_MODELS = new Set([contract.flashModel, 'deepseek-v4-flash', 'deepseek-v4-pro']);
export const DEFAULT_MAX_OUTPUT_TOKENS = contract.defaultMaxOutputTokens;
export const SAFE_UNLIMITED_MAX_OUTPUT_TOKENS = contract.maxOutputTokens;
const CHILD_NOTICE_SOURCES = new Set(['subagent-settled', 'subagent-report', 'agent-message']);
const TOOL_DENY_LIST = Object.freeze([
  'ask_user_question',
  'create_goal',
  'get_goal',
  'update_goal',
  'exit_plan_mode',
  'workflow',
  'ralph',
  'subagent',
  'subagent_fork',
  'send_message',
  'list_agents',
  'interrupt_agent',
]);
const STANDARD_MODEL_TOOLS = Object.freeze([
  'edit',
  'glob',
  'grep',
  'job_kill',
  'job_list',
  'job_output',
  'read',
  'read_image',
  'skill',
  'todo_write',
  'web_search',
  'write',
  ...TOOL_DENY_LIST,
]);
const READ_ONLY_MUTATING_TOOLS = Object.freeze(new Set([
  'apply_patch',
  'bash',
  'edit',
  'exec',
  'job_kill',
  'job_list',
  'job_output',
  'pwsh',
  'run_code',
  'shell',
  'str_replace_editor',
  'terminal',
  'write',
  'write_file',
]));
const PERMISSIONS = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const REASONING_EFFORTS = new Set(['off', 'low', 'high', 'max']);
const policies = new Map();
const originalTasks = new Map();
const parentRoles = new Map();
const observedRoles = new WeakMap();
const leadLeases = new Set();
const leadPolicies = new Map();
const leadToolUsage = new Map();
const leadToolRestrictions = new Map();
const childToolRestrictions = new Map();
let taskStore;
let titleService;
let toolRegistry = new ToolRegistry();

function restoreTask(agent) {
  const saved = taskStore.get(agent.id);
  if (!saved) return null;
  parentRoles.set(agent.id, saved.role);
  if (saved.role !== 'relay') {
    (saved.role === 'lead' ? leadPolicies : policies).set(agent.id, saved.policy);
    originalTasks.set(agent.id, saved.originalTask);
    if (saved.role === 'lead') {
      if (saved.lease === 'active') leadLeases.add(agent.id);
    }
  }
  return saved;
}

function savePolicy(agent, policy, role, extra = {}) {
  const saved = taskStore.get(agent.id);
  return saved ? taskStore.update(agent.id, { policy, role, ...extra })
    : taskStore.create({ id: agent.id, policy, role, ...extra });
}

function closeLease(id) {
  leadLeases.delete(id);
  if (taskStore.get(id)) taskStore.update(id, { lease: 'closed' });
}

function requireManagedPolicy(agent) {
  const record = taskStore.get(agent.id);
  if (record?.policy) {
    const root = taskStore.root(agent.id);
    if (root.dispatch?.recoveryId && ['pending', 'running'].includes(root.dispatch.state) && root.recovery?.preservedSessions?.includes(agent.id)) {
      throw new Error('Recovery preserves this completed child; reuse its existing result. No model request was sent.');
    }
  }
  if (taskStore.get(agent.id)?.dispatch?.state === 'unknown') throw new Error('Submission outcome is unknown; automatic replay is disabled');
  const parentId = agent.session.header.parentSession;
  const parent = parentId && taskStore.get(parentId);
  if (!policies.has(agent.id) && !leadPolicies.has(agent.id)
      && (coordinationRole(agent) === 'lead' || parent?.role === 'relay' || parent?.role === 'lead')) {
    throw new Error('Managed session has no durable policy; explicit re-admission is required');
  }
}

function reserveOutput(agent, policy, turn, step) {
  return taskStore.outputAllowance(agent.id, policy.maxOutputTokens);
}

export const name = 'codex-subagent-bridge';
export const inject = ['agents', 'sessions', 'approval', 'commands', 'permissionPresets', 'subagents', 'tools', 'connection', 'webServer', 'typertGateway', 'sessionTitle', 'llm', 'schedule', 'sessionController', 'workspaceRegistry', 'sessionProjections'];

function decodePayload(rawInput) {
  const encoded = String(rawInput || '').trim();
  if (!encoded) throw new Error('missing bridge payload');
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object') throw new Error('invalid bridge payload');
  return value;
}

function textPrompt(value) {
  const task = String(value || '').trim();
  if (!task) throw new Error('task is required');
  return [{ type: 'text', text: task }];
}

function taskLabel(task) {
  const compact = String(task).replace(/\s+/g, ' ').trim();
  return `Codex · ${compact.slice(0, 56) || 'DeepSeek task'}`;
}

function success(value) {
  return { kind: 'success', text: JSON.stringify(value) };
}

function integerInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function outputTokenLimit(value, fallback = DEFAULT_MAX_OUTPUT_TOKENS) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 64) {
    throw new Error('maxOutputTokens must be a safe integer greater than or equal to 64');
  }
  return number;
}

export function normalizePolicy(value = {}) {
  if (value.unlimitedOutputTokens === true && value.maxOutputTokens !== undefined && value.maxOutputTokens !== null
    && value.outputSafetyCap === undefined) {
    throw new Error('maxOutputTokens and unlimitedOutputTokens cannot be set together');
  }
  const requestedUnlimited = value.unlimitedOutputTokens === true;
  const maxOutputTokens = requestedUnlimited
    ? SAFE_UNLIMITED_MAX_OUTPUT_TOKENS
    : Math.min(outputTokenLimit(value.maxOutputTokens), SAFE_UNLIMITED_MAX_OUTPUT_TOKENS);
  return Object.freeze({
    provider: BRIDGE_PROVIDER,
    model: BRIDGE_MODEL,
    permission: PERMISSIONS.has(value.permission) ? value.permission : 'read-only',
    reasoningEffort: REASONING_EFFORTS.has(value.reasoningEffort) ? value.reasoningEffort : 'high',
    maxOutputTokens,
    unlimitedOutputTokens: requestedUnlimited,
    outputSafetyCap: SAFE_UNLIMITED_MAX_OUTPUT_TOKENS,
    outputSafetyLimited: requestedUnlimited || Number(value.maxOutputTokens) > SAFE_UNLIMITED_MAX_OUTPUT_TOKENS,
    maxToolCalls: optionalLimit(value.maxToolCalls, 'maxToolCalls'),
    allowTerminal: value.allowTerminal === true,
    allowDelegation: false,
    finalizeEmpty: value.finalizeEmpty !== false,
    continueUntilAnswer: value.continueUntilAnswer !== false,
    ...budgetPolicy(value, maxOutputTokens),
  });
}

export function normalizeLeadChildPolicy(value = {}) {
  if (value.unlimitedOutputTokens === true && value.maxOutputTokens !== undefined && value.maxOutputTokens !== null
    && value.outputSafetyCap === undefined) {
    throw new Error('child maxOutputTokens and unlimitedOutputTokens cannot be set together');
  }
  const requestedUnlimited = value.unlimitedOutputTokens === true;
  const maxOutputTokens = requestedUnlimited
    ? SAFE_UNLIMITED_MAX_OUTPUT_TOKENS
    : Math.min(outputTokenLimit(value.maxOutputTokens), SAFE_UNLIMITED_MAX_OUTPUT_TOKENS);
  return Object.freeze({
    provider: BRIDGE_PROVIDER,
    model: value.model === 'deepseek-v4-flash' ? BRIDGE_MODEL : CHILD_MODELS.has(value.model) ? value.model : BRIDGE_MODEL,
    permission: PERMISSIONS.has(value.permission) ? value.permission : 'read-only',
    reasoningEffort: REASONING_EFFORTS.has(value.reasoningEffort) ? value.reasoningEffort : 'high',
    maxOutputTokens,
    unlimitedOutputTokens: requestedUnlimited,
    outputSafetyCap: SAFE_UNLIMITED_MAX_OUTPUT_TOKENS,
    outputSafetyLimited: requestedUnlimited || Number(value.maxOutputTokens) > SAFE_UNLIMITED_MAX_OUTPUT_TOKENS,
    maxToolCalls: optionalLimit(value.maxToolCalls, 'maxToolCalls'),
    allowTerminal: value.allowTerminal === true,
    allowDelegation: value.allowDelegation === true,
    finalizeEmpty: value.finalizeEmpty !== false,
    continueUntilAnswer: value.continueUntilAnswer !== false,
    ...budgetPolicy(value, maxOutputTokens),
  });
}

export function normalizeLeadPolicy(value = {}) {
  return Object.freeze({
    ...normalizePolicy(value),
    maxChildren: integerInRange(value.maxChildren, 4, 0, 16),
    childPolicy: normalizeLeadChildPolicy(value.childPolicy),
  });
}

export function applyOutputBudget(config, policy) {
  return { ...config, maxTokens: policy.maxOutputTokens };
}

function sessionTitle(agent) {
  return agent?.session ? titleService?.get(agent.session)?.title || '' : '';
}

function permittedTool(tool, policy, agent, lead = false, args) {
  if (allowedTools(policy, { lead }).includes(tool?.name)) return null;
  return toolRegistry.decision(tool, policy, agent.session.header.cwd, args);
}

export function coordinationRole(agent, explicitRoles = parentRoles) {
  if (!agent) return '';
  const session = { parentSessionId: agent.session?.header?.parentSession };
  if (explicitRoles.has(agent.id)) return coordinatorRoleForSession(session, { role: explicitRoles.get(agent.id) });
  if (observedRoles.has(agent)) return observedRoles.get(agent);
  session.projections = { values: { title: sessionTitle(agent) } };
  const role = coordinatorRoleForSession(session);
  observedRoles.set(agent, role);
  return role;
}

export function isChildNotice(message) {
  return CHILD_NOTICE_SOURCES.has(message?.source?.kind);
}

export function filterCoordinatorMessages(messages) {
  return (messages || []).filter((message) => !isChildNotice(message));
}

export function runningDescendantIds(entries = []) {
  return (entries || [])
    .filter((entry) => entry?.kind === 'child' && (entry.activity === 'running' || entry.running === true))
    .map((entry) => entry.id)
    .filter(Boolean);
}

function waitDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason || new Error('Lead turn was cancelled'));
    }
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function waitForRunningDescendants(ctx, agent, signal, shouldContinue = () => true) {
  while (!signal.aborted && shouldContinue()) {
    let descendants;
    try {
      descendants = await ctx.subagents.listDescendants(agent.id, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('Cannot establish descendant completion', { cause: error });
    }
    if (descendants.some((entry) => entry.kind === 'diagnostic')) throw new Error('Descendant state is incomplete');
    const queued = descendants.some(entry => {
      if (entry.kind !== 'child') return false;
      const state = taskStore.get(entry.id);
      if (state?.dispatch?.state === 'unknown' || Object.values(state?.finalizations || {}).some(item => item.status === 'unknown')) {
        throw new Error('Descendant outcome is unknown; explicit reconciliation is required before handoff');
      }
      return ['pending', 'running'].includes(state?.dispatch?.state)
        || Object.values(state?.finalizations || {}).some(item => item.status === 'running');
    });
    if (runningDescendantIds(descendants).length === 0 && !queued) return;
    await waitDelay(500, signal);
  }
}

export function continuationPrompt(originalTask, followupTask) {
  const original = String(originalTask || '').trim();
  const followup = String(followupTask || '').trim();
  if (!original || original === followup) return followup || original;
  return [
    '原始完整任务（本轮仍须严格遵守）：',
    original,
    '',
    '本轮续写要求：',
    followup,
    '',
    '请继续完成原始任务；不要依赖可能失真的摘要来恢复任务要求。',
  ].join('\n');
}

function applyPermission(ctx, agent, policy) {
  if (!agent || ctx.permissionPresets.current(agent.session) === policy.permission) return;
  ctx.permissionPresets.set(agent.session, policy.permission);
}

function terminalToolName() {
  return process.platform === 'win32' ? 'pwsh' : 'bash';
}

export function deniedChildTools(policy) {
  const denied = new Set();
  if (policy.maxToolCalls === 0) {
    for (const name of STANDARD_MODEL_TOOLS) denied.add(name);
    denied.add(terminalToolName());
  }
  if (!policy.allowDelegation) {
    for (const name of TOOL_DENY_LIST) denied.add(name);
  }
  if (!policy.allowTerminal || policy.permission === 'read-only') denied.add(terminalToolName());
  if (policy.permission === 'read-only') {
    denied.add('write');
    denied.add('edit');
  }
  return [...denied];
}

export function deniedLeadTools(policy) {
  const denied = new Set();
  if (policy.maxToolCalls === 0) {
    for (const name of STANDARD_MODEL_TOOLS) denied.add(name);
    denied.add(terminalToolName());
  }
  if (!policy.allowTerminal || policy.permission === 'read-only') denied.add(terminalToolName());
  if (policy.permission === 'read-only') {
    denied.add('write');
    denied.add('edit');
  }
  if (policy.maxChildren === 0) {
    denied.add('subagent');
    denied.add('subagent_fork');
  }
  return [...denied];
}

export function childToolRestriction(policy) {
  if (policy.maxToolCalls === 0) return { allow: [] };
  return { deny: deniedChildTools(policy) };
}

export function leadToolRestriction(policy) {
  if (policy.maxToolCalls === 0) return { allow: [] };
  return { deny: deniedLeadTools(policy) };
}

function replaceToolRestriction(store, agent, restriction) {
  if (!agent) return;
  // Newer DSH rejects unknown names in restrict(); scoped preset tools are
  // additionally filtered through the authoritative assembly hook below.
  if (restriction.deny) {
    store.get(agent.id)?.();
    store.delete(agent.id);
    return;
  }
  const signature = JSON.stringify(restriction);
  if (store.get(agent.id)?.agent === agent && store.get(agent.id)?.signature === signature) return;
  store.get(agent.id)?.();
  store.delete(agent.id);
  const dispose = agent.ctx.tools.restrict(restriction);
  dispose.agent = agent;
  dispose.signature = signature;
  store.set(agent.id, dispose);
}

function applyChildToolRestriction(agent, policy) {
  replaceToolRestriction(childToolRestrictions, agent, childToolRestriction(policy));
}

function applyLeadToolRestriction(agent, policy) {
  replaceToolRestriction(leadToolRestrictions, agent, leadToolRestriction(policy));
}

function installChildGuards(ctx) {
  const usage = new Map();
  const disposers = [
      ctx.on('agent/created', ({ agent }) => {
        const saved = restoreTask(agent);
        const parentId = agent.session.header.parentSession;
        const parent = parentId && taskStore.get(parentId);
        const inherited = parent?.role === 'lead' ? parent.policy.childPolicy : null;
        if (!saved && inherited) {
          taskStore.create({ id: agent.id, parentId, rootId: parent.rootId, policy: inherited });
          policies.set(agent.id, inherited);
        }
        const policy = policies.get(agent.id);
        if (policy) {
          applyPermission(ctx, agent, policy);
          applyChildToolRestriction(agent, policy);
        }
      }, { global: true }),
      ctx.on('agent/disposed', ({ agent }) => {
        childToolRestrictions.get(agent.id)?.();
        childToolRestrictions.delete(agent.id);
        policies.delete(agent.id);
        originalTasks.delete(agent.id);
        usage.delete(agent.id);
      }, { global: true }),
      ctx.on('agent/inbox/claimed', ({ agent, turn }) => {
        if (usage.get(agent.id)?.turn !== turn) usage.set(agent.id, { turn, calls: 0 });
      }, { global: true }),
      ctx.on('agent/request', async ({ agent, turn, step }, next) => {
        requireManagedPolicy(agent);
        const config = await next();
        const policy = policies.get(agent.id);
        if (!policy) return config;
        applyPermission(ctx, agent, policy);
        applyChildToolRestriction(agent, policy);
        return { ...applyOutputBudget({
          ...config,
          provider: policy.provider,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
        }, policy), maxTokens: reserveOutput(agent, policy, turn, step) };
      }, { global: true }),
      ctx.tools.guard((exec) => {
        const policy = exec.agent && policies.get(exec.agent.id);
        if (!policy || exec.name === 'report') return undefined;
        const denial = recoveryToolDenial(taskStore, exec.agent.id, exec.name, exec.arguments, exec.agent.session.header.cwd)
          || permittedTool(ctx.tools.get(exec.name, exec.agent), policy, exec.agent, false, exec.arguments);
        if (denial) return denial;
        const state = usage.get(exec.agent.id) || { turn: 0, calls: 0 };
        state.calls += 1;
        usage.set(exec.agent.id, state);
        if (policy.permission === 'read-only' && READ_ONLY_MUTATING_TOOLS.has(exec.name)) {
          return `Codex bridge read-only policy blocks tool "${exec.name}".`;
        }
        if (!policy.allowTerminal && READ_ONLY_MUTATING_TOOLS.has(exec.name)
          && ['bash', 'exec', 'pwsh', 'run_code', 'shell', 'terminal'].includes(exec.name)) {
          return `Codex bridge child terminal policy blocks tool "${exec.name}".`;
        }
        if (policy.maxToolCalls != null && state.calls > policy.maxToolCalls) {
          return `Codex bridge tool-call limit reached (${policy.maxToolCalls} per turn).`;
        }
        try { taskStore.tool(exec.agent.id); } catch (error) { return error.message; }
        return undefined;
      }),
    ];
  return () => {
      for (const dispose of disposers.reverse()) dispose();
  };
}

function installCoordinatorGuards(ctx) {
  const disposers = [
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next();
      const policy = context.agent && (policies.get(context.agent.id) || leadPolicies.get(context.agent.id));
      if (!policy) return assembly;
      return { ...assembly, tools: assembly.tools.filter((tool) => !permittedTool(tool, policy, context.agent, !policies.has(context.agent.id))) };
    }, { global: true }),
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const childPolicy = policies.get(agent.id);
      const leadPolicy = leadPolicies.get(agent.id);
      if (childPolicy) {
        applyPermission(ctx, agent, childPolicy);
        applyChildToolRestriction(agent, childPolicy);
      } else if (leadPolicy) {
        applyPermission(ctx, agent, leadPolicy);
        applyLeadToolRestriction(agent, leadPolicy);
      }
      const role = coordinationRole(agent);
      if (!role || role === 'lead' && leadLeases.has(agent.id)) return next();
      const retained = filterCoordinatorMessages(messages);
      if (!retained.length && retained.length !== messages.length) return { kind: 'reject' };
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      return { ...decision, messages: filterCoordinatorMessages(decision.messages) };
    }, { global: true }),
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      const config = await next();
      const policy = leadPolicies.get(agent.id);
      if (!policy) return config;
      applyPermission(ctx, agent, policy);
      return { ...applyOutputBudget({
        ...config,
        provider: policy.provider,
        model: policy.model,
        reasoningEffort: policy.reasoningEffort,
      }, policy), maxTokens: reserveOutput(agent, policy, turn, step) };
    }, { global: true }),
    ctx.on('agent/inbox/claimed', ({ agent, turn }) => {
      if (!leadPolicies.has(agent.id)) return;
      const state = leadToolUsage.get(agent.id);
      if (!state || state.turn !== turn) leadToolUsage.set(agent.id, { turn, calls: 0, children: 0 });
    }, { global: true }),
    ctx.tools.guard((exec) => {
      const policy = exec.agent && leadPolicies.get(exec.agent.id);
      if (!policy) return undefined;
      const denial = recoveryToolDenial(taskStore, exec.agent.id, exec.name, exec.arguments, exec.agent.session.header.cwd)
        || permittedTool(ctx.tools.get(exec.name, exec.agent), policy, exec.agent, true, exec.arguments);
      if (denial) return denial;
      const state = leadToolUsage.get(exec.agent.id) || { turn: 0, calls: 0, children: 0 };
      state.calls += 1;
      if (['subagent', 'subagent_fork'].includes(exec.name)) state.children += 1;
      leadToolUsage.set(exec.agent.id, state);
      if (policy.permission === 'read-only' && READ_ONLY_MUTATING_TOOLS.has(exec.name)) {
        return `Codex Lead read-only policy blocks tool "${exec.name}".`;
      }
      if (!policy.allowTerminal && ['bash', 'exec', 'pwsh', 'run_code', 'shell', 'terminal'].includes(exec.name)) {
        return `Codex Lead terminal policy blocks tool "${exec.name}".`;
      }
      if (policy.maxToolCalls != null && state.calls > policy.maxToolCalls) {
        return `Codex Lead tool-call limit reached (${policy.maxToolCalls} per turn).`;
      }
      if (state.children > policy.maxChildren) {
        return `Codex Lead child-agent limit reached (${policy.maxChildren} per turn).`;
      }
      try { taskStore.tool(exec.agent.id, { child: ['subagent', 'subagent_fork'].includes(exec.name) }); }
      catch (error) { return error.message; }
      return undefined;
    }),
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      const role = coordinationRole(agent);
      if (role === 'relay') return;
      if (role === 'lead') {
        await waitForRunningDescendants(ctx, agent, signal, () => leadLeases.has(agent.id));
        if ((agent.inbox?.nextStep || []).some(isChildNotice)) return;
        closeLease(agent.id);
        return;
      }
      await waitForRunningDescendants(ctx, agent, signal);
    }, { global: true }),
    ctx.on('agent/error', ({ agent }) => {
      if (coordinationRole(agent) === 'lead') closeLease(agent.id);
    }, { global: true }),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

export function apply(ctx, config = {}) {
  titleService = ctx.sessionTitle;
  const projectionBinding = bindProjectionRegistry(ctx);
  const inboxLifecycle = mountInboxLifecycle(ctx);
  const build = readBuildInfo();
  const processInstance = { id: randomUUID(), startedAt: Date.now(), node: process.versions.node,
    electron: process.versions.electron || null, v8: process.versions.v8, platform: process.platform, arch: process.arch };
  const profile = ctx.get('profileContext');
  const hostInfo = profile ? hostRuntimeInfo(profile) : null;
  const stateRoot = process.env.DSH_COLLAB_STATE_DIR || path.join(profile?.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'codex-collab');
  taskStore = new TaskStore(stateRoot);
  taskStore.executionBuild = { buildId: build.buildId || null, sourceDigest: build.sourceDigest || null, instanceId: processInstance.id, collabVersion: packageInfo.version };
  ctx.effect(() => {
    try { return taskStore.claimWriter(); }
    catch (error) {
      // Durable children deliberately have no console pipes. Preserve a bounded,
      // non-secret startup diagnostic so the desktop does not just say timeout.
      const handshake = process.env.DSH_DESKTOP_HANDSHAKE_FILE;
      if (handshake) {
        const message = /^(Cannot verify|Legacy task-store|Task store already|Invalid task-store)/.test(error.message)
          ? error.message.slice(0, 1600)
          : error.code === 'EEXIST' ? 'Task-store recovery lock exists; verify the original runtime/recovery owner before manual recovery.'
            : 'Task-store writer initialization failed; inspect local file access and lock integrity.';
        try { fs.writeFileSync(`${handshake}.error`, JSON.stringify({ code: 'COLLAB_WRITER_LOCK', message }), { mode: 0o600 }); }
        catch { /* The original ownership failure remains authoritative. */ }
      }
      throw error;
    }
  });
  taskStore.recover();
  let browserRuntime;
  const runtime = () => {
    const url = ctx.webServer.getOrigin();
    // Reuse one authenticated observation connection, not a new token/mux per poll.
    if (!browserRuntime || browserRuntime.url !== url) browserRuntime = { url, webUrl: url, localControlApi: 2,
      entry: hostInfo?.entry || process.argv[1],
      dshVersion: hostInfo?.dshVersion || contract.dshVersion, bridgeVersion: contract.bridgeVersion,
      collabStateDirectory: taskStore.directory, capabilitiesApi: 1, schedulingApi: ctx.get('schedule') ? 2 : 0,
      projectionBinding, inboxLifecycle, build, processInstance, reconciliationApi: 1, recoveryApi: 1, collabVersion: packageInfo.version };
    return browserRuntime;
  };
  mountBrowserApi(ctx, runtime);
  const background = mountBackground(ctx, taskStore, runtime);
  const extensionTools = new Map();
  const invokeCore = (name, args, context = {}) => callTool(name, args, { ...context, runtime: runtime() });
  ctx.provide('dshCollabApi', {
    version: 1, runtime, callTool: invokeCore,
    registerTools(definitions, handler) {
      for (const definition of definitions) {
        if (!/^research_[a-z_]+$/.test(definition.name) || extensionTools.has(definition.name)) throw new Error('Unsupported or duplicate extension tool');
      }
      for (const definition of definitions) extensionTools.set(definition.name, handler);
      return () => { for (const definition of definitions) if (extensionTools.get(definition.name) === handler) extensionTools.delete(definition.name); };
    },
  });
  const nativeTransport = createNativeTransport(ctx, background);
  ctx.effect(() => transport.bindNative(runtime(), nativeTransport));
  const controlReady = startLocalEndpoint(nativeTransport, {
    background: (operation, args, signal) => nativeTransport.background(operation, args, signal),
    invokeTool: (operation, args, signal, onProgress) => extensionTools.has(operation)
      ? extensionTools.get(operation)(operation, args, { signal, onProgress })
      : invokeCore(operation, args, { signal, onProgress }),
  });
  // Keep listener ownership inside this plugin fiber and close it on unload.
  controlReady.catch(() => ctx.logger.error('Collab local endpoint could not start; no browser-access fallback was enabled.'));
  ctx.effect(() => async () => { const control = await controlReady.catch(() => null); await control?.close(); });
  const reconciliation = mountReconciliation(ctx, taskStore, background);
  toolRegistry = ToolRegistry.fromFile(process.env.DSH_COLLAB_TOOLS_FILE);
  background.registerOperation('deepseek_capabilities', args => inspectCapabilities(ctx, taskStore, toolRegistry, args));
  function admitLead(agent, payload, { turn, deadlineAt, recovery } = {}) {
    let policy = normalizeLeadPolicy(payload.policy);
    const spec = { task: payload.task, policy };
    const previous = payload.requestKey ? taskStore.findSubmission(`lead:${agent.id}`, String(payload.requestKey), spec) : null;
    if (previous?.receipt) return { ...previous.receipt, replayed: true };
    assertArchiveAdmission(liveArchiveAdmission(ctx, agent.session));
    const existing = taskStore.get(agent.id);
    if (existing) policy = continuedPolicy(existing.policy, policy);
    if (existing && turn === undefined) taskStore.beginDispatch(agent.id, { preserveDeadline: Boolean(recovery) });
    const submission = payload.requestKey ? taskStore.claimSubmission(`lead:${agent.id}`, String(payload.requestKey), spec) : null;
    savePolicy(agent, policy, 'lead', { lease: 'active', originalTask: String(payload.task || ''), latestTask: String(payload.task || '') });
    if (!existing) taskStore.beginDispatch(agent.id);
    if (turn !== undefined) taskStore.update(agent.id, { dispatch: { id: randomUUID(), state: 'running', turn, afterTurn: turn - 1,
      ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}) } });
    parentRoles.set(agent.id, 'lead'); leadPolicies.set(agent.id, policy); leadLeases.add(agent.id); leadToolUsage.delete(agent.id);
    applyPermission(ctx, agent, policy); applyLeadToolRestriction(agent, policy);
    if (payload.prompt) agent.followup(Object.freeze({ id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'user' }),
      content: Object.freeze(textPrompt(recovery ? `${recoveryPrompt(existing, recovery)}\n\nCurrent continuation instruction:\n${payload.prompt}` : payload.prompt).map(Object.freeze)) }));
    const receipt = { sessionId: agent.id, role: 'lead', lease: 'active', policy,
      requestKey: payload.requestKey || null, submission: taskStore.get(agent.id).dispatch, ...(recovery ? { recovery } : {}) };
    if (submission) taskStore.completeSubmission(submission.id, receipt);
    return receipt;
  }
  const schedules = mountSchedules(ctx, taskStore, background, admitLead);
  const pricing = readPricing(process.env.DSH_COLLAB_PRICING_FILE);
  ctx.on('llm/stream', (options, next) => budgetedStream({ store: taskStore, ctx, pricing }, options, next), { global: true, prepend: true });
  ctx.on('tools/execute', async (exec, next) => {
    if (!exec.agent || !taskStore.get(exec.agent.id)?.policy) return next();
    const deadline = assertDeadline(taskStore, exec.agent.id);
    if (deadline.at === null) return next();
    const remaining = deadline.at - Date.now();
    const previous = exec.signal;
    exec.signal = AbortSignal.any([previous, AbortSignal.timeout(remaining)]);
    try { return await next(); } finally { exec.signal = previous; }
  }, { global: true });
  ctx.on('agent/error', ({ agent, turn, step, error }) => {
    const record = taskStore.get(agent.id);
    if (!record?.policy) return;
    taskStore.update(agent.id, { failureDiagnostic: errorDiagnostic(error, {
      sessionId: agent.id, turn, step, submissionId: record.dispatch?.id || null,
    }, projectionBinding) });
  }, { global: true });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && event.data.reason?.kind === 'blocked' && taskStore.get(session.id)?.policy) {
      const admission = liveArchiveAdmission(ctx, session);
      if (admission.blocked) taskStore.update(session.id, { admissionBlock: { ...admission, turn: event.data.turn, at: Date.now() } });
    }
    if (event.type === 'session/title') {
      const agent = ctx.agents.get(session.id);
      if (agent) observedRoles.delete(agent);
    }
    schedules.beforeEvent(session, event);
    taskStore.observeLifecycle(session.id, event);
    if (['turn/start', 'turn/end'].includes(event.type)) background.reports.dirty = true;
    if (['assistant/message', 'assistant/attempt'].includes(event.type) && taskStore.get(session.id)?.policy) {
      new ResultStore(taskStore.directory).record(session.id, event);
    }
    recordWork(taskStore, session, event);
    recordActivity(taskStore, session, event);
    if (event.type === 'user/message') {
      const record = taskStore.get(session.id);
      if (record?.policy && !record.originalTask) taskStore.update(session.id, { originalTask:
        (event.data.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n') });
    }
    const continuing = continueUntilAnswer({ ctx, store: taskStore, session, event, reopenLead: (record) => {
      if (record.role === 'lead') { leadLeases.add(record.id); taskStore.update(record.id, { lease: 'active' }); }
    } });
    if (!continuing) scheduleConclusion({ ctx, store: taskStore, session, event, normalizePolicy, policies });
    schedules.afterEvent(session, event, continuing);
  }, { global: true });
  // Provider retries are not separate agent/request admissions. Do not allow
  // invisible billable retries to escape the persistent reservation ledger.
  ctx.on('agent/request-error', async ({ agent }, next) => {
    if (taskStore.get(agent.id)) return undefined;
    return next();
  }, { global: true });
  const publishHandshake = async () => {
    const filename = process.env.DSH_DESKTOP_HANDSHAKE_FILE;
    if (!filename) return;
    const url = ctx.webServer.getOrigin();
    const lifetime = globalThis[Symbol.for('dsh.collab.lifecycle')];
    const identity = processIdentity(process.pid).identity;
    const control = (await controlReady).descriptor;
    lifetime?.ready?.(identity);
    fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, url,
      processIdentity: identity, startedAt: Date.now(), instanceId: lifetime?.instanceId,
      launchUrl: ctx.connection.authenticatedUrl(url), bridgeVersion: contract.bridgeVersion,
      localControlApi: control.localControlApi, controlUrl: control.url, controlLaunchUrl: control.launchUrl,
      transportGeneration: control.transportGeneration,
      collabStateDirectory: taskStore.directory, capabilitiesApi: 1, schedulingApi: ctx.get('schedule') ? 2 : 0,
      projectionBinding, inboxLifecycle, build, processInstance, reconciliationApi: 1, recoveryApi: 1, collabVersion: packageInfo.version,
      toolRegistry: { revision: toolRegistry.revision, tools: toolRegistry.describe() } }), { mode: 0o600 });
  };
  if (ctx.get('appReady')) ctx.effect(() => ctx.appReady.onReady(publishHandshake));
  else publishHandshake();
  mountHostDiscovery(ctx, config, async () => ({ ...runtime(), ...(await controlReady).descriptor }));
  installChildGuards(ctx);
  installCoordinatorGuards(ctx);
  ctx.commands.register({
    name: 'codex-subagent',
    description: 'start a native continuable DeepSeek subagent for Codex',
    input: { hint: '<bridge-payload>' },
    recordInput: false,
    async handler(invocation) {
      const payload = decodePayload(invocation.rawInput);
      const task = String(payload.task || '').trim();
      const childId = randomUUID();
      const policy = normalizePolicy(payload.policy);
      const scope = invocation.agent.session.header.cwd || invocation.agent.id;
      const spec = { task, policy, ...(payload.budgetRootId ? { budgetRootId: payload.budgetRootId } : {}) };
      const prior = payload.requestKey ? taskStore.findSubmission(scope, String(payload.requestKey), spec) : null;
      if (prior?.receipt) return success({ ...prior.receipt, replayed: true });
      assertArchiveAdmission(liveArchiveAdmission(ctx, invocation.agent.session));
      const submission = payload.requestKey ? taskStore.claimSubmission(
        invocation.agent.session.header.cwd || invocation.agent.id, String(payload.requestKey),
        { task, policy, ...(payload.budgetRootId ? { budgetRootId: payload.budgetRootId } : {}) },
      ) : null;
      if (submission?.receipt) return success({ ...submission.receipt, replayed: true });
      if (!taskStore.get(invocation.agent.id)) taskStore.create({ id: invocation.agent.id, role: 'relay' });
      taskStore.create({ id: childId, parentId: invocation.agent.id, policy, originalTask: task,
        ...(payload.budgetRootId ? { rootId: taskStore.root(payload.budgetRootId).id } : {}) });
      taskStore.beginDispatch(childId);
      parentRoles.set(invocation.agent.id, 'relay');
      policies.set(childId, policy);
      originalTasks.set(childId, task);
      const started = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: taskLabel(task),
        childId,
        request: {
          prompt: textPrompt(task),
          parent: invocation.agent,
          agentOptions: applyOutputBudget({
            provider: BRIDGE_PROVIDER,
            model: BRIDGE_MODEL,
          }, policy),
        },
        signal: invocation.signal,
        delivery: 'caller',
      });
      started.result.catch((error) => ctx.logger.warn(`Codex child ${childId}: ${error.message}`));
      const receipt = {
        parentSessionId: invocation.agent.id,
        childSessionId: started.childId,
        messageId: started.messageId,
        mode: 'continuable',
        policy,
        requestKey: payload.requestKey || null,
        submission: taskStore.get(childId).dispatch,
      };
      if (submission) taskStore.completeSubmission(submission.id, receipt);
      return success(receipt);
    },
  });

  ctx.commands.register({
    name: 'codex-subagent-followup',
    description: 'send a follow-up prompt to a native Codex child agent',
    input: { hint: '<bridge-payload>' },
    recordInput: false,
    async handler(invocation) {
      const payload = decodePayload(invocation.rawInput);
      const childSessionId = String(payload.childSessionId || '').trim();
      if (!childSessionId) throw new Error('childSessionId is required');
      let policy = normalizePolicy(payload.policy);
      const prior = payload.requestKey ? taskStore.findSubmission(`continue:${childSessionId}`, String(payload.requestKey), { task: payload.task, policy }) : null;
      if (prior?.receipt) return success({ ...prior.receipt, replayed: true });
      const native = (await ctx.sessionController.list({})).items;
      assertArchiveAdmission(archiveAdmission(childSessionId, native, ctx.workspaceRegistry.archivedSessionIds));
      const submission = payload.requestKey ? taskStore.claimSubmission(`continue:${childSessionId}`, String(payload.requestKey), { task: payload.task, policy }) : null;
      if (submission?.receipt) return success({ ...submission.receipt, replayed: true });
      parentRoles.set(invocation.agent.id, 'relay');
      const saved = taskStore.get(childSessionId);
      if (saved && saved.parentId !== invocation.agent.id) throw new Error('Task parent mismatch');
      if (saved) taskStore.beginDispatch(childSessionId);
      if (saved) policy = continuedPolicy(saved.policy, policy);
      const originalTask = String(saved?.originalTask || originalTasks.get(childSessionId) || payload.originalTask || payload.task || '').trim();
      if (saved) taskStore.update(childSessionId, { policy, latestTask: continuationPrompt(originalTask, payload.task) });
      else taskStore.create({ id: childSessionId, parentId: invocation.agent.id, policy, originalTask });
      if (!saved) taskStore.beginDispatch(childSessionId);
      originalTasks.set(childSessionId, originalTask);
      policies.set(childSessionId, policy);
      const child = ctx.agents.get(childSessionId);
      applyPermission(ctx, child, policy);
      applyChildToolRestriction(child, policy);
      const { messageId } = await ctx.subagents.prompt({
        requestId: randomUUID(), parentSessionId: invocation.agent.id, childSessionId,
        mode: 'continuable', delivery: 'queue',
        content: textPrompt(continuationPrompt(originalTask, payload.task)),
      }, invocation.signal);
      const receipt = {
        parentSessionId: invocation.agent.id,
        childSessionId,
        messageId,
        mode: 'continuable',
        policy,
        requestKey: payload.requestKey || null,
        submission: taskStore.get(childSessionId).dispatch,
      };
      if (submission) taskStore.completeSubmission(submission.id, receipt);
      return success(receipt);
    },
  });

  ctx.commands.register({
    name: 'codex-lead-open',
    description: 'open one bounded Codex Lead task lease',
    input: { hint: '<bridge-payload>' },
    recordInput: false,
    async handler(invocation) {
      const payload = decodePayload(invocation.rawInput);
      const policy = normalizeLeadPolicy(payload.policy), existing = taskStore.get(invocation.agent.id);
      const previous = payload.requestKey ? taskStore.findSubmission(`lead:${invocation.agent.id}`, String(payload.requestKey), { task: payload.task, policy }) : null;
      if (previous?.receipt) return success({ ...previous.receipt, replayed: true });
      if (existing) { continuedPolicy(existing.policy, policy); assertDeadline(taskStore, existing.id); }
      return success(await reconciliation.continuation(invocation.agent.id, recovery => admitLead(invocation.agent, payload, { recovery })));
    },
  });

  ctx.commands.register({
    name: 'codex-lead-close',
    description: 'close a Codex Lead task lease without running the model',
    input: { hint: '<none>' },
    recordInput: false,
    async handler(invocation) {
      parentRoles.set(invocation.agent.id, 'lead');
      closeLease(invocation.agent.id);
      leadToolUsage.delete(invocation.agent.id);
      return success({ sessionId: invocation.agent.id, role: 'lead', lease: 'closed' });
    },
  });

  ctx.commands.register({
    name: 'codex-lead-policy',
    description: 'update a Codex Lead policy without opening or closing its task lease',
    input: { hint: '<bridge-payload>' },
    recordInput: false,
    async handler(invocation) {
      const payload = decodePayload(invocation.rawInput);
      const policy = normalizeLeadPolicy(payload.policy);
      savePolicy(invocation.agent, policy, 'lead');
      parentRoles.set(invocation.agent.id, 'lead');
      leadPolicies.set(invocation.agent.id, policy);
      applyPermission(ctx, invocation.agent, policy);
      applyLeadToolRestriction(invocation.agent, policy);
      return success({
        sessionId: invocation.agent.id,
        role: 'lead',
        lease: leadLeases.has(invocation.agent.id) ? 'active' : 'closed',
        policy,
      });
    },
  });

}
