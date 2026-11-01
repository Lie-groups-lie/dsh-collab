// Pure extension helpers. No executor, native state store, MCP process or desktop.
export const extensionApiVersion = 1;
export { validateInput } from '../core/schema.mjs';
export { withOperationLock } from '../core/operation-lock.mjs';
