import { RECEIPT_TOOLS, CONDITIONAL_READ_TOOLS } from './receipt-view.mjs';

function aliasSchema(schema) {
  if (!schema?.properties) return schema;
  const out = { ...schema, properties: { ...schema.properties } };
  if (schema.properties.session_id) {
    out.properties.task_session_id = { ...schema.properties.session_id,
      description: 'Preferred session ID alias for hosts that reserve session_id. If both are given they must match.' };
    if (schema.required?.includes('session_id')) {
      out.required = schema.required.filter(key => key !== 'session_id');
      out.allOf = [...(schema.allOf || []), { anyOf: [{ required: ['session_id'] }, { required: ['task_session_id'] }] }];
    }
  }
  if (schema.properties.tasks?.items) out.properties.tasks = {
    ...schema.properties.tasks, items: aliasSchema(schema.properties.tasks.items),
  };
  return out;
}

// Host-only fields are stripped before the authenticated Runtime call. Request
// keys and canonical task payloads are untouched; UI/native callers keep their API.
export function hostTools(tools) {
  return tools.map(tool => {
    let schema = aliasSchema(tool.inputSchema);
    if (CONDITIONAL_READ_TOOLS.has(tool.name)) schema = { ...schema, properties: { ...schema.properties,
      if_response_revision: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Previous compact responseRevision. Unchanged reads return a marker instead of repeating the answer. Never used to submit or skip native checks.' } } };
    return { ...tool, inputSchema: RECEIPT_TOOLS.has(tool.name) ? {
      ...schema, properties: { ...schema.properties, response_detail: { type: 'string', enum: ['compact', 'full'], default: 'compact',
        description: 'compact omits per-request ledger IDs and trace bodies, retaining answers, totals, warnings and exact policy references. full returns raw detail. Does not change execution budget.' } },
    } : schema };
  });
}

function aliases(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = { ...args };
  if (schema?.properties?.session_id && Object.hasOwn(out, 'task_session_id')) {
    if (typeof out.task_session_id !== 'string' || !out.task_session_id.trim()) throw new Error('task_session_id must be a nonempty session ID');
    if (Object.hasOwn(out, 'session_id') && out.session_id !== out.task_session_id) throw new Error('session_id and task_session_id conflict; no request sent');
    out.session_id = out.task_session_id; delete out.task_session_id;
  }
  if (schema?.required?.includes('session_id') && !Object.hasOwn(out, 'session_id')) throw new Error('Provide task_session_id or session_id; no request sent');
  if (Array.isArray(out.tasks) && schema?.properties?.tasks?.items) out.tasks = out.tasks.map(item => aliases(item, schema.properties.tasks.items));
  return out;
}

export function hostArguments(tool, args = {}) {
  const out = aliases(args, tool.inputSchema);
  let detail = RECEIPT_TOOLS.has(tool.name) ? 'compact' : 'full';
  let previousRevision;
  if (!CONDITIONAL_READ_TOOLS.has(tool.name) && out && Object.hasOwn(out, 'if_response_revision')) throw new Error('Conditional revisions are supported only on status/result reads; no request sent');
  if (CONDITIONAL_READ_TOOLS.has(tool.name) && out && Object.hasOwn(out, 'if_response_revision')) {
    if (typeof out.if_response_revision !== 'string' || !/^[a-f0-9]{64}$/.test(out.if_response_revision)) throw new Error('if_response_revision must be a returned SHA256 revision');
    previousRevision = out.if_response_revision; delete out.if_response_revision;
  }
  if (RECEIPT_TOOLS.has(tool.name) && out && Object.hasOwn(out, 'response_detail')) {
    if (!['compact', 'full'].includes(out.response_detail)) throw new Error('response_detail must be compact or full');
    detail = out.response_detail; delete out.response_detail;
  }
  if (detail === 'full' && previousRevision) throw new Error('Conditional reads require response_detail=compact');
  return { arguments: out, detail, previousRevision };
}
