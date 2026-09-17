import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorldMilitarySource,
  MILITARY_BINDING,
  MILITARY_PRODUCT_TYPE,
  WORLD_MILITARY_COVERAGE,
  WORLD_MILITARY_SOURCE_LABEL,
} from './worldSource.js';
import { readsbSnapshot } from '../../sources/live/aircraft.js';
import { createAdsbLolSource } from '../../sources/live/standalone.js';

const NOW_MS = 1789668370500; // the readsb envelope's `now`; the product's selection time
const T = new Date(NOW_MS).toISOString();
const NOW = NOW_MS + 30_000;

/**
 * A projected military point the way the backplane's positioned_entities
 * projector emits a world.military_aircraft row. `seenPos` and `seen` are
 * exact binary fractions so the direct readsb path computes the same
 * milliseconds.
 */
function point({
  hex,
  identity = hex ? `track:adsblol:icao24:${hex}` : 'track:adsblol:icao24:',
  lon,
  lat,
  geoAltFt = 8075,
  baroAltFt = 7550,
  callsign = 'TSTR38  ',
  onGround = false,
  speedKt = 143.3,
  track = 220.47,
  baroRateFpm = -320,
  category = 'A1',
  typeCode = 'BE20',
  registration = '823132',
  seenPos = 0.5,
  seen = 0.25,
  validAt = T,
}) {
  const nowS = NOW_MS / 1000;
  // The connector converts the same way normalizeReadsbAircraft does.
  const geoAlt = geoAltFt * 0.3048;
  const baroAlt = onGround || baroAltFt == null ? null : baroAltFt * 0.3048;
  const speed = speedKt * 0.514444;
  const verticalRate = baroRateFpm == null ? null : baroRateFpm * 0.00508;
  return {
    id: `${MILITARY_BINDING}/${identity}`,
    binding: MILITARY_BINDING,
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
      sampled_at: new Date((nowS - seenPos) * 1000).toISOString(),
      known_as_of: '2026-09-17T18:06:12+00:00',
      age_seconds: seenPos,
      temporal_status: 'held-report',
    },
    semantic_ref: {
      product_ref: { type_id: MILITARY_PRODUCT_TYPE, content_id: 'sha256:1' },
      descriptor_id: 'd1',
      type_id: MILITARY_PRODUCT_TYPE,
      semantic_identity: identity,
    },
    source_ref: null,
    properties: {
      identity: { scope: 'provider', provider: 'adsblol', key: 'icao24' },
      callsign,
      category,
      on_ground: onGround,
      velocity_mps: speed,
      true_track_deg: track,
      vertical_rate: verticalRate,
      last_contact: nowS - seen,
      position_source: 0,
      message_type: 'adsb_icao',
      registration,
      type_code: typeCode,
      squawk: '0164',
      emergency: 'none',
      height_datum: 'readsb alt_geom',
      selected_at: nowS,
      known_as_of: nowS + 1.5,
      observation_ref: { type_id: 'aircraft.observation_set.v1' },
      assertion_ref: { type_id: 'aircraft.identity_assertion_set.v1' },
    },
    readsb: {
      alt_baro: onGround ? 'ground' : baroAltFt,
      alt_geom: geoAltFt,
      gs: speedKt,
      baro_rate: baroRateFpm,
    },
  };
}

/** The same aircraft as the readsb row the direct adsb.lol source normalizes. */
function rowOf(p) {
  const s = p.properties;
  const nowS = NOW_MS / 1000;
  return {
    hex: p.semantic_ref.semantic_identity.split(':').at(-1),
    type: s.message_type,
    flight: s.callsign,
    r: s.registration,
    t: s.type_code,
    dbFlags: 1,
    alt_baro: p.readsb.alt_baro,
    alt_geom: p.readsb.alt_geom,
    gs: p.readsb.gs,
    track: s.true_track_deg,
    baro_rate: p.readsb.baro_rate ?? undefined,
    squawk: s.squawk,
    category: s.category,
    lat: p.position.lat,
    lon: p.position.lon,
    seen_pos: nowS - Date.parse(p.time.sampled_at) / 1000,
    seen: nowS - s.last_contact,
  };
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
  point({ hex: '15cd28', lon: -76.163772, lat: 38.224777 }),
  point({
    hex: 'AE1454',
    lon: -157.945708,
    lat: 21.307915,
    geoAltFt: 40,
    baroAltFt: null,
    callsign: 'BOE24   ',
    onGround: true,
    speedKt: 17.5,
    track: 180,
    baroRateFpm: null,
    category: 'A5',
    typeCode: 'C17',
    registration: '05-5150',
    seenPos: 0.125,
    seen: 0,
  }),
  point({
    hex: 'ae6966',
    lon: 8.5,
    lat: 50.0,
    geoAltFt: 36000,
    baroAltFt: 35000,
    callsign: '',
    category: null,
    typeCode: '',
    registration: '',
    seenPos: 2,
    seen: 1.5,
  }),
];

test('a projection becomes the snapshot the direct adsb.lol source builds from the same readsb rows', async () => {
  const world = createWorldMilitarySource({
    projectionSource: fixtureProjectionSource(projectionOf(POINTS)),
    head: 'world/main',
    now: () => NOW,
  });
  const direct = readsbSnapshot(
    { now: NOW_MS, ac: POINTS.map(rowOf) },
    { observedAtMs: NOW_MS, now: NOW },
  );
  const snapshot = await world.getSnapshot();
  assert.deepEqual(snapshot.records, direct.records);
  const [airborne, ground, quiet] = snapshot.records;
  assert.equal(airborne.id, '15cd28');
  assert.equal(airborne.callsign, 'TSTR38');
  assert.equal(airborne.typeCode, 'BE20');
  assert.equal(airborne.registration, '823132');
  assert.equal(airborne.verticalRateMps, -320 * 0.00508);
  assert.equal(airborne.positionTimeMs, NOW_MS - 500);
  assert.equal(airborne.contactTimeMs, NOW_MS - 250);
  assert.equal(airborne.operator, '');
  assert.equal(ground.id, 'ae1454', 'icao24 is lower-cased');
  assert.equal(ground.onGround, true);
  assert.equal(ground.baroAltitudeM, null);
  assert.equal(ground.ellipsoidAltitudeM, 40 * 0.3048);
  assert.equal(ground.category, 'A5');
  assert.equal(ground.typeCode, 'C17');
  assert.equal(quiet.callsign, '');
  assert.equal(quiet.category, null);
  assert.equal(quiet.typeCode, '');
  for (const key of [
    'complete',
    'rejectedCount',
    'observedAtMs',
    'ageMs',
    'stale',
    'freshness',
  ])
    assert.deepEqual(snapshot[key], direct[key], key);
  assert.equal(snapshot.observedAtMs, NOW_MS);
  assert.equal(snapshot.ageMs, 30_000);
  assert.equal(snapshot.freshness, 'current');
  assert.equal(snapshot.source, WORLD_MILITARY_SOURCE_LABEL);
  assert.equal(snapshot.coverage, WORLD_MILITARY_COVERAGE);
  assert.equal(snapshot.status, 200);
});

test('the direct source and the world adapter agree end to end for the same rows', async () => {
  const direct = createAdsbLolSource({
    api: (path) => path,
    fetchImpl: async () =>
      new Response(JSON.stringify({ now: NOW_MS, ac: POINTS.map(rowOf) }), {
        headers: { 'x-ads-b-cache-age-ms': '30000' },
      }),
    now: () => NOW,
  });
  const world = createWorldMilitarySource({
    projectionSource: fixtureProjectionSource(projectionOf(POINTS)),
    head: 'world/main',
    now: () => NOW,
  });
  const [a, b] = await Promise.all([
    direct.getSnapshot({}),
    world.getSnapshot({}),
  ]);
  assert.deepEqual(
    { ...b, source: a.source, coverage: a.coverage },
    a,
    'only the source and coverage labels differ',
  );
  assert.deepEqual(await world.getIdentities(), await direct.getIdentities());
  assert.deepEqual(await world.getIdentities(), ['15cd28', 'ae1454', 'ae6966']);
});

test('one demand per call: head, type filter, the military binding, wall-clock valid_at, the height grant, no policy, the signal; the viewport query is not sent', async () => {
  const projectionSource = fixtureProjectionSource(projectionOf(POINTS));
  const source = createWorldMilitarySource({
    projectionSource,
    head: 'world/test',
    now: () => 1789600000123,
  });
  const controller = new AbortController();
  await source.getSnapshot(
    { latitude: 30.25, longitude: -97.75 },
    { signal: controller.signal },
  );
  await source.getIdentities({}, { signal: controller.signal });
  assert.equal(projectionSource.demands.length, 2);
  for (const demand of projectionSource.demands) {
    assert.equal(demand.head, 'world/test');
    assert.equal(demand.revisionId, undefined);
    assert.deepEqual(demand.query, {
      type_filter: ['aircraft.track_state_set.v1'],
      requested_layers: ['world.military_aircraft'],
      valid_at: '2026-09-16T23:06:40.000Z',
    });
    assert.deepEqual(demand.projectionSpec, {
      display_assumptions: {
        aircraft_height: 'adsb-geometric-as-wgs84-ellipsoid',
      },
    });
    assert.equal(demand.signal, controller.signal);
  }
});

test('trails delegate to the provider source unchanged', async () => {
  const calls = [];
  const providerSource = {
    label: 'adsb.lol',
    async getSnapshot() {
      calls.push(['getSnapshot']);
      return { records: [] };
    },
    async getIdentities() {
      calls.push(['getIdentities']);
      return [];
    },
    async getTrack(reference, options) {
      calls.push(['getTrack', reference, options]);
      return { records: [{ latitude: 1 }], complete: false };
    },
  };
  const source = createWorldMilitarySource({
    projectionSource: fixtureProjectionSource(projectionOf([])),
    head: 'world/main',
    providerSource,
  });
  const controller = new AbortController();
  const options = { signal: controller.signal };
  assert.deepEqual(await source.getTrack('15cd28', options), {
    records: [{ latitude: 1 }],
    complete: false,
  });
  await source.getSnapshot();
  await source.getIdentities();
  assert.deepEqual(calls, [['getTrack', '15cd28', options]]);
  assert.equal(source.label, WORLD_MILITARY_SOURCE_LABEL);
});

test('without a provider source, trails are unsupported, not failures of the snapshot', async () => {
  const source = createWorldMilitarySource({
    projectionSource: fixtureProjectionSource(projectionOf(POINTS)),
    head: 'world/main',
  });
  await assert.rejects(
    () => source.getTrack('15cd28'),
    (error) => error.name === 'LiveSourceError' && error.code === 'unsupported',
  );
  assert.equal((await source.getSnapshot()).records.length, 3);
});

test('a snapshot older than two minutes is stale', async () => {
  const old = new Date(NOW - 121_000).toISOString();
  const source = createWorldMilitarySource({
    projectionSource: fixtureProjectionSource(
      projectionOf([point({ hex: '15cd28', lon: 0, lat: 0, validAt: old })]),
    ),
    head: 'world/main',
    now: () => NOW,
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.observedAtMs, Date.parse(old));
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.freshness, 'stale');
});

test('an empty projection is an empty, current-less snapshot and an empty identity list, not an error', async () => {
  const source = createWorldMilitarySource({
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
  assert.deepEqual(await source.getIdentities(), []);
});

test('a point the layer cannot place is rejected and counted, like a bad readsb row', async () => {
  const source = createWorldMilitarySource({
    projectionSource: fixtureProjectionSource(
      projectionOf([
        point({ hex: '15cd28', lon: -76.2, lat: 38.2 }),
        point({ hex: 'bad000', lon: 400, lat: 0 }),
        point({ identity: 'track:adsblol:icao24:', lon: 1, lat: 1 }),
        { id: 'world.military_aircraft/x', properties: null },
      ]),
    ),
    head: 'world/main',
    now: () => NOW,
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(
    snapshot.records.map((r) => r.id),
    ['15cd28'],
  );
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.rejectedCount, 3);
  assert.deepEqual(await source.getIdentities(), ['15cd28']);
});

test('a malformed projection rejects instead of replacing the displayed aircraft or the registry', async () => {
  for (const projection of [
    null,
    {},
    { points: 'nope' },
    projectionOf([point({ hex: 'bad', lon: 400, lat: 0 })]),
    projectionOf([{ id: 'world.military_aircraft/x', properties: null }]),
  ]) {
    const source = createWorldMilitarySource({
      projectionSource: fixtureProjectionSource(projection),
      head: 'world/main',
    });
    for (const call of [
      () => source.getSnapshot(),
      () => source.getIdentities(),
    ])
      await assert.rejects(
        call,
        (error) =>
          error.name === 'LiveSourceError' && error.code === 'malformed',
      );
  }
});

test('a source error propagates unchanged', async () => {
  const failure = new Error('World model unreachable');
  const source = createWorldMilitarySource({
    projectionSource: {
      async getProjection() {
        throw failure;
      },
    },
    head: 'world/main',
  });
  await assert.rejects(source.getSnapshot(), (error) => error === failure);
  await assert.rejects(source.getIdentities(), (error) => error === failure);
});

test('an aborted signal is honoured before and after the request', async () => {
  const projectionSource = fixtureProjectionSource(projectionOf(POINTS));
  const source = createWorldMilitarySource({
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
    createWorldMilitarySource({
      projectionSource: late,
      head: 'world/main',
    }).getIdentities({}, { signal: during.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('the adapter refuses to build without a ProjectionSource or a head', () => {
  assert.throws(
    () => createWorldMilitarySource({ head: 'world/main' }),
    /requires a ProjectionSource/,
  );
  assert.throws(
    () =>
      createWorldMilitarySource({
        projectionSource: fixtureProjectionSource(projectionOf([])),
      }),
    /requires a head/,
  );
});
