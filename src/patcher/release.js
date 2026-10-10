import { BETTERZALO_ASSET_PATTERNS, betterZaloReleaseApi, ZAPATCH_ASSET_PATTERNS, zaPatchReleaseApi } from './constants.js';
import { releaseFailed } from './errors.js';
import { fetchText, firstHexToken } from './download.js';

// Queries the official GitHub release API and picks the distribution
// artifact. Keeps the release/download layer modular so BetterZalo's
// packaging format can evolve without touching patch logic.
//
// Verified against the live GitHub API shape:
//   { tag_name, name, prerelease, draft, assets: [
//       { name, browser_download_url, size, digest: "sha256:<hex>" } ] }
// A "<asset>.sha256" sidecar is preferred for verification; the API
// `digest` field is the fallback. Either way a SHA-256 is required.

function normalizeRelease(data, apiUrl) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.assets)) {
    throw releaseFailed(apiUrl, 'unexpected release payload (no assets array)');
  }
  return {
    tag: data.tag_name || data.name || 'unknown',
    name: data.name || data.tag_name || 'unknown',
    prerelease: !!data.prerelease,
    htmlUrl: data.html_url || null,
    assets: data.assets
      .filter((a) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
      .map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        size: typeof a.size === 'number' ? a.size : null,
        digest: digestOf(a.digest),
      })),
  };
}

export async function fetchLatestRelease(apiUrl) {
  let body;
  try {
    body = await fetchText(apiUrl, { headers: { Accept: 'application/vnd.github+json' } });
  } catch (e) {
    throw releaseFailed(apiUrl, e.message);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw releaseFailed(apiUrl, 'release API did not return JSON');
  }
  const release = normalizeRelease(data, apiUrl);
  if (data.draft) throw releaseFailed(apiUrl, 'latest release is a draft');
  return release;
}

// Lists recent releases (newest first) for channel selection.
export async function listReleases(apiUrl, { limit = 10 } = {}) {
  const listUrl = `${apiUrl.replace(/\/latest\/?$/, '')}?per_page=${Math.max(1, Math.min(limit, 30))}`;
  let body;
  try {
    body = await fetchText(listUrl, { headers: { Accept: 'application/vnd.github+json' } });
  } catch (e) {
    throw releaseFailed(listUrl, e.message);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw releaseFailed(listUrl, 'release API did not return JSON');
  }
  if (!Array.isArray(data)) throw releaseFailed(listUrl, 'unexpected release list payload');
  return data
    .filter((d) => d && typeof d === 'object' && !d.draft)
    .map((d) => normalizeRelease(d, listUrl));
}

function digestOf(field) {
  if (typeof field !== 'string') return null;
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(field.trim());
  return m ? m[1].toLowerCase() : null;
}

export function selectAsset(release, patterns) {
  for (const pattern of patterns) {
    const found = release.assets.find((a) => pattern.test(a.name));
    if (found) return found;
  }
  return null;
}

function sidecarFor(release, asset) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return (
    assets.find((a) => a.name === `${asset.name}.sha256`) ||
    assets.find((a) => a.name === `${asset.name}.sha256.txt`)
  );
}

// Resolves the expected SHA-256 for an asset: sidecar file wins, API
// digest is the fallback. Throws when neither exists — artifacts are
// never accepted without a verifiable checksum.
export async function resolveAssetSha256(release, asset) {
  const sidecar = sidecarFor(release, asset);
  if (sidecar) {
    const text = await fetchText(sidecar.url, { headers: { Accept: 'text/plain, */*' } });
    const hex = firstHexToken(text);
    if (!hex) throw releaseFailed(release.tag, `checksum sidecar ${sidecar.name} has no SHA-256 hash`);
    return { sha256: hex, source: sidecar.name };
  }
  if (asset.digest) return { sha256: asset.digest, source: 'release API digest' };
  throw releaseFailed(release.tag, `no SHA-256 available for ${asset.name} (no sidecar, no API digest)`);
}

export const BUILD_CHANNELS = ['stable', 'alpha'];

export function normalizeChannel(value) {
  const c = String(value || 'stable').trim().toLowerCase();
  if (!BUILD_CHANNELS.includes(c)) {
    throw releaseFailed('channel', `unknown build channel: ${value} (expected stable or alpha)`);
  }
  return c;
}

export async function betterZaloRelease(channel = 'stable') {
  const api = betterZaloReleaseApi();
  const want = normalizeChannel(channel);
  let release;
  if (want === 'alpha') {
    const all = await listReleases(api);
    release = all.find((r) => r.prerelease) || null;
    if (!release) {
      throw releaseFailed(api, 'no alpha/pre-release build published yet');
    }
  } else {
    release = await fetchLatestRelease(api);
  }
  const asset = selectAsset(release, BETTERZALO_ASSET_PATTERNS);
  if (!asset) {
    throw releaseFailed(
      api,
      `no BetterZalo distribution artifact found in ${release.tag}`,
      `Release ${release.tag} exists but ships no downloadable zip yet. A local package can be used offline with --package <dir>.`,
    );
  }
  return { release, asset, channel: want };
}

export async function zaPatchRelease() {
  const api = zaPatchReleaseApi();
  let release;
  try {
    release = await fetchLatestRelease(api);
  } catch (e) {
    const prefix = `Release lookup failed (${api}): `;
    const inner = e.code === 'RELEASE_FAILED' && e.message.startsWith(prefix)
      ? e.message.slice(prefix.length)
      : e.message;
    throw releaseFailed(api, inner, 'No ZaPatch update is published yet. Try again after a new release exists.');
  }
  const asset = selectAsset(release, ZAPATCH_ASSET_PATTERNS);
  if (!asset) {
    throw releaseFailed(api, `no ZaPatch.exe artifact found in ${release.tag}`);
  }
  return { release, asset };
}
