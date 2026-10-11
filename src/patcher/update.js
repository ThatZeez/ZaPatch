import { detectZaloVersion } from './version.js';

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
