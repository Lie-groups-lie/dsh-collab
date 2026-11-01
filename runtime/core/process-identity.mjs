import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Used only at writer acquisition, never in a UI/status polling loop.
// "unknown" must fail closed; a successful PID existence check is not identity.
export function processIdentity(pid, expectedIdentity) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  try {
    if (process.platform === 'win32') {
      const expected = /^windows:\d+$/.test(expectedIdentity || '') ? expectedIdentity.slice(8) : null;
      const result = spawnSync(fileURLToPath(new URL('./process-identity.exe', import.meta.url)),
        [String(pid), ...(expected ? [expected] : [])], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096 });
      if (result.status !== 0 || result.error) return { state: 'unknown' };
      const value = JSON.parse(result.stdout);
      if (value.state === 'dead') return value;
      if (value.state === 'replaced' && expected) return { state: 'replaced' };
      if (value.state === 'alive' && /^windows:\d+$/.test(value.identity)) return value;
      return { state: 'unknown' };
    }
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm may contain spaces/parentheses. Fields after its final ')' start at 3.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (['Z', 'X'].includes(fields[0])) return { state: 'dead' };
      if (!/^\d+$/.test(fields[19])) return { state: 'unknown' };
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return { state: 'alive', identity: `linux:${boot}:${fields[19]}` };
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C' },
      });
      if (result.status === 0 && result.stdout.trim()) {
        return { state: 'alive', identity: `darwin:${result.stdout.trim()}` };
      }
    }
    // Unsupported/probe-failed systems may confirm death, never claim ownership.
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH' || process.platform === 'linux' && error.code === 'ENOENT') return { state: 'dead' };
  }
  return { state: 'unknown' };
}
