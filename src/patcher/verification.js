import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { extractFile, readHeader } from './asar.js';
import { receiptPathFor, stateDirFor } from './constants.js';
import { appAsarFor } from './patch.js';

// Verifies a patched installation against its receipt: every recorded
// asar-internal file must exist with a matching sha256, and the
// index.html hook must be present. Legacy (loose-file) receipts without
// asar entries report Invalid so repair/install takes over.
export async function verifyAgainstReceipt({ versionDir, receipt = null }) {
  const receiptPath = receiptPathFor(versionDir);
  const rec = receipt || (await fs.readFile(receiptPath, 'utf8').then(JSON.parse).catch(() => null));
  if (!rec) {
    return { ok: false, reason: 'no receipt (BetterZalo not installed)', checks: [] };
  }
  if (!rec.asar || !Array.isArray(rec.files)) {
    return { ok: false, reason: 'legacy install (predates asar patching); reinstall to migrate', checks: [] };
  }
  const asarPath = appAsarFor(versionDir);
  const header = await readHeader(asarPath).catch(() => null);
  if (!header) {
    return { ok: false, reason: 'app.asar unreadable', checks: [] };
  }
  const checks = [];
  let ok = true;
  for (const f of rec.files) {
    const rel = f.asarPath || f.dest;
    let buf = null;
    try {
      buf = await extractFile(asarPath, rel, header);
    } catch {
      buf = null;
    }
    if (!buf) {
      checks.push({ file: rel, ok: false, reason: 'missing from asar' });
      ok = false;
      continue;
    }
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (f.sha256 && actual.toLowerCase() !== f.sha256.toLowerCase()) {
      checks.push({ file: rel, ok: false, reason: 'hash mismatch' });
      ok = false;
    } else {
      checks.push({ file: rel, ok: true });
    }
  }
  let hookOk = true;
  try {
    const html = (await extractFile(asarPath, 'pc-dist/index.html', header)).toString('utf8');
    hookOk = rec.hookJs ? html.includes(rec.hookJs.split('/').pop()) && html.includes('BetterZalo') : html.includes('BetterZalo');
  } catch {
    hookOk = false;
  }
  if (!hookOk) {
    ok = false;
    checks.push({ file: 'pc-dist/index.html hook', ok: false, reason: 'hook missing' });
  }
  return { ok, receipt: rec, checks };
}

export async function readReceipt(versionDir) {
  return fs.readFile(receiptPathFor(versionDir), 'utf8').then(JSON.parse).catch(() => null);
}

export function receiptDir(versionDir) {
  return stateDirFor(versionDir);
}
