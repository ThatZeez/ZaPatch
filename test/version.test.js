import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCompatibility, compareVersions, parseVersion, satisfiesRange, versionMatchesEntry } from '../src/patcher/version.js';

test('parseVersion handles 3- and 4-part versions', () => {
  assert.deepEqual(parseVersion('26.9.10'), { major: 26, minor: 9, patch: 10, build: 0, raw: '26.9.10' });
  assert.equal(parseVersion('26.9.10.2959').build, 2959);
  assert.equal(parseVersion('nope'), null);
});

test('compareVersions orders correctly', () => {
  assert.equal(compareVersions('26.8.20', '26.9.10'), -1);
  assert.equal(compareVersions('26.9.10', '26.9.10'), 0);
  assert.equal(compareVersions('26.10.0', '26.9.10'), 1);
});

test('satisfiesRange is inclusive', () => {
  assert.equal(satisfiesRange('26.9.10', '26.0.0', '26.99.99'), true);
  assert.equal(satisfiesRange('25.0.0', '26.0.0', null), false);
  assert.equal(satisfiesRange('27.0.0', null, '26.99.99'), false);
});

test('checkCompatibility refuses out-of-range', () => {
  assert.throws(() => checkCompatibility('25.0.0', { minZaloVersion: '26.0.0', maxZaloVersion: '26.99.99' }));
});

test('versionMatchesEntry tolerates 4-part FileVersions', () => {
  assert.equal(versionMatchesEntry('26.9.10.2959', '26.9.10'), true);
  assert.equal(versionMatchesEntry('26.9.10', '26.9.10'), true);
  assert.equal(versionMatchesEntry('26.9.11', '26.9.10'), false);
  assert.equal(versionMatchesEntry('25.9.10', '26.9.10'), false);
});

test('checkCompatibility honors supportedZaloVersions list', () => {
  const pkg = { supportedZaloVersions: ['26.9.10'] };
  assert.equal(checkCompatibility('26.9.10.2959', pkg), true);
  assert.equal(checkCompatibility('26.9.10', pkg), true);
  assert.throws(() => checkCompatibility('26.8.20', pkg), /Unsupported Zalo version: 26\.8\.20/);
});
