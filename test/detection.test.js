import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectInstallDir, pickActiveVersionDir, validateAndResolve } from '../src/patcher/detection.js';

async function makeZaloRoot(versions = ['26.9.10']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zalo-'));
  for (const v of versions) {
    const dir = path.join(root, `Zalo-${v}`);
    await fs.mkdir(path.join(dir, 'resources'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Zalo.exe'), 'exe');
    await fs.writeFile(path.join(dir, 'resources', 'app.asar'), 'asar');
  }
  await fs.writeFile(path.join(root, 'Zalo.exe'), 'launcher');
  return root;
}

test('inspectInstallDir accepts versioned layout', async () => {
  const dir = await makeZaloRoot(['26.8.20', '26.9.10']);
  const res = await inspectInstallDir(dir);
  assert.equal(res.valid, true);
  assert.equal(res.versionDirs.length, 2);
  const active = pickActiveVersionDir(res.versionDirs);
  assert.equal(active.version, '26.9.10');
  await fs.rm(dir, { recursive: true, force: true });
});

test('inspectInstallDir rejects non-zalo dirs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-'));
  const res = await inspectInstallDir(dir);
  assert.equal(res.valid, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('validateAndResolve rejects files and missing dirs', async () => {
  await assert.rejects(() => validateAndResolve(path.join(os.tmpdir(), 'nope-bz-12345')));
});
