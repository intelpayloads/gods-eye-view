import assert from 'node:assert/strict';
import test from 'node:test';
import { createBikeshareSource } from './source.js';

/** Resolve logical provider paths unchanged, as the standalone composition does. */
const api = (path) => path;
test('station source keeps upstream URLs behind the fixed GBFS endpoint', async () => {
  const calls = [];
  const source = createBikeshareSource({
    api,
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response('{"data":{"stations":[]}}');
    },
  });
  for (const url of [
    'file:///etc/passwd',
    'http://example.test/stations',
    'https://user:pass@example.test/stations',
  ])
    await assert.rejects(source.getStations(url), /HTTPS GBFS/);
  assert.equal(calls.length, 0);
  await source.getStations('https://example.test/stations.json');
  const url = new URL(calls[0][0], 'https://app.example');
  assert.equal(url.pathname, '/api/gbfs');
  assert.equal(
    url.searchParams.get('url'),
    'https://example.test/stations.json',
  );
});
test('cancelled station parsing never publishes the response', async () => {
  const controller = new AbortController();
  const source = createBikeshareSource({
    api,
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { data: { stations: [] } };
      },
    }),
  });
  await assert.rejects(
    source.getStations('https://example.test/stations', {
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});

test('the GBFS route resolves through the supplied api, which is required', async () => {
  assert.throws(() => createBikeshareSource(), /requires an api/);
  const calls = [];
  const source = createBikeshareSource({
    api: (path) => `https://compat.test${path}`,
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return new Response('{"data":{"stations":[]}}');
    },
  });
  await source.getStations('https://example.test/stations.json');
  assert.equal(calls[0].origin, 'https://compat.test');
  assert.equal(calls[0].pathname, '/api/gbfs');
});
