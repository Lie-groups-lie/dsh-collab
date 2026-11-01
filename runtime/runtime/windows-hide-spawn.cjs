const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { promisify } = require('node:util');

if (process.platform === 'win32') {
  for (const name of ['spawn', 'spawnSync', 'fork', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function hidden(file, args, options) {
      return Array.isArray(args)
        ? original.call(this, file, args, { ...(options || {}), windowsHide: true })
        : original.call(this, file, { ...(args || {}), windowsHide: true });
    };
  }
  for (const name of ['exec', 'execFile']) {
    const original = childProcess[name];
    const wrapped = function hidden(...input) {
      const command = input.shift();
      const args = name === 'execFile' && Array.isArray(input[0]) ? input.shift() : undefined;
      const options = input[0] && typeof input[0] === 'object' ? input.shift() : {};
      const callback = typeof input[0] === 'function' ? input[0] : undefined;
      return name === 'execFile' ? original.call(this, command, args || [], { ...options, windowsHide: true }, callback)
        : original.call(this, command, { ...options, windowsHide: true }, callback);
    };
    wrapped[promisify.custom] = (...args) => {
      let child;
      const promise = new Promise((resolve, reject) => {
        child = wrapped(...args, (error, stdout, stderr) => {
          if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
          else resolve({ stdout, stderr });
        });
      });
      promise.child = child;
      return promise;
    };
    childProcess[name] = wrapped;
  }
  const originalExecSync = childProcess.execSync;
  childProcess.execSync = function hidden(command, options) { return originalExecSync.call(this, command, { ...(options || {}), windowsHide: true }); };
  syncBuiltinESMExports();
}

// NODE_OPTIONS has already been consumed by this process. Do not leak the
// process preload into commands subsequently launched by DSH tools.
if (process.env.DSH_COLLAB_ORIGINAL_NODE_OPTIONS) process.env.NODE_OPTIONS = process.env.DSH_COLLAB_ORIGINAL_NODE_OPTIONS;
else delete process.env.NODE_OPTIONS;
delete process.env.DSH_COLLAB_ORIGINAL_NODE_OPTIONS;
