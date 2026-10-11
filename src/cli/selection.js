import { loadConfig, saveConfig } from '../patcher/config.js';
import { defaultInstallCandidates } from '../patcher/constants.js';
import { findDefaultInstall, validateAndResolve } from '../patcher/detection.js';
import { Codes, PatcherError } from '../patcher/errors.js';
import { normalizeChannel } from '../patcher/release.js';
import { ask, selectOption } from './menu.js';
import * as out from './output.js';

function aborted() {
  return new PatcherError(Codes.ABORTED, 'Aborted by user.', '', 0);
}

// Arrow-key option picker shared by every selection menu below.
// Esc/Ctrl+C aborts; non-TTY falls back to a numbered prompt.
async function choose({ header, options, signal }) {
  const idx = await selectOption({
    header,
    items: options.map((label) => ({ label })),
    initial: 0,
    signal,
  });
  if (idx === null) throw aborted();
  return idx;
}

// Build line prompt, before installation selection. Explicit --package
// skips it; non-TTY defaults to stable.
export async function selectBuildChannel({ channelFlag = null, hasLocalPackage = false, signal = null } = {}) {
  if (channelFlag) return normalizeChannel(channelFlag);
  if (hasLocalPackage || !process.stdin.isTTY) return 'stable';
  const idx = await choose({
    header: [out.c.bold('ZaPatch'), '', 'Select BetterZalo build:', ''],
    options: ['Stable (recommended)', 'Alpha / pre-release'],
    signal,
  });
  return idx === 1 ? 'alpha' : 'stable';
}

// Resolves to an already-verified install dir and persists it.
// Never modifies the Zalo installation itself.
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
      const idx = await choose({
        header: [out.c.bold('ZaPatch'), '', 'Zalo installation:', stillValid.installDir, ''],
        options: ['Continue with this installation', 'Change installation', 'Exit'],
        signal,
      });
      if (idx === 0) return stillValid;
      if (idx === 2) throw aborted();
      return firstTimeFlow({ signal });
    }
    out.warn('Previously saved installation is no longer valid. Please select again.');
  }

  if (!process.stdin.isTTY) {
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
  const idx = await choose({
    header: [out.c.bold('ZaPatch'), '', 'Select Zalo installation:', ''],
    options: ['Use default Zalo installation', 'Enter custom installation path', 'Exit'],
    signal,
  });
  if (idx === 2) throw aborted();

  if (idx === 1) {
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
