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
  if (!data || typeof data !== 'object' || !Array.isArray(data.assets)) {
    throw releaseFailed(apiUrl, 'unexpected release payload (no assets array)');
  }
  if (data.draft) throw releaseFailed(apiUrl, 'latest release is a draft');
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

export async function betterZaloRelease() {
  const api = betterZaloReleaseApi();
  const release = await fetchLatestRelease(api);
  const asset = selectAsset(release, BETTERZALO_ASSET_PATTERNS);
  if (!asset) {
    throw releaseFailed(api, `no BetterZalo distribution artifact found in ${release.tag}`);
  }
  return { release, asset };
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
