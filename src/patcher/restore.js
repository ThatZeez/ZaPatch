import fs from 'node:fs/promises';
import path from 'node:path';
import { findLatestBackup, hashFile, listBackups } from './backup.js';
import { receiptPathFor, stateDirFor } from './constants.js';
import { restoreFailed } from './errors.js';

// Restores original files from a verified backup and removes files the
// patch added. Backups are never deleted automatically.
export async function restoreFromBackup({ versionDir, backup }) {
  try {
    const { manifest, dir } = backup;
    const restored = [];
    const removed = [];
    for (const e of manifest.entries) {
      const target = path.join(versionDir, e.path);
      if (e.existed) {
        const src = path.join(dir, 'files', e.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(src, target);
        restored.push(e.path);
      } else {
        await fs.rm(target, { force: true });
        removed.push(e.path);
      }
    }
    // Verify restored content matches the backup manifest.
    for (const e of manifest.entries) {
      if (!e.existed) continue;
      const actual = await hashFile(path.join(versionDir, e.path)).catch(() => null);
      if (actual !== e.sha256) {
        throw new Error(`restored file mismatch: ${e.path}`);
      }
    }
    // Drop the patch receipt so status no longer reports "Installed".
    await fs.rm(receiptPathFor(versionDir), { force: true });
    // Remove the state dir if it is now empty (best effort).
    await fs.rmdir(stateDirFor(versionDir)).catch(() => {});
    return { restored, removed };
  } catch (e) {
    throw restoreFailed(e.message);
  }
}

export async function resolveBackup({ installDir, backupId = null, zaloVersion = null }) {
  if (backupId) {
    const all = await listBackups(installDir);
    const found = all.find((b) => b.id === backupId);
    if (!found) throw restoreFailed(`backup not found: ${backupId}`);
    return found;
  }
  const latest = await findLatestBackup(installDir, zaloVersion);
  if (!latest) throw restoreFailed('no backup available for this installation');
  return latest;
}
