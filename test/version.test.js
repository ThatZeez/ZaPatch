import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions, parseVersion, satisfiesRange } from '../src/patcher/version.js';
import { checkCompatibility } from '../src/patcher/version.js';

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
