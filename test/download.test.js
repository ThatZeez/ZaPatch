import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadFile } from '../src/patcher/download.js';
import { startFixtureServer } from './fixture-server.js';

const PAYLOAD = Buffer.from('fake-archive-bytes');

function sha(b) {
  return crypto.createHash('sha256').update(b).digest('hex');
}

test('downloads a file and verifies its hash', async () => {
  const routes = new Map([['/asset.zip', { body: PAYLOAD }]]);
  const srv = await startFixtureServer(routes);
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));
    const dest = path.join(dir, 'asset.zip');
    let seen = null;
    const out = await downloadFile(`${srv.base}/asset.zip`, dest, {
      expectedSha256: sha(PAYLOAD),
      onProgress: (p) => {
        seen = p;
      },
    });
    assert.equal(out.sha256, sha(PAYLOAD));
    assert.ok(seen && seen.downloaded === PAYLOAD.length);
    await fs.rm(dir, { recursive: true, force: true });
  } finally {
    srv.close();
  }
});

test('hash mismatch rejects and deletes the file', async () => {
  const routes = new Map([['/asset.zip', { body: PAYLOAD }]]);
  const srv = await startFixtureServer(routes);
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));
    const dest = path.join(dir, 'asset.zip');
    await assert.rejects(
      () => downloadFile(`${srv.base}/asset.zip`, dest, { expectedSha256: '0'.repeat(64) }),
      /SHA-256 mismatch/,
    );
    assert.equal(await fs.stat(dest).then(() => true).catch(() => false), false);
    await fs.rm(dir, { recursive: true, force: true });
  } finally {
    srv.close();
  }
});

test('follows redirects', async () => {
  const routes = new Map([
    ['/old', { redirect: '/asset.zip' }],
    ['/asset.zip', { body: PAYLOAD }],
  ]);
  const srv = await startFixtureServer(routes);
  try {
    routes.get('/old').redirect = `${srv.base}/asset.zip`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));
    const dest = path.join(dir, 'asset.zip');
    const out = await downloadFile(`${srv.base}/old`, dest, { expectedSha256: sha(PAYLOAD) });
    assert.equal(out.bytes, PAYLOAD.length);
    await fs.rm(dir, { recursive: true, force: true });
  } finally {
    srv.close();
  }
});
