import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectConnection, readRuntime, callRemote } from './client.mjs';

const actions = {
  DSH_RUNTIME_AUTH: 'The selected instance rejected authentication. Refresh its discovery record through the running DSH host; do not change browser-access settings or replay tasks.',
  DSH_RUNTIME_UNREACHABLE: 'The selected backend is unreachable. Inspect its process and crash log. Do not infer that its tasks completed or automatically start another backend.',
  DSH_OBSERVATION_CANCELLED: 'The read-only health check timed out. Retry diagnostics later; no task was submitted or cancelled.',
  DSH_CONTROL_VERSION: 'Update the native DSH Collab package in an idle maintenance window; its control API is incompatible.',
};
const safeVersion = value => typeof value === 'string' && /^[0-9][0-9A-Za-z.+-]{0,80}$/.test(value) ? value : null;
function packagedVersion() {
  try { return safeVersion(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); }
  catch { return null; }
}

export async function diagnose({ live = false, env = process.env, discoveryOptions, remote = callRemote } = {}) {
  const report = inspectConnection(env, discoveryOptions);
  report.ok = report.discoveryValid && report.controlCompatible === true && !report.multipleRecords;
  report.liveCheckRequested = live;
  report.modelInferenceTested = false;
  if (!live || !report.ok) return report;
  report.mode = 'authenticated-read-only-health';
  try {
    const result = await remote('deepseek_runtime_status', {}, { runtime: readRuntime(env, discoveryOptions), timeoutMs: 15000 });
    // Deliberate projection: upstream status contains workspace and module paths.
    report.reachable = true;
    report.authenticated = true;
    report.compatible = result?.compatibility?.compatible === true;
    report.versions = {
      clients: packagedVersion(),
      collab: safeVersion(result?.runtime?.collabVersion),
      dsh: safeVersion(result?.runtime?.dshVersion),
      bridge: safeVersion(result?.runtime?.bridgeVersion),
      expectedDsh: safeVersion(result?.expected?.dshVersion),
      expectedBridge: safeVersion(result?.expected?.bridgeVersion),
    };
    report.clientRuntimeMatch = report.versions.clients !== null && report.versions.clients === report.versions.collab;
    report.ok = report.compatible && report.clientRuntimeMatch;
    report.nextAction = report.ok
      ? 'Connection and Runtime contract verified. In the intended host, check MCP tools and call deepseek_runtime_status. This CLI check does not prove that an existing chat loaded its plugin or that model inference works.'
      : !report.clientRuntimeMatch
        ? 'Clients and the running Collab package differ or version identity is missing. Compare versions.clients with versions.collab; install matching packages in an idle maintenance window. Existing task data is unchanged.'
        : 'The running Runtime contract is incompatible or incomplete. Compare reported DSH/bridge versions with expected versions; update only when work is idle.';
  } catch (error) {
    const candidate = typeof error.code === 'string' ? error.code : String(error.message).match(/\bDSH_[A-Z_0-9]+\b/)?.[0];
    const code = Object.hasOwn(actions, candidate || '') ? candidate : /^DSH_CONTROL_HTTP_\d{3}$/.test(candidate || '') ? candidate : 'DSH_HEALTH_FAILED';
    report.ok = false;
    report.errorCode = code;
    report.reachable = code === 'DSH_RUNTIME_AUTH' || code.startsWith('DSH_CONTROL_HTTP_') ? true : null;
    report.authenticated = code === 'DSH_RUNTIME_AUTH' ? false : null;
    report.nextAction = actions[code] || 'The health endpoint did not return a valid result. Inspect local DSH diagnostics; no task was submitted or replayed.';
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.some(arg => arg !== '--live') || argv.length > 1) throw new Error('Invalid arguments');
  const result = await diagnose({ live: argv.includes('--live') });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('DSH_CONNECTION_DIAGNOSTIC_FAILED: use node lib/diagnostics.mjs [--live]. No host was started or task submitted.\n'); process.exitCode = 1; });
}
