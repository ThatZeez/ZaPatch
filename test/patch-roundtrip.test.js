import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBackup, listBackups } from '../src/patcher/backup.js';
import { loadPackage } from '../src/patcher/package.js';
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

function examplePackageDir() {
  return fileURLToPath(new URL('../example-package', import.meta.url));
}

test('patch -> verify -> status -> restore roundtrip', async () => {
  const { installDir, versionDir } = await makeFakeInstall();
  // Pre-existing file that the patch will overwrite (backup path).
  await fs.mkdir(path.join(versionDir, 'betterzalo'), { recursive: true });
  await fs.writeFile(path.join(versionDir, 'betterzalo', 'betterzalo-core.js'), 'original');

  const pkg = await loadPackage(examplePackageDir());
  const { receipt, backup } = await applyPatch({ versionDir, zaloVersion: '26.9.10', pkg, onStep: () => {} });

  assert.ok(receipt.files.length === 2);
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
