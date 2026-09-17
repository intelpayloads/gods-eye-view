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
function fixtureProjectionSource(projection = PROJECTION) {
  const demands = [];
  return {
    demands,
    async getRevisions({ head }) {
      return { head, revisions: [{ id: projection.revision_id }] };
    },
    async getProjection(demand) {
      demands.push(demand);
      return projection;
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
        layerSources: { satellites: 'world' },
        projectionSource,
      }),
    /Layer satellites has no world adapter/,
    'the shipped registry has no satellites adapter',
  );
  assert.throws(
    () =>
      configureLayerSources({
        layerSources: { 'local-firms': 'world' },
        projectionSource,
        worldSources: { 'local-firms': () => null },
      }),
    /world adapter for local-firms returned no source/,
    'a factory that returns nothing fails at configuration',
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

test("a world adapter is built per slot with that slot's provider source, once per configuration", async () => {
  resetLayerSources();
  const built = [];
  const first = createLayerSource('military', {
    label: 'first provider',
    getSnapshot: async () => ({ records: [] }),
  });
  const second = createLayerSource('military', {
    label: 'second provider',
    getSnapshot: async () => ({ records: [] }),
  });
  const restore = configureLayerSources({
    layerSources: { military: 'world' },
    projectionSource: fixtureProjectionSource(),
    head: 'world/test',
    worldSources: {
      military: ({ projectionSource, head, providerSource }) => {
        built.push({ head, providerSource, projectionSource });
        return {
          label: `world over ${providerSource?.label ?? 'nothing'}`,
          getSnapshot: async () => ({ records: [] }),
        };
      },
    },
  });
  try {
    assert.equal(first.label, 'world over first provider');
    assert.equal(second.label, 'world over second provider');
    await first.getSnapshot();
    await second.getSnapshot();
    assert.equal(
      built.filter((b) => b.providerSource).length,
      2,
      'one adapter per slot, built once each',
    );
    assert.equal(
      built[0].providerSource,
      undefined,
      'the configuration probe carries no provider source',
    );
    for (const b of built.slice(1)) assert.equal(b.head, 'world/test');
  } finally {
    restore();
  }
  assert.equal(first.label, 'first provider');
});

test("the shipped registry configures flights: 'world': snapshots read the ProjectionSource, trails still reach the provider", async () => {
  resetLayerSources();
  const requests = [];
  const slot = createLayerSource(
    'flights',
    createOpenSkySource({
      api: (path) => path,
      fetchImpl: async (url) => {
        requests.push(url);
        return new Response('{"path":[]}');
      },
    }),
  );
  const projectionSource = fixtureProjectionSource({
    ...PROJECTION,
    points: [
      {
        id: 'world.aircraft/track:opensky:icao24:a1b2c3',
        position: { lon: -97.7, lat: 30.2, height_m: 1000 },
        height: { barometric_height_m: 950 },
        time: {
          valid_at: '2026-09-17T15:00:05+00:00',
          sampled_at: '2026-09-17T15:00:00+00:00',
        },
        semantic_ref: { semantic_identity: 'track:opensky:icao24:a1b2c3' },
        properties: { callsign: 'ABC123', velocity_mps: 200 },
      },
    ],
  });
  const restore = configureLayerSources({
    layerSources: { flights: 'world' },
    projectionSource,
    head: 'world/test',
  });
  try {
    assert.equal(layerSourceMode('flights'), 'world');
    assert.equal(slot.label, 'World model (OpenSky)');
    const snapshot = await slot.getSnapshot({ latitude: 30, longitude: -97 });
    assert.deepEqual(
      snapshot.records.map((r) => [r.id, r.callsign, r.speedMps]),
      [['a1b2c3', 'ABC123', 200]],
    );
    assert.equal(projectionSource.demands.length, 1);
    assert.equal(projectionSource.demands[0].head, 'world/test');
    assert.deepEqual(projectionSource.demands[0].query.type_filter, [
      'aircraft.track_state_set.v1',
    ]);
    assert.deepEqual(requests, [], '/api/opensky was never fetched');
    await slot.getTrack('a1b2c3');
    assert.deepEqual(requests, ['/api/opensky-track?icao24=a1b2c3']);
  } finally {
    restore();
  }
});

test("the shipped registry configures earthquakes: 'world' and reads the ProjectionSource", async () => {
  resetLayerSources();
  assert.deepEqual(Object.keys(WORLD_LAYER_SOURCES), [
    'earthquakes',
    'flights',
  ]);
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
