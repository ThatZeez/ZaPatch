import fs from 'node:fs/promises';
import path from 'node:path';
import { createBackup, findLatestBackup } from './backup.js';
import { Codes, PatcherError } from './errors.js';
import { checkUpdateState } from './update.js';
import { readReceipt, verifyAgainstReceipt } from './verification.js';
import { checkCompatibility } from './version.js';

// Targeted repair: only missing/corrupted BetterZalo files are reapplied.
// This is deliberately NOT a reinstall: the original backup is preserved,
// receipt metadata is kept, and intact files are never touched.
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

  const broken = report.checks.filter((c) => !c.ok);
  onStep(`Found ${broken.length} broken file(s)`, 'run');

  // The candidate package must match what the receipt describes, and must
  // support the current Zalo version.
  checkCompatibility(effectiveZalo, pkg);
  const byDest = new Map(pkg.files.map((f) => [f.dest.replaceAll('\\', '/'), f]));
  for (const b of broken) {
    if (!byDest.has(b.file)) {
      throw new PatcherError(
        'PACKAGE_INVALID',
        `Installed file ${b.file} is not part of the candidate BetterZalo ${pkg.version} build.`,
        'Obtain the exact BetterZalo build recorded in the receipt, or run Install to repatch cleanly.',
        10,
      );
    }
  }

  // Ensure a backup exists before touching anything. Prefer the original;
  // only snapshot the current state when no backup exists at all.
  let backup = await findLatestBackup(installDir, receipt.zaloVersion).catch(() => null)
    || await findLatestBackup(installDir).catch(() => null);
  let backupCreated = null;
  if (!backup) {
    onStep('Creating safety backup', 'run');
    const plan = broken.map((b) => ({
      destRel: b.file,
      destAbs: path.join(versionDir, b.file),
    }));
    backupCreated = await createBackup({ installDir, versionDir, zaloVersion: effectiveZalo, plan });
    backup = backupCreated;
    onStep('Creating safety backup', 'ok');
  }

  onStep('Repairing files', 'run');
  const repaired = [];
  try {
    for (const b of broken) {
      signal?.throwIfInterrupted?.('repair');
      const src = byDest.get(b.file);
      await fs.mkdir(path.dirname(path.join(versionDir, b.file)), { recursive: true });
      await fs.copyFile(src.srcAbs, path.join(versionDir, b.file));
      repaired.push(b.file);
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
