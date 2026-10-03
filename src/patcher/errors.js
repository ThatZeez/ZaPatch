import { EXIT } from './constants.js';

// Machine-readable error codes; CLI maps them to exit codes and hints.
export class PatcherError extends Error {
  constructor(code, message, hint = '', exitCode = EXIT.GENERIC) {
    super(message);
    this.name = 'PatcherError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export const Codes = {
  NOT_WINDOWS: 'NOT_WINDOWS',
  ZALO_NOT_FOUND: 'ZALO_NOT_FOUND',
  INVALID_INSTALL: 'INVALID_INSTALL',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  BACKUP_FAILED: 'BACKUP_FAILED',
  PATCH_FAILED: 'PATCH_FAILED',
  VERIFY_FAILED: 'VERIFY_FAILED',
  RESTORE_FAILED: 'RESTORE_FAILED',
  PACKAGE_INVALID: 'PACKAGE_INVALID',
  NO_BACKUP: 'NO_BACKUP',
  ABORTED: 'ABORTED',
};

export function notWindows() {
  return new PatcherError(
    Codes.NOT_WINDOWS,
    `This patcher targets Windows only (current platform: ${process.platform}).`,
    'Run betterzalo-patcher on Windows.',
    EXIT.GENERIC,
  );
}

export function zaloNotFound(detail = '') {
  return new PatcherError(
    Codes.ZALO_NOT_FOUND,
    `Zalo installation not found.${detail ? ` ${detail}` : ''}`,
    'Use option [2] to enter a custom path, or pass --zalo-path <dir>.',
    EXIT.NOT_FOUND,
  );
}

export function invalidInstall(dir, reason) {
  return new PatcherError(
    Codes.INVALID_INSTALL,
    `Not a valid Zalo PC installation: ${dir}\nReason: ${reason}`,
    'Select the Zalo installation directory (the folder containing Zalo.exe or Zalo-* version folders), not a single file.',
    EXIT.NOT_FOUND,
  );
}

export function unsupportedVersion(zaloVersion, min, max) {
  const range = min || max ? ` (supported range: ${min ?? '?'} - ${max ?? '?'})` : '';
  return new PatcherError(
    Codes.UNSUPPORTED_VERSION,
    `Unsupported Zalo version: ${zaloVersion}${range}. Refusing to patch.`,
    'Wait for a compatible BetterZalo package, or restore and stay on a supported Zalo version.',
    EXIT.UNSUPPORTED_VERSION,
  );
}

export function unsupportedVersionList(zaloVersion, supported) {
  return new PatcherError(
    Codes.UNSUPPORTED_VERSION,
    `Unsupported Zalo version: ${zaloVersion} (supported: ${supported.join(', ')}). Refusing to patch.`,
    'Wait for a compatible BetterZalo package, or restore and stay on a supported Zalo version.',
    EXIT.UNSUPPORTED_VERSION,
  );
}

export function permissionDenied(target, hint = '') {
  return new PatcherError(
    Codes.PERMISSION_DENIED,
    `Permission denied: ${target}`,
    hint || 'Close Zalo, then re-run the terminal as Administrator and retry.',
    EXIT.PERMISSION,
  );
}

export function backupFailed(reason) {
  return new PatcherError(
    Codes.BACKUP_FAILED,
    `Backup failed: ${reason}`,
    'No files were modified. Check disk space and permissions, then retry.',
    EXIT.BACKUP_FAILED,
  );
}

export function patchFailed(reason) {
  return new PatcherError(
    Codes.PATCH_FAILED,
    `Patch failed: ${reason}`,
    'The patcher attempted rollback from the verified backup. Run `status` to check the current state.',
    EXIT.PATCH_FAILED,
  );
}

export function verifyFailed(reason) {
  return new PatcherError(
    Codes.VERIFY_FAILED,
    `Verification failed: ${reason}`,
    'Run `status` for details. If files drifted, `restore` then `install` again.',
    EXIT.VERIFY_FAILED,
  );
}

export function restoreFailed(reason) {
  return new PatcherError(
    Codes.RESTORE_FAILED,
    `Restore failed: ${reason}`,
    'Backups are never auto-deleted. Inspect the backup directory and retry with --backup <id>.',
    EXIT.RESTORE_FAILED,
  );
}

export function packageInvalid(reason) {
  return new PatcherError(
    Codes.PACKAGE_INVALID,
    `Missing or invalid BetterZalo package: ${reason}`,
    'Pass a package directory containing a valid manifest.json (or legacy betterzalo-package.json).',
    EXIT.PACKAGE_INVALID,
  );
}
