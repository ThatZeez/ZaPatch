import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPackage } from '../src/patcher/package.js';

async function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

test('legacy betterzalo-package.json still loads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-legacy-'));
  await writeFile(dir, 'payload/a.js', 'console.log(1);');
  await writeFile(
    dir,
    'betterzalo-package.json',
    JSON.stringify({
      name: 'betterzalo',
      version: '0.1.0',
      minZaloVersion: '26.0.0',
      files: [{ src: 'payload/a.js', dest: 'betterzalo/a.js' }],
    }),
  );
  const pkg = await loadPackage(dir);
  assert.equal(pkg.format, 'betterzalo-package.json');
  assert.equal(pkg.files[0].dest, 'betterzalo/a.js');
  await fs.rm(dir, { recursive: true, force: true });
});

test('manifest.json layout loads with default dests', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-new-'));
  await writeFile(dir, 'files/core.js', 'core');
  await writeFile(
    dir,
    'manifest.json',
    JSON.stringify({
      manifestVersion: 1,
      name: 'BetterZalo',
      version: '0.1.0',
      supportedZaloVersions: ['26.9.10'],
      files: [{ path: 'files/core.js', size: 4, sha256: '0c9a5b...placeholder' }],
    }),
  );
  // Fix the placeholder hash with the real one.
  const { sha256File } = await import('../src/patcher/package.js');
  const real = await sha256File(path.join(dir, 'files/core.js'));
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.files[0].sha256 = real;
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const pkg = await loadPackage(dir);
  assert.equal(pkg.format, 'manifest.json');
  assert.equal(pkg.files[0].dest, 'betterzalo/core.js');
  await fs.rm(dir, { recursive: true, force: true });
});

test('rejects sha256 mismatch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-badhash-'));
  await writeFile(dir, 'files/core.js', 'tampered');
  await writeFile(
    dir,
    'manifest.json',
    JSON.stringify({
      manifestVersion: 1,
      name: 'BetterZalo',
      version: '0.1.0',
      supportedZaloVersions: ['26.9.10'],
      files: [{ path: 'files/core.js', size: 8, sha256: '0'.repeat(64) }],
    }),
  );
  await assert.rejects(() => loadPackage(dir), /sha256 mismatch/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('rejects checksums.txt mismatch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-badsums-'));
  await writeFile(dir, 'files/core.js', 'core-content');
  const { sha256File } = await import('../src/patcher/package.js');
  const real = await sha256File(path.join(dir, 'files/core.js'));
  await writeFile(
    dir,
    'manifest.json',
    JSON.stringify({
      manifestVersion: 1,
      name: 'BetterZalo',
      version: '0.1.0',
      supportedZaloVersions: ['26.9.10'],
      files: [{ path: 'files/core.js', size: 12, sha256: real }],
    }),
  );
  await writeFile(dir, 'checksums.txt', `${'f'.repeat(64)}  files/core.js\n`);
  await assert.rejects(() => loadPackage(dir), /checksums\.txt mismatch/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('loadPackage rejects unsafe dest paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-'));
  await fs.writeFile(path.join(dir, 'a.js'), 'x');
  await fs.writeFile(
    path.join(dir, 'betterzalo-package.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', files: [{ src: 'a.js', dest: '../evil.js' }] }),
  );
  await assert.rejects(() => loadPackage(dir));
  await fs.rm(dir, { recursive: true, force: true });
});
