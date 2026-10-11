import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupWorkDir, packageFromArchive } from '../patcher/artifact.js';
import { saveConfig } from '../patcher/config.js';
import { downloadCacheDir, EXIT, PATCHER_NAME, PATCHER_VERSION } from '../patcher/constants.js';
import { findDefaultInstall, validateAndResolve } from '../patcher/detection.js';
import { Codes, PatcherError, unsupportedVersion } from '../patcher/errors.js';
import { createLogger } from '../patcher/logger.js';
import { checkWritable, ensureZaloNotRunning, isElevated } from '../patcher/permissions.js';
import { loadPackage } from '../patcher/package.js';
import { applyPatch } from '../patcher/patch.js';
import { downloadFile } from '../patcher/download.js';
import { betterZaloRelease, resolveAssetSha256 } from '../patcher/release.js';
import { repairInstallation } from '../patcher/repair.js';
import { resolveBackup, restoreFromBackup } from '../patcher/restore.js';
import { getStatus } from '../patcher/status.js';
import { applySelfUpdate, checkSelfUpdate, isNewer, normalizeTag } from '../patcher/updater.js';
import { readReceipt, verifyAgainstReceipt } from '../patcher/verification.js';
import { checkCompatibility, detectZaloVersion } from '../patcher/version.js';
import { confirm } from './menu.js';
import * as out from './output.js';
import { selectBuildChannel, selectInstallation } from './selection.js';

const COMMANDS = ['install', 'repair', 'uninstall', 'restore', 'update', 'status', 'version', 'menu'];

export function printHelp() {
  out.info(`${PATCHER_NAME} v${PATCHER_VERSION} — Windows-only CLI for BetterZalo
`);
  out.info('Usage:');
  out.info('  ZaPatch                        Open the interactive main menu');
  out.info('  ZaPatch <command> [options]\n');
  out.info('Commands:');
  out.info('  install    Install BetterZalo (downloads the official release unless --package is given)');
  out.info('  repair     Repair a damaged BetterZalo installation (targeted, keeps backups)');
  out.info('  uninstall  Remove BetterZalo and restore original Zalo files (alias: restore)');
  out.info('  update     Update ZaPatch itself (never updates BetterZalo)');
  out.info('  status     Report installation, version, patch and backup state');
  out.info('  version    Print the ZaPatch version');
  out.info('  menu       Open the interactive main menu\n');
  out.info('Options:');
  out.info('  --zalo-path <dir>   Use this Zalo installation directory (skip prompts)');
  out.info('  --package <dir>     Local BetterZalo package directory (offline install/repair)');
  out.info('  --channel <name>    Build line: stable or alpha (install/repair, default: prompt or stable)');
  out.info('  --backup <id>       Backup id to restore (uninstall)');
  out.info('  --json              Machine-readable status output (status)');
  out.info('  --yes               Confirm without prompting (scripts)');
  out.info('  --no-pause          Do not wait for Enter before exiting');
  out.info('  --help, -h          Show this help');
  out.info('  --version, -V       Print the ZaPatch version');
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { command: null, zaloPath: null, pkg: null, channel: null, backup: null, json: false, yes: false, noPause: false };
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
    } else if (a === '--channel' && args[i + 1]) {
      opts.channel = args[++i];
    } else if (a.startsWith('--channel=')) {
      opts.channel = a.slice('--channel='.length);
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--yes' || a === '-y') {
      opts.yes = true;
    } else if (a === '--no-pause') {
      opts.noPause = true;
    } else if (!a.startsWith('-') && !opts.command) {
      opts.command = a;
    } else {
      throw new PatcherError(Codes.ABORTED, `Unknown argument: ${a}`, 'Run with --help for usage.', EXIT.USAGE);
    }
  }
  return opts;
}

// Shared prelude: flag/persisted/prompt -> validate -> detect version.
async function resolveVerifiedInstallation(opts, logger, signal) {
  signal?.throwIfInterrupted?.('setup');
  const resolved = await selectInstallation({ zaloPathFlag: opts.zaloPath, signal });
  await logger.info('installation selected', { path: resolved.installDir });
  const full = await validateAndResolve(resolved.installDir);
  const live = await detectZaloVersion(full);
  if (!live.version) {
    throw unsupportedVersion('unknown', null, null);
  }
  return { ...full, zaloVersion: live.version, versionSource: live.source };
}

function steps() {
  return (name, status) => out.step(name, status);
}

function progressPrinter(label) {
  let last = 0;
  return ({ downloaded, total }) => {
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    const extra = total ? ` / ${(total / 1048576).toFixed(1)} MB` : '';
    process.stdout.write(`\r${label} ${(downloaded / 1048576).toFixed(1)} MB${extra} ...`);
  };
}

// Verified BetterZalo package: explicit --package dir wins (offline),
// else the release for the selected channel is downloaded and cached.
export async function resolveBetterZaloPackage({ pkgDirFlag, channel = 'stable', zaloVersion, logger, signal }) {
  if (pkgDirFlag) {
    const pkg = await loadPackage(pkgDirFlag);
    await logger.info('local package loaded', { name: pkg.name, version: pkg.version, dir: pkg.dir });
    return { pkg, channel: 'local', cleanup: async () => {} };
  }

  const { release, asset, channel: resolved } = await betterZaloRelease(channel);
  await logger.info('release found', { tag: release.tag, asset: asset.name, channel: resolved });
  out.info(`BetterZalo ${resolved} release: ${release.tag} (${asset.name})`);

  const tagSlug = normalizeTag(release.tag).replace(/[^0-9A-Za-z._-]+/g, '_') || 'latest';
  const cacheTarget = path.join(downloadCacheDir(), `betterzalo-${resolved}-${tagSlug}`);
  const cached = await loadPackage(cacheTarget).catch(() => null);
  if (cached) {
    try {
      checkCompatibility(zaloVersion, cached);
      out.info(`Using cached BetterZalo ${cached.version}.`);
      await logger.info('cache hit', { dir: cacheTarget, version: cached.version });
      return { pkg: cached, cleanup: async () => {} };
    } catch {
      await logger.info('cached package incompatible, re-downloading', { dir: cacheTarget });
    }
  }

  signal?.throwIfInterrupted?.('download');
  const { sha256, source } = await resolveAssetSha256(release, asset);
  await logger.info('checksum source', { source });
  out.info(`Verifying download via ${source}...`);
  await fs.mkdir(downloadCacheDir(), { recursive: true });
  const archivePath = path.join(downloadCacheDir(), `${tagSlug}-${asset.name}`);
  const print = progressPrinter('Downloading BetterZalo');
  await downloadFile(asset.url, archivePath, { expectedSha256: sha256, onProgress: print, signal });
  process.stdout.write('\n');
  await logger.info('download verified', { bytes: asset.size });

  const { pkg, workDir } = await packageFromArchive(archivePath, { workParent: downloadCacheDir() });
  await fs.rm(cacheTarget, { recursive: true, force: true }).catch(() => {});
  await fs.rename(workDir, cacheTarget).catch(() => {});
  const dir = await fs.stat(cacheTarget).then(() => cacheTarget).catch(() => workDir);
  await logger.info('artifact ready', { dir, version: pkg.version });
  return { pkg, channel: resolved, cleanup: () => cleanupWorkDir(dir === cacheTarget ? null : workDir) };
}

async function ensureWritable(versionDir) {
  try {
    await fs.access(versionDir, fs.constants.W_OK);
  } catch {
    const elevated = await isElevated();
    throw new PatcherError(
      Codes.PERMISSION_DENIED,
      `Permission denied: ${versionDir}`,
      elevated === false
        ? 'Close Zalo, re-run this terminal as Administrator, then retry.'
        : 'Close Zalo (it may lock its files) and retry.',
      EXIT.PERMISSION,
    );
  }
  const probe = await checkWritable([versionDir]);
  if (!probe.ok) {
    throw new PatcherError(Codes.PERMISSION_DENIED, `Permission denied: ${probe.denied[0]}`, 'Close Zalo and retry.', EXIT.PERMISSION);
  }
}

export async function flowInstall({ opts, logger, signal }) {
  const channel = await selectBuildChannel({
    channelFlag: opts.channel,
    hasLocalPackage: !!opts.pkg,
    signal,
  });
  const inst = await resolveVerifiedInstallation(opts, logger, signal);
  await saveConfig(inst.installDir).catch(() => {});
  out.info(`\nDetecting Zalo...         ${out.c.green('OK')}`);
  out.info(`Zalo version: ${inst.zaloVersion} (${inst.versionSource})`);
  // Fail fast: a running Zalo locks app.asar and the replace fails
  // with EPERM after the backup. Check before downloading anything.
  await ensureZaloNotRunning();

  const { pkg, channel: resolved, cleanup } = await resolveBetterZaloPackage({
    pkgDirFlag: opts.pkg,
    channel,
    zaloVersion: inst.zaloVersion,
    logger,
    signal,
  });
  try {
    out.info(`BetterZalo build: ${pkg.name} ${pkg.version} (${resolved})`);
    checkCompatibility(inst.zaloVersion, pkg);
    await logger.info('version check passed', { zalo: inst.zaloVersion, pkg: pkg.version, channel: resolved });
    await ensureWritable(inst.versionDir);

    const { receipt, backup } = await applyPatch({
      versionDir: inst.versionDir,
      zaloVersion: inst.zaloVersion,
      pkg,
      channel: resolved,
      onStep: steps(),
      signal,
    });
    await logger.info('installed', {
      zalo: inst.zaloVersion,
      package: `${pkg.name}@${pkg.version}`,
      channel: resolved,
      backup: backup.id,
      files: receipt.files.length,
    });
    console.log('\nBetterZalo installed successfully.');
    return EXIT.OK;
  } finally {
    await cleanup().catch(() => {});
  }
}

export async function flowRepair({ opts, logger, signal }) {
  const inst = await resolveVerifiedInstallation(opts, logger, signal);
  await saveConfig(inst.installDir).catch(() => {});
  out.info(`\nZalo version: ${inst.zaloVersion} (${inst.versionSource})`);
  await ensureZaloNotRunning();

  // Without an explicit flag, repair sticks to the channel the install
  // came from so an alpha install is not "repaired" with a stable build.
  // Only ask when there is no recorded channel to inherit.
  const receipt = await readReceipt(inst.versionDir);
  const channel = receipt?.channel && !opts.channel && !opts.pkg
    ? receipt.channel
    : await selectBuildChannel({ channelFlag: opts.channel, hasLocalPackage: !!opts.pkg, signal });
  if (receipt?.channel && channel === receipt.channel && !opts.channel) {
    out.info(`Repairing with the recorded ${channel} build line.`);
  }
  const { pkg, cleanup } = await resolveBetterZaloPackage({
    pkgDirFlag: opts.pkg,
    channel,
    zaloVersion: inst.zaloVersion,
    logger,
    signal,
  });
  try {
    const result = await repairInstallation({
      versionDir: inst.versionDir,
      installDir: inst.installDir,
      zaloVersion: inst.zaloVersion,
      pkg,
      onStep: steps(),
      signal,
    });
    await logger.info('repair finished', { status: result.status, repaired: result.repaired });
    if (result.status === 'healthy') {
      console.log('\nBetterZalo is healthy. Nothing to repair.');
    } else {
      console.log(`\nRepaired ${result.repaired.length} file(s). Original backup preserved (${result.backupId}).`);
    }
    return EXIT.OK;
  } finally {
    await cleanup().catch(() => {});
  }
}

export async function flowUninstall({ opts, logger, signal }) {
  const inst = await resolveVerifiedInstallation(opts, logger, signal);
  signal?.throwIfInterrupted?.('uninstall');

  const receipt = await readReceipt(inst.versionDir);
  const backup = await resolveBackup({
    installDir: inst.installDir,
    backupId: opts.backup,
    zaloVersion: inst.zaloVersion,
  }).catch(() => null);

  if (!receipt && !backup) {
    out.info('BetterZalo does not appear to be installed here, and no backup exists.');
    out.info('Nothing to uninstall.');
    return EXIT.OK;
  }
  if (!backup) {
    throw new PatcherError(
      Codes.RESTORE_FAILED,
      'BetterZalo files are present but no verified backup exists. Refusing to delete files blindly.',
      'Reinstall the same Zalo version, run Install to create a backup, then uninstall.',
      EXIT.RESTORE_FAILED,
    );
  }

  await logger.info('uninstall started', { backup: backup.id, zalo: inst.zaloVersion });
  out.info(`Restoring original files from backup ${backup.id}...`);
  const result = await restoreFromBackup({ versionDir: inst.versionDir, backup });
  await logger.info('uninstalled', { restored: result.restored.length, removed: result.removed.length });

  const leftover = await readReceipt(inst.versionDir);
  if (leftover) {
    throw new PatcherError(Codes.VERIFY_FAILED, 'Uninstall left a BetterZalo receipt behind.', 'Run Repair, then try again.', EXIT.VERIFY_FAILED);
  }
  console.log(`\nRestored ${result.restored.length} original file(s), removed ${result.removed.length} BetterZalo file(s).`);
  console.log('Backup retained (backups are never auto-deleted).');
  console.log('Zalo is back to its original state.');
  return EXIT.OK;
}

export async function flowSelfUpdate({ opts, logger, signal }) {
  signal?.throwIfInterrupted?.('self-update');
  out.info(`ZaPatch version: ${PATCHER_VERSION}`);
  const { release, asset, latest } = await checkSelfUpdate();
  await logger.info('self-update check', { current: PATCHER_VERSION, latest });
  if (!isNewer(latest, PATCHER_VERSION)) {
    out.info(`Already up to date (${PATCHER_VERSION}).`);
    return EXIT.OK;
  }
  out.info(`New version available: ${latest} (release: ${release.tag})`);
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new PatcherError(
        Codes.ABORTED,
        'Refusing to self-update without confirmation in non-interactive mode.',
        'Re-run with --yes to confirm.',
        EXIT.USAGE,
      );
    }
    const ok = await confirm(`Download and install ZaPatch ${latest}?`, { signal });
    if (!ok) {
      out.info('Self-update cancelled.');
      return EXIT.OK;
    }
  }
  const print = progressPrinter('Downloading ZaPatch');
  const result = await applySelfUpdate({ asset, release, onProgress: print, signal });
  process.stdout.write('\n');
  await logger.info('self-updated', { version: result.version });
  console.log(`\nZaPatch updated to ${result.version}.`);
  console.log('Restart ZaPatch to use the new version.');
  console.log(`(Previous executable kept as ${result.backupExe}; it is removed on next start.)`);
  return EXIT.OK;
}

export function menuFlows(logger) {
  const base = { logger };
  return {
    install: ({ signal }) => flowInstall({ opts: {}, logger: base.logger, signal }),
    repair: ({ signal }) => flowRepair({ opts: {}, logger: base.logger, signal }),
    uninstall: ({ signal }) => flowUninstall({ opts: {}, logger: base.logger, signal }),
    'self-update': ({ signal }) => flowSelfUpdate({ opts: { yes: false }, logger: base.logger, signal }),
  };
}

export async function run(argv = process.argv, { signal = null } = {}) {
  const logger = createLogger();
  const opts = parseArgs(argv);

  if (!opts.command || opts.command === 'help' || opts.command === 'menu') {
    if (!opts.command) return { menu: true, logger, signal, opts };
    if (opts.command === 'menu') return { menu: true, logger, signal, opts };
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
      return cmdStatus(opts, logger, signal);
    case 'install':
      return flowInstall({ opts, logger, signal });
    case 'repair':
      return flowRepair({ opts, logger, signal });
    case 'uninstall':
    case 'restore':
      return flowUninstall({ opts, logger, signal });
    case 'update':
      return flowSelfUpdate({ opts, logger, signal });
    default:
      throw new PatcherError(Codes.ABORTED, `Unknown command: ${opts.command}`, '', EXIT.USAGE);
  }
}

async function cmdStatus(opts, logger, _signal) {
  let resolved;
  if (opts.zaloPath) {
    resolved = await validateAndResolve(opts.zaloPath);
  } else {
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
      out.info('Run ZaPatch and select Install to get started.');
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
  out.info(`BetterZalo:       ${status.betterZalo}${status.packageVersion ? ` (${status.packageVersion})` : ''}${status.channel ? ` [${status.channel}]` : ''}`);
  out.info(`Patch status:     ${status.patchStatus}`);
  out.info(`Backup:           ${status.backup}`);
  if (status.receiptZaloVersion && status.zaloVersion && status.receiptZaloVersion !== status.zaloVersion) {
    out.warn(`\nZalo was updated (${status.receiptZaloVersion} -> ${status.zaloVersion}). Run Repair or Install with a compatible release.`);
    return EXIT.UNSUPPORTED_VERSION;
  }
  return status.patchStatus === 'Invalid' ? EXIT.VERIFY_FAILED : EXIT.OK;
}
