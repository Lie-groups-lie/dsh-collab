import { allowedTools, reservedToolNames } from './capabilities.mjs';
import { capabilityDiagnostics } from './capability-diagnostics.mjs';

// Prospective policy only. Does not access native sessions, credentials or stores.
// This result is never an admission receipt or an execution permission token.
export function policyPreview(policy, { lead = false, scope = 'task', sharedToolsDisabled = false, sharedChildrenDisabled = false } = {}) {
  const diagnostics = capabilityDiagnostics(policy, { lead, scope });
  const warnings = diagnostics.warnings.filter(w => w.scope === scope);
  const warn = (code, message) => warnings.push({ code, scope, message });
  const selected = allowedTools(policy, { lead });
  const toolsDisabled = sharedToolsDisabled || policy.maxToolCallsTotal === 0;
  const childrenDisabled = sharedChildrenDisabled || policy.maxChildrenTotal === 0;
  const spawn = new Set(['subagent', 'subagent_fork']);
  const candidates = toolsDisabled ? [] : selected.filter(name => !childrenDisabled || !spawn.has(name));
  const external = (policy.allowedTools || []).filter(name => !reservedToolNames.has(name));
  if (policy.allowTerminal && policy.permission === 'read-only') warn('TERMINAL_BLOCKED_BY_READ_ONLY',
    'allow_terminal does not override read-only permission. Terminal tools remain blocked.');
  if (policy.allowExternalWrites && policy.permission === 'read-only') warn('EXTERNAL_WRITES_BLOCKED_BY_READ_ONLY',
    'allow_external_writes does not override read-only permission. External writes remain blocked.');
  if (toolsDisabled) warn('SHARED_TOOLS_DISABLED', 'The shared tool-call budget is zero; no task in this preview can execute tools.');
  if (lead && policy.maxChildren > 0 && childrenDisabled) warn('SHARED_CHILDREN_DISABLED',
    'The shared child budget is zero even though max_children is positive. No child can be admitted.');
  if (external.length) warn('THIRD_PARTY_TOOLS_UNVERIFIED',
    'Selected third-party tools require native availability, administrator registration, schema and workspace checks. This offline preview grants none of them.');
  const excludedTools = (policy.allowedTools || []).filter(name => reservedToolNames.has(name) && !candidates.includes(name));
  if (excludedTools.length) warn('SELECTED_BUILTINS_EXCLUDED', 'Some selected built-in tools are excluded by the permission, delegation or tool-budget policy.');
  const result = {
    scope, policy, candidateBuiltinTools: candidates, excludedBuiltinTools: excludedTools,
    thirdPartyTools: external.map(name => ({ name, available: null, authorized: null })),
    delegation: { ...diagnostics.delegation, policyAllows: candidates.some(name => spawn.has(name)), enabled: null, source: 'policy-only' },
    messaging: { ...diagnostics.messaging, policyAllows: candidates.includes('send_message'), enabled: null,
      delivery: candidates.includes('send_message') ? 'message-or-final-answer' : 'final-answer' },
    warnings,
  };
  if (lead && policy.childPolicy) {
    result.child = policyPreview(policy.childPolicy, { scope: 'child_policy', sharedToolsDisabled: toolsDisabled, sharedChildrenDisabled: childrenDisabled });
    warnings.push(...result.child.warnings);
  }
  return result;
}
