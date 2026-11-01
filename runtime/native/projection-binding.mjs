import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const INTERNAL = ['cellFor', 'advanceCell', 'drive'];
const ORIGINAL = Symbol.for('cordis.original');

// Cordis rebinds public service methods to caller contexts. These internal
// methods only mutate the registry's own cells, not the caller's scope.
// No prototype/disk patch, retry, or swallowed projection exception.
export function bindProjectionRegistry(ctx) {
  const service = ctx.sessionProjections;
  const owner = service?.[ORIGINAL] || service;
  if (!owner || !(owner.registrations instanceof Map)) throw new Error('Unsupported native projection registry: no owner registrations');
  const descriptors = new Map(), methods = new Map();
  for (const key of INTERNAL) {
    if (typeof owner[key] !== 'function') throw new Error(`Unsupported native projection registry: ${key} is not a function`);
    descriptors.set(key, Object.getOwnPropertyDescriptor(owner, key));
    methods.set(key, owner[key]);
  }
  const info = { mode: 'owner-bound-internals', constructor: owner.constructor?.name,
    prototype: Object.getPrototypeOf(owner)?.constructor?.name, methods: {} };
  try {
    const require = createRequire(process.argv[1] || import.meta.url);
    const modulePath = require.resolve('@deepseek-ai/dsh-session-projection');
    info.module = { path: modulePath, sha256: createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex') };
  } catch { info.module = { unavailable: true }; }
  const installed = new Map();
  for (const key of INTERNAL) {
    const fn = methods.get(key).bind(owner);
    installed.set(key, fn);
    Object.defineProperty(owner, key, { value: fn, configurable: true, writable: true });
    info.methods[key] = typeof service[key];
  }
  ctx.effect(() => () => {
    for (const key of INTERNAL) {
      if (owner[key] !== installed.get(key)) continue;
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(owner, key, descriptor);
      else delete owner[key];
    }
  });
  return Object.freeze(info);
}

// Do not persist error headers, payloads, credentials or source text. Retain only
// bounded stack frame locations and operational identifiers.
export function errorDiagnostic(error, identity, projection) {
  const frames = String(error?.stack || '').split('\n')
    .filter(line => /^\s+at /.test(line))
    .map(line => {
      const match = /(?:file:\/\/\/)?([^()\r\n]+:\d+:\d+)\)?$/.exec(line);
      return match ? match[1].trim().replace(/^at\s+/, '').slice(-600) : null;
    }).filter(Boolean).slice(0, 20);
  return { layer: 'native-agent', source: 'agent/error', ...identity,
    name: /^[\w.]{1,80}$/.test(error?.name || '') ? error.name : 'Error',
    code: /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : null,
    syscall: /^[a-zA-Z]{1,40}$/.test(error?.syscall || '') ? error.syscall : null,
    stackFrames: frames, stackAvailable: frames.length > 0, projection, recordedAt: Date.now() };
}
