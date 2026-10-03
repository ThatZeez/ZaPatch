import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applySelfUpdate, cleanupStaleBackup, isNewer, normalizeTag } from '../src/patcher/updater.js';
import { startFixtureServer } from './fixture-server.js';

test('version comparison handles v prefixes', () => {
  assert.equal(normalizeTag('v0.2.0'), '0.2.0');
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
});

test('self-update swaps the exe and keeps .old until cleanup', async () => {
  const NEW_EXE = Buffer.from('MZ-fake-new-exe');
  const OLD_EXE = Buffer.from('MZ-fake-old-exe');
  const routes = new Map([['/ZaPatch.exe', { body: NEW_EXE }]]);
  const srv = await startFixtureServer(routes);
  try {
    const crypto = await import('node:crypto');
    const hex = crypto.createHash('sha256').update(NEW_EXE).digest('hex');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'selfupd-'));
    const exe = path.join(dir, 'ZaPatch.exe');
    await fs.writeFile(exe, OLD_EXE);
    const asset = { name: 'ZaPatch.exe', url: `${srv.base}/ZaPatch.exe`, size: NEW_EXE.length, digest: hex };
    const release = { tag: 'v9.9.9', assets: [asset] };

    const out = await applySelfUpdate({ exePath: exe, asset, release });
    assert.equal(out.exePath, exe);
    assert.equal((await fs.readFile(exe)).toString(), NEW_EXE.toString());
    assert.equal((await fs.readFile(out.backupExe)).toString(), OLD_EXE.toString());
    assert.equal(await cleanupStaleBackup(exe), true);
    assert.equal(await fs.stat(out.backupExe).then(() => true).catch(() => false), false);
    await fs.rm(dir, { recursive: true, force: true });
  } finally {
    srv.close();
  }
});

test('self-update refuses non-exe runtimes', async () => {
  const { applySelfUpdate } = await import('../src/patcher/updater.js');
  await assert.rejects(
    () => applySelfUpdate({ exePath: '/usr/local/bin/zapatch', asset: { name: 'x', url: 'http://x' }, release: { tag: 'v1' } }),
    /non-exe runtime/,
  );
});
