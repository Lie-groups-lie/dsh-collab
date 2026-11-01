import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateInput } from './schema.mjs';
import { reservedToolNames } from './capabilities.mjs';

export const capabilityQuerySchema = { type: 'object', properties: {
  session_id: { type: 'string', minLength: 1, maxLength: 160 }, tool_name: { type: 'string', minLength: 1, maxLength: 256 },
  offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
}, additionalProperties: false };

import { canonical } from './canonical.mjs';
export { canonical } from './canonical.mjs';
export function toolFingerprint(tool) {
  return createHash('sha256').update(JSON.stringify(canonical({ name: tool.name, description: tool.description || '', parameters: tool.parameters }))).digest('hex');
}
const effects = new Set(['network-read', 'external-write', 'local-read', 'local-write', 'terminal']);
const schemaKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'description']);
function checkRestriction(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Tool argument restriction must be a schema object');
  for (const key of Object.keys(schema)) if (!schemaKeys.has(key)) throw new Error(`Unsupported restriction keyword: ${key}`);
  if (!['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(schema.type)) throw new Error('Restriction schema requires a supported type');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw new Error('additionalProperties restrictions must be boolean');
  if (schema.type === 'array' && !schema.items) throw new Error('Array restriction requires items');
  if (schema.pattern) new RegExp(schema.pattern);
  for (const value of Object.values(schema.properties || {})) checkRestriction(value);
  if (schema.items) checkRestriction(schema.items);
}

export class ToolRegistry {
  constructor(manifest = { schema: 1, tools: [] }) {
    if (manifest.schema !== 1 || !Array.isArray(manifest.tools)) throw new Error('Invalid trusted tool registry');
    this.entries = new Map();
    for (const entry of manifest.tools) {
      if (!entry || typeof entry.name !== 'string' || !entry.name || reservedToolNames.has(entry.name) || this.entries.has(entry.name)
        || !/^[a-f0-9]{64}$/.test(entry.schemaSha256) || !effects.has(entry.effect)
        || !Array.isArray(entry.workspaces) || !entry.workspaces.length || entry.workspaces.some((cwd) => !path.isAbsolute(cwd))) throw new Error('Invalid trusted tool entry');
      if (entry.argumentsSchema) checkRestriction(entry.argumentsSchema);
      this.entries.set(entry.name, structuredClone(entry));
    }
    this.revision = createHash('sha256').update(JSON.stringify(canonical(manifest))).digest('hex');
  }
  static fromFile(filename) { return new ToolRegistry(filename ? JSON.parse(fs.readFileSync(filename, 'utf8')) : undefined); }
  decision(tool, policy, cwd, args) {
    const entry = tool && this.entries.get(tool.name);
    if (!entry || policy.maxToolCalls === 0 || !policy.allowedTools?.includes(tool.name)) return 'Third-party tool is not explicitly granted';
    const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (!cwd || !entry.workspaces.some((value) => normalize(value) === normalize(cwd))) return 'Tool registry workspace mismatch';
    if (toolFingerprint(tool) !== entry.schemaSha256) return 'Tool schema changed; administrator review is required';
    if (entry.effect === 'external-write' && (policy.permission === 'read-only' || !policy.allowExternalWrites)) return 'External writes are not authorized';
    // Remote tools do not inherit DSH filesystem confinement. Never pretend a
    // workspace-write permission can constrain an arbitrary external file writer.
    if (entry.effect === 'local-write' && policy.permission !== 'danger-full-access') return 'External file writes require an independently confined adapter or explicit full-access policy';
    if (entry.effect === 'terminal' && (!policy.allowTerminal || policy.permission === 'read-only')) return 'External terminal is not authorized';
    if (args !== undefined && entry.argumentsSchema) {
      try { validateInput(args, entry.argumentsSchema); } catch { return 'Tool arguments violate administrator restrictions'; }
    }
    return null;
  }
  describe() { return [...this.entries.values()].map(({ argumentsSchema, ...entry }) => ({ ...entry, restrictedArguments: Boolean(argumentsSchema) })); }
}
