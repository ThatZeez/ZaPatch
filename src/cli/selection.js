import { loadConfig, saveConfig } from '../patcher/config.js';
import { defaultInstallCandidates } from '../patcher/constants.js';
import { findDefaultInstall, validateAndResolve } from '../patcher/detection.js';
import { Codes, PatcherError } from '../patcher/errors.js';
import { ask } from './menu.js';
import * as out from './output.js';

function aborted() {
  return new PatcherError(Codes.ABORTED, 'Aborted by user.', '', 0);
}

// Interactive installation selection. Resolves to an absolute dir
// that has already been verified, and persists it. Never modifies
// the Zalo installation itself. A null answer means Ctrl+C.
export async function selectInstallation({ zaloPathFlag = null, signal = null } = {}) {
  if (zaloPathFlag) {
    const resolved = await validateAndResolve(zaloPathFlag);
    await saveConfig(resolved.installDir);
    return resolved;
  }

  const persisted = await loadConfig();
  if (persisted) {
    const stillValid = await validateAndResolve(persisted.zaloPath).catch(() => null);
    if (stillValid) {
      if (!process.stdin.isTTY) {
        return stillValid;
      }
      out.header('ZaPatch');
      out.info(`\nZalo installation:\n${stillValid.installDir}\n`);
      out.info('[1] Continue with this installation');
      out.info('[2] Change installation');
      out.info('[3] Exit');
      const raw = await ask('\nSelect an option: ', { signal });
      if (raw === null) throw aborted();
      const choice = raw.trim();
      if (choice === '1' || choice === '') return stillValid;
      if (choice === '3') throw aborted();
      if (choice !== '2') {
        out.warn('\nInvalid option. Please enter 1, 2, or 3.');
        return selectInstallation({ signal });
      }
      return firstTimeFlow({ signal });
    }
    out.warn('Previously saved installation is no longer valid. Please select again.');
  }

  if (!process.stdin.isTTY) {
    // Scripts must pass --zalo-path; never hang waiting for input.
    const found = await findDefaultInstall();
    if (found.installDir) {
      return found;
    }
    throw new PatcherError(
      Codes.ZALO_NOT_FOUND,
      'No Zalo installation selected and no interactive terminal available.',
      'Re-run with --zalo-path <dir>.',
      3,
    );
  }
  return firstTimeFlow({ signal });
}

async function firstTimeFlow({ signal = null } = {}) {
  out.header('ZaPatch');
  out.info('\nSelect Zalo installation:\n');
  out.info('[1] Use default Zalo installation');
  out.info('[2] Enter custom installation path');
  out.info('[3] Exit');
  const raw = await ask('\nSelect an option: ', { signal });
  if (raw === null) throw aborted();
  const choice = raw.trim();
  if (choice === '3') throw aborted();
  if (choice !== '' && choice !== '1' && choice !== '2') {
    out.warn('\nInvalid option. Please enter 1, 2, or 3.');
    return firstTimeFlow({ signal });
  }

  if (choice === '2') {
    const rawPath = await ask('\nEnter Zalo installation path:\n> ', { signal });
    if (rawPath === null) throw aborted();
    const custom = rawPath.trim().replace(/^"|"$/g, '');
    if (!custom) throw new PatcherError(Codes.ABORTED, 'No path entered.', '', 2);
    const resolved = await validateAndResolve(custom);
    await saveConfig(resolved.installDir);
    return resolved;
  }

  // Default: check every usual location, not one hardcoded path.
  const found = await findDefaultInstall(defaultInstallCandidates());
  if (!found.installDir) {
    out.warn('\nDefault Zalo installation not found in the usual locations.');
    const rawPath = await ask('\nEnter Zalo installation path (or empty to exit):\n> ', { signal });
    if (rawPath === null || !rawPath.trim()) throw aborted();
    const resolved = await validateAndResolve(rawPath.trim().replace(/^"|"$/g, ''));
    await saveConfig(resolved.installDir);
    return resolved;
  }
  await saveConfig(found.installDir);
  return found;
}
