import fs from 'node:fs/promises';
import { patchAsar } from './asar.js';
import { createBackup, findLatestBackup } from './backup.js';
import { Codes, PatcherError } from './errors.js';
import { appAsarFor, asarPathFor, pickHookJs } from './patch.js';
import { checkUpdateState } from './update.js';
import { readReceipt, verifyAgainstReceipt } from './verification.js';
import { checkCompatibility } from './version.js';

// Targeted asar repair: only missing/corrupted blobs (and an absent hook)
// are reapplied. Not a reinstall: the original backup and receipt survive,
// intact entries are never touched.
export async function repairInstallation({ versionDir, installDir, zaloVersion, pkg, onStep = () => {}, signal = null }) {
  signal?.throwIfInterrupted?.('repair');

  onStep('Checking current installation', 'run');
  const receipt = await readReceipt(versionDir);
  if (!receipt) {
    onStep('Checking current installation', 'fail');
    throw new PatcherError(
      Codes.NOT_FOUND,
      'BetterZalo is not installed in this Zalo version directory.',
      'Run Install to install BetterZalo first.',
      3,
    );
  }

  // Zalo may have updated since the patch: never blindly reuse the old build.
  const drift = await checkUpdateState({ resolved: { versionDir }, receipt });
  const effectiveZalo = drift.live.version || zaloVersion;
  if (drift.needsAttention) {
    try {
      checkCompatibility(effectiveZalo, pkg);
      onStep('Checking current installation', 'run');
      onStep(`Zalo updated (${drift.previous} -> ${drift.live.version}); candidate build still compatible`, 'ok');
    } catch {
      onStep('Checking current installation', 'fail');
      throw new PatcherError(
        'UNSUPPORTED_VERSION',
        `Zalo was updated (${drift.previous} -> ${drift.live.version}); the installed BetterZalo build is no longer valid and the candidate build does not support it either.`,
        'Run Install to fetch a compatible BetterZalo release for this Zalo version.',
        4,
      );
    }
  }

  const report = await verifyAgainstReceipt({ versionDir, receipt });
  if (report.ok) {
    onStep('Checking current installation', 'ok');
    return { repaired: [], status: 'healthy', receipt };
  }
  onStep('Checking current installation', 'fail');

  const broken = report.checks.filter((c) => !c.ok && !c.file.endsWith(' hook'));
  const hookBroken = report.checks.some((c) => !c.ok && c.file.endsWith(' hook'));
  onStep(`Found ${broken.length + (hookBroken ? 1 : 0)} broken item(s)`, 'run');

  checkCompatibility(effectiveZalo, pkg);
  const byAsar = new Map(pkg.files.map((f) => [asarPathFor(f.dest), f]));
  for (const b of broken) {
    if (!byAsar.has(b.file)) {
      throw new PatcherError(
        'PACKAGE_INVALID',
        `Installed file ${b.file} is not part of the candidate BetterZalo ${pkg.version} build.`,
        'Obtain the exact BetterZalo build recorded in the receipt, or run Install to repatch cleanly.',
        10,
      );
    }
  }

  // Prefer the original backup; snapshot the current asar only when none exists.
  const asarPath = appAsarFor(versionDir);
  const asarRel = 'resources/app.asar';
  let backup = await findLatestBackup(installDir, receipt.zaloVersion).catch(() => null)
    || await findLatestBackup(installDir).catch(() => null);
  let backupCreated = null;
  if (!backup) {
    onStep('Creating safety backup', 'run');
    backupCreated = await createBackup({
      installDir,
      versionDir,
      zaloVersion: effectiveZalo,
      plan: [{ destRel: asarRel, destAbs: asarPath }],
    });
    backup = backupCreated;
    onStep('Creating safety backup', 'ok');
  }

  onStep('Repairing files', 'run');
  const repaired = [];
  try {
    signal?.throwIfInterrupted?.('repair');
    if (broken.length > 0 || hookBroken) {
      const blobs = [];
      for (const b of broken) {
        const src = byAsar.get(b.file);
        blobs.push({ asarPath: b.file, data: await fs.readFile(src.srcAbs) });
        repaired.push(b.file);
      }
      await patchAsar({
        asarPath,
        addFiles: blobs,
        hookJs: hookBroken ? receipt.hookJs || pickHookJs(pkg) : null,
        signal,
      });
      if (hookBroken) repaired.push('pc-dist/index.html hook');
    }
  } catch (e) {
    onStep('Repairing files', 'fail');
    if (e.code === 'INTERRUPTED') throw e;
    throw new PatcherError('PATCH_FAILED', `Repair failed: ${e.message}`, 'Run Repair again or run Install to repatch cleanly.', 7);
  }
  onStep('Repairing files', 'ok');

  onStep('Verifying repaired installation', 'run');
  const after = await verifyAgainstReceipt({ versionDir, receipt });
  if (!after.ok) {
    onStep('Verifying repaired installation', 'fail');
    throw new PatcherError('VERIFY_FAILED', 'Repaired files still fail verification.', 'Run Install to repatch cleanly.', 8);
  }
  onStep('Verifying repaired installation', 'ok');
  return { repaired, status: 'repaired', receipt, backupId: backup.id, backupCreated: !!backupCreated };
}
