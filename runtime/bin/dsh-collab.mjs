#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import contract from '../runtime-contract.json' with { type: 'json' };
import packageInfo from '../package.json' with { type: 'json' };
import { api, readRuntime } from '../mcp/dsh-client.mjs';
import { startStandalone } from '../runtime/standalone.mjs';
import { ToolRegistry, toolFingerprint } from '../core/tool-registry.mjs';
import { runtimeCompatibility } from '../core/runtime-compatibility.mjs';
import connection from '../runtime/connection.cjs';

export const pluginRoot = path.resolve(import.meta.dirname, '..');

// Configuration is printed, never installed into a host or a project implicitly.
export function hostConfig(host, { root = pluginRoot, platform = process.platform, runtimeFile } = {}) {
  const server = path.join(root, 'mcp', 'server.mjs');
  const command = platform === 'win32' ? path.join(root, 'mcp', 'dsh-collab-mcp.exe') : 'node';
  const args = [server];
  const env = runtimeFile ? { DSH_DESKTOP_RUNTIME_FILE: path.resolve(runtimeFile) } : {};
  if (host === 'claude') return { mcpServers: { dsh_collab: { command, args, ...(runtimeFile ? { env } : {}) } } };
  if (host === 'opencode') return { mcp: { dsh_collab: {
    type: 'local', command: [command, ...args], enabled: true,
    ...(runtimeFile ? { environment: env } : {}),
  } } };
  if (host === 'codex') return { mcpServers: { dsh_collab: {
    command, args, cwd: root, env_vars: ['APPDATA', 'USERPROFILE', 'LOCALAPPDATA', 'PATH', 'DSH_DESKTOP_RUNTIME_FILE', 'DSH_MCP_NODE'],
    startup_timeout_sec: 30, tool_timeout_sec: 7200, required: true,
    ...(runtimeFile ? { env } : {}),
  } } };
  throw new Error('Supported config targets: codex, claude, opencode (v1).');
}

export function nativePatch(root = pluginRoot) {
  const entry = pathToFileURL(path.join(root, 'native', 'index.mjs')).href;
  return `- insert:\n    - id: codex-subagent-bridge\n      name: ${JSON.stringify(entry)}\n`;
}

export function hostPatch(runtimeFile) {
  if (!runtimeFile || !path.isAbsolute(runtimeFile)) throw new Error('host-patch requires an absolute runtime file');
  return `- id: dsh-collab\n  config:\n    runtimeFile: ${JSON.stringify(runtimeFile)}\n`;
}

export async function doctor({ offline = false, runtimeFile, env = process.env, cwd = process.cwd() } = {}) {
  const runtime = runtimeFile
    ? { ...JSON.parse(fs.readFileSync(runtimeFile, 'utf8')), runtimeFile: path.resolve(runtimeFile) }
    : readRuntime({ env, cwd });
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(runtime.url || '')) throw new Error('Runtime must use a loopback URL.');
  const checks = {
    dshVersionMatches: runtime.dshVersion === contract.dshVersion,
    bridgeVersionMatches: runtime.bridgeVersion === contract.bridgeVersion,
    nativeEntryPresent: fs.existsSync(path.join(pluginRoot, 'native', 'index.mjs')),
    runtimeEntryPresent: connection.runtimeEntryPresent(runtime),
    authenticationPresent: new URL(runtime.launchUrl || runtime.url).searchParams.has('token'),
  };
  const compatibility = runtimeCompatibility(runtime, contract);
  let reachable = null;
  let modelAvailable = null;
  let standardPresetAvailable = null;
  if (!offline) {
    const [models, presets] = await Promise.all([
      api(runtime, 'session.models', {}, 10000), api(runtime, 'agentPreset.list', {}, 10000),
    ]);
    reachable = true;
    modelAvailable = (models.groups || []).some((group) => group.models?.some((model) => model.id === contract.flashModel));
    standardPresetAvailable = (presets.presets || []).some((preset) => preset.id === 'standard' && !preset.broken);
  }
  // Deliberately omit launchUrl, cookies, credentials, workspace paths, and history.
  return {
    plugin: { name: packageInfo.name, version: packageInfo.version },
    ok: compatibility.compatible && Object.values(checks).every(Boolean) && (offline || modelAvailable && standardPresetAvailable),
    compatibility,
    offline, checks, reachable, modelAvailable, standardPresetAvailable,
    modelInferenceTested: false, bridgeEnforcementTested: false,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args.shift();
  let runtimeFile;
  let offline = false;
  let cwd, entry;
  const positional = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--runtime-file') {
      runtimeFile = args.shift();
      if (!runtimeFile || runtimeFile.startsWith('--')) throw new Error('--runtime-file requires a path.');
    } else if (arg === '--cwd' || arg === '--dsh-entry') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      if (arg === '--cwd') cwd = value; else entry = value;
    } else if (arg === '--offline') offline = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (!['runtime-start', 'runtime-recover'].includes(command) && (cwd || entry)) throw new Error('Runtime options are only valid for runtime-start or runtime-recover');
  if (['runtime-start', 'runtime-recover'].includes(command) && !positional.length && !offline) {
    process.stdout.write(`${JSON.stringify(await startStandalone({ runtimeFile, cwd, entry, attachOnly: command === 'runtime-recover' }), null, 2)}\n`);
  } else if (command === 'config' && positional.length === 1 && !offline) {
    if (!fs.existsSync(path.join(pluginRoot, 'mcp/server.mjs'))) throw new Error('Use the separate Clients package for host MCP configuration.');
    process.stdout.write(`${JSON.stringify(hostConfig(positional[0], { runtimeFile }), null, 2)}\n`);
  } else if (command === 'patch' && !positional.length && !runtimeFile && !offline) {
    process.stdout.write(nativePatch());
  } else if (command === 'host-patch' && !positional.length && runtimeFile && !offline) {
    process.stdout.write(hostPatch(runtimeFile));
  } else if (command === 'doctor' && !positional.length) {
    const report = await doctor({ runtimeFile, offline });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } else if (command === 'tool-fingerprint' && positional.length === 1 && !runtimeFile) {
    const tool = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
    if (typeof tool.name !== 'string' || !tool.parameters || typeof tool.parameters !== 'object') throw new Error('Expected a DSH tool schema');
    process.stdout.write(`${JSON.stringify({ name: tool.name, schemaSha256: toolFingerprint(tool) }, null, 2)}\n`);
  } else if (command === 'validate-tools' && positional.length === 1 && !runtimeFile) {
    const registry = ToolRegistry.fromFile(positional[0]);
    process.stdout.write(`${JSON.stringify({ valid: true, revision: registry.revision, tools: registry.entries.size })}\n`);
  } else {
    throw new Error('Usage: dsh-collab doctor [--offline] [--runtime-file PATH] | config codex|claude|opencode [--runtime-file PATH] | patch | host-patch --runtime-file PATH | runtime-start|runtime-recover --runtime-file PATH --cwd PATH [--dsh-entry PATH]');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Do not echo malformed credential-bearing runtime URLs or server responses.
    process.stderr.write('dsh-collab: command failed. Check arguments, runtime availability and pinned versions. See README.md.\n');
    process.exitCode = 1;
  });
}
