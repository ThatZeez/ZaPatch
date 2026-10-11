import fs from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from './version.js';
import { downloadFile } from './download.js';
import { selfUpdateFailed } from './errors.js';
import { resolveAssetSha256, zaPatchRelease } from './release.js';

// ZaPatch self-update: replaces only the ZaPatch executable itself.
// Windows cannot overwrite a running .exe but CAN rename it: verify
// download -> rename current to .old -> move new into place -> verify.
// The .old copy is removed on the next successful start. Never automatic;
// only via the menu / `update` command.

export function normalizeTag(tag) {
  return String(tag || '').trim().replace(/^v/i, '');
}

export function isNewer(latest, current) {
  const l = normalizeTag(latest);
  const c = normalizeTag(current);
  if (!l || !c) return l !== c;
  return compareVersions(l, c) > 0;
}

export async function checkSelfUpdate({ timeout } = {}) {
  const { release, asset } = await zaPatchRelease({ timeout });
  return { release, asset, latest: normalizeTag(release.tag) };
}

export function updateNotice(current, latest) {
  if (!isNewer(latest, current)) return null;
  return `ZaPatch v${normalizeTag(latest)} is available — pick "Update ZaPatch" to update.`;
}

export async function applySelfUpdate({
  exePath,
  asset,
  release,
  onProgress = null,
  signal = null,
} = {}) {
  const target = exePath || process.execPath;
  if (!target.toLowerCase().endsWith('.exe')) {
    throw selfUpdateFailed(
      `refusing to self-update a non-exe runtime (${path.basename(target)}). Run the built ZaPatch.exe instead.`,
    );
  }
  signal?.throwIfInterrupted?.('self-update');

  const { sha256 } = await resolveAssetSha256(release, asset);
  const dir = path.dirname(target);
  const tmpPath = path.join(dir, 'ZaPatch.update.download');
  const newPath = path.join(dir, 'ZaPatch.new.exe');
  const oldPath = path.join(dir, 'ZaPatch.old.exe');

  await fs.rm(tmpPath, { force: true }).catch(() => {});
  await fs.rm(newPath, { force: true }).catch(() => {});

  await downloadFile(asset.url, tmpPath, { expectedSha256: sha256, onProgress, signal });
  signal?.throwIfInterrupted?.('self-update');
  await fs.rename(tmpPath, newPath);

  try {
    await fs.rm(oldPath, { force: true }).catch(() => {});
    await fs.rename(target, oldPath);
  } catch (e) {
    await fs.rm(newPath, { force: true }).catch(() => {});
    throw selfUpdateFailed(`cannot stage current executable: ${e.message}`);
  }
  try {
    await fs.rename(newPath, target);
  } catch (e) {
    await fs.rename(oldPath, target).catch(() => {});
    await fs.rm(newPath, { force: true }).catch(() => {});
    throw selfUpdateFailed(`cannot install new executable: ${e.message}`);
  }
  const st = await fs.stat(target).catch(() => null);
  if (!st || !st.isFile()) {
    await fs.rename(oldPath, target).catch(() => {});
    throw selfUpdateFailed('new executable missing after swap');
  }
  return { exePath: target, backupExe: oldPath, version: normalizeTag(release.tag) };
}

export async function cleanupStaleBackup(exePath) {
  const target = exePath || process.execPath;
  if (!target.toLowerCase().endsWith('.exe')) return false;
  const oldPath = path.join(path.dirname(target), 'ZaPatch.old.exe');
  const exists = await fs.stat(oldPath).then(() => true).catch(() => false);
  if (!exists) return false;
  await fs.rm(oldPath, { force: true }).catch(() => {});
  return true;
}
