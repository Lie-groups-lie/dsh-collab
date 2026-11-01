import fs from 'node:fs';
// Windows scanners/readers can briefly deny MoveFileEx replacement even after
// the writer has closed its handle. Keep the old committed file until an atomic
// replacement succeeds; never implement delete-then-rename or replay the work.
export function atomicReplaceSync(source, destination, { rename = fs.renameSync, platform = process.platform,
  wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const delays = [5, 10, 20, 40, 80];
  for (let attempt = 0; ; attempt++) {
    try { rename(source, destination); return; }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error;
      wait(delays[attempt]);
    }
  }
}
