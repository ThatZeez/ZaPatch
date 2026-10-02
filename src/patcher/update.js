import { detectZaloVersion } from './version.js';

// Detects a Zalo update that may have invalidated the patch: compares the
// live Zalo version against the version recorded in the receipt.
export async function checkUpdateState({ resolved, receipt }) {
  const live = await detectZaloVersion(resolved);
  if (!receipt) {
    return { updated: false, live, previous: null, needsAttention: false };
  }
  const previous = receipt.zaloVersion || null;
  if (previous && live.version && previous !== live.version) {
    return { updated: true, live, previous, needsAttention: true };
  }
  return { updated: false, live, previous, needsAttention: false };
}
