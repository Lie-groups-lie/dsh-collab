import { allowedTools } from './capabilities.mjs';

const canSpawn = names => names.includes('subagent') || names.includes('subagent_fork');

// A count is a ceiling, never an authorization grant. Missing observations are
// unknown, not evidence that the next model request will receive a tool.
export function capabilityDiagnostics(policy, { lead = false, exposedTools = null, scope = 'task' } = {}) {
  if (!policy) return { delegation: null, messaging: null, warnings: [] };
  const selected = allowedTools(policy, { lead });
  const observed = Array.isArray(exposedTools);
  const warnings = [];
  const warn = (code, message) => warnings.push({ code, scope, message });
  const requested = lead ? policy.maxChildren > 0 : policy.allowDelegation === true;
  if (requested && !canSpawn(selected)) warn('DELEGATION_TOOLS_EXCLUDED',
    'Child capacity was requested, but policy excludes subagent/subagent_fork. allowed_tools must explicitly retain a spawn tool, and max_tool_calls must not be 0. No permission was expanded.');
  else if (!requested && canSpawn(policy.allowedTools || [])) warn('DELEGATION_NOT_GRANTED',
    'allowed_tools lists a spawn tool, but delegation is disabled by the task policy. Tool selection does not grant delegation; no permission was expanded.');
  else if (requested && observed && !canSpawn(exposedTools)) warn('DELEGATION_NOT_EXPOSED',
    'Policy permits delegation, but this model request exposes no spawn tool. Check the native preset and tool availability; no child creation is confirmed.');
  if (policy.allowedTools?.includes('send_message') && !selected.includes('send_message')) warn('MESSAGE_TOOL_NOT_GRANTED',
    'send_message appears in allowed_tools but is blocked by the delegation/tool policy. A whitelist selects tools; it cannot grant missing capabilities. Return the result in the final answer.');
  const result = {
    delegation: { enabled: observed ? canSpawn(exposedTools) : null, policyAllows: canSpawn(selected),
      maxChildren: lead ? policy.maxChildren ?? null : null, source: observed ? 'model-request' : 'policy-only' },
    messaging: { enabled: observed ? exposedTools.includes('send_message') : null,
      policyAllows: selected.includes('send_message'), delivery: (observed ? exposedTools : selected).includes('send_message') ? 'message-or-final-answer' : 'final-answer' },
    warnings,
  };
  if (lead && policy.childPolicy) {
    result.childCapabilities = capabilityDiagnostics(policy.childPolicy, { scope: 'child_policy' });
    warnings.push(...result.childCapabilities.warnings);
  }
  return result;
}

export function deliveryGuidance(toolNames) {
  if (toolNames.includes('send_message')) return 'Return a substantive final answer. send_message is available for authorized coordination; sending a message is not proof that the task is complete.';
  return 'send_message is unavailable in this request. Return the result and any blockers in your final answer; do not attempt unavailable messaging or delegation tools. '
    + (toolNames.some(name => ['write', 'edit'].includes(name))
      ? 'Use file delivery only if the user requested it, within the granted workspace permissions.'
      : 'Do not create a delivery file: this request exposes no file-writing tool.');
}
