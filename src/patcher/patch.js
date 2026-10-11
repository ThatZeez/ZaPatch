import fs from 'node:fs/promises';
import path from 'node:path';
import { patchAsar, verifyPatchedAsar } from './asar.js';
import { createBackup } from './backup.js';
import { PATCHER_VERSION, receiptPathFor, stateDirFor } from './constants.js';
import { patchFailed, permissionDenied } from './errors.js';

// Full patch pipeline: verify files -> backup app.asar -> patch asar ->
// verify -> report. Rolls back from the verified backup on failure.
//
// Zalo's renderer lives entirely inside resources/app.asar, so loose
// files next to Zalo.exe are never loaded — installs there reported
// success while Zalo visibly never changed. Payload goes under pc-dist/
// with an index.html <script> hook (CSP 'self' allows same-archive scripts).

export function appAsarFor(versionDir) {
  return path.join(versionDir, 'resources', 'app.asar');
}

// Package `dest` paths resolve inside the asar under pc-dist/.
export function asarPathFor(dest) {
  return 'pc-dist/' + String(dest).replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

// Hook loads betterzalo-core.js when present, else the first .js file.
export function pickHookJs(pkg) {
  const core = pkg.files.find((f) => f.dest.replaceAll('\\', '/').split('/').pop() === 'betterzalo-core.js');
  const chosen = core || pkg.files.find((f) => f.dest.toLowerCase().endsWith('.js'));
  if (!chosen) throw patchFailed('package has no .js file to hook into index.html');
  return asarPathFor(chosen.dest);
}

export async function applyPatch({ versionDir, zaloVersion, pkg, channel = 'stable', onStep = () => {}, signal = null }) {
  const asarPath = appAsarFor(versionDir);
  const hookJs = pickHookJs(pkg);
  const plan = pkg.files.map((f) => ({ ...f, asarPath: asarPathFor(f.dest) }));

  onStep('Verifying required files', 'run');
  for (const item of plan) {
    const st = await fs.stat(item.srcAbs).catch(() => null);
    if (!st || !st.isFile()) {
      onStep('Verifying required files', 'fail');
      throw patchFailed(`package file missing: ${item.src}`);
    }
  }
  const asarStat = await fs.stat(asarPath).catch(() => null);
  if (!asarStat || !asarStat.isFile()) {
    onStep('Verifying required files', 'fail');
    throw patchFailed(`app.asar not found: ${asarPath}`);
  }
  try {
    await fs.access(asarPath, fs.constants.W_OK);
  } catch {
    throw permissionDenied(asarPath);
  }
  onStep('Verifying required files', 'ok');

  onStep('Creating backup', 'run');
  const backup = await createBackup({
    installDir: path.resolve(versionDir, '..'),
    versionDir,
    zaloVersion,
    plan: [{ destRel: path.relative(versionDir, asarPath).replaceAll('\\', '/'), destAbs: asarPath }],
  });
  onStep('Creating backup', 'ok');

  onStep('Applying BetterZalo', 'run');
  try {
    signal?.throwIfInterrupted?.('install');
    const blobs = [];
    for (const item of plan) {
      blobs.push({ asarPath: item.asarPath, data: await fs.readFile(item.srcAbs) });
    }
    await patchAsar({ asarPath, addFiles: blobs, hookJs, signal });
  } catch (e) {
    onStep('Applying BetterZalo', 'fail');
    await rollbackAsar({ versionDir, backup }).catch(() => {});
    if (e.code === 'INTERRUPTED') throw e;
    throw e.code === 'PATCH_FAILED' || e.code?.startsWith?.('PACKAGE') ? e : patchFailed(e.message);
  }
  onStep('Applying BetterZalo', 'ok');

  onStep('Verifying installation', 'run');
  const receipt = {
    patcherVersion: PATCHER_VERSION,
    packageName: pkg.name,
    packageVersion: pkg.version,
    channel,
    asar: true,
    hookJs,
    zaloVersion,
    appliedAt: new Date().toISOString(),
    backupId: backup.id,
    files: plan.map((p) => ({ dest: p.dest, asarPath: p.asarPath, sha256: p.sha256, size: p.size })),
  };
  await fs.mkdir(stateDirFor(versionDir), { recursive: true });
  await fs.writeFile(receiptPathFor(versionDir), JSON.stringify(receipt, null, 2), 'utf8');

  try {
    signal?.throwIfInterrupted?.('install');
    const v = await verifyPatchedAsar(asarPath, {
      expectFiles: plan.map((p) => ({ asarPath: p.asarPath, sha256: p.sha256, size: p.size })),
    });
    if (!v.ok) {
      const bad = v.checks.filter((c) => !c.ok).map((c) => `${c.file} (${c.reason})`).join(', ');
      throw patchFailed(`post-patch verification failed: ${bad || 'index.html hook missing'}`);
    }
  } catch (e) {
    onStep('Verifying installation', 'fail');
    await rollbackAsar({ versionDir, backup }).catch(() => {});
    throw e;
  }
  onStep('Verifying installation', 'ok');
  return { receipt, backup };
}

async function rollbackAsar({ versionDir, backup }) {
  const entry = backup.manifest.entries[0];
  if (entry && entry.existed) {
    await fs.copyFile(path.join(backup.dir, 'files', entry.path), path.join(versionDir, entry.path)).catch(() => {});
  }
  await fs.rm(receiptPathFor(versionDir), { force: true }).catch(() => {});
}
