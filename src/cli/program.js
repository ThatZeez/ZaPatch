import { saveConfig } from '../patcher/config.js';
import { EXIT, PATCHER_NAME, PATCHER_VERSION } from '../patcher/constants.js';
import { findDefaultInstall, validateAndResolve } from '../patcher/detection.js';
import { Codes, PatcherError } from '../patcher/errors.js';
import { createLogger } from '../patcher/logger.js';
import { checkWritable, isElevated } from '../patcher/permissions.js';
import { loadPackage } from '../patcher/package.js';
import { applyPatch } from '../patcher/patch.js';
import { resolveBackup, restoreFromBackup } from '../patcher/restore.js';
import { getStatus } from '../patcher/status.js';
import { checkUpdateState } from '../patcher/update.js';
import { readReceipt } from '../patcher/verification.js';
import { checkCompatibility, detectZaloVersion } from '../patcher/version.js';
import * as out from './output.js';
import { selectInstallation } from './selection.js';

const COMMANDS = ['install', 'update', 'restore', 'status', 'version'];

export function printHelp() {
  out.info(`${PATCHER_NAME} v${PATCHER_VERSION} — Windows-only CLI for BetterZalo
`);
  out.info('Usage:');
  out.info('  betterzalo-patcher <command> [options]\n');
  out.info('Commands:');
  out.info('  install   Install BetterZalo into the selected Zalo installation');
  out.info('  update    Check for Zalo updates and repatch when compatible');
  out.info('  restore   Restore original Zalo files from a verified backup');
  out.info('  status    Report installation, version, patch and backup state');
  out.info('  version   Print the patcher version\n');
  out.info('Options:');
  out.info('  --zalo-path <dir>   Use this Zalo installation directory (skip prompts)');
  out.info('  --package <dir>     BetterZalo package directory (install/update)');
  out.info('  --backup <id>       Backup id to restore (restore)');
  out.info('  --json              Machine-readable status output (status)');
  out.info('  --help, -h          Show this help');
  out.info('  --version, -V       Print the patcher version');
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { command: null, zaloPath: null, pkg: null, backup: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--help' || a === '-h') && !opts.command) {
      opts.command = 'help';
    } else if ((a === '--version' || a === '-V') && !opts.command) {
      opts.command = 'version';
    } else if (a === '--zalo-path' && args[i + 1]) {
      opts.zaloPath = args[++i];
    } else if (a.startsWith('--zalo-path=')) {
      opts.zaloPath = a.slice('--zalo-path='.length);
    } else if (a === '--package' && args[i + 1]) {
      opts.pkg = args[++i];
    } else if (a.startsWith('--package=')) {
      opts.pkg = a.slice('--package='.length);
    } else if (a === '--backup' && args[i + 1]) {
      opts.backup = args[++i];
    } else if (a.startsWith('--backup=')) {
      opts.backup = a.slice('--backup='.length);
    } else if (a === '--json') {
      opts.json = true;
    } else if (!a.startsWith('-') && !opts.command) {
      opts.command = a;
    } else {
      throw new PatcherError(Codes.ABORTED, `Unknown argument: ${a}`, 'Run with --help for usage.', EXIT.USAGE);
    }
  }
  return opts;
}

// Shared prelude for commands that need a verified installation:
// resolve path (flag/persisted/prompt) -> validate -> detect version.
async function resolveVerifiedInstallation(opts, logger) {
  const resolved = await selectInstallation({ zaloPathFlag: opts.zaloPath });
  await logger.info('installation selected', { path: resolved.installDir });
  const full = await validateAndResolve(resolved.installDir);
  const live = await detectZaloVersion(full);
  if (!live.version) {
    const { unsupportedVersion } = await import('../patcher/errors.js');
    throw unsupportedVersion('unknown', null, null);
  }
  return { ...full, zaloVersion: live.version, versionSource: live.source };
}

function onStepLogger(logger) {
  return (name, status) => out.step(name, status);
}

export async function run(argv = process.argv) {
  const logger = createLogger();
  const opts = parseArgs(argv);

  if (!opts.command || opts.command === 'help') {
    printHelp();
    return EXIT.OK;
  }
  if (opts.command === 'version') {
    out.info(`${PATCHER_NAME} ${PATCHER_VERSION}`);
    return EXIT.OK;
  }
  if (!COMMANDS.includes(opts.command)) {
    throw new PatcherError(Codes.ABORTED, `Unknown command: ${opts.command}`, 'Run with --help for usage.', EXIT.USAGE);
  }

  switch (opts.command) {
    case 'status':
      return cmdStatus(opts, logger);
    case 'install':
      return cmdInstall(opts, logger);
    case 'restore':
      return cmdRestore(opts, logger);
    case 'update':
      return cmdUpdate(opts, logger);
    default:
      throw new PatcherError(Codes.ABORTED, `Unknown command: ${opts.command}`, '', EXIT.USAGE);
  }
}

async function cmdStatus(opts, logger) {
  let resolved;
  if (opts.zaloPath) {
    resolved = await validateAndResolve(opts.zaloPath);
  } else {
    // Status never prompts on first launch without TTY; report not-found instead.
    const { loadConfig } = await import('../patcher/config.js');
    const saved = await loadConfig();
    if (saved) {
      resolved = await validateAndResolve(saved.zaloPath).catch(() => null);
    }
    if (!resolved) {
      const found = await findDefaultInstall();
      if (found.installDir) resolved = found;
    }
    if (!resolved) {
      if (opts.json) {
        console.log(JSON.stringify({ installation: 'NotFound' }, null, 2));
        return EXIT.NOT_FOUND;
      }
      out.info('Zalo installation: NotFound');
      out.info('Run `install` and select your Zalo directory to get started.');
      return EXIT.NOT_FOUND;
    }
  }
  const status = await getStatus(resolved);
  await logger.info('status', status);
  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return EXIT.OK;
  }
  out.info(`Zalo installation: ${status.installation}`);
  out.info(`Path:             ${status.installDir}`);
  out.info(`Zalo version:     ${status.zaloVersion ?? 'unknown'}${status.zaloVersionSource ? ` (${status.zaloVersionSource})` : ''}`);
  out.info(`BetterZalo:       ${status.betterZalo}${status.packageVersion ? ` (${status.packageVersion})` : ''}`);
  out.info(`Patch status:     ${status.patchStatus}`);
  out.info(`Backup:           ${status.backup}`);
  if (status.receiptZaloVersion && status.zaloVersion && status.receiptZaloVersion !== status.zaloVersion) {
    out.warn(`\nZalo was updated (${status.receiptZaloVersion} -> ${status.zaloVersion}). Run \`update\` with a compatible package.`);
    return EXIT.UNSUPPORTED_VERSION;
  }
  return status.patchStatus === 'Invalid' ? EXIT.VERIFY_FAILED : EXIT.OK;
}

async function cmdInstall(opts, logger) {
  if (!opts.pkg) {
    throw new PatcherError(Codes.PACKAGE_INVALID, 'No BetterZalo package given.', 'Re-run with --package <dir>.', EXIT.PACKAGE_INVALID);
  }
  const pkg = await loadPackage(opts.pkg);
  await logger.info('package loaded', { name: pkg.name, version: pkg.version });

  const inst = await resolveVerifiedInstallation(opts, logger);
  await saveConfig(inst.installDir).catch(() => {});
  out.info(`\nDetecting Zalo...         ${out.c.green('OK')}`);
  out.info(`Zalo version: ${inst.zaloVersion} (${inst.versionSource})`);

  checkCompatibility(inst.zaloVersion, pkg);
  await logger.info('version check passed', { zalo: inst.zaloVersion, pkg: pkg.version });

  const writable = await checkWritable([inst.versionDir]);
  if (!writable.ok) {
    const elevated = await isElevated();
    throw new PatcherError(
      Codes.PERMISSION_DENIED,
      `Permission denied: ${writable.denied[0]}`,
      elevated === false
        ? 'Close Zalo, re-run this terminal as Administrator, then retry.'
        : 'Close Zalo (it may lock its files) and retry.',
      EXIT.PERMISSION,
    );
  }

  const { receipt, backup } = await applyPatch({
    versionDir: inst.versionDir,
    zaloVersion: inst.zaloVersion,
    pkg,
    onStep: onStepLogger(logger),
  });
  await logger.info('installed', {
    zalo: inst.zaloVersion,
    package: `${pkg.name}@${pkg.version}`,
    backup: backup.id,
    files: receipt.files.length,
  });
  console.log('\nBetterZalo installed successfully.');
  return EXIT.OK;
}

async function cmdRestore(opts, logger) {
  const inst = await resolveVerifiedInstallation(opts, logger);
  const backup = await resolveBackup({
    installDir: inst.installDir,
    backupId: opts.backup,
    zaloVersion: inst.zaloVersion,
  });
  await logger.info('restore started', { backup: backup.id, zalo: inst.zaloVersion });
  out.info(`Restoring backup ${backup.id}...`);
  const result = await restoreFromBackup({ versionDir: inst.versionDir, backup });
  await logger.info('restored', { restored: result.restored.length, removed: result.removed.length });
  console.log(`\nRestored ${result.restored.length} file(s), removed ${result.removed.length} added file(s).`);
  console.log('Backup retained (backups are never auto-deleted).');
  return EXIT.OK;
}

async function cmdUpdate(opts, logger) {
  const inst = await resolveVerifiedInstallation(opts, logger);
  const receipt = await readReceipt(inst.versionDir);
  const state = await checkUpdateState({ resolved: inst, receipt });

  if (!receipt) {
    out.info('BetterZalo is not installed in this Zalo version directory.');
    out.info('Run `install` with --package <dir> to install it.');
    return EXIT.NOT_FOUND;
  }
  if (!state.needsAttention) {
    out.info(`Zalo version: ${state.live.version} — matches patched version. Nothing to do.`);
    const { verifyAgainstReceipt } = await import('../patcher/verification.js');
    const v = await verifyAgainstReceipt({ versionDir: inst.versionDir, receipt });
    out.info(`Patch status: ${v.ok ? 'Valid' : 'Invalid'}`);
    return v.ok ? EXIT.OK : EXIT.VERIFY_FAILED;
  }

  out.warn(`Zalo was updated (${state.previous} -> ${state.live.version}).`);
  out.warn('The current BetterZalo patch may no longer be compatible.');
  await logger.warn('zalo updated since patch', { previous: state.previous, current: state.live.version });
  if (!opts.pkg) {
    out.info('Re-run with --package <dir> containing a compatible build to repatch.');
    return EXIT.UNSUPPORTED_VERSION;
  }
  const pkg = await loadPackage(opts.pkg);
  checkCompatibility(state.live.version, pkg);
  out.info(`Compatible package found: ${pkg.name} ${pkg.version}. Repatching...`);
  await applyPatch({
    versionDir: inst.versionDir,
    zaloVersion: state.live.version,
    pkg,
    onStep: onStepLogger(logger),
  });
  console.log('\nBetterZalo updated successfully.');
  return EXIT.OK;
}
