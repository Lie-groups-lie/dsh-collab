import fs from 'node:fs';
import path from 'node:path';
import manager from './manager.cjs';
import contract from '../runtime-contract.json' with { type: 'json' };

export async function startStandalone({ runtimeFile, cwd, entry, attachOnly = false } = {}) {
  if (!runtimeFile || !cwd) throw new Error('runtime-start requires --runtime-file and --cwd');
  cwd = fs.realpathSync(cwd);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Workspace must be a directory');
  runtimeFile = path.resolve(runtimeFile);
  const located = manager.findDsh({ cwd, explicit: entry });
  if (!located || located.version !== contract.dshVersion) throw new Error('Install the pinned DSH version before starting the runtime');
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true, mode: 0o700 });
  const runtime = await manager.connectOrStart(runtimeFile, { cwd, explicit: located.entry,
    durable: true, bridgeVersion: contract.bridgeVersion, attachOnly });
  return { started: !runtime.attached, attached: runtime.attached, updatePending: Boolean(runtime.updatePending),
    recovered: Boolean(runtime.recovered), runtimeFile, dshVersion: runtime.version, instanceId: runtime.instanceId };
}
