import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBackup, listBackups } from '../src/patcher/backup.js';
import { loadPackage, sha256File } from '../src/patcher/package.js';
import { applyPatch } from '../src/patcher/patch.js';
import { restoreFromBackup } from '../src/patcher/restore.js';
import { getStatus } from '../src/patcher/status.js';
import { verifyAgainstReceipt } from '../src/patcher/verification.js';

async function makeFakeInstall() {
  const installDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zaloinstall-'));
  const versionDir = path.join(installDir, 'Zalo-26.9.10');
  await fs.mkdir(path.join(versionDir, 'resources'), { recursive: true });
  await fs.writeFile(path.join(versionDir, 'Zalo.exe'), 'exe');
  await fs.writeFile(path.join(versionDir, 'resources', 'app.asar'), 'asar');
  return { installDir, versionDir };
}

// Builds a manifest.json-format package in a temp dir (hermetic fixture).
async function makeFixturePackage() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bzpkg-'));
  const core = path.join(dir, 'files', 'betterzalo-core.js');
  await fs.mkdir(path.dirname(core), { recursive: true });
  await fs.writeFile(core, 'fixture-core');
  const hash = await sha256File(core);
  const st = await fs.stat(core);
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      manifestVersion: 1,
      name: 'BetterZalo',
      version: '9.9.9',
      supportedZaloVersions: ['26.9.10'],
      files: [{ path: 'files/betterzalo-core.js', size: st.size, sha256: hash }],
    }),
  );
  return loadPackage(dir).then((pkg) => ({ pkg, dir }));
}

test('patch -> verify -> status -> restore roundtrip', async () => {
  const { installDir, versionDir } = await makeFakeInstall();
  // Pre-existing file that the patch will overwrite (backup path).
  await fs.mkdir(path.join(versionDir, 'betterzalo'), { recursive: true });
  await fs.writeFile(path.join(versionDir, 'betterzalo', 'betterzalo-core.js'), 'original');

  const { pkg, dir: pkgDir } = await makeFixturePackage();
  const { receipt, backup } = await applyPatch({ versionDir, zaloVersion: '26.9.10', pkg, onStep: () => {} });

  assert.equal(receipt.files.length, 1);
  assert.equal(receipt.files[0].dest, 'betterzalo/betterzalo-core.js');
  assert.ok((await listBackups(installDir)).length === 1);
  assert.equal(backup.manifest.zaloVersion, '26.9.10');

  const v = await verifyAgainstReceipt({ versionDir });
  assert.equal(v.ok, true);

  const status = await getStatus({ installDir, versionDir });
  assert.equal(status.betterZalo, 'Installed');
  assert.equal(status.patchStatus, 'Valid');

  const result = await restoreFromBackup({ versionDir, backup });
  assert.ok(result.restored.includes('betterzalo/betterzalo-core.js'));
  assert.equal(await fs.readFile(path.join(versionDir, 'betterzalo', 'betterzalo-core.js'), 'utf8'), 'original');
  await fs.rm(installDir, { recursive: true, force: true });
  await fs.rm(pkgDir, { recursive: true, force: true });
});

test('restore prunes empty BetterZalo dirs left by added files', async () => {
  const { installDir, versionDir } = await makeFakeInstall();
  const { pkg, dir: pkgDir } = await makeFixturePackage();
  const { backup } = await applyPatch({ versionDir, zaloVersion: '26.9.10', pkg, onStep: () => {} });
  // Added-only files vanish on restore, so the now-empty dir goes too.
  await restoreFromBackup({ versionDir, backup });
  assert.equal(await fs.stat(path.join(versionDir, 'betterzalo')).then(() => true).catch(() => false), false);
  await fs.rm(installDir, { recursive: true, force: true });
  await fs.rm(pkgDir, { recursive: true, force: true });
});

test('createBackup records added files without content', async () => {
  const { installDir, versionDir } = await makeFakeInstall();
  const { manifest } = await createBackup({
    installDir,
    versionDir,
    zaloVersion: '26.9.10',
    plan: [{ destAbs: path.join(versionDir, 'new-file.txt'), destRel: 'new-file.txt' }],
  });
  assert.equal(manifest.entries[0].existed, false);
  await fs.rm(installDir, { recursive: true, force: true });
});
