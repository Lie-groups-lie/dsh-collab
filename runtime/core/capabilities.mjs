// Known built-ins only. A third-party name/annotation cannot grant itself access.
const READ = ['read', 'glob', 'grep', 'read_image', 'web_search', 'skill', 'todo_write'];
const WRITE = ['edit', 'write'];
const TERMINAL = ['pwsh', 'bash', 'job_list', 'job_output', 'job_kill'];
const DELEGATE = ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent'];
export const reservedToolNames = new Set([...READ, ...WRITE, ...TERMINAL, ...DELEGATE, 'report']);

export function allowedTools(policy, { lead = false } = {}) {
  if (policy.maxToolCalls === 0) return [];
  const names = [...READ];
  const writable = ['workspace-write', 'danger-full-access'].includes(policy.permission);
  if (writable) names.push(...WRITE);
  if (policy.allowTerminal && writable) names.push(...TERMINAL);
  if (lead && policy.maxChildren > 0 || !lead && policy.allowDelegation) names.push(...DELEGATE);
  return policy.allowedTools ? names.filter((name) => policy.allowedTools.includes(name)) : names;
}

export function optionalLimit(value, name, minimum = 0) {
  if (value === undefined || value === null || value === -1) return null;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}: out of range`);
  return value;
}

export function budgetPolicy(value = {}, maxOutputTokens = 32768) {
  const integer = (key, fallback, min, max) => {
    if (value[key] === undefined) return fallback;
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`Invalid ${key}`);
    return value[key];
  };
  if (value.allowedTools !== undefined && (!Array.isArray(value.allowedTools) || value.allowedTools.some((name) => typeof name !== 'string'))) {
    throw new Error('allowedTools must be an array of tool names');
  }
  return {
    maxRequests: optionalLimit(value.maxRequests, 'maxRequests', 1),
    maxTotalOutputTokens: optionalLimit(value.maxTotalOutputTokens, 'maxTotalOutputTokens', 64),
    maxTotalInputTokens: optionalLimit(value.maxTotalInputTokens, 'maxTotalInputTokens', 1),
    maxConcurrentRequests: integer('maxConcurrentRequests', 4, 1, 32),
    ...(value.maxCostMicros === undefined ? {} : { maxCostMicros: integer('maxCostMicros', 0, 1, 1000000000) }),
    maxToolCallsTotal: optionalLimit(value.maxToolCallsTotal, 'maxToolCallsTotal'),
    maxChildrenTotal: integer('maxChildrenTotal', 16, 0, 256),
    maxDurationSeconds: optionalLimit(value.maxDurationSeconds, 'maxDurationSeconds', 1),
    ...(value.allowedTools === undefined ? {} : { allowedTools: [...new Set(value.allowedTools)] }),
    allowExternalWrites: value.allowExternalWrites === true,
  };
}

export function continuedPolicy(previous, next) {
  const result = { ...next };
  for (const key of ['maxRequests', 'maxTotalOutputTokens', 'maxTotalInputTokens', 'maxConcurrentRequests', 'maxToolCallsTotal', 'maxChildrenTotal', 'maxDurationSeconds']) {
    const before = previous[key], after = next[key];
    result[key] = before == null ? after : after == null ? before : Math.min(before, after);
  }
  if (previous.maxCostMicros !== undefined) result.maxCostMicros = Math.min(previous.maxCostMicros, next.maxCostMicros ?? previous.maxCostMicros);
  if (previous.allowedTools) result.allowedTools = previous.allowedTools.filter((name) => !next.allowedTools || next.allowedTools.includes(name));
  return result;
}
