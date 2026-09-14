import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirmsSource } from './source.js';

/** Resolve logical provider paths unchanged, as the standalone composition does. */
const api = (path) => path;

test('a malformed successful response is never accepted as an empty fire snapshot', async () => {
  for (const payload of [{}, { fires: null }, { fires: {} }]) {
    const source = createFirmsSource({
      api,
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    });
    await assert.rejects(source.getSnapshot(), /Malformed fire snapshot/);
  }
});
test('optional-key guidance is distinct from denial or upstream failure', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const source = createFirmsSource({
      api,
      fetchImpl: async () => ({
        ok: false,
        status,
        json: async () => ({ error: 'no_key' }),
      }),
    });
    if (status === 503)
      assert.deepEqual(await source.getSnapshot(), { keyRequired: true });
    else
      await assert.rejects(
        source.getSnapshot(),
        new RegExp(`FIRMS HTTP ${status}`),
      );
  }
});
test('response-body completion honors cancellation without replacing records', async () => {
  const abort = new AbortController();
  const source = createFirmsSource({
    api,
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { fires: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('the fire route resolves through the supplied api, which is required', async () => {
  assert.throws(() => createFirmsSource(), /requires an api/);
  const calls = [];
  const source = createFirmsSource({
    api: (path) => `https://compat.test${path}`,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('{"fires":[]}');
    },
  });
  assert.deepEqual(await source.getSnapshot(), { fires: [] });
  assert.deepEqual(calls, ['https://compat.test/api/firms']);
});
