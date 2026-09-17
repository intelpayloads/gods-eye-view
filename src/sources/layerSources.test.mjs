import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureLayerSources,
  createLayerSource,
  LAYER_SOURCE_KEYS,
  layerSourceMode,
  resetLayerSources,
  WORLD_LAYER_SOURCES,
} from './layerSources.js';
import {
  createAdsbLolSource,
  createAisStreamSource,
  createOpenSkySource,
} from './live/standalone.js';
import { createSatelliteSource } from '../layers/satellites/source.js';
import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createFirmsSource } from '../layers/firms/source.js';
import { createLaunchSource } from '../layers/launches/source.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createInstallationSource } from '../layers/installations/source.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';
import { createRadioSource } from '../layers/radio/source.js';
import { createWeatherEffectsSource } from '../layers/weather/source.js';

/** Each key's provider source, as the standalone composition builds it. */
const PROVIDER_SOURCES = Object.freeze({
  flights: createOpenSkySource,
  military: createAdsbLolSource,
  'ais-live-vessels': createAisStreamSource,
  satellites: createSatelliteSource,
  earthquakes: createUsgsEarthquakeSource,
  'local-firms': createFirmsSource,
  'rocket-launches': createLaunchSource,
  traffic: createTrafficSource,
  cctv: createCctvSource,
  'military-installations': createInstallationSource,
  bikeshare: createBikeshareSource,
  radio: createRadioSource,
  'weather-effects': createWeatherEffectsSource,
});

const PROJECTION = Object.freeze({
  revision_id: 'rev-1',
  points: [
    {
      id: 'fire:viirs:1',
      position: { lon: -97.7, lat: 30.2 },
      properties: { frp: 12.5 },
    },
  ],
  lines: [],
  polygons: [],
  field_samples: [],
  annotations: [],
  assumptions: [],
  omissions: [],
});

/** An in-memory ProjectionSource that records each demand. */
function fixtureProjectionSource() {
  const demands = [];
  return {
    demands,
    async getRevisions({ head }) {
      return { head, revisions: [{ id: PROJECTION.revision_id }] };
    },
    async getProjection(demand) {
      demands.push(demand);
      return PROJECTION;
    },
  };
}

/** A FIRMS world adapter written the way a connector ticket would. */
const firesFromWorld = ({ projectionSource, head }) => ({
  async getSnapshot({ signal } = {}) {
    const projection = await projectionSource.getProjection({
      head,
      query: { type_id: 'fire.detection_set.v1' },
      signal,
    });
    return {
      fires: projection.points.map((point) => ({
        id: point.id,
        latitude: point.position.lat,
        longitude: point.position.lon,
        frp: point.properties.frp,
      })),
    };
  },
});

function countingFirmsProvider() {
  const requests = [];
  const source = createFirmsSource({
    api: (path) => path,
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response('{"fires":[{"id":"provider"}]}');
    },
  });
  return { requests, source };
}

test('every layer source key has a provider source and the registry holds only known keys', () => {
  assert.deepEqual(
    Object.keys(PROVIDER_SOURCES).sort(),
    [...LAYER_SOURCE_KEYS].sort(),
  );
  for (const key of Object.keys(WORLD_LAYER_SOURCES))
    assert.ok(LAYER_SOURCE_KEYS.includes(key), `unknown adapter key ${key}`);
});

test('by default a slot delegates to its provider source', async () => {
  resetLayerSources();
  const { requests, source } = countingFirmsProvider();
  const slot = createLayerSource('local-firms', source);
  assert.deepEqual(Object.keys(slot), Object.keys(source));
  assert.equal(layerSourceMode('local-firms'), 'provider');
  assert.deepEqual(await slot.getSnapshot(), { fires: [{ id: 'provider' }] });
  assert.deepEqual(requests, ['/api/firms']);
});

test('a world slot reads the ProjectionSource through its adapter and never calls the provider', async () => {
  resetLayerSources();
  const { requests, source } = countingFirmsProvider();
  const slot = createLayerSource('local-firms', source);
  const projectionSource = fixtureProjectionSource();
  const restore = configureLayerSources({
    layerSources: { 'local-firms': 'world' },
    projectionSource,
    head: 'world/test',
    worldSources: { 'local-firms': firesFromWorld },
  });
  try {
    assert.equal(layerSourceMode('local-firms'), 'world');
    const controller = new AbortController();
    const snapshot = await slot.getSnapshot({ signal: controller.signal });
    assert.deepEqual(snapshot, {
      fires: [
        { id: 'fire:viirs:1', latitude: 30.2, longitude: -97.7, frp: 12.5 },
      ],
    });
    assert.equal(projectionSource.demands.length, 1);
    assert.equal(projectionSource.demands[0].head, 'world/test');
    assert.equal(projectionSource.demands[0].signal, controller.signal);
    assert.deepEqual(requests, [], 'the provider source was never called');
  } finally {
    restore();
  }
  await slot.getSnapshot();
  assert.deepEqual(
    requests,
    ['/api/firms'],
    'restore returns the slot to its provider',
  );
});

test('non-method properties such as a source label follow the active source', () => {
  resetLayerSources();
  const slot = createLayerSource('flights', {
    label: 'OpenSky Network',
    getSnapshot: async () => ({ records: [] }),
  });
  assert.equal(slot.label, 'OpenSky Network');
  const restore = configureLayerSources({
    layerSources: { flights: 'world' },
    projectionSource: fixtureProjectionSource(),
    worldSources: {
      flights: () => ({
        label: 'World model',
        getSnapshot: async () => ({ records: [] }),
      }),
    },
  });
  assert.equal(slot.label, 'World model');
  restore();
  assert.equal(slot.label, 'OpenSky Network');
});

test('unknown keys, unknown modes, missing adapters and a missing ProjectionSource are refused', () => {
  resetLayerSources();
  const projectionSource = fixtureProjectionSource();
  const worldSources = { 'local-firms': firesFromWorld };
  assert.throws(
    () =>
      configureLayerSources({
        layerSources: { fires: 'world' },
        projectionSource,
        worldSources,
      }),
    /Unknown layer source key: fires/,
  );
  assert.throws(
    () =>
      configureLayerSources({
        layerSources: { 'local-firms': 'compat' },
        projectionSource,
        worldSources,
      }),
    /must be 'provider' or 'world'/,
  );
  assert.throws(
    () =>
      configureLayerSources({
        layerSources: { flights: 'world' },
        projectionSource,
        worldSources,
      }),
    /Layer flights has no world adapter/,
  );
  assert.throws(
    () =>
      configureLayerSources({
        layerSources: { flights: 'world' },
        projectionSource,
      }),
    /Layer flights has no world adapter/,
    'the shipped registry has no flights adapter',
  );
  assert.throws(
    () =>
      configureLayerSources({
        layerSources: { 'local-firms': 'world' },
        worldSources,
      }),
    /requires a ProjectionSource/,
  );
  assert.throws(
    () => configureLayerSources({ layerSources: ['flights'] }),
    /must be an object/,
  );
  assert.throws(
    () => createLayerSource('fires', {}),
    /Unknown layer source key/,
  );
  assert.throws(
    () => createLayerSource('flights', null),
    /requires a provider source/,
  );
  assert.equal(
    layerSourceMode('local-firms'),
    'provider',
    'a refused configuration changes nothing',
  );
});

test("explicit 'provider' rows need no adapter or ProjectionSource", () => {
  resetLayerSources();
  const restore = configureLayerSources({
    layerSources: Object.fromEntries(
      LAYER_SOURCE_KEYS.map((key) => [key, 'provider']),
    ),
  });
  for (const key of LAYER_SOURCE_KEYS)
    assert.equal(layerSourceMode(key), 'provider');
  restore();
});

test('a stale restore does not undo a newer layer source configuration', () => {
  resetLayerSources();
  const projectionSource = fixtureProjectionSource();
  const worldSources = { 'local-firms': firesFromWorld };
  const restoreFirst = configureLayerSources({
    layerSources: { 'local-firms': 'world' },
    projectionSource,
    worldSources,
  });
  const restoreSecond = configureLayerSources({ layerSources: {} });
  restoreFirst();
  assert.equal(layerSourceMode('local-firms'), 'provider');
  restoreSecond();
  assert.equal(layerSourceMode('local-firms'), 'world');
  resetLayerSources();
  assert.equal(layerSourceMode('local-firms'), 'provider');
});

test('a world adapter missing a provider method fails that call by name', () => {
  resetLayerSources();
  const slot = createLayerSource(
    'cctv',
    createCctvSource({ api: (path) => path }),
  );
  const restore = configureLayerSources({
    layerSources: { cctv: 'world' },
    projectionSource: fixtureProjectionSource(),
    worldSources: {
      cctv: () => ({ getCatalog: async () => ({ sources: [] }) }),
    },
  });
  try {
    assert.throws(
      () => slot.getHealth(),
      /world adapter for cctv does not implement getHealth\(\)/,
    );
  } finally {
    restore();
  }
});

test("the shipped registry configures earthquakes: 'world' and reads the ProjectionSource", async () => {
  resetLayerSources();
  assert.deepEqual(Object.keys(WORLD_LAYER_SOURCES), ['earthquakes']);
  const requests = [];
  const slot = createLayerSource(
    'earthquakes',
    createUsgsEarthquakeSource({
      fetchImpl: async (url) => {
        requests.push(url);
        return new Response('{"features":[]}');
      },
    }),
  );
  const projectionSource = fixtureProjectionSource();
  const restore = configureLayerSources({
    layerSources: { earthquakes: 'world' },
    projectionSource,
    head: 'world/test',
  });
  try {
    assert.equal(layerSourceMode('earthquakes'), 'world');
    assert.deepEqual(await slot.getSnapshot(), []);
    assert.equal(projectionSource.demands.length, 1);
    assert.equal(projectionSource.demands[0].head, 'world/test');
    assert.deepEqual(projectionSource.demands[0].query.type_filter, [
      'seismic.event_set.v1',
    ]);
    assert.deepEqual(requests, [], 'USGS was never fetched directly');
  } finally {
    restore();
  }
});

test('every registered world adapter exposes its provider source methods', () => {
  for (const [key, adapterFor] of Object.entries(WORLD_LAYER_SOURCES)) {
    const provider = PROVIDER_SOURCES[key]({ api: (path) => path });
    const adapter = adapterFor({
      projectionSource: fixtureProjectionSource(),
      head: 'world/main',
    });
    for (const [name, value] of Object.entries(provider)) {
      if (typeof value === 'function')
        assert.equal(
          typeof adapter[name],
          'function',
          `${key} world adapter lacks ${name}()`,
        );
    }
  }
});
