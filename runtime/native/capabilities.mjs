import { allowedTools, reservedToolNames } from '../core/capabilities.mjs';
import { toolFingerprint, capabilityQuerySchema } from '../core/tool-registry.mjs';
import { validateInput } from '../core/schema.mjs';

// Inspection never resolves a cold agent, grants a tool, or calls its body.
export function inspectCapabilities(ctx, store, registry, args = {}) {
  validateInput(args, capabilityQuerySchema);
  const record = args.session_id ? store.get(args.session_id) : null;
  if (args.session_id && !record?.policy) throw new Error('Managed task not found; capability inspection does not create or adopt sessions');
  const agent = args.session_id ? ctx.agents.get(args.session_id) : null;
  // Global discovery is useful before creating a model task. It is a host
  // catalog, not a promise about a workspace/preset or a task permission.
  const schemas = agent ? ctx.tools.schemas(agent) : args.session_id ? [] : ctx.tools.schemas();
  const actual = new Map(schemas.map(tool => [tool.name, tool]));
  const names = [...new Set([...actual.keys(), ...registry.entries.keys(), ...(record?.policy?.allowedTools || [])])].sort();
  const selected = args.tool_name ? names.filter(name => name === args.tool_name) : names;
  if (args.tool_name && !selected.length) throw new Error('Tool is not present in this DSH scope or trusted registry; Codex-only plugins are not imported automatically');
  const offset = args.offset || 0, limit = args.limit || 50;
  const builtins = record ? allowedTools(record.policy, { lead: record.role === 'lead' }) : [];
  const items = selected.slice(offset, offset + limit).map(name => {
    const tool = actual.get(name), registered = registry.entries.get(name);
    const reason = !args.session_id ? 'Host catalog only; select a managed session to inspect effective permission'
      : !agent ? 'Session is not loaded; live availability and permission are unknown (not awakened by inspection)'
      : !tool ? 'Tool is not mounted or is hidden by the DSH preset/scope'
      : builtins.includes(name) ? null : registry.decision(tool, record.policy, agent.session.header.cwd);
    return { name, executor: 'dsh', available: agent || !args.session_id ? Boolean(tool) : null,
      callable: agent ? Boolean(tool && !reason) : null, denial: reason,
      builtin: reservedToolNames.has(name), registered: Boolean(registered),
      effect: registered?.effect || null, schemaSha256: tool ? toolFingerprint(tool) : null,
      expectedSchemaSha256: registered?.schemaSha256 || null,
      ...(args.tool_name && tool ? { schema: tool, argumentRestrictions: registered?.argumentsSchema || null } : {}) };
  });
  return { sessionId: args.session_id || null, inspectionOnly: true, registryRevision: registry.revision,
    hostAdapters: { scheduling: { available: Boolean(ctx.get?.('schedule')), api: ctx.get?.('schedule') ? 1 : 0,
      operations: ['deepseek_schedule_create', 'deepseek_schedule_list', 'deepseek_schedule_update', 'deepseek_schedule_delete', 'deepseek_schedule_history'],
      caller: 'authenticated-collab-host', target: 'managed-root-lead', modelToolGrant: false } },
    scope: args.session_id ? 'session' : 'host', inventoryComplete: Boolean(agent) || !args.session_id, items, total: selected.length,
    nextOffset: offset + items.length < selected.length ? offset + items.length : null,
    note: 'Callable describes Collab admission, not a guarantee that the plugin accepts the arguments or that its service is online. Credentials stay with the DSH plugin. Register reviewed schemas, then explicitly select allowed_tools; no implicit grant.' };
}
