import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeCandidates } from './discovery.mjs';
import { diagnose } from './diagnostics.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// A single entry point for both hosts. Installation stays with the host CLI;
// this module never edits their permissions, profiles or credential stores.
export function installationPlan(root, host, { platform = process.platform, env = process.env, cli = host } = {}) {
  if (!['codex', 'claude'].includes(host)) throw new Error('Choose codex or claude');
  root = fs.realpathSync(root);
  const catalog = read(path.join(root, host === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json'));
  const name = host === 'codex' ? 'dsh-codex-collab' : 'dsh-collab';
  const entry = catalog.plugins.find(plugin => plugin.name === name);
  if (!entry || !/^[a-z0-9-]+$/.test(catalog.name)) throw new Error('Invalid Clients marketplace');
  const source = typeof entry.source === 'string' ? entry.source : entry.source?.path;
  if (typeof source !== 'string' || !source.startsWith('./')) throw new Error('Local plugin source required');
  const folder = fs.realpathSync(path.resolve(root, source));
  if (!folder.startsWith(root + path.sep)) throw new Error('Plugin source outside Clients package');
  const meta = read(path.join(folder, host === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json'));
  const servers = host === 'codex' ? read(path.join(folder, '.mcp.json')).mcpServers : meta.mcpServers;
  const command = servers?.dsh_collab?.command;
  const windows = typeof command === 'string' && command.endsWith('.exe');
  if (windows !== (platform === 'win32')) throw new Error('Wrong download: use Windows Clients on Windows and POSIX Clients on macOS/Linux');
  if (!fs.existsSync(path.join(folder, 'mcp/server.mjs')) || windows && !fs.existsSync(path.join(folder, 'mcp/dsh-collab-mcp.exe'))) throw new Error('Incomplete Clients package');
  const selector = `${name}@${catalog.name}`;
  return { schema: 1, host, version: meta.version, marketplace: catalog.name, source: root, selector,
    steps: [
      { command: cli, args: ['plugin', 'marketplace', 'add', root] },
      { command: cli, args: ['plugin', host === 'codex' ? 'add' : 'install', selector, ...(host === 'claude' ? ['--scope', 'user'] : [])] },
    ],
    connection: { runtimeFile: path.resolve(runtimeCandidates(env)[0]),
      note: 'Configure this same expanded path as dsh-collab.config.runtimeFile in the active DSH profile. Existing working configurations need no change.' },
    effect: 'Registers the Clients marketplace and installs the host plugin. Does not install or restart DSH, grant tool permissions, run models or refresh an existing chat.',
  };
}

export function applyInstallation(plan, { run = spawnSync, env = process.env } = {}) {
  const receipts = [];
  const options = { env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000, maxBuffer: 1024 * 1024 };
  const listed = run(plan.steps[0].command, ['plugin', 'marketplace', 'list', '--json'], options);
  if (listed.status !== 0) return { ok: false, receipts, errorCode: listed.error?.code === 'ENOENT' ? 'HOST_CLI_NOT_FOUND' : 'HOST_MARKETPLACE_INSPECTION_FAILED',
    nextAction: 'Use a host CLI supporting plugin marketplace list --json, or use the printed installation commands in the host plugin manager. No installation was attempted.' };
  let marketplaces;
  try {
    const value = JSON.parse(listed.stdout);
    marketplaces = Array.isArray(value) ? value : value.marketplaces;
    if (!Array.isArray(marketplaces)) throw new Error('Unknown format');
  } catch {
    return { ok: false, receipts, errorCode: 'HOST_MARKETPLACE_FORMAT', nextAction: 'Host marketplace output was not recognized; use its plugin manager. No installation was attempted.' };
  }
  const existing = marketplaces.find(item => item.name === plan.marketplace);
  if (existing) {
    const source = existing.root || (existing.source === 'directory' ? existing.path : existing.source?.path);
    let same = false;
    try { same = typeof source === 'string' && fs.realpathSync(source) === fs.realpathSync(plan.source); } catch {}
    if (!same) return { ok: false, receipts, errorCode: 'MARKETPLACE_SOURCE_CONFLICT', nextAction: 'This marketplace name already points elsewhere. Resolve that source in the host plugin manager; no source was replaced or plugin uninstalled.' };
  }
  // No shell interpolation, no permission allowlists, no uninstall/reinstall.
  for (const [index, step] of plan.steps.entries()) {
    if (index === 0 && existing) { receipts.push({ step: 1, ok: true, state: 'already-registered' }); continue; }
    const result = run(step.command, step.args, options);
    receipts.push({ step: index + 1, exitCode: result.status ?? null, ok: result.status === 0,
      errorCode: result.error?.code === 'ENOENT' ? 'HOST_CLI_NOT_FOUND' : result.status !== 0 ? 'HOST_INSTALL_FAILED' : null });
    if (result.status !== 0) return { ok: false, receipts, nextAction: 'Host CLI did not complete this step. Inspect the host plugin manager or run the printed command directly. An existing marketplace at another location must be resolved there; no existing source was removed.' };
  }
  return { ok: true, receipts, nextAction: 'Host CLI accepted installation. Verify the plugin in the host MCP list and call deepseek_runtime_status there; installation alone does not prove current-chat availability.' };
}

export async function main(root, argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === 'doctor') {
    if (rest.some(x => x !== '--live') || rest.length > 1) throw new Error('Invalid doctor option');
    const report = await diagnose({ live: rest.includes('--live') });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command !== 'install') throw new Error('Use: node setup.mjs doctor [--live] | install codex|claude [--apply] [--cli PATH]');
  const host = rest.shift();
  let apply = false, cli = host;
  while (rest.length) {
    const flag = rest.shift();
    if (flag === '--apply' && !apply) apply = true;
    else if (flag === '--cli' && rest[0] && !rest[0].startsWith('--')) cli = rest.shift();
    else throw new Error('Unknown install option');
  }
  const plan = installationPlan(root, host, { cli });
  process.stdout.write(JSON.stringify({ mode: apply ? 'apply' : 'preview', plan }, null, 2) + '\n');
  if (apply) {
    const receipt = applyInstallation(plan);
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    if (!receipt.ok) process.exitCode = 1;
  }
}
