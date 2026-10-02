import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultInstallCandidates } from './constants.js';
import { invalidInstall } from './errors.js';
import { compareVersions } from './version.js';

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function versionFromDirName(name) {
  const m = /^Zalo-(\d+\.\d+\.\d+(?:\.\d+)?)$/.exec(name);
  return m ? m[1] : null;
}

// A valid Zalo PC install is the Squirrel-style root: it contains either a
// launcher Zalo.exe or at least one versioned Zalo-x.y.z dir that itself
// contains Zalo.exe + resources/app.asar.
export async function inspectInstallDir(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return { valid: false, reason: 'directory is not readable' };

  const names = new Set(entries.map((e) => e.name));
  const versionDirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const v = versionFromDirName(e.name);
    if (!v) continue;
    const vDir = path.join(dir, e.name);
    const exe = path.join(vDir, 'Zalo.exe');
    const asar = path.join(vDir, 'resources', 'app.asar');
    if ((await exists(exe)) && (await exists(asar))) {
      versionDirs.push({ name: e.name, version: v, dir: vDir });
    }
  }

  const hasLauncher = names.has('Zalo.exe');
  if (versionDirs.length === 0 && !hasLauncher) {
    return {
      valid: false,
      reason: 'expected Zalo.exe or versioned Zalo-x.y.z folders with Zalo.exe + resources/app.asar',
    };
  }
  if (versionDirs.length === 0) {
    return { valid: false, reason: 'no versioned Zalo-x.y.z folder with Zalo.exe + resources/app.asar found' };
  }
  return { valid: true, versionDirs };
}

export function pickActiveVersionDir(versionDirs) {
  const sorted = [...versionDirs].sort((a, b) => compareVersions(a.version, b.version));
  return sorted[sorted.length - 1];
}

export async function validateAndResolve(dir) {
  const abs = path.resolve(dir);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw invalidInstall(dir, 'path does not exist or is not a directory');
  }
  const inspected = await inspectInstallDir(abs);
  if (!inspected.valid) throw invalidInstall(abs, inspected.reason);
  const active = pickActiveVersionDir(inspected.versionDirs);
  return {
    installDir: abs,
    versionDir: active.dir,
    versionFromFolder: active.version,
    launcherExe: path.join(abs, 'Zalo.exe'),
    appAsar: path.join(active.dir, 'resources', 'app.asar'),
    allVersions: inspected.versionDirs.map((v) => v.version),
  };
}

export async function findDefaultInstall(candidates = defaultInstallCandidates()) {
  const checked = [];
  for (const c of candidates) {
    checked.push(c);
    const stat = await fs.stat(c).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    const inspected = await inspectInstallDir(c).catch(() => null);
    if (inspected && inspected.valid) {
      const active = pickActiveVersionDir(inspected.versionDirs);
      return {
        installDir: path.resolve(c),
        versionDir: active.dir,
        versionFromFolder: active.version,
        launcherExe: path.join(path.resolve(c), 'Zalo.exe'),
        appAsar: path.join(active.dir, 'resources', 'app.asar'),
        allVersions: inspected.versionDirs.map((v) => v.version),
      };
    }
  }
  return { checked };
}
