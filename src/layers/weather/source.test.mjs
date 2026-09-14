import assert from 'node:assert/strict';
import test from 'node:test';
import { createWeatherEffectsSource } from './source.js';

test('the weather observation resolves through the supplied api, which is required', async () => {
  assert.throws(() => createWeatherEffectsSource(), /requires an api/);
  const calls = [];
  const source = createWeatherEffectsSource({
    api: (path) => `https://compat.test${path}`,
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return new Response('{"weather":{"cloudCover":40},"status":"ready"}');
    },
  });
  const payload = await source.getObservation({
    latitude: 30.123456,
    longitude: -97.5,
  });
  assert.deepEqual(payload.weather, { cloudCover: 40 });
  assert.equal(
    calls[0].origin + calls[0].pathname,
    'https://compat.test/api/weather-effects',
  );
  assert.equal(calls[0].searchParams.get('latitude'), '30.12346');
  assert.equal(calls[0].searchParams.get('longitude'), '-97.50000');
});

test('unavailable or empty observations are errors, never a clear sky', async () => {
  const point = { latitude: 30, longitude: -97 };
  const failed = createWeatherEffectsSource({
    api: (path) => path,
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(failed.getObservation(point), /unavailable \(503\)/);
  const empty = createWeatherEffectsSource({
    api: (path) => path,
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(empty.getObservation(point), /observation unavailable/);
  await assert.rejects(
    empty.getObservation({ latitude: NaN, longitude: 0 }),
    /observation point/,
  );
});
