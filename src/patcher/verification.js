import fs from 'node:fs/promises';
import path from 'node:path';
import { receiptPathFor, stateDirFor } from './constants.js';

// Verifies a patched installation against its receipt:
// every recorded file must exist and match its sha256.
export async function verifyAgainstReceipt({ versionDir, receipt = null }) {
  const receiptPath = receiptPathFor(versionDir);
  const rec = receipt || (await fs.readFile(receiptPath, 'utf8').then(JSON.parse).catch(() => null));
  if (!rec) {
    return { ok: false, reason: 'no receipt (BetterZalo not installed)', checks: [] };
  }
  const checks = [];
  let ok = true;
  for (const f of rec.files || []) {
    const abs = path.join(versionDir, f.dest);
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isFile()) {
      checks.push({ file: f.dest, ok: false, reason: 'missing' });
      ok = false;
      continue;
    }
    const { hashFile } = await import('./backup.js');
    const actual = await hashFile(abs).catch(() => null);
    if (actual !== f.sha256) {
      checks.push({ file: f.dest, ok: false, reason: 'hash mismatch' });
      ok = false;
    } else {
      checks.push({ file: f.dest, ok: true });
    }
  }
  return { ok, receipt: rec, checks };
}

export async function readReceipt(versionDir) {
  return fs.readFile(receiptPathFor(versionDir), 'utf8').then(JSON.parse).catch(() => null);
}

export function receiptDir(versionDir) {
  return stateDirFor(versionDir);
}
