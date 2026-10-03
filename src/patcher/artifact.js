import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NEW_MANIFEST_NAME } from './constants.js';
import { packageInvalid } from './errors.js';
import { loadPackage } from './package.js';

// Turns a downloaded BetterZalo distribution archive into a loadable
// package directory. Expected shape (provisional until the first real
// BetterZalo release exists): a .zip whose root — or a single top-level
// folder — contains manifest.json + checksums.txt + files/.
//
// Extraction uses Windows-native tools only (tar.exe, then
// Expand-Archive): no new dependencies. Never executes anything from
// the archive; only manifest.json/checksums.txt/payload files are read.

function run(cmd, args, { env = null, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { env: env || process.env, timeout, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${(stderr || err.message).trim()}`));
        else resolve(true);
      },
    );
    child.on('error', (e) => reject(new Error(`${cmd} unavailable: ${e.message}`)));
  });
}

export async function extractZip(archivePath, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  try {
    await run('tar.exe', ['-xf', archivePath, '-C', destDir]);
    return { tool: 'tar.exe' };
  } catch (tarErr) {
    try {
      await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:BZ_ZIP -DestinationPath $env:BZ_DEST -Force'],
        { env: { ...process.env, BZ_ZIP: archivePath, BZ_DEST: destDir } },
      );
      return { tool: 'Expand-Archive' };
    } catch {
      throw packageInvalid(`cannot extract ${path.basename(archivePath)}: ${tarErr.message}`);
    }
  }
}

async function findPackageRoot(extractDir) {
  const isFile = (p) => fs.stat(p).then((s) => s.isFile()).catch(() => false);
  if (await isFile(path.join(extractDir, NEW_MANIFEST_NAME))) return extractDir;
  // Single-root-folder zips: look one level down.
  const entries = await fs.readdir(extractDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (await isFile(path.join(extractDir, e.name, NEW_MANIFEST_NAME))) {
      return path.join(extractDir, e.name);
    }
  }
  throw packageInvalid(`extracted archive has no ${NEW_MANIFEST_NAME} at its root`);
}

// Full pipeline: extract -> locate root -> loadPackage (which verifies
// sizes, per-file SHA-256, and checksums.txt when present).
export async function packageFromArchive(archivePath, { workParent = null } = {}) {
  if (!archivePath.toLowerCase().endsWith('.zip')) {
    throw packageInvalid(`unsupported artifact format (expected .zip): ${path.basename(archivePath)}`);
  }
  if (workParent) await fs.mkdir(workParent, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(workParent || os.tmpdir(), 'bz-artifact-'));
  await extractZip(archivePath, workDir);
  const root = await findPackageRoot(workDir);
  const pkg = await loadPackage(root);
  return { pkg, dir: root, workDir };
}

// Best-effort cleanup of extraction temp dirs. Never throws.
export async function cleanupWorkDir(workDir) {
  if (!workDir) return;
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}
