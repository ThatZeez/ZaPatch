import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAsar, extractFile, patchAsar } from '../src/patcher/asar.js';
import { applyPatch, appAsarFor } from '../src/patcher/patch.js';
import { loadPackage, sha256File } from '../src/patcher/package.js';
import { repairInstallation } from '../src/patcher/repair.js';
import { listBackups } from '../src/patcher/backup.js';

async function makeFakeInstall() {
  const installDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zaloinstall-'));
  const versionDir = path.join(installDir, 'Zalo-26.9.10');
  await fs.mkdir(path.join(versionDir, 'resources'), { recursive: true });
  await fs.writeFile(path.join(versionDir, 'Zalo.exe'), 'exe');
  await createAsar(path.join(versionDir, 'resources', 'app.asar'), {
    'package.json': JSON.stringify({ name: 'Zalo', main: 'bootstrap.js' }),
    'pc-dist/index.html': '<html><body><script src="render.js"></script></body></html>',
    'pc-dist/render.js': 'console.log("app");',
  });
  return { installDir, versionDir };
}

async function makePkg() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bzpkg-'));
  const mk = async (rel, content) => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    return { rel, hash: await sha256File(abs), size: (await fs.stat(abs)).size };
  };
  const a = await mk('files/a.js', 'aaa');
  const b = await mk('files/b.js', 'bbb');
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      manifestVersion: 1,
      name: 'BetterZalo',
      version: '1.0.0',
      supportedZaloVersions: ['26.9.10'],
      files: [
        { path: a.rel, size: a.size, sha256: a.hash },
        { path: b.rel, size: b.size, sha256: b.hash },
      ],
    }),
  );
  return { pkg: await loadPackage(dir), dir };
}

async function installFixture() {
  const { installDir, versionDir } = await makeFakeInstall();
  const { pkg, dir: pkgDir } = await makePkg();
  const installed = await applyPatch({ versionDir, zaloVersion: '26.9.10', pkg, onStep: () => {} });
  return { installDir, versionDir, pkg, pkgDir, backupId: installed.backup.id };
}

test('repair fixes only broken asar entries and keeps the backup', async () => {
  const f = await installFixture();
  try {
    // Corrupt one blob inside the asar, leave everything else intact.
    const asarPath = appAsarFor(f.versionDir);
    await patchAsar({ asarPath, addFiles: [{ asarPath: 'pc-dist/betterzalo/a.js', data: 'corrupted' }] });
    const result = await repairInstallation({
      versionDir: f.versionDir,
      installDir: f.installDir,
      zaloVersion: '26.9.10',
      pkg: f.pkg,
      onStep: () => {},
    });
    assert.equal(result.status, 'repaired');
    assert.deepEqual(result.repaired, ['pc-dist/betterzalo/a.js']);
    assert.equal(result.backupId, f.backupId);
    assert.equal((await listBackups(f.installDir)).length, 1);
    assert.equal((await extractFile(asarPath, 'pc-dist/betterzalo/a.js')).toString(), 'aaa');
    assert.equal((await extractFile(asarPath, 'pc-dist/betterzalo/b.js')).toString(), 'bbb');
    assert.equal((await extractFile(asarPath, 'pc-dist/render.js')).toString(), 'console.log("app");');
  } finally {
    await fs.rm(f.installDir, { recursive: true, force: true });
    await fs.rm(f.pkgDir, { recursive: true, force: true });
  }
});

test('repair reports healthy when nothing is broken', async () => {
  const f = await installFixture();
  try {
    const result = await repairInstallation({
      versionDir: f.versionDir,
      installDir: f.installDir,
      zaloVersion: '26.9.10',
      pkg: f.pkg,
      onStep: () => {},
    });
    assert.equal(result.status, 'healthy');
    assert.deepEqual(result.repaired, []);
  } finally {
    await fs.rm(f.installDir, { recursive: true, force: true });
    await fs.rm(f.pkgDir, { recursive: true, force: true });
  }
});

test('repair refuses when nothing is installed', async () => {
  const { installDir, versionDir } = await makeFakeInstall();
  const { pkg, dir: pkgDir } = await makePkg();
  try {
    await assert.rejects(
      () => repairInstallation({ versionDir, installDir, zaloVersion: '26.9.10', pkg, onStep: () => {} }),
      /not installed/,
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
    await fs.rm(pkgDir, { recursive: true, force: true });
  }
});
