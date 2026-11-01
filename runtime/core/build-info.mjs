import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Loaded once at process startup. Never label a running instance by looking at
// a mutable latest-release pointer, nor claim a dirty tree is a Git commit.
export function readBuildInfo(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { kind: 'source-checkout', verified: false }; throw error; }
  if (manifest.schema !== 1 || !manifest.files || !manifest.buildId) throw new Error('Invalid package build provenance');
  const mismatches = [];
  for (const [relative, expected] of Object.entries(manifest.files)) {
    if (!relative || relative.includes('..') || path.isAbsolute(relative) || relative.includes('\\')) throw new Error('Invalid build provenance path');
    let digest;
    try { digest = createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (digest !== expected) mismatches.push(relative);
  }
  return { kind: 'package', buildId: manifest.buildId, sourceDigest: manifest.sourceDigest,
    packageDigest: manifest.packageDigest, verified: mismatches.length === 0, mismatches };
}
