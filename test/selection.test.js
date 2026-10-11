import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBuildChannel } from '../src/cli/selection.js';

test('explicit channel flag wins without prompting', async () => {
  assert.equal(await selectBuildChannel({ channelFlag: 'alpha' }), 'alpha');
  assert.equal(await selectBuildChannel({ channelFlag: 'ALPHA' }), 'alpha');
  assert.equal(await selectBuildChannel({ channelFlag: 'stable' }), 'stable');
});

test('unknown channel flag is rejected', async () => {
  await assert.rejects(() => selectBuildChannel({ channelFlag: 'beta' }), /unknown build channel/);
});

test('local package skips the build prompt', async () => {
  assert.equal(await selectBuildChannel({ hasLocalPackage: true }), 'stable');
});
