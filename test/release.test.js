import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchLatestRelease, resolveAssetSha256, selectAsset } from '../src/patcher/release.js';
import { startFixtureServer } from './fixture-server.js';

const FAKE_HEX = 'a'.repeat(64);

function releaseJson(base, { withSidecar = true, withDigest = true } = {}) {
  const assets = [
    {
      name: 'BetterZalo-0.2.0-windows.zip',
      browser_download_url: `${base}/BetterZalo-0.2.0-windows.zip`,
      size: 123,
      ...(withDigest ? { digest: `sha256:${FAKE_HEX}` } : {}),
    },
  ];
  if (withSidecar) {
    assets.push({
      name: 'BetterZalo-0.2.0-windows.zip.sha256',
      browser_download_url: `${base}/BetterZalo-0.2.0-windows.zip.sha256`,
      size: 80,
    });
  }
  return {
    tag_name: 'v0.2.0',
    name: 'BetterZalo 0.2.0',
    prerelease: false,
    assets,
  };
}

test('fetches release and selects the windows artifact', async () => {
  const routes = new Map();
  const srv = await startFixtureServer(routes);
  try {
    routes.set('/releases/latest', { body: JSON.stringify(releaseJson(srv.base)), contentType: 'application/json' });
    const release = await fetchLatestRelease(`${srv.base}/releases/latest`);
    assert.equal(release.tag, 'v0.2.0');
    const asset = selectAsset(release, [/betterzalo.*windows.*\.zip$/i, /betterzalo.*\.zip$/i]);
    assert.equal(asset.name, 'BetterZalo-0.2.0-windows.zip');
  } finally {
    srv.close();
  }
});

test('checksum prefers the .sha256 sidecar over the API digest', async () => {
  const routes = new Map();
  const srv = await startFixtureServer(routes);
  try {
    routes.set('/releases/latest', { body: JSON.stringify(releaseJson(srv.base)), contentType: 'application/json' });
    routes.set('/BetterZalo-0.2.0-windows.zip.sha256', { body: `${'b'.repeat(64)}  BetterZalo-0.2.0-windows.zip\n` });
    const release = await fetchLatestRelease(`${srv.base}/releases/latest`);
    const out = await resolveAssetSha256(release, release.assets[0]);
    assert.equal(out.sha256, 'b'.repeat(64));
    assert.equal(out.source, 'BetterZalo-0.2.0-windows.zip.sha256');
  } finally {
    srv.close();
  }
});

test('checksum falls back to the API digest field', async () => {
  const routes = new Map();
  const srv = await startFixtureServer(routes);
  try {
    routes.set('/releases/latest', {
      body: JSON.stringify(releaseJson(srv.base, { withSidecar: false })),
      contentType: 'application/json',
    });
    const release = await fetchLatestRelease(`${srv.base}/releases/latest`);
    const out = await resolveAssetSha256(release, release.assets[0]);
    assert.equal(out.sha256, FAKE_HEX);
    assert.equal(out.source, 'release API digest');
  } finally {
    srv.close();
  }
});

test('refuses artifacts with no verifiable checksum', async () => {
  const routes = new Map();
  const srv = await startFixtureServer(routes);
  try {
    routes.set('/releases/latest', {
      body: JSON.stringify(releaseJson(srv.base, { withSidecar: false, withDigest: false })),
      contentType: 'application/json',
    });
    const release = await fetchLatestRelease(`${srv.base}/releases/latest`);
    await assert.rejects(() => resolveAssetSha256(release, release.assets[0]), /no SHA-256 available/);
  } finally {
    srv.close();
  }
});

test('release lookup fails cleanly on 404 (no releases yet)', async () => {
  const routes = new Map();
  const srv = await startFixtureServer(routes);
  try {
    await assert.rejects(() => fetchLatestRelease(`${srv.base}/releases/latest`), /HTTP 404/);
  } finally {
    srv.close();
  }
});
