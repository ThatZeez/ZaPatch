import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { CHECKSUMS_NAME, NEW_MANIFEST_NAME, PACKAGE_MANIFEST_NAME } from './constants.js';
import { packageInvalid } from './errors.js';
import { parseVersion } from './version.js';

// BetterZalo package interface (directory-based). Supported layouts:
// manifest.json (v1, preferred) or legacy betterzalo-package.json.
// Example: { "manifestVersion": 1, "name": "BetterZalo", "version":
// "0.1.0", "supportedZaloVersions": ["26.9.10"], "files":
// [{ "path": "files/betterzalo-core.js", "size": 29948, "sha256": "<hex>" }] }
// Entry `path` is package-relative; install `dest` defaults to
// `betterzalo/<path-minus-leading-files-or-payload-prefix>`, and an
// adjacent checksums.txt is cross-checked when present. The patcher only
// copies declared files and verifies hashes — never BetterZalo internals.

export function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = createReadStream(absPath);
    rs.on('error', reject);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

async function readJson(absPath, what) {
  const raw = await fs.readFile(absPath, 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw packageInvalid(`${what} is not valid JSON: ${e.message}`);
  }
}

export async function loadPackage(packageDir) {
  const abs = path.resolve(packageDir);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw packageInvalid(`package directory not found: ${packageDir}`);
  }
  const modern = await readJson(path.join(abs, NEW_MANIFEST_NAME), NEW_MANIFEST_NAME);
  if (modern) return loadModernPackage(abs, modern);
  const legacy = await readJson(path.join(abs, PACKAGE_MANIFEST_NAME), PACKAGE_MANIFEST_NAME);
  if (legacy) return loadLegacyPackage(abs, legacy);
  throw packageInvalid(`no manifest found (looked for ${NEW_MANIFEST_NAME}, ${PACKAGE_MANIFEST_NAME}) in: ${abs}`);
}

function defaultDestFor(entryPath) {
  // Strip one leading "files/"/"payload/" segment so payloads land
  // namespaced under betterzalo/, away from Zalo's own files.
  const fwd = entryPath.replaceAll('\\', '/');
  const stripped = /^(files|payload)\//.test(fwd) ? fwd.replace(/^(files|payload)\//, '') : fwd;
  return `betterzalo/${stripped}`;
}

function assertSafeDest(dest) {
  const norm = path.posix.normalize(String(dest).replaceAll('\\', '/'));
  if (norm.startsWith('..') || path.win32.isAbsolute(String(dest)) || norm.startsWith('/')) {
    throw packageInvalid(`unsafe "dest" path (must stay inside version dir): ${dest}`);
  }
  return norm;
}

function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m) map.set(m[2].replaceAll('\\', '/'), m[1].toLowerCase());
  }
  return map;
}

async function loadModernPackage(abs, m) {
  if (!m || typeof m !== 'object') throw packageInvalid('manifest must be an object');
  if (m.manifestVersion !== 1) throw packageInvalid(`unsupported "manifestVersion": ${m.manifestVersion} (expected 1)`);
  if (typeof m.name !== 'string' || !m.name.trim()) throw packageInvalid('"name" must be a non-empty string');
  if (typeof m.version !== 'string' || !m.version.trim()) throw packageInvalid('"version" must be a non-empty string');
  let supportedZaloVersions = null;
  if (m.supportedZaloVersions !== undefined) {
    if (!Array.isArray(m.supportedZaloVersions) || m.supportedZaloVersions.length === 0) {
      throw packageInvalid('"supportedZaloVersions" must be a non-empty array when present');
    }
    for (const v of m.supportedZaloVersions) {
      if (typeof v !== 'string' || !parseVersion(v)) throw packageInvalid(`invalid Zalo version entry: ${v}`);
    }
    supportedZaloVersions = [...m.supportedZaloVersions];
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    throw packageInvalid('"files" must be a non-empty array');
  }

  const files = [];
  const seenDest = new Set();
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string' || !f.path.trim()) {
      throw packageInvalid('each file needs a "path" string');
    }
    const rel = f.path.replaceAll('\\', '/');
    if (rel.startsWith('..') || path.win32.isAbsolute(f.path) || rel.startsWith('/')) {
      throw packageInvalid(`unsafe "path" (must stay inside package dir): ${f.path}`);
    }
    const dest = assertSafeDest(typeof f.dest === 'string' && f.dest.trim() ? f.dest : defaultDestFor(rel));
    if (seenDest.has(dest)) throw packageInvalid(`duplicate install path: ${dest}`);
    seenDest.add(dest);

    const srcAbs = path.join(abs, rel);
    const st = await fs.stat(srcAbs).catch(() => null);
    if (!st || !st.isFile()) throw packageInvalid(`package file missing: ${f.path}`);
    if (typeof f.size === 'number' && st.size !== f.size) {
      throw packageInvalid(`size mismatch for ${f.path}: manifest says ${f.size}, actual ${st.size}`);
    }
    const actual = await sha256File(srcAbs);
    if (typeof f.sha256 === 'string' && f.sha256 && actual.toLowerCase() !== f.sha256.toLowerCase()) {
      throw packageInvalid(`sha256 mismatch for ${f.path}`);
    }
    files.push({ src: rel, dest, srcAbs, sha256: actual, size: st.size });
  }

  const sumsRaw = await fs.readFile(path.join(abs, CHECKSUMS_NAME), 'utf8').catch(() => null);
  if (sumsRaw !== null) {
    const sums = parseChecksums(sumsRaw);
    for (const f of files) {
      const expected = sums.get(f.src);
      if (!expected) throw packageInvalid(`${CHECKSUMS_NAME} has no entry for ${f.src}`);
      if (expected !== f.sha256.toLowerCase()) {
        throw packageInvalid(`${CHECKSUMS_NAME} mismatch for ${f.src}`);
      }
    }
  }

  return {
    dir: abs,
    format: 'manifest.json',
    name: m.name,
    version: m.version,
    minZaloVersion: m.minZaloVersion || null,
    maxZaloVersion: m.maxZaloVersion || null,
    supportedZaloVersions,
    files,
  };
}

export async function loadLegacyPackage(abs, manifest) {
  validateLegacyShape(manifest);
  const files = [];
  for (const f of manifest.files) {
    const srcAbs = path.join(abs, f.src);
    const st = await fs.stat(srcAbs).catch(() => null);
    if (!st || !st.isFile()) throw packageInvalid(`package file missing: ${f.src}`);
    files.push({
      src: f.src,
      dest: assertSafeDest(f.dest),
      srcAbs,
      sha256: await sha256File(srcAbs),
      size: st.size,
    });
  }
  return {
    dir: abs,
    format: PACKAGE_MANIFEST_NAME,
    name: manifest.name,
    version: manifest.version,
    minZaloVersion: manifest.minZaloVersion || null,
    maxZaloVersion: manifest.maxZaloVersion || null,
    supportedZaloVersions: Array.isArray(manifest.supportedZaloVersions)
      ? [...manifest.supportedZaloVersions]
      : null,
    files,
  };
}

export function validateLegacyShape(m) {
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
    const norm = assertSafeDest(f.dest);
    if (seen.has(norm)) throw packageInvalid(`duplicate "dest" path: ${f.dest}`);
    seen.add(norm);
  }
}
