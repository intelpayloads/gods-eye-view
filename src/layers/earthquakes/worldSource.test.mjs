import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorldEarthquakeSource,
  EARTHQUAKE_PRODUCT_TYPE,
} from './worldSource.js';
import { createUsgsEarthquakeSource } from './source.js';

/** A projected point the way the backplane's positioned_entities projector emits it. */
function point({
  usgsId,
  identity = usgsId ? `event:usgs:${usgsId}` : 'event:usgs:anon',
  lon,
  lat,
  depthKm = 10,
  mag,
  place = 'Fixture',
  timeMs = 1789572901404,
}) {
  const properties = {
    net: 'ak',
    code: 'a1',
    alert: null,
    place,
    tsunami: 0,
    depth_km: depthKm,
    magnitude: mag,
    event_type: 'earthquake',
    event_time_ms: timeMs,
    feature_index: 0,
    magnitude_type: 'ml',
  };
  if (usgsId !== undefined) properties.usgs_id = usgsId;
  return {
    id: `world.earthquakes/${identity}`,
    binding: 'world.earthquakes',
    position: { lon, lat, height_m: depthKm == null ? null : -depthKm * 1000 },
    frame: 'WGS84',
    height: {
      value_m: depthKm == null ? null : -depthKm * 1000,
      source_field: 'geometric_height_m',
      assumption: 'undeclared_height_datum:read-as-wgs84-ellipsoid',
      interpretation: 'explicit-grant',
      barometric_height_m: null,
    },
    time: {
      valid_at: new Date(timeMs).toISOString(),
      sampled_at: new Date(timeMs).toISOString(),
      known_as_of: '2026-09-17T15:27:24.972779+00:00',
      age_seconds: null,
      temporal_status: null,
    },
    semantic_ref: {
      product_ref: { type_id: EARTHQUAKE_PRODUCT_TYPE, content_id: 'sha256:1' },
      descriptor_id: 'd1',
      type_id: EARTHQUAKE_PRODUCT_TYPE,
      semantic_identity: identity,
    },
    source_ref: null,
    properties,
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
  point({
    usgsId: 'us7000abcd',
    lon: -151.263,
    lat: 61.606,
    depthKm: 0.1,
    mag: 4.6,
    place: '40 km W of Susitna, Alaska',
  }),
  point({
    usgsId: 'nc73999999',
    lon: -122.8,
    lat: 38.8,
    depthKm: 2.3,
    mag: 1.8,
  }),
  point({
    usgsId: 'ak0269hjkl',
    lon: -150.1,
    lat: 63.2,
    depthKm: 85,
    mag: 2.5,
    timeMs: 1789570000000,
  }),
];

test('a projection becomes the rows the direct USGS source returns, M2.5+ only', async () => {
  const projectionSource = fixtureProjectionSource(projectionOf(POINTS));
  const source = createWorldEarthquakeSource({
    projectionSource,
    head: 'world/main',
  });
  const rows = await source.getSnapshot();
  assert.deepEqual(rows, [
    {
      stableId: 'us7000abcd',
      usgsId: 'us7000abcd',
      lon: -151.263,
      lat: 61.606,
      depthKm: 0.1,
      mag: 4.6,
      place: '40 km W of Susitna, Alaska',
      time: 1789572901404,
    },
    {
      stableId: 'ak0269hjkl',
      usgsId: 'ak0269hjkl',
      lon: -150.1,
      lat: 63.2,
      depthKm: 85,
      mag: 2.5,
      place: 'Fixture',
      time: 1789570000000,
    },
  ]);
});

test('the world rows and the direct USGS rows agree for the same events', async () => {
  const feed = {
    type: 'FeatureCollection',
    features: POINTS.map((p) => ({
      type: 'Feature',
      id: p.properties.usgs_id,
      geometry: {
        type: 'Point',
        coordinates: [p.position.lon, p.position.lat, p.properties.depth_km],
      },
      properties: {
        mag: p.properties.magnitude,
        place: p.properties.place,
        time: p.properties.event_time_ms,
      },
    })),
  };
  const direct = createUsgsEarthquakeSource({
    fetchImpl: async () => new Response(JSON.stringify(feed)),
  });
  const world = createWorldEarthquakeSource({
    projectionSource: fixtureProjectionSource(projectionOf(POINTS)),
    head: 'world/main',
  });
  assert.deepEqual(await world.getSnapshot(), await direct.getSnapshot());
});

test('one demand per snapshot: head, type filter, wall-clock valid_at, the height grant, no policy, the signal', async () => {
  const projectionSource = fixtureProjectionSource(projectionOf(POINTS));
  const source = createWorldEarthquakeSource({
    projectionSource,
    head: 'world/test',
    now: () => 1789600000123,
  });
  const controller = new AbortController();
  await source.getSnapshot({ signal: controller.signal });
  assert.equal(projectionSource.demands.length, 1);
  const demand = projectionSource.demands[0];
  assert.equal(demand.head, 'world/test');
  assert.equal(demand.revisionId, undefined);
  assert.deepEqual(demand.query, {
    type_filter: ['seismic.event_set.v1'],
    valid_at: '2026-09-16T23:06:40.000Z',
  });
  assert.deepEqual(demand.projectionSpec, {
    display_assumptions: {
      undeclared_height_datum: 'read-as-wgs84-ellipsoid',
    },
  });
  assert.equal(demand.signal, controller.signal);
});

test('a point without usgs_id keeps a stable id from its semantic identity', async () => {
  const source = createWorldEarthquakeSource({
    projectionSource: fixtureProjectionSource(
      projectionOf([
        point({
          identity: 'event:usgs:ci12345678',
          lon: -118.1,
          lat: 34.2,
          mag: 3.1,
        }),
      ]),
    ),
    head: 'world/main',
  });
  const [row] = await source.getSnapshot();
  assert.equal(row.stableId, 'ci12345678');
  assert.equal(row.usgsId, 'ci12345678');
});

test('a missing depth or place is null, as the direct source reports it', async () => {
  const source = createWorldEarthquakeSource({
    projectionSource: fixtureProjectionSource(
      projectionOf([
        point({
          usgsId: 'x1',
          lon: 10,
          lat: 20,
          depthKm: null,
          mag: 5,
          place: null,
        }),
      ]),
    ),
    head: 'world/main',
  });
  assert.deepEqual(await source.getSnapshot(), [
    {
      stableId: 'x1',
      usgsId: 'x1',
      lon: 10,
      lat: 20,
      depthKm: null,
      mag: 5,
      place: null,
      time: 1789572901404,
    },
  ]);
});

test('an empty projection is an empty snapshot, not an error', async () => {
  const source = createWorldEarthquakeSource({
    projectionSource: fixtureProjectionSource(projectionOf([])),
    head: 'world/main',
  });
  assert.deepEqual(await source.getSnapshot(), []);
});

test('a malformed projection rejects instead of replacing the displayed events', async () => {
  for (const projection of [
    null,
    {},
    { points: 'nope' },
    projectionOf([point({ usgsId: 'bad', lon: 400, lat: 0, mag: 3 })]),
    projectionOf([point({ usgsId: 'bad', lon: 0, lat: 0, mag: 11 })]),
    projectionOf([
      point({ usgsId: 'dup', lon: 0, lat: 0, mag: 3 }),
      point({ usgsId: 'dup', lon: 1, lat: 1, mag: 4 }),
    ]),
    projectionOf([{ id: 'world.earthquakes/x', properties: null }]),
  ]) {
    const source = createWorldEarthquakeSource({
      projectionSource: fixtureProjectionSource(projection),
      head: 'world/main',
    });
    await assert.rejects(source.getSnapshot(), /Malformed world-model/);
  }
});

test('a source error propagates unchanged', async () => {
  const failure = new Error('World model unreachable');
  const source = createWorldEarthquakeSource({
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
  const source = createWorldEarthquakeSource({
    projectionSource,
    head: 'world/main',
  });
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    source.getSnapshot({ signal: before.signal }),
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
    createWorldEarthquakeSource({
      projectionSource: late,
      head: 'world/main',
    }).getSnapshot({ signal: during.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('the adapter refuses to build without a ProjectionSource or a head', () => {
  assert.throws(
    () => createWorldEarthquakeSource({ head: 'world/main' }),
    /requires a ProjectionSource/,
  );
  assert.throws(
    () =>
      createWorldEarthquakeSource({
        projectionSource: fixtureProjectionSource(projectionOf([])),
      }),
    /requires a head/,
  );
});
