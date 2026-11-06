import path from 'node:path';
import os from 'node:os';

// Keep explicit selection exclusive: never silently connect to a different host.
export function runtimeCandidates(env = process.env, { platform = process.platform, home = os.homedir(), cwd = process.cwd() } = {}) {
  if (env.DSH_DESKTOP_RUNTIME_FILE) return [env.DSH_DESKTOP_RUNTIME_FILE];
  const p = platform === 'win32' ? path.win32 : path.posix;
  const config = env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(home, '.config');
  const standard = platform === 'win32'
    ? p.join(env.APPDATA || p.join(home, '.config'), 'DeepSeek Harness', 'runtime.json')
    : platform === 'darwin'
      ? p.join(home, 'Library', 'Application Support', 'DeepSeek Harness', 'runtime.json')
      : p.join(config, 'DeepSeek Harness', 'runtime.json');
  return [...new Set([standard,
    ...(platform === 'darwin' || platform === 'linux' ? [p.join(home, '.config', 'DeepSeek Harness', 'runtime.json')] : []),
    p.join(cwd, '.dsh-desktop', 'runtime.json')])];
}
