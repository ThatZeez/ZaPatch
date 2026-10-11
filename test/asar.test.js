import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAsar, extractFile, hookTagFor, insertHook, listFiles, patchAsar, readHeader, verifyPatchedAsar } from '../src/patcher/asar.js';

async function fixtureAsar(dir) {
  const asarPath = path.join(dir, 'app.asar');
  await createAsar(asarPath, {
    'package.json': JSON.stringify({ name: 'Zalo', main: 'bootstrap.js' }),
    'pc-dist/index.html': '<html><body><script src="render.js"></script></body></html>',
    'pc-dist/render.js': 'console.log("app");',
    'main-dist/main.js': 'console.log("main");',
  });
  return asarPath;
}

test('create + read + extract roundtrip', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asar-'));
  try {
    const asarPath = await fixtureAsar(dir);
    const { header } = await readHeader(asarPath);
    assert.ok(listFiles(header).includes('pc-dist/index.html'));
    const html = await extractFile(asarPath, 'pc-dist/index.html');
    assert.ok(html.toString('utf8').includes('render.js'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Strict reader emulating Chromium/node-asar Pickle semantics: the first
// 8 bytes are an outer pickle holding the inner total, the next bytes an
// inner pickle holding the JSON size + string, and the data base is
// 8 + inner total. Anything else and Electron cannot open the archive.
async function strictReadHeader(asarPath) {
  const fh = await fs.open(asarPath, 'r');
  try {
    const pre = Buffer.alloc(16);
    await fh.read(pre, 0, 16, 0);
    const outerSize = pre.readUInt32LE(0);
    if (outerSize !== 4) throw new Error(`outer pickle size must be 4, got ${outerSize}`);
    const innerTotal = pre.readUInt32LE(4);
    const innerSize = pre.readUInt32LE(8);
    const jsonSize = pre.readUInt32LE(12);
    const pad = (4 - (jsonSize % 4)) % 4;
    assert.equal(innerSize, 4 + jsonSize + pad);
    assert.equal(innerTotal, 4 + innerSize);
    const jb = Buffer.alloc(jsonSize);
    await fh.read(jb, 0, jsonSize, 16);
    return { header: JSON.parse(jb.toString('utf8')), dataBase: 8 + innerTotal };
  } finally {
    await fh.close().catch(() => {});
  }
}

async function strictExtract(asarPath, rel) {
  const { header, dataBase } = await strictReadHeader(asarPath);
  const parts = rel.split('/');
  let node = header;
  for (const p of parts) node = node.files ? node.files[p] : undefined;
  assert.ok(node && !node.files, `missing: ${rel}`);
  const fh = await fs.open(asarPath, 'r');
  try {
    const buf = Buffer.alloc(node.size);
    await fh.read(buf, 0, node.size, dataBase + parseInt(node.offset, 10));
    return buf;
  } finally {
    await fh.close().catch(() => {});
  }
}

test('writer emits canonical nested-pickle prelude', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asar-'));
  try {
    const asarPath = await fixtureAsar(dir);
    await strictReadHeader(asarPath);
    assert.equal((await strictExtract(asarPath, 'pc-dist/render.js')).toString(), 'console.log("app");');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('patched asar stays strictly readable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asar-'));
  try {
    const asarPath = await fixtureAsar(dir);
    await patchAsar({
      asarPath,
      addFiles: [{ asarPath: 'pc-dist/betterzalo/betterzalo-core.js', data: '/* bz */' }],
      hookJs: 'pc-dist/betterzalo/betterzalo-core.js',
    });
    assert.equal((await strictExtract(asarPath, 'pc-dist/render.js')).toString(), 'console.log("app");');
    assert.equal((await strictExtract(asarPath, 'pc-dist/betterzalo/betterzalo-core.js')).toString(), '/* bz */');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('patch adds blobs, hooks index.html, preserves old bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asar-'));
  try {
    const asarPath = await fixtureAsar(dir);
    const before = (await extractFile(asarPath, 'main-dist/main.js')).toString();
    const out = await patchAsar({
      asarPath,
      addFiles: [{ asarPath: 'pc-dist/betterzalo/betterzalo-core.js', data: '/* bz */' }],
      hookJs: 'pc-dist/betterzalo/betterzalo-core.js',
    });
    assert.equal(out.hookInserted, true);
    assert.equal((await extractFile(asarPath, 'main-dist/main.js')).toString(), before);
    const html = (await extractFile(asarPath, 'pc-dist/index.html')).toString();
    assert.ok(html.includes('<!-- BetterZalo -->'));
    assert.ok(html.includes('<script src="betterzalo/betterzalo-core.js"></script>'));
    assert.equal((await extractFile(asarPath, 'pc-dist/betterzalo/betterzalo-core.js')).toString(), '/* bz */');
    // Idempotent: second patch does not duplicate the hook.
    const again = await patchAsar({
      asarPath,
      addFiles: [{ asarPath: 'pc-dist/betterzalo/betterzalo-core.js', data: '/* bz */' }],
      hookJs: 'pc-dist/betterzalo/betterzalo-core.js',
    });
    assert.equal(again.hookInserted, false);
    const html2 = (await extractFile(asarPath, 'pc-dist/index.html')).toString();
    assert.equal(html2.match(/BetterZalo/g).length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('verifyPatchedAsar checks files and hook', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asar-'));
  try {
    const asarPath = await fixtureAsar(dir);
    await patchAsar({
      asarPath,
      addFiles: [{ asarPath: 'pc-dist/betterzalo/betterzalo-core.js', data: '/* bz */' }],
      hookJs: 'pc-dist/betterzalo/betterzalo-core.js',
    });
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update('/* bz */').digest('hex');
    const v = await verifyPatchedAsar(asarPath, {
      expectFiles: [{ asarPath: 'pc-dist/betterzalo/betterzalo-core.js', sha256: hash, size: 8 }],
    });
    assert.equal(v.ok, true);
    assert.equal(v.hookOk, true);
    const bad = await verifyPatchedAsar(asarPath, {
      expectFiles: [{ asarPath: 'pc-dist/betterzalo/missing.js', size: 1 }],
    });
    assert.equal(bad.ok, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('hookTagFor and insertHook units', () => {
  assert.equal(hookTagFor('pc-dist/betterzalo/x.js'), '<!-- BetterZalo --><script src="betterzalo/x.js"></script>');
  const once = insertHook('<body></body>', hookTagFor('pc-dist/betterzalo/x.js'));
  assert.equal(once.inserted, true);
  assert.equal(insertHook(once.html, hookTagFor('pc-dist/betterzalo/x.js')).inserted, false);
});
