// Compare known release formats only: DSH semver or the bridge's date.revision.
// Unknown formats must not guess which process is stale.
export function compareContractVersions(actual, expected, component) {
  const pattern = component === 'bridgeVersion' ? /^(\d+\.\d+\.\d+\.\d+)$/
    : /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  const left = typeof actual === 'string' && pattern.exec(actual);
  const right = typeof expected === 'string' && pattern.exec(expected);
  if (!left || !right) return null;
  const a = left[1].split('.').map(BigInt), b = right[1].split('.').map(BigInt);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  if (left[2] === right[2]) return 0;
  if (!left[2]) return 1;
  if (!right[2]) return -1;
  const preA = left[2].split('.'), preB = right[2].split('.');
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    if (preA[i] === preB[i]) continue;
    if (preA[i] === undefined) return -1;
    if (preB[i] === undefined) return 1;
    const numericA = /^\d+$/.test(preA[i]), numericB = /^\d+$/.test(preB[i]);
    if (numericA !== numericB) return numericA ? -1 : 1;
    if (numericA) { if (BigInt(preA[i]) === BigInt(preB[i])) continue; return BigInt(preA[i]) < BigInt(preB[i]) ? -1 : 1; }
    return preA[i] < preB[i] ? -1 : 1;
  }
  return 0;
}

export function runtimeCompatibility(runtime, expected) {
  const actual = { dshVersion: runtime.dshVersion || runtime.version || null, bridgeVersion: runtime.bridgeVersion || null };
  const issues = [];
  for (const component of ['dshVersion', 'bridgeVersion']) {
    if (actual[component] === expected[component]) continue;
    const order = compareContractVersions(actual[component], expected[component], component);
    const olderSide = order === -1 ? 'runtime' : order === 1 ? 'client' : 'unknown';
    issues.push({ component, actual: actual[component], expected: expected[component], olderSide,
      message: olderSide === 'runtime'
        ? `${component}: DSH runtime/native bridge is older (后台过旧). Update that runtime only after checking active tasks and authorizing a controlled restart; do not restart Codex for this mismatch.`
        : olderSide === 'client'
          ? `${component}: the connected Collab client/MCP expects an older contract (客户端兼容基线过旧). Update/refresh that plugin connection; restarting or downgrading the newer DSH runtime is not the remedy.`
          : `${component}: version is missing, unrecognized, or not orderable (无法判断哪端过旧). Verify the loaded client and runtime builds before changing either side.` });
  }
  if (!runtime.collabStateDirectory) issues.push({ component: 'collabStateDirectory', actual: null, expected: 'present', olderSide: 'unknown',
    message: 'Runtime discovery has no Collab state directory (后台连接记录缺少状态目录). Verify native bridge registration; this alone does not identify an older version.' });
  return { compatible: issues.length === 0, actual, expected: { dshVersion: expected.dshVersion, bridgeVersion: expected.bridgeVersion }, issues };
}

export function requireCompatibleRuntime(runtime, expected) {
  const report = runtimeCompatibility(runtime, expected);
  if (report.compatible) return;
  const error = new Error(`Runtime contract mismatch:\n${report.issues.map(issue => `${issue.message} Actual=${issue.actual ?? 'missing'}; expected=${issue.expected}.`).join('\n')}\nNo task was submitted. Read-only diagnostics remain available.`);
  error.code = 'DSH_RUNTIME_CONTRACT_MISMATCH';
  error.details = report;
  throw error;
}
