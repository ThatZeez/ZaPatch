import os from 'node:os';
import path from 'node:path';

export const PATCHER_VERSION = '0.1.0';
export const PATCHER_NAME = 'betterzalo-patcher';

// Persisted state lives outside the Zalo install so it survives Zalo updates.
export function configDir() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'BetterZaloPatcher');
}

export function configFile() {
  return path.join(configDir(), 'config.json');
}

export function logDir() {
  return path.join(configDir(), 'logs');
}

// Inside-Zalo markers. Backups live at install root so they survive
// version-dir switches (Zalo-26.9.10 -> Zalo-26.10.x). Receipts live in
// the versioned dir so a Zalo update naturally orphans the old receipt.
export const STATE_DIR_NAME = '.betterzalo';
export const RECEIPT_FILE_NAME = 'receipt.json';
export const BACKUP_MANIFEST_NAME = 'manifest.json';

export function stateDirFor(versionDir) {
  return path.join(versionDir, STATE_DIR_NAME);
}

export function receiptPathFor(versionDir) {
  return path.join(versionDir, STATE_DIR_NAME, RECEIPT_FILE_NAME);
}

export function backupsRootFor(installDir) {
  return path.join(installDir, STATE_DIR_NAME, 'backups');
}

export const PACKAGE_MANIFEST_NAME = 'betterzalo-package.json';
export const NEW_MANIFEST_NAME = 'manifest.json';
export const CHECKSUMS_NAME = 'checksums.txt';

// Official release sources. betterzalo-package consumption stays
// directory-based, but the primary install path is now the GitHub
// release artifact (a zip containing manifest.json + payload).
export function betterZaloReleaseApi() {
  return process.env.BETTERZALO_RELEASE_API || 'https://api.github.com/repos/ThatZeez/BetterZalo/releases/latest';
}

export function zaPatchReleaseApi() {
  return process.env.ZAPATCH_RELEASE_API || 'https://api.github.com/repos/ThatZeez/ZaPatch/releases/latest';
}

// Preferred BetterZalo artifact names, in order. Provisional until the
// first real BetterZalo release exists (the API 404s as of v0.1.0);
// patterns are checked in order so packaging can evolve.
export const BETTERZALO_ASSET_PATTERNS = [
  /betterzalo.*windows.*\.zip$/i,
  /betterzalo.*\.zip$/i,
];

export const ZAPATCH_ASSET_PATTERNS = [
  /^ZaPatch\.exe$/i,
  /zapatch.*windows.*\.exe$/i,
  /zapatch.*\.exe$/i,
];

export function downloadCacheDir() {
  return path.join(configDir(), 'cache');
}

// Candidate default Zalo locations, checked in order. Never assume one
// hardcoded path: users install via different packages/scopes.
export function defaultInstallCandidates() {
  const out = [];
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (localAppData) out.push(path.join(localAppData, 'Programs', 'Zalo'));
  if (programFiles) out.push(path.join(programFiles, 'Zalo'));
  if (programFilesX86) out.push(path.join(programFilesX86, 'Zalo'));
  return [...new Set(out)];
}

export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  UNSUPPORTED_VERSION: 4,
  PERMISSION: 5,
  BACKUP_FAILED: 6,
  PATCH_FAILED: 7,
  VERIFY_FAILED: 8,
  RESTORE_FAILED: 9,
  PACKAGE_INVALID: 10,
  DOWNLOAD_FAILED: 11,
  SELF_UPDATE_FAILED: 12,
  INTERRUPTED: 130,
};
