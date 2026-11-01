import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { processIdentity } from '../core/process-identity.mjs';
import launch from '../runtime/launch-transaction.cjs';

// Read the runtime selected by the host's public profile contract. Never use a
// different checkout's version to label an already running desktop.
export function hostRuntimeInfo(profile) {
  if (!profile?.installAnchor || !path.isAbsolute(profile.installAnchor)) {
    throw new Error('Collab host discovery requires the active DSH profile context');
  }
  const require = createRequire(profile.installAnchor);
  const anchorPackage = JSON.parse(fs.readFileSync(profile.installAnchor, 'utf8'));
  const manifest = profile.resolvePackageManifest?.('@deepseek-ai/dsh')
    || (anchorPackage.name === '@deepseek-ai/dsh' ? profile.installAnchor : require.resolve('@deepseek-ai/dsh/package.json'));
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh' || typeof pkg.version !== 'string' || !pkg.bin?.dsh) {
    throw new Error('Cannot identify the host DSH package');
  }
  const entry = path.resolve(path.dirname(manifest), pkg.bin.dsh);
  if (!fs.existsSync(entry)) throw new Error('Host DSH entry is missing');
  return { entry, dshVersion: pkg.version,
    profile: { name: profile.name, directory: profile.dir, home: profile.home } };
}

export function registrationPath(config = {}, env = process.env) {
  const filename = config.runtimeFile ?? env.DSH_COLLAB_RUNTIME_FILE;
  if (filename === undefined || filename === '') return null;
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) {
    throw new Error('Collab runtimeFile must be an absolute local path');
  }
  return path.resolve(filename);
}

function checkedRecord(value) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(value.url || '')) throw Object.assign(new Error('Collab discovery requires a loopback runtime'), { code: 'DSH_HOST_ORIGIN_INVALID' });
  let auth;
  try { auth = new URL(value.launchUrl); } catch { throw Object.assign(new Error('Collab discovery authentication is missing'), { code: 'DSH_HOST_AUTH_MISSING' }); }
  if (auth.origin !== new URL(value.url).origin || !auth.searchParams.has('token') || auth.username || auth.password) {
    throw Object.assign(new Error('Collab discovery authentication must belong to this runtime'), { code: 'DSH_HOST_AUTH_INVALID' });
  }
  if (!Number.isSafeInteger(value.dshPid) || value.dshPid <= 0 || !value.processIdentity
      || !value.instanceId || !path.isAbsolute(value.collabStateDirectory || '') || !path.isAbsolute(value.entry || '')) {
    throw Object.assign(new Error('Collab discovery is missing process or storage identity'), { code: 'DSH_HOST_IDENTITY_INVALID' });
  }
}

// Reuse the startup publication lease: a desktop and the legacy launcher cannot
// replace each other's connection concurrently. This never starts a process.
export async function publishHostRuntime(filename, record, { identify = processIdentity, active = () => true } = {}) {
  checkedRecord(record);
  record = { ...record, url: new URL(record.url).href };
  return launch.withLaunchTransaction(filename, async transaction => {
    if (!active()) return false;
    const previous = launch.readJson(filename);
    if (previous) {
      const sameProcess = previous.dshPid === record.dshPid && previous.processIdentity === record.processIdentity;
      if (!sameProcess) {
        const state = identify(previous.dshPid, previous.processIdentity);
        const replaced = state.state === 'replaced' && previous.processIdentity
          || state.state === 'alive' && previous.processIdentity && state.identity && state.identity !== previous.processIdentity;
        if (state.state !== 'dead' && !replaced) {
          throw Object.assign(new Error('Another live or unverified DSH runtime owns this connection; no connection was replaced'),
            { code: 'DSH_HOST_CONNECTION_IN_USE' });
        }
      }
    }
    launch.writeJson(filename, record);
    transaction.reset({ phase: 'published', instanceId: record.instanceId, dshPid: record.dshPid,
      processIdentity: record.processIdentity, hostManaged: true });
    return true;
  });
}

export function mountHostDiscovery(ctx, config, runtime) {
  const filename = registrationPath(config);
  if (!filename) return { state: 'disabled' };
  const host = hostRuntimeInfo(ctx.get('profileContext'));
  const instanceId = randomUUID(), startedAt = Date.now();
  const status = { state: 'waiting', api: 1 };
  let active = true, pending = Promise.resolve();
  ctx.effect(() => {
    const publish = () => {
      pending = (async () => {
        const identity = processIdentity(process.pid);
        if (identity.state !== 'alive' || !identity.identity) throw new Error('Cannot verify the desktop host process identity');
        const record = { ...await runtime(), ...host, instanceId, startedAt, dshPid: process.pid,
          processIdentity: identity.identity, hostManaged: true, durable: false,
          source: 'DSH native plugin', hostRegistrationApi: 1 };
        if (await publishHostRuntime(filename, record, { active: () => active })) status.state = 'published';
      })().catch(error => {
        status.state = 'failed'; status.code = error.code || 'DSH_HOST_REGISTRATION_FAILED';
        // Do not log tokens, URLs with query strings, session contents or paths.
        ctx.logger.error(`Collab host connection registration failed (${status.code}); inspect the configured runtimeFile and active host.`);
      });
    };
    const cancel = ctx.get('appReady')?.onReady(publish);
    if (!ctx.get('appReady')) publish();
    return async () => { active = false; cancel?.(); await pending; };
  });
  return status;
}
