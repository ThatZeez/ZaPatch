import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPackage } from '../src/patcher/package.js';

test('loadPackage accepts example-package', async () => {
  const dir = fileURLToPath(new URL('../example-package', import.meta.url));
  const pkg = await loadPackage(dir);
  assert.equal(pkg.name, 'betterzalo');
  assert.equal(pkg.files.length, 2);
  assert.ok(pkg.files[0].sha256.length === 64);
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
