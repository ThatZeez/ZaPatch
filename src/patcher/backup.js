import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKUP_MANIFEST_NAME, PATCHER_VERSION, backupsRootFor } from './constants.js';
import { backupFailed, Codes, PatcherError } from './errors.js';

export function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = createReadStream(absPath);
    rs.on('error', reject);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

function backupDirName(zaloVersion, date = new Date()) {
  const s = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${s(date.getMonth() + 1)}${s(date.getDate())}-${s(date.getHours())}${s(date.getMinutes())}${s(date.getSeconds())}`;
  const safe = String(zaloVersion).replace(/[^0-9A-Za-z._-]+/g, '_');
  return `${safe}_${stamp}`;
}

export async function createBackup({ installDir, versionDir, zaloVersion, plan }) {
  const root = backupsRootFor(installDir);
  const id = backupDirName(zaloVersion);
  const dir = path.join(root, id);
  try {
    await fs.mkdir(path.join(dir, 'files'), { recursive: true });
    const entries = [];
    for (const item of plan) {
      const st = await fs.stat(item.destAbs).catch(() => null);
      if (!st || !st.isFile()) {
        entries.push({ path: item.destRel, existed: false, sha256: null, size: 0 });
        continue;
      }
      const sha = await hashFile(item.destAbs);
      const backupFile = path.join(dir, 'files', item.destRel);
      await fs.mkdir(path.dirname(backupFile), { recursive: true });
      await fs.copyFile(item.destAbs, backupFile);
      entries.push({ path: item.destRel, existed: true, sha256: sha, size: st.size });
    }
    const manifest = {
      id,
      zaloVersion,
      createdAt: new Date().toISOString(),
      patcherVersion: PATCHER_VERSION,
      entries,
    };
    await fs.writeFile(path.join(dir, BACKUP_MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
    for (const e of entries) {
      if (!e.existed) continue;
      const actual = await hashFile(path.join(dir, 'files', e.path));
      if (actual !== e.sha256) {
        throw new Error(`backup verification mismatch for ${e.path}`);
      }
    }
    return { id, dir, manifest };
  } catch (e) {
    if (e instanceof PatcherError) throw e;
    throw backupFailed(e.message);
  }
}

export async function listBackups(installDir) {
  const root = backupsRootFor(installDir);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifestPath = path.join(root, e.name, BACKUP_MANIFEST_NAME);
    const raw = await fs.readFile(manifestPath, 'utf8').catch(() => null);
    if (!raw) continue;
    try {
      out.push({ id: e.name, dir: path.join(root, e.name), manifest: JSON.parse(raw) });
    } catch {
    }
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1));
  return out;
}

export async function findLatestBackup(installDir, zaloVersion = null) {
  const all = await listBackups(installDir);
  if (zaloVersion) {
    const match = all.filter((b) => b.manifest.zaloVersion === zaloVersion);
    if (match.length > 0) return match[0];
  }
  return all[0] || null;
}
