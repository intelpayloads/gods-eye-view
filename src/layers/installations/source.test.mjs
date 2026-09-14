import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstallationSource } from './source.js';

/** Resolve logical provider paths unchanged, as the standalone composition does. */
const api = (path) => path;

const box = { south: 30.1, west: -97.9, north: 30.3, east: -97.6 };
test('mapped-site sources validate viewport bounds and preserve the exact retry key', async () => {
  const calls = [];
  const source = createInstallationSource({
    api,
    fetchImpl: async (url) => {
      calls.push(new URL(url, 'https://example.test'));
      return new Response(JSON.stringify({ elements: [], status: 'stale' }));
    },
  });
  for (const invalid of [
    null,
    { ...box, east: Infinity },
    { ...box, north: 90 },
    { ...box, south: 31 },
  ])
    await assert.rejects(
      source.getMappedSites(invalid),
      /bounded installation viewport/,
    );
  assert.equal(calls.length, 0);
  const payload = await source.getMappedSites(box, { exact: true });
  assert.equal(payload.status, 'stale');
  assert.equal(calls[0].pathname, '/api/military-installations');
  assert.equal(calls[0].searchParams.get('exact'), '1');
  assert.equal(calls[0].searchParams.get('south'), '30.10000');
});
test('malformed installation and place snapshots are never accepted as empty success', async () => {
  const source = createInstallationSource({
    api,
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(
    source.getMappedSites(box),
    /Malformed installation snapshot/,
  );
  await assert.rejects(
    source.searchNearby({ latitude: 30.2, longitude: -97.7, radiusM: 1000 }),
    /Malformed nearby-place snapshot/,
  );
});
test('installation response parsing respects cancellation before any follow-on search', async () => {
  const controller = new AbortController();
  const source = createInstallationSource({
    api,
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { elements: [] };
      },
    }),
  });
  await assert.rejects(
    source.getMappedSites(box, { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('installation routes resolve through the supplied api, which is required', async () => {
  assert.throws(() => createInstallationSource(), /requires an api/);
  const calls = [];
  const source = createInstallationSource({
    api: (path) => `https://compat.test${path}`,
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return new Response('{"elements":[],"places":[]}');
    },
  });
  await source.getMappedSites(box);
  await source.searchNearby({
    latitude: 30.2,
    longitude: -97.7,
    radiusM: 1000,
  });
  assert.deepEqual(
    calls.map((url) => url.origin + url.pathname),
    [
      'https://compat.test/api/military-installations',
      'https://compat.test/api/google/text-search',
    ],
  );
});
