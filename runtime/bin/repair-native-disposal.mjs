#!/usr/bin/env node
// Explicit, version/hash-gated repair for two DSH 0.2.1-rc.2 consumers of
// Cordis' single-shot disposer. Never executed on plugin load. Stop the target
// Host normally, after quiescence checks, before applying; no task data is read.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const fixes = [
  { name: '@deepseek-ai/dsh-file-reference-local', version: '0.2.1-rc.2',
    sha256: '99988e1858e227391386ec8579a2991e8be0104a9c9ea6b0b2baeb13cb3b89e6',
    before: 'const task = fiber.dispose().catch((error) => {',
    after: 'const task = Promise.resolve(fiber.dispose()).catch((error) => {' },
  { name: '@deepseek-ai/dsh-tool-subagent', version: '0.2.1-rc.2',
    sha256: 'de7b10aaf52b1b1616d13a831a9ece1f820b8a6302fe94667f31b6d641b2f46e',
    before: '\t\tfiber.dispose().catch((error) => {',
    after: '\t\tPromise.resolve(fiber.dispose()).catch((error) => {' },
];
export const hash = data => createHash('sha256').update(data).digest('hex');

export function planRepair(moduleRoot) {
  const root = fs.realpathSync(moduleRoot);
  return fixes.map(fix => {
    const folder = fs.realpathSync(path.join(root, fix.name));
    if (!folder.startsWith(root + path.sep)) throw new Error(`Package escapes module root: ${fix.name}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json')));
    if (manifest.name !== fix.name || manifest.version !== fix.version) throw new Error(`Unsupported package version: ${fix.name}`);
    const file = fs.realpathSync(path.join(folder, 'lib/index.js'));
    if (!file.startsWith(folder + path.sep)) throw new Error(`Module escapes package root: ${fix.name}`);
    const original = fs.readFileSync(file, 'utf8');
    let baseline = original, alreadyPatched = false;
    if (hash(original) !== fix.sha256) {
      baseline = original.replace(fix.after, fix.before);
      if (hash(baseline) !== fix.sha256) throw new Error(`Unrecognized module content: ${fix.name}`);
      alreadyPatched = true;
    }
    if (baseline.split(fix.before).length !== 2) throw new Error(`Ambiguous repair site: ${fix.name}`);
    const updated = baseline.replace(fix.before, fix.after);
    return { name: fix.name, version: fix.version, file, original, updated,
      beforeSha256: hash(original), afterSha256: hash(updated), alreadyPatched };
  });
}

function replace(file, content) {
  const temporary = `${file}.collab-${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, content, { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function repair(moduleRoot, { apply = false, backupDir } = {}) {
  const plan = planRepair(moduleRoot); // Validate BOTH modules before any write.
  if (apply && !backupDir) throw new Error('An explicit backup directory is required');
  const changed = [];
  if (apply && plan.some(item => !item.alreadyPatched)) {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const item of plan.filter(item => !item.alreadyPatched)) {
      const backup = path.join(backupDir, item.name.split('/')[1] + '.before.js');
      if (fs.existsSync(backup)) throw new Error('Backup already exists; use a new directory');
    }
    try {
      for (const item of plan.filter(item => !item.alreadyPatched)) {
        if (hash(fs.readFileSync(item.file)) !== item.beforeSha256) throw new Error('Module changed after preflight');
        fs.writeFileSync(path.join(backupDir, item.name.split('/')[1] + '.before.js'), item.original, { flag: 'wx' });
        replace(item.file, item.updated); changed.push(item);
        if (hash(fs.readFileSync(item.file)) !== item.afterSha256) throw new Error('Repair verification failed');
      }
    } catch (error) {
      for (const item of changed.reverse()) replace(item.file, item.original);
      throw error;
    }
  }
  const receipt = { repair: 'native-disposal-return-value-v1', applied: apply,
    requiresNormalHostRestart: apply && changed.length > 0, sessionDataModified: false,
    modules: plan.map(({ original, updated, ...item }) => item) };
  if (apply && changed.length) fs.writeFileSync(path.join(backupDir, 'repair.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const moduleRoot = args.shift();
  const apply = args.includes('--apply');
  const backup = args.find(a => a.startsWith('--backup='))?.slice(9);
  if (!moduleRoot || args.some(a => a !== '--apply' && !a.startsWith('--backup='))) {
    throw new Error('Usage: repair-native-disposal.mjs ABSOLUTE_NODE_MODULES [--apply --backup=ABSOLUTE_BACKUP_DIR]');
  }
  if (!path.isAbsolute(moduleRoot) || (backup && !path.isAbsolute(backup))) throw new Error('Absolute paths required');
  console.log(JSON.stringify(repair(moduleRoot, { apply, backupDir: backup }), null, 2));
}
