import fs from 'node:fs/promises';
import path from 'node:path';
import { createBackup } from './backup.js';
import { PATCHER_VERSION, receiptPathFor, stateDirFor } from './constants.js';
import { patchFailed, permissionDenied } from './errors.js';
import { hashFile } from './backup.js';

function toDestRel(dest) {
  return dest.replaceAll('\\', '/').replace(/^\.\//, '');
}

// Full patch pipeline from the spec:
// verify files -> backup -> apply -> verify -> report.
// Rolls back from the verified backup when the apply step fails.
export async function applyPatch({ versionDir, zaloVersion, pkg, onStep = () => {} }) {
  const plan = pkg.files.map((f) => ({
    ...f,
    destRel: toDestRel(f.dest),
    destAbs: path.join(versionDir, toDestRel(f.dest)),
  }));

  onStep('Verifying required files', 'run');
  for (const item of plan) {
    const st = await fs.stat(item.srcAbs).catch(() => null);
    if (!st || !st.isFile()) {
      onStep('Verifying required files', 'fail');
      throw patchFailed(`package file missing: ${item.src}`);
    }
  }
  try {
    await fs.access(versionDir, fs.constants.W_OK);
  } catch {
    throw permissionDenied(versionDir);
  }
  onStep('Verifying required files', 'ok');

  onStep('Creating backup', 'run');
  const backup = await createBackup({
    installDir: path.resolve(versionDir, '..'),
    versionDir,
    zaloVersion,
    plan,
  });
  onStep('Creating backup', 'ok');

  onStep('Applying BetterZalo', 'run');
  const applied = [];
  try {
    for (const item of plan) {
      await fs.mkdir(path.dirname(item.destAbs), { recursive: true });
      await fs.copyFile(item.srcAbs, item.destAbs);
      applied.push(item);
    }
  } catch (e) {
    onStep('Applying BetterZalo', 'fail');
    await rollbackPartial({ versionDir, backup, applied }).catch(() => {});
    throw patchFailed(e.message);
  }
  onStep('Applying BetterZalo', 'ok');

  onStep('Verifying installation', 'run');
  const receipt = {
    patcherVersion: PATCHER_VERSION,
    packageName: pkg.name,
    packageVersion: pkg.version,
    zaloVersion,
    appliedAt: new Date().toISOString(),
    backupId: backup.id,
    files: plan.map((p) => ({ dest: p.destRel, sha256: p.sha256, size: p.size })),
  };
  await fs.mkdir(stateDirFor(versionDir), { recursive: true });
  await fs.writeFile(receiptPathFor(versionDir), JSON.stringify(receipt, null, 2), 'utf8');

  for (const item of plan) {
    const actual = await hashFile(item.destAbs).catch(() => null);
    if (actual !== item.sha256) {
      onStep('Verifying installation', 'fail');
      await rollbackPartial({ versionDir, backup, applied }).catch(() => {});
      throw patchFailed(`post-copy hash mismatch: ${item.destRel}`);
    }
  }
  onStep('Verifying installation', 'ok');
  return { receipt, backup };
}

async function rollbackPartial({ versionDir, backup, applied }) {
  for (const item of applied) {
    const entry = backup.manifest.entries.find((e) => e.path === item.destRel);
    if (entry && entry.existed) {
      await fs.copyFile(path.join(backup.dir, 'files', entry.path), item.destAbs).catch(() => {});
    } else {
      await fs.rm(item.destAbs, { force: true }).catch(() => {});
    }
  }
  await fs.rm(receiptPathFor(versionDir), { force: true }).catch(() => {});
}
