/** Render this moment (GEN-369) exists only where the host gave God's Eye a way to render. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountRunRender } from './index.js';

test('no renderSource, no RENDER: nothing is mounted and the player carries on', () => {
  const touched = [];
  const saved = globalThis.document;
  globalThis.document = new Proxy({}, { get: (_, key) => touched.push(key) && undefined });
  try {
    const node = {};
    assert.equal(mountRunRender({ renderSource: null, viewer: { container: node }, playerRoot: node, controls: node }), null);
    assert.equal(mountRunRender({ renderSource: {}, viewer: null, playerRoot: node, controls: node }), null);
    assert.deepEqual(touched, [], 'the page is not touched');
  } finally {
    globalThis.document = saved;
  }
});
