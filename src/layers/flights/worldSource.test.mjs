import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIRCRAFT_PRODUCT_TYPE,
  createWorldFlightSource,
  WORLD_FLIGHT_COVERAGE,
  WORLD_FLIGHT_SOURCE_LABEL,
} from './worldSource.js';
import { openSkySnapshot } from '../../sources/live/aircraft.js';
import { createOpenSkySource } from '../../sources/live/standalone.js';

const T = '2026-09-17T15:00:05+00:00'; // the product's selection time
const T_MS = Date.parse(T);
const NOW = T_MS + 30_000;

/** A projected aircraft point the way the backplane's positioned_entities projector emits it. */
function point({
  icao24,
  identity = icao24
    ? `track:opensky:icao24:${icao24}`
    : 'track:opensky:icao24:',
  lon,
  lat,
  geoAlt = 1000,
  baroAlt = 950,
  callsign = 'ABC123  ',
  onGround = false,
  speed = 200,
  track = 90,
  category = 3,
  sampledAtS = 1789570800,
  validAt = T,
}) {
  return {
    id: `world.aircraft/${identity}`,
    binding: 'world.aircraft',
    position: { lon, lat, height_m: geoAlt },
    frame: 'WGS84',
    height: {
      value_m: geoAlt,
      source_field: 'geometric_height_m',
      assumption: 'aircraft_height:adsb-geometric-as-wgs84-ellipsoid',
      interpretation: 'explicit-grant',
      barometric_height_m: baroAlt,
    },
    time: {
      valid_at: validAt,
      sampled_at: new Date(sampledAtS * 1000).toISOString(),
      known_as_of: '2026-09-17T15:00:06+00:00',
      age_seconds: 5,
      temporal_status: 'held-report',
    },
    semantic_ref: {
      product_ref: { type_id: AIRCRAFT_PRODUCT_TYPE, content_id: 'sha256:1' },
      descriptor_id: 'd1',
      type_id: AIRCRAFT_PRODUCT_TYPE,
      semantic_identity: identity,
    },
    source_ref: null,
    properties: {
      identity: { scope: 'provider', provider: 'opensky', key: 'icao24' },
      callsign,
      category,
      on_ground: onGround,
      velocity_mps: speed,
      true_track_deg: track,
      position_source: 0,
      height_datum: 'wgs84-ellipsoid',
      selected_at: T_MS / 1000,
      known_as_of: T_MS / 1000 + 1,
      observation_ref: { type_id: 'aircraft.observation_set.v1' },
      assertion_ref: { type_id: 'aircraft.identity_assertion_set.v1' },
    },
  };
}

/** The same aircraft as an OpenSky state vector row (18 columns). */
function stateOf(p) {
  const s = p.properties;
  return [
    p.semantic_ref.semantic_identity.split(':').at(-1),
    s.callsign,
    '',
    Date.parse(p.time.sampled_at) / 1000,
    Date.parse(p.time.sampled_at) / 1000,
    p.position.lon,
    p.position.lat,
    p.height.barometric_height_m,
    s.on_ground,
    s.velocity_mps,
    s.true_track_deg,
    null,
    null,
    p.position.height_m,
    null,
    false,
    s.position_source,
    s.category,
  ];
}

function projectionOf(points) {
  return {
    revision_id: 'rev-1',
    points,
    lines: [],
    polygons: [],
    field_samples: [],
    annotations: [],
    assumptions: [],
    omissions: [],
  };
}

/** A ProjectionSource that records each demand and answers one projection. */
function fixtureProjectionSource(projection) {
  const demands = [];
  return {
    demands,
    async getRevisions({ head }) {
      return { head, revisions: [{ id: 'rev-1' }] };
    },
    async getProjection(demand) {
      demands.push(demand);
      return projection;
    },
  };
}

const POINTS = [
  point({ icao24: 'a1b2c3', lon: -97.7, lat: 30.2 }),
  point({
    icao24: '3c6444',
    lon: 8.5,
    lat: 50.0,
    geoAlt: 11000,
    baroAlt: 10668,
    callsign: 'DLH400',
    speed: 240,
    track: 275.5,
    category: 6,
    sampledAtS: 1789570803,
  }),
  point({
    icao24: 'ABCDEF',
    lon: 151.2,
    lat: -33.9,
    geoAlt: 12,
    baroAlt: null,
    callsign: '',
    onGround: true,
    speed: 4,
    track: 0,
    category: null,
  }),
];

test('a projection becomes the snapshot the direct OpenSky source builds from the same states', async () => {
  const world = createWorldFlightSource({
    projectionSource: fixtureProjectionSource(projectionOf(POINTS)),
    head: 'world/main',
    now: () => NOW,
  });
  const direct = openSkySnapshot(
    { time: T_MS / 1000, states: POINTS.map(stateOf) },
    { now: NOW },
  );
  const snapshot = await world.getSnapshot();
  assert.deepEqual(snapshot.records, direct.records);
  assert.equal(snapshot.records[0].id, 'a1b2c3');
  assert.equal(snapshot.records[0].callsign, 'ABC123');
  assert.equal(snapshot.records[2].id, 'abcdef', 'icao24 is lower-cased');
  assert.equal(snapshot.records[2].onGround, true);
  assert.equal(snapshot.records[2].baroAltitudeM, null);
  assert.equal(snapshot.records[2].category, null);
  for (const key of [
    'complete',
    'rejectedCount',
    'observedAtMs',
    'ageMs',
    'stale',
    'freshness',
  ])
    assert.deepEqual(snapshot[key], direct[key], key);
  assert.equal(snapshot.observedAtMs, T_MS);
  assert.equal(snapshot.ageMs, 30_000);
  assert.equal(snapshot.freshness, 'current');
  assert.equal(snapshot.source, WORLD_FLIGHT_SOURCE_LABEL);
  assert.equal(snapshot.coverage, WORLD_FLIGHT_COVERAGE);
  assert.equal(snapshot.status, 200);
});

test('the direct source and the world adapter agree end to end for the same states', async () => {
  const direct = createOpenSkySource({
    api: (path) => path,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ time: T_MS / 1000, states: POINTS.map(stateOf) }),
      ),
    now: () => NOW,
  });
  const world = createWorldFlightSource({
    projectionSource: fixtureProjectionSource(projectionOf(POINTS)),
    head: 'world/main',
    now: () => NOW,
  });
  const [a, b] = await Promise.all([
    direct.getSnapshot({ latitude: 30, longitude: -97 }),
    world.getSnapshot({ latitude: 30, longitude: -97 }),
  ]);
  assert.deepEqual(
    { ...b, source: a.source, coverage: a.coverage },
    a,
    'only the source and coverage labels differ',
  );
});

test('one demand per snapshot: head, type filter, the world.aircraft binding, wall-clock valid_at, the height grant, no policy, the signal; the viewport query is not sent', async () => {
  const projectionSource = fixtureProjectionSource(projectionOf(POINTS));
  const source = createWorldFlightSource({
    projectionSource,
    head: 'world/test',
    now: () => 1789600000123,
  });
  const controller = new AbortController();
  await source.getSnapshot(
    { latitude: 30.25, longitude: -97.75 },
    { signal: controller.signal },
  );
  assert.equal(projectionSource.demands.length, 1);
  const demand = projectionSource.demands[0];
  assert.equal(demand.head, 'world/test');
  assert.equal(demand.revisionId, undefined);
  assert.deepEqual(demand.query, {
    type_filter: ['aircraft.track_state_set.v1'],
    requested_layers: ['world.aircraft'],
    valid_at: '2026-09-16T23:06:40.000Z',
  });
  assert.deepEqual(demand.projectionSpec, {
    display_assumptions: {
      aircraft_height: 'adsb-geometric-as-wgs84-ellipsoid',
    },
  });
  assert.equal(demand.signal, controller.signal);
});

test('trails and enrichment delegate to the provider source unchanged', async () => {
  const calls = [];
  const providerSource = {
    label: 'OpenSky Network',
    async getSnapshot() {
      calls.push(['getSnapshot']);
      return { records: [] };
    },
    async getTrack(reference, options) {
      calls.push(['getTrack', reference, options]);
      return { records: [{ latitude: 1 }], complete: false };
    },
    async getEnrichment(query, options) {
      calls.push(['getEnrichment', query, options]);
      return { found: true };
    },
  };
  const source = createWorldFlightSource({
    projectionSource: fixtureProjectionSource(projectionOf([])),
    head: 'world/main',
    providerSource,
  });
  const controller = new AbortController();
  const options = { signal: controller.signal };
  assert.deepEqual(await source.getTrack('a1b2c3', options), {
    records: [{ latitude: 1 }],
    complete: false,
  });
  assert.deepEqual(
    await source.getEnrichment({ kind: 'type', id: 'a1b2c3' }, options),
    { found: true },
  );
  await source.getSnapshot();
  assert.deepEqual(calls, [
    ['getTrack', 'a1b2c3', options],
    ['getEnrichment', { kind: 'type', id: 'a1b2c3' }, options],
  ]);
  assert.equal(source.label, WORLD_FLIGHT_SOURCE_LABEL);
});

test('without a provider source, trails and enrichment are unsupported, not failures of the snapshot', async () => {
  const source = createWorldFlightSource({
    projectionSource: fixtureProjectionSource(projectionOf(POINTS)),
    head: 'world/main',
  });
  for (const call of [
    () => source.getTrack('a1b2c3'),
    () => source.getEnrichment({ kind: 'type', id: 'a1b2c3' }),
  ])
    await assert.rejects(
      call,
      (error) =>
        error.name === 'LiveSourceError' && error.code === 'unsupported',
    );
  assert.equal((await source.getSnapshot()).records.length, 3);
});

test('a snapshot older than two minutes is stale, as the direct source reports it', async () => {
  const old = '2026-09-17T14:57:00+00:00';
  const source = createWorldFlightSource({
    projectionSource: fixtureProjectionSource(
      projectionOf([point({ icao24: 'a1b2c3', lon: 0, lat: 0, validAt: old })]),
    ),
    head: 'world/main',
    now: () => NOW,
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.observedAtMs, Date.parse(old));
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.freshness, 'stale');
});

test('an empty projection is an empty, current-less snapshot, not an error', async () => {
  const source = createWorldFlightSource({
    projectionSource: fixtureProjectionSource(projectionOf([])),
    head: 'world/main',
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(snapshot.records, []);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.rejectedCount, 0);
  assert.equal(snapshot.observedAtMs, null);
  assert.equal(snapshot.ageMs, null);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.freshness, 'unknown');
});

test('a point the layer cannot place is rejected and counted, like a bad state vector', async () => {
  const source = createWorldFlightSource({
    projectionSource: fixtureProjectionSource(
      projectionOf([
        point({ icao24: 'a1b2c3', lon: -97.7, lat: 30.2 }),
        point({ icao24: 'bad000', lon: 400, lat: 0 }),
        point({ identity: 'track:opensky:icao24:', lon: 1, lat: 1 }),
        { id: 'world.aircraft/x', properties: null },
      ]),
    ),
    head: 'world/main',
    now: () => NOW,
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(
    snapshot.records.map((r) => r.id),
    ['a1b2c3'],
  );
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.rejectedCount, 3);
});

test('a malformed projection rejects instead of replacing the displayed aircraft', async () => {
  for (const projection of [
    null,
    {},
    { points: 'nope' },
    projectionOf([point({ icao24: 'bad', lon: 400, lat: 0 })]),
    projectionOf([{ id: 'world.aircraft/x', properties: null }]),
  ]) {
    const source = createWorldFlightSource({
      projectionSource: fixtureProjectionSource(projection),
      head: 'world/main',
    });
    await assert.rejects(
      source.getSnapshot(),
      (error) => error.name === 'LiveSourceError' && error.code === 'malformed',
    );
  }
});

test('a source error propagates unchanged', async () => {
  const failure = new Error('World model unreachable');
  const source = createWorldFlightSource({
    projectionSource: {
      async getProjection() {
        throw failure;
      },
    },
    head: 'world/main',
  });
  await assert.rejects(source.getSnapshot(), (error) => error === failure);
});

test('an aborted signal is honoured before and after the request', async () => {
  const projectionSource = fixtureProjectionSource(projectionOf(POINTS));
  const source = createWorldFlightSource({
    projectionSource,
    head: 'world/main',
  });
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    source.getSnapshot({}, { signal: before.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(projectionSource.demands.length, 0);

  const during = new AbortController();
  const late = {
    async getProjection() {
      during.abort();
      return projectionOf(POINTS);
    },
  };
  await assert.rejects(
    createWorldFlightSource({
      projectionSource: late,
      head: 'world/main',
    }).getSnapshot({}, { signal: during.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('the adapter refuses to build without a ProjectionSource or a head', () => {
  assert.throws(
    () => createWorldFlightSource({ head: 'world/main' }),
    /requires a ProjectionSource/,
  );
  assert.throws(
    () =>
      createWorldFlightSource({
        projectionSource: fixtureProjectionSource(projectionOf([])),
      }),
    /requires a head/,
  );
});
