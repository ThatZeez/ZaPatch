import readline from 'node:readline';
import { loadConfig, saveConfig } from '../patcher/config.js';
import { defaultInstallCandidates } from '../patcher/constants.js';
import { findDefaultInstall, validateAndResolve } from '../patcher/detection.js';
import { Codes, PatcherError } from '../patcher/errors.js';
import * as out from './output.js';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Interactive installation selection per spec. Resolves to an absolute dir
// that has already been verified, and persists it. Never modifies anything.
export async function selectInstallation({ zaloPathFlag = null } = {}) {
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
      out.header('BetterZalo Patcher');
      out.info(`\nZalo installation:\n${stillValid.installDir}\n`);
      out.info('[1] Continue with this installation');
      out.info('[2] Change installation');
      out.info('[3] Exit');
      const choice = (await prompt('\nSelect an option: ')).trim();
      if (choice === '1' || choice === '') return stillValid;
      if (choice === '3') throw new PatcherError(Codes.ABORTED, 'Aborted by user.', '', 0);
      return firstTimeFlow();
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
  return firstTimeFlow();
}

async function firstTimeFlow() {
  out.header('BetterZalo Patcher');
  out.info('\nWhere is your Zalo installation?\n');
  out.info('[1] Use default Zalo installation');
  out.info('[2] Enter a custom path');
  out.info('[3] Exit');
  const choice = (await prompt('\nSelect an option: ')).trim();
  if (choice === '3') throw new PatcherError(Codes.ABORTED, 'Aborted by user.', '', 0);

  if (choice === '2') {
    const custom = (await prompt('\nEnter Zalo installation path:\n> ')).trim().replace(/^"|"$/g, '');
    if (!custom) throw new PatcherError(Codes.ABORTED, 'No path entered.', '', 2);
    const resolved = await validateAndResolve(custom);
    await saveConfig(resolved.installDir);
    return resolved;
  }

  // Default: check every usual location, not one hardcoded path.
  const found = await findDefaultInstall(defaultInstallCandidates());
  if (!found.installDir) {
    out.warn('\nDefault Zalo installation not found in the usual locations.');
    const custom = (await prompt('\nEnter Zalo installation path (or empty to exit):\n> ')).trim().replace(/^"|"$/g, '');
    if (!custom) throw new PatcherError(Codes.ABORTED, 'Aborted by user.', '', 0);
    const resolved = await validateAndResolve(custom);
    await saveConfig(resolved.installDir);
    return resolved;
  }
  await saveConfig(found.installDir);
  return found;
}
