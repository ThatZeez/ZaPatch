import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { unsupportedVersion, unsupportedVersionList } from './errors.js';

export function parseVersion(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    build: m[4] !== undefined ? Number(m[4]) : 0,
    raw: str.trim(),
  };
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  for (const k of ['major', 'minor', 'patch', 'build']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return 0;
}

export function satisfiesRange(version, min, max) {
  if (min && compareVersions(version, min) < 0) return false;
  if (max && compareVersions(version, max) > 0) return false;
  return true;
}

// Reads PE FileVersion via PowerShell. Windows-only by design; returns null
// when unavailable so callers can fall back to folder-name detection.
export function getExeVersion(exePath) {
  return new Promise((resolve) => {
    const ps = 'powershell.exe';
    const cmd = `(Get-Item -LiteralPath $env:BZ_EXE).VersionInfo.FileVersion`;
    const child = execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { env: { ...process.env, BZ_EXE: exePath }, timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const v = String(stdout || '').trim();
        resolve(parseVersion(v) ? v : null);
      },
    );
    child.on('error', () => resolve(null));
  });
}

function versionFromUpdateYml(text) {
  const m = /^version:\s*([0-9][0-9A-Za-z._-]*)/m.exec(text);
  return m && parseVersion(m[1]) ? m[1] : null;
}

// Order: exe metadata > folder name > app-update.yml. Returns { version, source }.
export async function detectZaloVersion(resolved) {
  const exeInVersionDir = path.join(resolved.versionDir, 'Zalo.exe');
  const exeVersion = await getExeVersion(exeInVersionDir);
  if (exeVersion) return { version: exeVersion, source: 'Zalo.exe FileVersion' };

  if (resolved.versionFromFolder) {
    return { version: resolved.versionFromFolder, source: 'folder name' };
  }

  const yml = await fs
    .readFile(path.join(resolved.versionDir, 'resources', 'app-update.yml'), 'utf8')
    .catch(() => null);
  if (yml) {
    const v = versionFromUpdateYml(yml);
    if (v) return { version: v, source: 'app-update.yml' };
  }
  return { version: null, source: 'unknown' };
}

export function checkCompatibility(zaloVersion, pkg) {
  if (!zaloVersion) {
    throw unsupportedVersion('unknown', pkg.minZaloVersion || null, pkg.maxZaloVersion || null);
  }
  // Explicit per-version list wins over the min/max range when present.
  if (Array.isArray(pkg.supportedZaloVersions) && pkg.supportedZaloVersions.length > 0) {
    const ok = pkg.supportedZaloVersions.some((entry) => versionMatchesEntry(zaloVersion, entry));
    if (!ok) {
      throw unsupportedVersionList(zaloVersion, pkg.supportedZaloVersions);
    }
    return true;
  }
  const min = pkg.minZaloVersion || null;
  const max = pkg.maxZaloVersion || null;
  if (!satisfiesRange(zaloVersion, min, max)) {
    throw unsupportedVersion(zaloVersion, min, max);
  }
  return true;
}

// Matches a live Zalo version against one supported-versions entry.
// Tolerates 4-part Windows FileVersions ("26.9.10.2959") against 3-part
// entries ("26.9.10") by comparing the leading parts.
export function versionMatchesEntry(live, entry) {
  if (live === entry) return true;
  if (typeof live === 'string' && typeof entry === 'string' && live.startsWith(entry + '.')) return true;
  const pl = parseVersion(live);
  const pe = parseVersion(entry);
  if (!pl || !pe) return false;
  return pl.major === pe.major && pl.minor === pe.minor && pl.patch === pe.patch;
}
