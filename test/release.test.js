import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchLatestRelease, betterZaloRelease, resolveAssetSha256, selectAsset } from '../src/patcher/release.js';
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

function alphaFixture(base) {
  return [
    {
      tag_name: 'v0.2.0',
      name: 'BetterZalo 0.2.0',
      prerelease: false,
      assets: [
        { name: 'BetterZalo-0.2.0-windows.zip', browser_download_url: `${base}/stable.zip`, size: 10 },
      ],
    },
    {
      tag_name: 'v0.3.0-alpha.1',
      name: 'BetterZalo 0.3.0 alpha',
      prerelease: true,
      assets: [
        { name: 'BetterZalo-0.3.0-alpha-windows.zip', browser_download_url: `${base}/alpha.zip`, size: 20, digest: `sha256:${'c'.repeat(64)}` },
      ],
    },
  ];
}

test('alpha channel picks the latest pre-release', async () => {
  const routes = new Map();
  const srv = await startFixtureServer(routes);
  const prev = process.env.BETTERZALO_RELEASE_API;
  try {
    routes.set('/releases?per_page=10', { body: JSON.stringify(alphaFixture(srv.base)), contentType: 'application/json' });
    process.env.BETTERZALO_RELEASE_API = `${srv.base}/releases/latest`;
    const { release, asset, channel } = await betterZaloRelease('alpha');
    assert.equal(channel, 'alpha');
    assert.equal(release.tag, 'v0.3.0-alpha.1');
    assert.equal(asset.name, 'BetterZalo-0.3.0-alpha-windows.zip');
  } finally {
    if (prev === undefined) delete process.env.BETTERZALO_RELEASE_API;
    else process.env.BETTERZALO_RELEASE_API = prev;
    srv.close();
  }
});

test('stable channel uses the latest endpoint', async () => {
  const routes = new Map();
  const srv = await startFixtureServer(routes);
  const prev = process.env.BETTERZALO_RELEASE_API;
  try {
    routes.set('/releases/latest', {
      body: JSON.stringify({ tag_name: 'v0.2.0', prerelease: false, assets: [{ name: 'BetterZalo-0.2.0-windows.zip', browser_download_url: `${srv.base}/s.zip`, digest: `sha256:${'d'.repeat(64)}` }] }),
      contentType: 'application/json',
    });
    process.env.BETTERZALO_RELEASE_API = `${srv.base}/releases/latest`;
    const { release, channel } = await betterZaloRelease('stable');
    assert.equal(channel, 'stable');
    assert.equal(release.tag, 'v0.2.0');
  } finally {
    if (prev === undefined) delete process.env.BETTERZALO_RELEASE_API;
    else process.env.BETTERZALO_RELEASE_API = prev;
    srv.close();
  }
});

test('alpha channel fails clearly when no pre-release exists', async () => {
  const routes = new Map();
  const srv = await startFixtureServer(routes);
  const prev = process.env.BETTERZALO_RELEASE_API;
  try {
    routes.set('/releases?per_page=10', {
      body: JSON.stringify([{ tag_name: 'v0.2.0', prerelease: false, assets: [] }]),
      contentType: 'application/json',
    });
    process.env.BETTERZALO_RELEASE_API = `${srv.base}/releases/latest`;
    await assert.rejects(() => betterZaloRelease('alpha'), /no alpha\/pre-release build/);
  } finally {
    if (prev === undefined) delete process.env.BETTERZALO_RELEASE_API;
    else process.env.BETTERZALO_RELEASE_API = prev;
    srv.close();
  }
});

test('unknown channel is rejected', async () => {
  await assert.rejects(() => betterZaloRelease('beta'), /unknown build channel/);
});
