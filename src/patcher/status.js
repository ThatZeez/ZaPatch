import { findLatestBackup } from './backup.js';
import { detectZaloVersion } from './version.js';
import { readReceipt, verifyAgainstReceipt } from './verification.js';

// Aggregates only verifiable facts. Missing receipt -> NotInstalled;
// failed file checks -> Invalid; never invent status.
export async function getStatus(resolved) {
  const live = await detectZaloVersion(resolved).catch(() => ({ version: null, source: 'unknown' }));
  const receipt = await readReceipt(resolved.versionDir);
  const backups = await findLatestBackup(resolved.installDir).catch(() => null);

  let betterZalo = 'NotInstalled';
  let patchStatus = 'Unknown';
  if (receipt) {
    betterZalo = 'Installed';
    if (receipt.zaloVersion && live.version && receipt.zaloVersion !== live.version) {
      patchStatus = 'NeedsAttention (Zalo updated)';
    } else {
      const v = await verifyAgainstReceipt({ versionDir: resolved.versionDir, receipt }).catch(() => null);
      patchStatus = v && v.ok ? 'Valid' : 'Invalid';
    }
  }

  return {
    installation: 'Found',
    installDir: resolved.installDir,
    versionDir: resolved.versionDir,
    zaloVersion: live.version,
    zaloVersionSource: live.source,
    betterZalo,
    packageVersion: receipt ? `${receipt.packageName} ${receipt.packageVersion}` : null,
    channel: receipt?.channel || null,
    receiptZaloVersion: receipt ? receipt.zaloVersion : null,
    patchStatus,
    backup: backups ? `Available (${backups.id})` : 'None',
  };
}
