import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { PACKAGE_MANIFEST_NAME } from './constants.js';
import { packageInvalid } from './errors.js';
import { parseVersion } from './version.js';

// BetterZalo package interface (v1, directory-based).
// A package is a directory containing betterzalo-package.json:
//
//   {
//     "name": "betterzalo",
//     "version": "0.1.0",
//     "minZaloVersion": "26.0.0",
//     "maxZaloVersion": "26.99.99",
//     "files": [{ "src": "payload/betterzalo-core.js",
//                 "dest": "betterzalo/betterzalo-core.js" }]
//   }
//
// `src` is relative to the package dir, `dest` is relative to the Zalo
// version dir. The patcher never needs BetterZalo internals: it copies
// declared files, records sha256 hashes, and verifies them later.
// Future transports (zip, signed feed) can reuse this manifest shape.

export function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = createReadStream(absPath);
    rs.on('error', reject);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

export async function loadPackage(packageDir) {
  const abs = path.resolve(packageDir);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw packageInvalid(`package directory not found: ${packageDir}`);
  }
  const manifestPath = path.join(abs, PACKAGE_MANIFEST_NAME);
  const raw = await fs.readFile(manifestPath, 'utf8').catch(() => null);
  if (!raw) throw packageInvalid(`manifest not found: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw packageInvalid(`manifest is not valid JSON: ${e.message}`);
  }
  validateManifestShape(manifest);

  const files = [];
  for (const f of manifest.files) {
    const srcAbs = path.join(abs, f.src);
    const st = await fs.stat(srcAbs).catch(() => null);
    if (!st || !st.isFile()) throw packageInvalid(`package file missing: ${f.src}`);
    files.push({
      src: f.src,
      dest: f.dest,
      srcAbs,
      sha256: await sha256File(srcAbs),
      size: st.size,
    });
  }
  return {
    dir: abs,
    name: manifest.name,
    version: manifest.version,
    minZaloVersion: manifest.minZaloVersion || null,
    maxZaloVersion: manifest.maxZaloVersion || null,
    files,
  };
}

export function validateManifestShape(m) {
  if (!m || typeof m !== 'object') throw packageInvalid('manifest must be an object');
  if (typeof m.name !== 'string' || !m.name.trim()) throw packageInvalid('"name" must be a non-empty string');
  if (typeof m.version !== 'string' || !m.version.trim()) throw packageInvalid('"version" must be a non-empty string');
  for (const k of ['minZaloVersion', 'maxZaloVersion']) {
    if (m[k] !== undefined && m[k] !== null && !parseVersion(String(m[k]))) {
      throw packageInvalid(`"${k}" is not a version: ${m[k]}`);
    }
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    throw packageInvalid('"files" must be a non-empty array');
  }
  const seen = new Set();
  for (const f of m.files) {
    if (!f || typeof f.src !== 'string' || !f.src.trim()) throw packageInvalid('each file needs a "src" path');
    if (typeof f.dest !== 'string' || !f.dest.trim()) throw packageInvalid('each file needs a "dest" path');
    const norm = path.posix.normalize(f.dest.replaceAll('\\', '/'));
    if (norm.startsWith('..') || path.win32.isAbsolute(f.dest) || norm.startsWith('/')) {
      throw packageInvalid(`unsafe "dest" path (must stay inside version dir): ${f.dest}`);
    }
    if (seen.has(norm)) throw packageInvalid(`duplicate "dest" path: ${f.dest}`);
    seen.add(norm);
  }
}
