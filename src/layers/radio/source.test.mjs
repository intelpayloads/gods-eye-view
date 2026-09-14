import assert from 'node:assert/strict';
import test from 'node:test';
import { createRadioSource } from './source.js';

test('the station directory resolves through the supplied api, which is required', async () => {
  assert.throws(() => createRadioSource(), /requires an api/);
  const calls = [];
  const source = createRadioSource({
    api: (path) => `https://compat.test${path}`,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response('{"stations":[]}');
    },
  });
  const controller = new AbortController();
  assert.deepEqual(await source.getDirectory({ signal: controller.signal }), {
    stations: [],
  });
  assert.equal(calls[0].url, 'https://compat.test/api/radio/stations');
  assert.equal(calls[0].options.signal, controller.signal);
});

test('a failed directory response is an error with its status', async () => {
  const source = createRadioSource({
    api: (path) => path,
    fetchImpl: async () => new Response('', { status: 502 }),
  });
  await assert.rejects(source.getDirectory(), /Radio directory returned 502/);
});
