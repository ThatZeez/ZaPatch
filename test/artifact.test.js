import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupWorkDir, packageFromArchive } from '../src/patcher/artifact.js';
import { buildStoredZip } from './fixture-server.js';

function sha(b) {
  return crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
}

async function writeZip(dir, name, entries) {
  const abs = path.join(dir, name);
  await fs.writeFile(abs, buildStoredZip(entries));
  return abs;
}

function manifestFor(core) {
  return JSON.stringify({
    manifestVersion: 1,
    name: 'BetterZalo',
    version: '0.3.0',
    supportedZaloVersions: ['26.9.10'],
    files: [{ path: 'files/core.js', size: Buffer.byteLength(core), sha256: sha(core) }],
  });
}

test('extracts a root-level package and verifies it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'art-'));
  try {
    const core = 'artifact-core';
    const zip = await writeZip(dir, 'bz.zip', [
      { name: 'manifest.json', data: manifestFor(core) },
      { name: 'files/core.js', data: core },
    ]);
    const { pkg, workDir } = await packageFromArchive(zip, { workParent: dir });
    assert.equal(pkg.version, '0.3.0');
    assert.equal(pkg.files[0].dest, 'betterzalo/core.js');
    await cleanupWorkDir(workDir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('handles single-root-folder zips', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'art-'));
  try {
    const core = 'nested-core';
    const zip = await writeZip(dir, 'bz.zip', [
      { name: 'BetterZalo-0.3.0/manifest.json', data: manifestFor(core) },
      { name: 'BetterZalo-0.3.0/files/core.js', data: core },
    ]);
    const { pkg, workDir } = await packageFromArchive(zip, { workParent: dir });
    assert.equal(pkg.version, '0.3.0');
    await cleanupWorkDir(workDir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rejects non-zip artifacts and missing manifests', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'art-'));
  try {
    const notZip = path.join(dir, 'bz.tar.gz');
    await fs.writeFile(notZip, 'nope');
    await assert.rejects(() => packageFromArchive(notZip, { workParent: dir }), /expected \.zip/);
    const noManifest = await writeZip(dir, 'empty.zip', [{ name: 'readme.txt', data: 'hi' }]);
    await assert.rejects(() => packageFromArchive(noManifest, { workParent: dir }), /no manifest\.json/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
