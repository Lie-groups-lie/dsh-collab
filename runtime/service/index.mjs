// Shared host-neutral task facade. Importing it starts no process or model request.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import contract from '../runtime-contract.json' with { type: 'json' };
import { budgetPolicy, optionalLimit } from '../core/capabilities.mjs';
import { validateInput } from '../core/schema.mjs';
import { ResultStore } from '../core/result-store.mjs';
import { notificationTools } from '../core/notifications.mjs';
import { taskIndex } from '../core/task-index.mjs';
import { taskTree } from '../core/task-tree.mjs';
import { archiveAdmission } from '../core/archive-admission.mjs';
import { runtimeCompatibility } from '../core/runtime-compatibility.mjs';
import { capabilityQuerySchema } from '../core/tool-registry.mjs';
import { scheduleTools } from '../core/schedules.mjs';
import { reconciliationTool } from '../core/reconciliation.mjs';
import { traceEvent } from '../core/trace.mjs';
import transport from '../mcp/dsh-transport.cjs';
import {
  api,
  archiveSession,
  closeLeadLease,
  continueFlashSubagent,
  ensureBridgeParent,
  leadResult,
  listLeads,
  readRuntime,
  requireManagedRuntime,
  recentSessions,
  observeSessions,
  pendingDescendants,
  nativeTaskState,
  resolveLead,
  sessionResult,
  startLeadTurn,
  startFlashSubagent,
  updateLeadPolicy,
  waitForTurn,
} from '../mcp/dsh-client.mjs';

const PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'];
const EFFORTS = ['off', 'low', 'high', 'max'];
const CHILD_MODELS = [contract.flashModel, 'deepseek-v4-flash', 'deepseek-v4-pro'];
const TOOL_LIMIT_SCHEMA = { type: 'integer', minimum: -1, description: 'Optional per-turn tool-call limit. Omit or use -1 for no count limit. 0 disables every tool. Do not invent a small quota unless the user requests one.' };
export const DEFAULT_MAX_OUTPUT_TOKENS = contract.defaultMaxOutputTokens;
export const SAFE_UNLIMITED_MAX_OUTPUT_TOKENS = contract.maxOutputTokens;
export const FINALIZER_MAX_OUTPUT_TOKENS = 4096;
export const TRANSCRIPT_SAFE_TOKENS = contract.defaultMaxTranscriptTokens;
export const TASK_MAX_CHARS = 120000;
const CHILD_POLICY_SCHEMA = {
  type: 'object',
  description: 'Host-enforced policy for every native child created by this Lead. Defaults to Flash, read-only, no terminal, and no further delegation.',
  properties: {
    model: {
      type: 'string',
      enum: CHILD_MODELS,
      default: contract.flashModel,
      description: 'Exact child model. Keep Flash unless the user explicitly requests Pro.',
    },
    permission: { type: 'string', enum: PERMISSIONS, default: 'read-only' },
    reasoning_effort: { type: 'string', enum: EFFORTS, default: 'high' },
    max_output_tokens: { type: 'integer', minimum: 64, maximum: SAFE_UNLIMITED_MAX_OUTPUT_TOKENS, default: DEFAULT_MAX_OUTPUT_TOKENS },
    unlimited_output_tokens: {
      type: 'boolean',
      default: false,
      description: `Use the host safety ceiling (${SAFE_UNLIMITED_MAX_OUTPUT_TOKENS}), never an unbounded provider transcript.`,
    },
    max_tool_calls: TOOL_LIMIT_SCHEMA,
    allowed_tools: { type: 'array', items: { type: 'string' }, uniqueItems: true, description: 'Explicit tool selection for future Lead children, independent of the Lead tool list. Third-party tools still require administrator registration, matching workspace and schema.' },
    allow_external_writes: { type: 'boolean', default: false, description: 'Authorize selected registered external-write tools for future children. Read-only still denies writes; never inherited implicitly from the Lead.' },
    continue_until_answer: { type: 'boolean', default: true, description: 'Continue interrupted responses or preambles through the native task inbox until an answer or explicit blocker. User cancellation, errors, explicit budgets and repeated no-progress still stop the task.' },
    allow_terminal: {
      type: 'boolean',
      default: false,
      description: 'Allow bash/pwsh/shell-style tools in Lead children. False removes and hard-blocks terminal execution.',
    },
  },
  additionalProperties: false,
};
const BUDGET_SCHEMA = {
  max_requests: { type: 'integer', minimum: -1, description: 'Optional shared model-request limit; omit or -1 for no plugin count limit. Positive values enforce an explicitly chosen budget.' },
  max_total_output_tokens: { type: 'integer', minimum: -1, description: 'Optional cumulative output cap (reasoning plus visible text); omit or -1 for no plugin total cap. Finite values must be at least 64. Do not add a small cap merely to delegate work.' },
  max_total_input_tokens: { type: 'integer', minimum: -1, description: 'Optional cumulative input cap; omit or -1 for no plugin total cap. Finite limits reserve the provider context capacity for in-flight calls.' },
  max_concurrent_requests: { type: 'integer', minimum: 1, maximum: 32, default: 4 },
  max_cost_micros: { type: 'integer', minimum: 1, maximum: 1000000000, description: 'Cost admission cap in micro-units of the administrator-configured pricing currency. Requires a trusted pricing registry; not an invoice guarantee.' },
  allow_external_writes: { type: 'boolean', default: false, description: 'Explicitly permit registered external-write tools selected in allowed_tools. Read-only policy still denies them.' },
  max_tool_calls_total: { type: 'integer', minimum: -1, description: 'Optional shared tool-call limit; omit or -1 for no count limit. 0 denies all tools.' },
  max_children_total: { type: 'integer', minimum: 0, maximum: 256, default: 16 },
  max_duration_seconds: { type: 'integer', minimum: -1, maximum: 604800, description: 'Optional deadline from original task creation; omit or -1 for no plugin deadline. Positive seconds cooperatively cancel generation/tools; not an OS kill boundary.' },
  allowed_tools: { type: 'array', items: { type: 'string' }, uniqueItems: true, description: 'Narrow built-in capabilities and explicitly select administrator-registered third-party tools. Unknown names never grant access.' },
};

function requestBudget(args) {
  return budgetPolicy(Object.fromEntries([
    ['maxRequests', args.max_requests], ['maxTotalOutputTokens', args.max_total_output_tokens],
    ['maxTotalInputTokens', args.max_total_input_tokens], ['maxConcurrentRequests', args.max_concurrent_requests],
    ['maxCostMicros', args.max_cost_micros], ['allowExternalWrites', args.allow_external_writes],
    ['maxToolCallsTotal', args.max_tool_calls_total], ['maxChildrenTotal', args.max_children_total],
    ['maxDurationSeconds', args.max_duration_seconds], ['allowedTools', args.allowed_tools],
  ].filter(([, value]) => value !== undefined)));
}
let creationQueue = Promise.resolve();

function serializeCreation(operation) {
  const scheduled = creationQueue.then(operation, operation);
  creationQueue = scheduled.catch(() => {});
  return scheduled;
}

export const tools = [
  {
    name: 'deepseek_runtime_status',
    description: 'Check the local DSH runtime, available models and agent presets without creating a session or running a model.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'deepseek_flash',
    description: 'Run the latest official deepseek-flash model as a native, continuable DSH child agent and return its final answer. New calls are grouped below one Codex coordination session per workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, maxLength: TASK_MAX_CHARS, description: 'Self-contained task for the DeepSeek Flash subagent.' },
        cwd: { type: 'string', minLength: 1, description: 'Workspace directory. Defaults to the desktop app workspace.' },
        session_id: { type: 'string', minLength: 1, description: 'Continue a previous native DSH child agent.' },
        permission: { type: 'string', enum: PERMISSIONS, default: 'read-only' },
        reasoning_effort: { type: 'string', enum: EFFORTS, default: 'high' },
        max_output_tokens: {
          type: 'integer',
          minimum: 64,
          maximum: SAFE_UNLIMITED_MAX_OUTPUT_TOKENS,
          default: DEFAULT_MAX_OUTPUT_TOKENS,
          description: 'Per-model-request reasoning plus visible-output cap, not the task total. Defaults to the provider maximum. Omit unless the user needs a specific per-response limit.',
        },
        unlimited_output_tokens: {
          type: 'boolean',
          default: false,
          description: `Use the host safety ceiling (${SAFE_UNLIMITED_MAX_OUTPUT_TOKENS}); it is not truly unbounded. Cannot be combined with max_output_tokens.`,
        },
        max_tool_calls: TOOL_LIMIT_SCHEMA,
        allow_terminal: { type: 'boolean', default: false, description: 'Expose pwsh/bash to this child. False removes it before the model request and also blocks execution.' },
        finalize_empty: { type: 'boolean', default: true, description: 'If reasoning exhausts the budget with no visible answer, run one bounded no-tool conclusion pass.' },
        return_reasoning: { type: 'boolean', default: false, description: 'Return DSH-visible DeepSeek reasoning chunks in addition to the final result.' },
        reasoning_max_chars: { type: 'integer', minimum: 1000, maximum: 50000, default: 12000 },
        wait_for_completion: { type: 'boolean', default: true, description: 'False returns the native session id immediately; poll deepseek_flash_status for live progress.' },
        timeout_seconds: { type: 'integer', minimum: 5, maximum: 1800, default: 1800 },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'deepseek_flash_status',
    description: 'Read the current state, final answer, and token/cache usage of a DeepSeek Flash subagent session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        return_reasoning: { type: 'boolean', default: false },
        reasoning_max_chars: { type: 'integer', minimum: 1000, maximum: 50000, default: 12000 },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'deepseek_flash_stop',
    description: 'Stop the active turn of a DeepSeek Flash subagent session.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', minLength: 1 } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'deepseek_lead',
    description: 'Create or continue a persistent Codex Lead that may coordinate its own bounded DSH subagents for a larger project.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, maxLength: TASK_MAX_CHARS, description: 'Project task for the Codex Lead.' },
        cwd: { type: 'string', minLength: 1, description: 'Required workspace for a new Lead; validated when continuing.' },
        lead_id: { type: 'string', minLength: 1, description: 'Continue an existing Codex Lead session.' },
        name: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$', description: 'Optional custom display name for a new Lead (Unicode supported, no control characters or blank-only names). Omit for Codex Lead N. Identity is persisted role metadata; continue by lead_id after renaming.' },
        permission: { type: 'string', enum: PERMISSIONS, default: 'read-only' },
        reasoning_effort: { type: 'string', enum: EFFORTS, default: 'high' },
        max_output_tokens: { type: 'integer', minimum: 64, maximum: SAFE_UNLIMITED_MAX_OUTPUT_TOKENS, default: DEFAULT_MAX_OUTPUT_TOKENS },
        unlimited_output_tokens: { type: 'boolean', default: false },
        max_tool_calls: TOOL_LIMIT_SCHEMA,
        max_children: { type: 'integer', minimum: 0, maximum: 16, default: 4 },
        child_policy: CHILD_POLICY_SCHEMA,
        finalize_empty: { type: 'boolean', default: true, description: 'Run at most one bounded no-tool conclusion pass when the Lead exhausts its budget without a visible final answer.' },
        return_reasoning: { type: 'boolean', default: false },
        reasoning_max_chars: { type: 'integer', minimum: 1000, maximum: 50000, default: 12000 },
        wait_for_completion: { type: 'boolean', default: true },
        timeout_seconds: { type: 'integer', minimum: 5, maximum: 3600, default: 3600 },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'deepseek_lead_policy_update',
    description: 'Hot-update an existing Codex Lead and its future child-agent policy without starting a new model turn.',
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', minLength: 1 },
        cwd: { type: 'string', minLength: 1, description: 'Optional workspace assertion for the existing Lead.' },
        permission: { type: 'string', enum: PERMISSIONS, default: 'read-only' },
        reasoning_effort: { type: 'string', enum: EFFORTS, default: 'high' },
        max_output_tokens: { type: 'integer', minimum: 64, maximum: SAFE_UNLIMITED_MAX_OUTPUT_TOKENS, default: DEFAULT_MAX_OUTPUT_TOKENS },
        unlimited_output_tokens: { type: 'boolean', default: false },
        max_tool_calls: TOOL_LIMIT_SCHEMA,
        max_children: { type: 'integer', minimum: 0, maximum: 16, default: 4 },
        child_policy: CHILD_POLICY_SCHEMA,
        finalize_empty: { type: 'boolean', default: true },
      },
      required: ['lead_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'deepseek_lead_status',
    description: 'Read a Codex Lead result, token/cache usage, and its direct DSH child-agent results.',
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', minLength: 1 },
        return_reasoning: { type: 'boolean', default: false },
        reasoning_max_chars: { type: 'integer', minimum: 1000, maximum: 50000, default: 12000 },
        include_children: { type: 'boolean', default: true },
      },
      required: ['lead_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'deepseek_lead_list',
    description: 'List persistent Codex Lead sessions, optionally limited to one workspace.',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string', minLength: 1 }, include_archived: { type: 'boolean', default: false } },
      additionalProperties: false,
    },
  },
  {
    name: 'deepseek_lead_stop',
    description: 'Stop a running Codex Lead turn and close its task lease.',
    inputSchema: {
      type: 'object',
      properties: { lead_id: { type: 'string', minLength: 1 } },
      required: ['lead_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'deepseek_session_archive',
    description: 'Archive one settled session, or explicitly restore its archive status. Native archive blocks subagent descendants. Restore changes only the named session and never prompts or replays work.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', minLength: 1 }, action: { type: 'string', enum: ['archive', 'restore'], default: 'archive' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
];

tools.push({
  name: 'deepseek_tasks_wait',
  description: 'Wait for existing DSH sessions and their descendants. Read-only: never resumes agents or creates messages. A timeout returns pending IDs, not completion.',
  inputSchema: { type: 'object', required: ['session_ids'], additionalProperties: false, properties: {
    session_ids: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 32, uniqueItems: true },
    timeout_seconds: { type: 'integer', minimum: 0, maximum: 60, default: 30 },
  } },
}, {
  name: 'deepseek_task_result',
  description: 'Read the current result in bounded pages, including partial output and an exact turn identity. Does not run a model or mutate the session.',
  inputSchema: { type: 'object', required: ['session_id'], additionalProperties: false, properties: {
    session_id: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 32000, default: 12000 },
    expected_turn: { type: 'integer', minimum: 0, description: 'Reject if the session advanced since the previous page.' },
  } },
});
for (const tool of tools) {
  const readOnly = /(?:_status|_list|_result|_wait)$/.test(tool.name);
  tool.annotations = { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly || tool.name === 'deepseek_session_archive', openWorldHint: !readOnly };
  tool.outputSchema = { type: 'object', additionalProperties: true };
}

for (const tool of tools.filter((item) => ['deepseek_flash', 'deepseek_lead'].includes(item.name))) {
  Object.assign(tool.inputSchema.properties, BUDGET_SCHEMA);
  tool.inputSchema.properties.continue_until_answer = CHILD_POLICY_SCHEMA.properties.continue_until_answer;
  tool.inputSchema.properties.max_transcript_tokens = {
    type: 'integer', minimum: 0, maximum: contract.contextWindow, default: TRANSCRIPT_SAFE_TOKENS,
    description: 'Plugin continuation threshold. Set 0 to let native DSH compaction and the provider manage the context.',
  };
}
Object.assign(tools.find((tool) => tool.name === 'deepseek_lead_policy_update').inputSchema.properties, BUDGET_SCHEMA);
for (const name of ['deepseek_lead', 'deepseek_lead_policy_update']) {
  tools.find(tool => tool.name === name).inputSchema.properties.allow_terminal = {
    type: 'boolean', default: false,
    description: 'Allow terminal tools for the Lead itself. False removes and blocks them; child_policy controls children separately.',
  };
}
tools.find((tool) => tool.name === 'deepseek_task_result').inputSchema.properties.expected_revision = {
  type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Result revision from the previous page; detects live text changes.',
};
for (const name of ['deepseek_flash', 'deepseek_lead']) tools.find((tool) => tool.name === name).inputSchema.properties.request_key = {
  type: 'string', minLength: 1, maxLength: 160, description: 'Submission idempotency key. Reuse the exact task, target and policy to retrieve the same receipt; use a new key for a genuinely new turn.',
};
CHILD_POLICY_SCHEMA.properties.allowed_tools = BUDGET_SCHEMA.allowed_tools;
CHILD_POLICY_SCHEMA.properties.allow_external_writes = BUDGET_SCHEMA.allow_external_writes;

tools.push({ name: 'deepseek_tasks_list', description: 'List managed Direct, Lead and child tasks without creating or waking sessions.',
  inputSchema: { type: 'object', properties: { cwd: { type: 'string', minLength: 1 },
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    include_archived: { type: 'boolean', default: false } }, additionalProperties: false } });
tools.push({ name: 'deepseek_task_tree', description: 'Read the full durable task family, including archived/missing children, exact receipt/turn IDs and recovery state. Does not wake, reconcile or execute any agent.',
  inputSchema: { type: 'object', properties: { session_id: { type: 'string', minLength: 1, maxLength: 160 }, receipt_offset: { type: 'integer', minimum: 0 } }, required: ['session_id'], additionalProperties: false } });
tools.push({ name: 'deepseek_task_cancel', description: 'Request cancellation of a managed task, optionally including descendants. Cancellation acknowledgement is not proof of quiescence; wait afterward.',
  inputSchema: { type: 'object', properties: { session_id: { type: 'string', minLength: 1 },
    scope: { type: 'string', enum: ['self', 'tree'], default: 'tree' } }, required: ['session_id'], additionalProperties: false } });
tools.push({ name: 'deepseek_tasks_start', description: 'Start up to eight independent Direct tasks and return their handles. Each item must have a stable request_key. Partial batch failures do not replay successful items. Join with deepseek_tasks_wait.',
  inputSchema: { type: 'object', properties: { tasks: { type: 'array', minItems: 1, maxItems: 8,
    items: { ...tools.find((t) => t.name === 'deepseek_flash').inputSchema, required: ['task', 'cwd', 'request_key'] } } }, required: ['tasks'], additionalProperties: false } });
tools.push({ name: 'deepseek_capabilities', description: 'Inspect actual DSH plugin tools, pinned schemas and effective task permissions. Read-only; never wakes an agent, grants capabilities, executes tools or imports Codex-only plugins. A cold session returns unknown availability.',
  inputSchema: capabilityQuerySchema });
for (const tool of tools.filter((t) => !t.annotations)) {
  const readOnly = ['deepseek_tasks_list', 'deepseek_task_tree', 'deepseek_capabilities'].includes(tool.name);
  tool.annotations = { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly || tool.name === 'deepseek_task_cancel', openWorldHint: !readOnly };
  tool.outputSchema = { type: 'object', additionalProperties: true };
}
Object.assign(tools.find((tool) => tool.name === 'deepseek_task_result').inputSchema.properties, {
  include_task: { type: 'boolean', default: false, description: 'Include the original submitted task and effective policy. Does not read unrelated parent conversations.' },
});

function transcriptLimit(value) {
  if (value === undefined) return TRANSCRIPT_SAFE_TOKENS;
  if (!Number.isSafeInteger(value) || value < 0 || value > contract.contextWindow) {
    throw new Error(`max_transcript_tokens must be between 0 and ${contract.contextWindow}`);
  }
  return value;
}

tools.push(...notificationTools);
tools.push(...scheduleTools);
tools.push(reconciliationTool);
tools.push({ name: 'deepseek_task_trace', description: 'Read native visible execution history: user tasks, intermediate assistant output, tool inputs/results and turn endings. Read-only, no wakeup or reasoning disclosure. Uses a stable sequence cursor; long individual records have explicit text offsets.',
  inputSchema: { type: 'object', required: ['session_id'], additionalProperties: false, properties: {
    session_id: { type: 'string', minLength: 1, maxLength: 160 }, before_seq: { type: 'integer', minimum: 0 },
    through_seq: { type: 'integer', minimum: -1 }, max_messages: { type: 'integer', minimum: 1, maximum: 20 },
    event_seq: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32000 },
  } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, outputSchema: { type: 'object', additionalProperties: true } });

export async function recoverConclusion(result, policy, operation) {
  if (!needsConclusionPass(result, policy)) return;
  try {
    const finalizer = await operation();
    result.finalization = {
      attempted: true, sessionId: finalizer.sessionId, status: finalizer.status,
      maxOutputTokens: FINALIZER_MAX_OUTPUT_TOKENS,
    };
    if (String(finalizer.answer || '').trim()) {
      result.answer = finalizer.answer;
      result.recoveredFinalAnswer = true;
    }
  } catch (error) {
    result.finalization = { attempted: true, status: 'failed', error: error.message };
  }
}

export function requestPolicy(args, defaults = {}) {
  const permission = PERMISSIONS.includes(args.permission) ? args.permission : 'read-only';
  const reasoningEffort = EFFORTS.includes(args.reasoning_effort) ? args.reasoning_effort : 'high';
  const hasMaxOutputTokens = Object.prototype.hasOwnProperty.call(args, 'max_output_tokens');
  if (args.unlimited_output_tokens === true && hasMaxOutputTokens) {
    throw new Error('max_output_tokens and unlimited_output_tokens cannot be set together');
  }
  const requestedMaxOutputTokens = hasMaxOutputTokens ? args.max_output_tokens : null;
  if (requestedMaxOutputTokens !== null && (!Number.isSafeInteger(requestedMaxOutputTokens)
    || requestedMaxOutputTokens < 64 || requestedMaxOutputTokens > SAFE_UNLIMITED_MAX_OUTPUT_TOKENS)) {
    throw new Error(`max_output_tokens must be between 64 and ${SAFE_UNLIMITED_MAX_OUTPUT_TOKENS}`);
  }
  const unlimitedOutputTokens = args.unlimited_output_tokens === true;
  const maxOutputTokens = unlimitedOutputTokens
    ? SAFE_UNLIMITED_MAX_OUTPUT_TOKENS
    : requestedMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return {
    ...requestBudget(args),
    permission,
    reasoningEffort,
    maxOutputTokens,
    requestedMaxOutputTokens,
    unlimitedOutputTokens,
    outputSafetyCap: SAFE_UNLIMITED_MAX_OUTPUT_TOKENS,
    outputSafetyLimited: unlimitedOutputTokens,
    maxTranscriptTokens: transcriptLimit(args.max_transcript_tokens),
    maxToolCalls: optionalLimit(args.max_tool_calls, 'max_tool_calls'),
    allowTerminal: args.allow_terminal === true,
    finalizeEmpty: args.finalize_empty !== false,
    continueUntilAnswer: args.continue_until_answer !== false,
    ...(defaults.withChildren ? {
      maxChildren: Number.isSafeInteger(args.max_children) ? args.max_children : defaults.maxChildren ?? 4,
      childPolicy: requestChildPolicy(args.child_policy),
    } : {}),
  };
}

function requestChildPolicy(args = {}) {
  const hasMaxOutputTokens = Object.prototype.hasOwnProperty.call(args, 'max_output_tokens');
  if (args.unlimited_output_tokens === true && hasMaxOutputTokens) {
    throw new Error('child_policy.max_output_tokens and child_policy.unlimited_output_tokens cannot be set together');
  }
  const requestedMaxOutputTokens = hasMaxOutputTokens ? args.max_output_tokens : null;
  if (requestedMaxOutputTokens !== null && (!Number.isSafeInteger(requestedMaxOutputTokens)
    || requestedMaxOutputTokens < 64 || requestedMaxOutputTokens > SAFE_UNLIMITED_MAX_OUTPUT_TOKENS)) {
    throw new Error(`child_policy.max_output_tokens must be between 64 and ${SAFE_UNLIMITED_MAX_OUTPUT_TOKENS}`);
  }
  const unlimitedOutputTokens = args.unlimited_output_tokens === true;
  const maxOutputTokens = unlimitedOutputTokens
    ? SAFE_UNLIMITED_MAX_OUTPUT_TOKENS
    : requestedMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return {
    ...requestBudget(args),
    provider: 'deepseek-official',
    model: args.model === 'deepseek-v4-flash' ? contract.flashModel : CHILD_MODELS.includes(args.model) ? args.model : contract.flashModel,
    permission: PERMISSIONS.includes(args.permission) ? args.permission : 'read-only',
    reasoningEffort: EFFORTS.includes(args.reasoning_effort) ? args.reasoning_effort : 'high',
    maxOutputTokens,
    requestedMaxOutputTokens,
    unlimitedOutputTokens,
    outputSafetyCap: SAFE_UNLIMITED_MAX_OUTPUT_TOKENS,
    outputSafetyLimited: unlimitedOutputTokens,
    maxToolCalls: optionalLimit(args.max_tool_calls, 'max_tool_calls'),
    allowTerminal: args.allow_terminal === true,
    allowDelegation: false,
    continueUntilAnswer: args.continue_until_answer !== false,
  };
}

function boundedText(value, limit) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[内容已由宿主截断]`;
}

export function needsConclusionPass(result, policy) {
  return policy.finalizeEmpty
    && !result.finalizationManaged
    && result.status === 'max-tokens'
    && !String(result.answer || '').trim()
    && Number(result.progress?.reasoningChars || 0) > 0;
}

async function runConclusionPass(runtime, parentSessionId, originalTask, primaryResult, timeoutMs) {
  const clue = boundedText(primaryResult.reasoning || '', 8000);
  const task = [
    '只生成最终答案，不再进行长篇推理，不调用任何工具。',
    '不得声称执行了未执行的操作；如果证据不足，请明确说明限制。',
    '',
    '原始任务：',
    boundedText(originalTask, 12000),
    '',
    '上一轮在输出额度耗尽前留下的有界工作线索：',
    clue || '没有可恢复的可见工作线索。请根据原始任务给出最可靠的简洁结论。',
  ].join('\n');
  const policy = {
    permission: 'read-only',
    reasoningEffort: 'off',
    maxOutputTokens: FINALIZER_MAX_OUTPUT_TOKENS,
    requestedMaxOutputTokens: FINALIZER_MAX_OUTPUT_TOKENS,
    unlimitedOutputTokens: false,
    outputSafetyCap: SAFE_UNLIMITED_MAX_OUTPUT_TOKENS,
    outputSafetyLimited: false,
    maxToolCalls: 0,
    allowTerminal: false,
    finalizeEmpty: false,
    continueUntilAnswer: false,
  };
  const started = await startFlashSubagent(runtime, { sessionId: parentSessionId }, task, policy, { budgetRootId: primaryResult.sessionId });
  const settled = await waitForTurn(runtime, started.childSessionId, 0, Math.min(timeoutMs, 300_000));
  const result = await sessionResult(runtime, started.childSessionId);
  return {
    ...result,
    status: settled.completed ? result.status : 'timed_out',
    requestedPolicy: policy,
  };
}

async function runFlash(args, onProgress, signal, runtimeOverride, budgetRootId) {
  const requestKey = args.request_key || randomUUID();
  const runtime = runtimeOverride || readRuntime();
  requireManagedRuntime(runtime);
  const task = String(args.task || '').trim();
  if (!task) throw new Error('task is required');
  if (task.length > TASK_MAX_CHARS) throw new Error(`task exceeds the ${TASK_MAX_CHARS}-character host safety limit`);
  const policy = requestPolicy(args);
  const { permission, reasoningEffort } = policy;
  if (budgetRootId) {
    const shared = nativeTaskState(runtime, budgetRootId);
    const owner = (await recentSessions(runtime)).find((s) => s.sessionId === budgetRootId);
    const normalize = (cwd) => process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
    if (!shared?.policy || !owner?.cwd || !args.cwd || normalize(owner.cwd) !== normalize(args.cwd)) {
      throw new Error('Shared budget requires a managed task in the same explicit workspace');
    }
    if (args.session_id) throw new Error('Shared budget membership is immutable on continuation');
  }
  const waitForCompletion = args.wait_for_completion !== false;
  const includeReasoning = args.return_reasoning === true;
  const reasoningMaxChars = Number.isSafeInteger(args.reasoning_max_chars) ? args.reasoning_max_chars : 12000;
  const timeoutSeconds = Number.isInteger(args.timeout_seconds) ? args.timeout_seconds : 1800;
  let childSessionId;
  let parentSessionId;
  let baselineTurns = 0;
  if (args.session_id) {
    const before = await sessionResult(runtime, args.session_id);
    if (policy.maxTranscriptTokens > 0 && before.transcript?.projectedTokens >= policy.maxTranscriptTokens) {
      throw new Error(`该会话 transcript 已达到 ${policy.maxTranscriptTokens} token 限额；可压缩上下文或显式设置 max_transcript_tokens: 0 交由原生 DSH 管理。`);
    }
    baselineTurns = before.turns;
    const continued = await continueFlashSubagent(runtime, args.session_id, task, policy, { requestKey });
    baselineTurns = continued.submission?.afterTurn ?? baselineTurns;
    childSessionId = continued.childSessionId;
    parentSessionId = continued.parentSessionId;
  } else {
    const started = await serializeCreation(async () => {
      const parent = await ensureBridgeParent(runtime, {
        cwd: args.cwd,
        permission,
        reasoningEffort,
      });
      return startFlashSubagent(runtime, parent, task, policy, { requestKey, budgetRootId });
    });
    childSessionId = started.childSessionId;
    parentSessionId = started.parentSessionId;
  }
  if (!waitForCompletion) {
    const result = await sessionResult(runtime, childSessionId, { includeReasoning, reasoningMaxChars });
    return {
      ...result,
      status: result.running ? 'running' : result.status,
      parentSessionId: parentSessionId || result.parentSessionId,
      requestedPolicy: policy,
      commandId: childSessionId,
      native: true,
      requestKey,
    };
  }
  const settled = await waitForTurn(runtime, childSessionId, baselineTurns, timeoutSeconds * 1000, { onProgress, signal });
  const result = await sessionResult(runtime, childSessionId, {
    includeReasoning: includeReasoning || policy.finalizeEmpty,
    reasoningMaxChars: policy.finalizeEmpty ? Math.min(reasoningMaxChars, 8000) : reasoningMaxChars,
  });
  result.status = settled.completed ? result.status : 'timed_out';
  result.parentSessionId = parentSessionId || result.parentSessionId;
  result.requestedPolicy = policy;
  result.commandId = childSessionId;
  result.native = true;
  result.requestKey = requestKey;
  if (settled.completed) await recoverConclusion(result, policy, () => runConclusionPass(
      runtime,
      result.parentSessionId,
      task,
      result,
      timeoutSeconds * 1000,
    ));
  if (!includeReasoning) {
    delete result.reasoning;
    delete result.reasoningTruncated;
  }
  return result;
}

async function runLead(args, onProgress, signal, runtimeOverride) {
  const requestKey = args.request_key || randomUUID();
  const runtime = runtimeOverride || readRuntime();
  requireManagedRuntime(runtime);
  const task = String(args.task || '').trim();
  if (!task) throw new Error('task is required');
  if (task.length > TASK_MAX_CHARS) throw new Error(`task exceeds the ${TASK_MAX_CHARS}-character host safety limit`);
  const policy = requestPolicy(args, { maxChildren: 4, withChildren: true });
  const before = args.lead_id ? await sessionResult(runtime, args.lead_id) : null;
  if (policy.maxTranscriptTokens > 0 && before?.transcript?.projectedTokens >= policy.maxTranscriptTokens) {
    throw new Error(`该 Lead transcript 已达到 ${policy.maxTranscriptTokens} token 限额；可压缩上下文或显式设置 max_transcript_tokens: 0 交由原生 DSH 管理。`);
  }
  const lead = await serializeCreation(() => resolveLead(runtime, {
    leadId: args.lead_id,
    cwd: args.cwd,
    name: args.name,
    permission: policy.permission,
    reasoningEffort: policy.reasoningEffort,
    requestKey,
  }));
  const started = await startLeadTurn(runtime, lead, task, policy, { requestKey });
  const baselineTurns = started.submission?.afterTurn ?? before?.turns ?? 0;
  const resultOptions = {
    includeReasoning: args.return_reasoning === true || policy.finalizeEmpty,
    reasoningMaxChars: policy.finalizeEmpty
      ? Math.min(Number.isSafeInteger(args.reasoning_max_chars) ? args.reasoning_max_chars : 8000, 8000)
      : Number.isSafeInteger(args.reasoning_max_chars) ? args.reasoning_max_chars : 12000,
    includeChildren: true,
  };
  if (args.wait_for_completion === false) {
    const result = await leadResult(runtime, lead.sessionId, { ...resultOptions, includeReasoning: args.return_reasoning === true });
    return { ...result, requestedPolicy: policy, commandId: lead.sessionId, lease: result.lease, requestKey,
      replayed: started.replayed === true, ...(started.recovery ? { recovery: started.recovery } : {}) };
  }
  const timeoutSeconds = Number.isInteger(args.timeout_seconds) ? args.timeout_seconds : 3600;
  const settled = await waitForTurn(runtime, lead.sessionId, baselineTurns, timeoutSeconds * 1000, { onProgress, signal });
  const result = await leadResult(runtime, lead.sessionId, resultOptions);
  if (!settled.completed) result.status = 'timed_out';
  else await closeLeadLease(runtime, lead.sessionId).catch(() => {});
  if (settled.completed) await recoverConclusion(result, policy, async () => {
    const parent = await ensureBridgeParent(runtime, {
      cwd: lead.cwd,
      permission: 'read-only',
      reasoningEffort: 'off',
    });
    return runConclusionPass(runtime, parent.sessionId, task, result, timeoutSeconds * 1000);
  });
  if (args.return_reasoning !== true) {
    delete result.reasoning;
    delete result.reasoningTruncated;
  }
  return {
    ...result,
    requestedPolicy: policy,
    commandId: lead.sessionId,
    lease: settled.completed ? 'closed' : 'active',
    requestKey,
  };
}

export async function callTool(name, args = {}, context = {}) {
  const definition = tools.find((tool) => tool.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  validateInput(args, definition.inputSchema);
  context.signal?.throwIfAborted();
  if (name === 'deepseek_flash') return runFlash(args, context.onProgress, context.signal, context.runtime, context.budgetRootId);
  if (name === 'deepseek_lead') return runLead(args, context.onProgress, context.signal, context.runtime);
  const runtime = context.runtime || readRuntime();
  if (name === 'deepseek_task_trace') {
    const managed = nativeTaskState(runtime, args.session_id);
    if (!managed?.policy) throw new Error('Trace is restricted to an existing managed Collab task');
    const sessions = await recentSessions(runtime), session = sessions.find(item => item.sessionId === args.session_id);
    if (!session) throw new Error('Native task session not found');
    const page = await api(runtime, 'session.trace', { sessionId: args.session_id, session, maxMessages: args.event_seq === undefined ? args.max_messages || 12 : 1,
      ...(args.through_seq === undefined ? {} : { throughSeq: args.through_seq }),
      ...(args.event_seq === undefined ? args.before_seq === undefined ? {} : { beforeSeq: args.before_seq } : { beforeSeq: args.event_seq + 1 }) });
    const events = (page.events || []).map(entry => entry.event || entry);
    const selected = (args.event_seq === undefined ? events : events.filter(event => event.seq === args.event_seq)).sort((a, b) => b.seq - a.seq);
    if (args.event_seq !== undefined && !selected.length) throw new Error('Native event is not available at this history cut; refresh the trace');
    const items = []; let chars = 0, firstSeq = Infinity, clipped = false;
    for (const event of selected) {
      if (items.length >= 60 || chars >= 200000) { clipped = true; break; }
      firstSeq = Math.min(firstSeq, event.seq);
      const item = traceEvent(event, { offset: args.offset || 0, limit: args.limit || 12000 });
      if (item) { items.push(item); chars += item.text.length; }
    }
    return { sessionId: args.session_id, throughSeq: page.throughSeq, items,
      nextBeforeSeq: args.event_seq === undefined && (page.hasMore || clipped) && Number.isFinite(firstSeq) ? firstSeq : null,
      children: sessions.filter(child => child.parentSessionId === args.session_id).map(child => ({ sessionId: child.sessionId, parentSessionId: args.session_id,
        title: child.projections?.values?.title || child.title || child.sessionId, cwd: child.cwd, running: child.running })),
      note: 'Native retained history only; no private reasoning. Delivery/progress is not proof of a correct result.' };
  }
  if (scheduleTools.some(tool => tool.name === name)) {
    requireManagedRuntime(runtime);
    if (runtime.schedulingApi !== 2) throw new Error('Native DSH scheduling adapter is unavailable or too old (requires schedulingApi=2, Collab 0.3.1-rc.9+). Update the native runtime bridge in a controlled idle restart; updating only the MCP client is insufficient. No schedule or model task was created.');
    return transport.backgroundRequest(runtime, name, args, context.signal);
  }
  if (name === reconciliationTool.name) {
    requireManagedRuntime(runtime);
    if (!(runtime.reconciliationApi >= 1)) throw new Error('Native Collab reconciliation adapter is too old; requires reconciliationApi=1. No session changed.');
    if (args.action === 'recover' && !(runtime.recoveryApi >= 1 || runtime.reconciliationApi >= 2)) throw new Error('Native Collab recovery adapter is too old; requires recoveryApi=1. Update the runtime bridge. No session changed.');
    return transport.backgroundRequest(runtime, name, args, context.signal);
  }
  if (name === 'deepseek_capabilities') {
    requireManagedRuntime(runtime);
    if (runtime.capabilitiesApi !== 1) throw new Error('This DSH runtime does not advertise capabilitiesApi=1. The native Collab adapter is too old for discovery; keep active tasks running and upgrade it in a controlled window. No tool was executed.');
    return transport.backgroundRequest(runtime, name, args, context.signal);
  }
  if (notificationTools.some(tool => tool.name === name)) {
    requireManagedRuntime(runtime);
    return transport.backgroundRequest(runtime, name, args, context.signal);
  }
  if (name === 'deepseek_tasks_start') {
    const results = [];
    for (const task of args.tasks) {
      context.signal?.throwIfAborted();
      try { results.push({ requestKey: task.request_key, accepted: true, result: await runFlash({ ...task, wait_for_completion: false }, undefined, context.signal, runtime) }); }
      catch (error) { results.push({ requestKey: task.request_key, accepted: null, error: error.message }); }
    }
    return { results, completed: false, nextAction: 'Join accepted session ids with deepseek_tasks_wait; inspect uncertain items using their original request keys.' };
  }
  if (name === 'deepseek_task_tree') {
    const [sessions, workspace] = await Promise.all([recentSessions(runtime), api(runtime, 'workspace.list')]);
    const graph = taskTree(taskIndex(runtime.collabStateDirectory).list(), sessions, args.session_id, new Set(workspace.archivedSessionIds || []));
    const record = nativeTaskState(runtime, args.session_id);
    const history = [ ...(record?.receiptHistory || []), ...(record?.dispatch ? [{ ...record.dispatch, executionBuild: record.executionBuild || null }] : []) ].reverse();
    const offset = args.receipt_offset || 0;
    return { ...graph, receipts: history.slice(offset, offset + 20), nextReceiptOffset: offset + 20 < history.length ? offset + 20 : null,
      receiptTotal: history.length, historyCoverage: 'observed-since-provenance-upgrade; older-native-turns-remain-in-trace',
      runtimeBuild: runtime.build || null, processInstance: runtime.processInstance || null };
  }
  if (name === 'deepseek_tasks_list') {
    const [sessions, workspace] = await Promise.all([recentSessions(runtime), api(runtime, 'workspace.list')]);
    const archived = new Set(workspace.archivedSessionIds || []);
    const nativeSessions = new Map(sessions.map(row => [row.sessionId, row]));
    const normalize = (cwd) => process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
    const candidates = sessions.filter((s) => (!args.cwd || normalize(s.cwd || '.') === normalize(args.cwd)) && (args.include_archived || !archived.has(s.sessionId)));
    const rows = new Map((runtime.collabStateDirectory ? taskIndex(runtime.collabStateDirectory).list(candidates.map(s => s.sessionId)) : []).map(row => [row.id, row]));
    const internal = new Set([...rows.values()].flatMap(row => (row.finalizations || []).map(item => item.sessionId)));
    const tasks = candidates.map((s) => ({ session: s, state: rows.get(s.sessionId) })).filter(({ state, session }) => state && state.role !== 'finalizer' && !internal.has(session.sessionId))
      .map(({ session: s, state }) => ({ sessionId: s.sessionId, rootId: state.rootId, parentSessionId: state.parentId || s.parentSessionId || '', cwd: s.cwd,
        title: s.projections?.values?.title || s.title || state.title || s.sessionId, createdAt: state.createdAt,
        role: state.role, running: s.running, submission: state.dispatch, archived: archived.has(s.sessionId),
        admission: archiveAdmission(s.sessionId, nativeSessions, archived), policyRevision: state.revision }));
    const offset = args.offset || 0, limit = args.limit || 50;
    return { tasks: tasks.slice(offset, offset + limit), total: tasks.length, nextOffset: offset + limit < tasks.length ? offset + limit : null };
  }
  if (name === 'deepseek_task_cancel') {
    requireManagedRuntime(runtime);
    if (!nativeTaskState(runtime, args.session_id)?.policy) throw new Error('Target is not a managed task');
    const sessions = await recentSessions(runtime), selected = new Set([args.session_id]);
    if (args.scope !== 'self') {
      let changed;
      do { changed = false; for (const s of sessions) if (selected.has(s.parentSessionId) && !selected.has(s.sessionId)) { selected.add(s.sessionId); changed = true; } } while (changed);
      for (const id of [...selected]) for (const f of Object.values(nativeTaskState(runtime, id)?.finalizations || {})) if (f.status === 'running') selected.add(f.sessionId);
    }
    const receipts = [];
    for (const id of selected) {
      const session = sessions.find((s) => s.sessionId === id);
      try {
        if (!session) throw new Error('Session visibility is unknown');
        if (nativeTaskState(runtime, id)?.role === 'lead') await closeLeadLease(runtime, id);
        const receipt = session.parentSessionId
          ? await api(runtime, 'subagent.interrupt', { parentSessionId: session.parentSessionId, childSessionId: id, mode: 'continuable' })
          : await api(runtime, 'session.cancel', { sessionId: id });
        receipts.push({ sessionId: id, cancellationRequested: true, receipt });
      } catch (error) { receipts.push({ sessionId: id, cancellationRequested: false, error: error.message }); }
    }
    return { scope: args.scope || 'tree', receipts, completed: false, nextAction: 'Wait for quiescence before archiving.' };
  }
  if (name === 'deepseek_tasks_wait') {
    const deadline = Date.now() + (args.timeout_seconds ?? 30) * 1000;
    let tasks;
    const summarize = (sessions) => args.session_ids.map((id) => {
        const session = sessions.find((item) => item.sessionId === id);
        const descendants = pendingDescendants(sessions, id, child => nativeTaskState(runtime, child)).map((item) => item.sessionId);
        const managed = nativeTaskState(runtime, id);
        const finalizing = Object.values(managed?.finalizations || {}).some((item) => item.status === 'running');
        const turns = Number(session?.projections?.values?.sessionStats?.turns || 0);
        return { sessionId: id, outcome: managed?.dispatch?.outcome || null,
          state: !session || managed?.dispatch?.state === 'unknown' || Object.values(managed?.finalizations || {}).some(item => item.status === 'unknown') ? 'unknown'
          : managed?.dispatch?.state === 'pending' ? 'accepted' : finalizing ? 'finalizing'
            : session.running || descendants.length || managed?.dispatch?.state === 'running' ? 'running'
              : Math.max(turns, managed?.lastTurn || 0) > 0 ? 'settled' : 'accepted', childrenPending: descendants };
      });
    do {
      context.signal?.throwIfAborted();
      tasks = summarize(await observeSessions(runtime));
      // Cached projections can guide waiting, but cannot certify completion.
      if (tasks.every(task => task.state === 'settled')) tasks = summarize(await recentSessions(runtime));
      if (tasks.every((task) => task.state === 'settled') || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
    } while (true);
    return { completed: tasks.every((task) => task.state === 'settled'), tasks, pending: tasks.filter((task) => task.state !== 'settled').map((task) => task.sessionId) };
  }
  if (name === 'deepseek_task_result') {
    const result = await sessionResult(runtime, args.session_id);
    if (args.expected_turn !== undefined && args.expected_turn !== result.turnId) throw new Error('Task turn changed; restart pagination');
    const offset = args.offset || 0, limit = args.limit || 12000;
    const text = result.answer || '';
    const artifact = runtime.collabStateDirectory && result.turnId > 0 && result.submission?.state !== 'pending'
      ? new ResultStore(runtime.collabStateDirectory).page(args.session_id, result.turnId, { offset, limit, revision: args.expected_revision }) : null;
    return { sessionId: result.sessionId, turnId: result.turnId, status: result.status, running: result.running,
      childrenPending: result.childrenPending, text: text.slice(offset, offset + limit), totalChars: text.length,
      nextOffset: offset + limit < text.length ? offset + limit : null,
      sourceTruncated: result.answerTruncated, ...(!result.finalization?.answer && artifact?.totalChars ? artifact : {}),
      finalization: result.finalization, usage: result.usage, error: result.error, failure: result.failure,
      diagnostic: result.diagnostic, admission: result.admission, admissionBlock: result.admissionBlock,
      effectiveDeadline: result.effectiveDeadline, reconciliation: result.reconciliation,
      recovery: result.recovery, recoveryHolds: result.recoveryHolds,
      model: result.model, provider: result.provider, permission: result.permission,
      finishReason: result.finishReason, toolCalls: result.progress?.toolCalls || [],
      activity: result.activity, activityTruncated: result.activityTruncated, completion: result.completion,
      progress: { step: result.progress?.step, turn: result.turnId }, budgetLedger: result.budgetLedger, budgetPolicy: result.budgetPolicy,
      ...(args.include_task ? { originalTask: nativeTaskState(runtime, args.session_id)?.originalTask || null, effectivePolicy: result.effectivePolicy } : {}) };
  }
  if (name === 'deepseek_runtime_status') {
    const [sessions, models, presets] = await Promise.all([
      api(runtime, 'session.list'), api(runtime, 'session.models'), api(runtime, 'agentPreset.list'),
    ]);
    return {
      runtime: { url: runtime.url, dshVersion: runtime.dshVersion, bridgeVersion: runtime.bridgeVersion, collabVersion: runtime.collabVersion || null,
        build: runtime.build || null, processInstance: runtime.processInstance || null },
      compatibility: runtimeCompatibility(runtime, contract),
      capabilitiesApi: runtime.capabilitiesApi || null,
      schedulingApi: runtime.schedulingApi || null,
      reconciliationApi: runtime.reconciliationApi || null,
      recoveryApi: runtime.recoveryApi || null,
      projectionBinding: runtime.projectionBinding || null,
      inboxLifecycle: runtime.inboxLifecycle || null,
      expected: contract, models, presets, toolRegistry: runtime.toolRegistry || null, sessions: { total: sessions.items?.length || 0,
        running: (sessions.items || []).filter((item) => item.running).length },
    };
  }
  if (name === 'deepseek_lead_policy_update') {
    const policy = requestPolicy(args, { maxChildren: 4, withChildren: true });
    const lead = await updateLeadPolicy(runtime, {
      leadId: args.lead_id,
      cwd: args.cwd,
      permission: policy.permission,
      reasoningEffort: policy.reasoningEffort,
    }, policy);
    return { ...lead, requestedPolicy: policy, commandId: args.lead_id, hotUpdated: true };
  }
  if (name === 'deepseek_flash_status') {
    const result = await sessionResult(runtime, args.session_id, {
      includeReasoning: args.return_reasoning === true,
      reasoningMaxChars: Number.isSafeInteger(args.reasoning_max_chars) ? args.reasoning_max_chars : 12000,
    });
    return { ...result, commandId: args.session_id, native: Boolean(result.parentSessionId) };
  }
  if (name === 'deepseek_flash_stop') {
    const result = await sessionResult(runtime, args.session_id);
    if (!result.parentSessionId) throw new Error('目标不是 DSH 原生子 Agent');
    const receipt = await api(runtime, 'subagent.interrupt', {
      parentSessionId: result.parentSessionId,
      childSessionId: args.session_id,
      mode: 'continuable',
    });
    return { sessionId: args.session_id, cancellationRequested: true, completed: false, receipt, nextAction: 'Wait for quiescence with deepseek_tasks_wait.' };
  }
  if (name === 'deepseek_lead_status') {
    const result = await leadResult(runtime, args.lead_id, {
      includeReasoning: args.return_reasoning === true,
      reasoningMaxChars: Number.isSafeInteger(args.reasoning_max_chars) ? args.reasoning_max_chars : 12000,
      includeChildren: args.include_children !== false,
    });
    return { ...result, commandId: args.lead_id };
  }
  if (name === 'deepseek_lead_list') return { leads: await listLeads(runtime, args.cwd, { includeArchived: args.include_archived === true }) };
  if (name === 'deepseek_lead_stop') {
    const receipt = await api(runtime, 'session.cancel', { sessionId: args.lead_id });
    await closeLeadLease(runtime, args.lead_id).catch(() => {});
    return { leadId: args.lead_id, cancellationRequested: true, completed: false, lease: 'closed', receipt, nextAction: 'Wait for the Lead and descendants; use deepseek_task_cancel with tree scope to cancel descendants too.' };
  }
  if (name === 'deepseek_session_archive') {
    if (args.action === 'restore') {
      const sessions = await recentSessions(runtime);
      if (!sessions.some(s => s.sessionId === args.session_id)) throw new Error('Target session is unavailable; no archive status was changed');
      return archiveSession(runtime, args.session_id, 'restore');
    }
    const current = await sessionResult(runtime, args.session_id);
    if (current.running || current.childrenPending.length || current.finalization?.status === 'running'
      || ['pending', 'running', 'unknown'].includes(current.submission?.state)) throw new Error('任务或后代尚未结算，不能归档；请先停止或等待完成。');
    return archiveSession(runtime, args.session_id);
  }
  throw new Error(`Unknown tool: ${name}`);
}
