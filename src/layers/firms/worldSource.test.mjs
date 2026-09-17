import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorldFirmsSource,
  FIRE_BINDINGS,
  FIRE_PRODUCT_TYPE,
  FIRE_WINDOW_SECONDS,
  fireRecordOf,
  WORLD_FIRMS_COVERAGE,
  WORLD_FIRMS_SOURCE_LABEL,
} from './worldSource.js';
import { createFirmsSource } from './source.js';
import { adaptFirmsRecords } from '../../data/firmsAdapt.js';
import { fireDetectionKey } from '../../data/firmsLabels.js';
import { filterTrailing24h, parseFirmsCsv } from '../../data/firmsCsv.js';

const NOW = Date.UTC(2026, 8, 17, 12, 30, 0); // 2026-09-17T12:30:00Z
const KNOWN = '2026-09-17T12:10:05.123456+00:00'; // when the world model received the CSV

/** The area API's header: what the live connector retains. */
const HEADER =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';

/**
 * A CSV row and the projected point the backplane emits for it (a
 * world.fires.viirs_* row of fire.detection_set.v1, 2-D: the product declares
 * no height, so `height_m` and `height` are null).
 */
function detection({
  lat,
  lon,
  ti4 = 340.2,
  scan = 0.39,
  track = 0.36,
  date = '2026-09-17',
  time = '1006',
  satellite = 'N20',
  instrument = 'VIIRS',
  confidence = 'n',
  ti5 = 295.1,
  frp = 12.7,
  daynight = 'D',
  binding = 'world.fires.viirs_noaa20',
  known = KNOWN,
}) {
  const row = `${lat},${lon},${ti4},${scan},${track},${date},${time},${satellite},${instrument},${confidence},2.0NRT,${ti5},${frp},${daynight}`;
  const hhmm = String(time).padStart(4, '0');
  const identity = `detection:firms:${satellite}:${date}T${hhmm}Z:${lat}:${lon}`;
  const acquiredAt = `${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00+00:00`;
  const point = {
    id: `${binding}/${identity}`,
    binding,
    position: { lon: Number(lon), lat: Number(lat), height_m: null },
    frame: 'WGS84',
    height: null,
    time: {
      valid_at: acquiredAt,
      sampled_at: acquiredAt,
      known_as_of: known,
      age_seconds: null,
      temporal_status: null,
      age_at_query_seconds: (NOW - Date.parse(acquiredAt)) / 1000,
    },
    semantic_ref: {
      product_ref: { type_id: FIRE_PRODUCT_TYPE, content_id: 'sha256:1' },
      descriptor_id: 'd1',
      type_id: FIRE_PRODUCT_TYPE,
      semantic_identity: identity,
    },
    source_ref: null,
    properties: {
      satellite,
      instrument,
      source: 'VIIRS_NOAA20_NRT',
      confidence,
      confidence_class: 'nominal',
      frp_mw: frp === '' ? null : Number(frp),
      bright_ti4_k: Number(ti4),
      bright_ti5_k: Number(ti5),
      scan_km: Number(scan),
      track_km: Number(track),
      daynight,
      acq_date: date,
      acq_time: String(time),
      acquired_at_ms: Date.parse(acquiredAt),
      version: '2.0NRT',
      row_index: 0,
    },
  };
  return { row, point };
}

const DETECTIONS = [
  detection({
    lat: '38.99488',
    lon: '-121.67046',
    frp: 0.53,
    daynight: 'N',
    confidence: 'n',
  }),
  detection({
    lat: '34.0522',
    lon: '-118.2437',
    time: '45',
    confidence: 'h',
    frp: 210.4,
  }),
  detection({
    lat: '19.40114',
    lon: '-155.28275',
    satellite: 'N21',
    binding: 'world.fires.viirs_noaa21',
    confidence: 'l',
    frp: '',
    known: '2026-09-17T12:12:00+00:00',
  }),
  detection({
    lat: '61.2181',
    lon: '-149.9003',
    satellite: 'N',
    binding: 'world.fires.viirs_snpp',
    date: '2026-09-16',
    time: '2359',
    daynight: 'N',
  }),
];

function projectionOf(points, extra = {}) {
  const bindings = [...new Set(points.map((p) => p.binding))];
  return {
    revision_id: 'rev-1',
    points,
    lines: [],
    polygons: [],
    field_samples: [],
    annotations: [],
    assumptions: bindings.flatMap((binding) => [
      { kind: 'no-height', binding },
      {
        kind: 'projection-policy',
        policy: 'temporal_age',
        mode: 'withhold',
        threshold_seconds: FIRE_WINDOW_SECONDS,
        age_basis: 'valid_time',
        binding,
        marked: 0,
        withheld: 0,
      },
    ]),
    omissions: [],
    ...extra,
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

test('a projection becomes the records the CSV parser builds from the same rows, so the layer renders and keys them identically', async () => {
  const world = createWorldFirmsSource({
    projectionSource: fixtureProjectionSource(
      projectionOf(DETECTIONS.map((d) => d.point)),
    ),
    head: 'world/main',
    now: () => NOW,
  });
  const snapshot = await world.getSnapshot();
  const parsed = parseFirmsCsv(
    [HEADER, ...DETECTIONS.map((d) => d.row)].join('\n') + '\n',
  );
  assert.deepEqual(snapshot.fires, parsed);
  assert.deepEqual(
    adaptFirmsRecords(snapshot.fires),
    adaptFirmsRecords(parsed),
  );
  assert.deepEqual(
    adaptFirmsRecords(snapshot.fires).map(fireDetectionKey),
    adaptFirmsRecords(parsed).map(fireDetectionKey),
  );
  const [nominal, high, low, alaska] = adaptFirmsRecords(snapshot.fires);
  assert.equal(nominal.confidence, 0.6);
  assert.equal(nominal.night, true);
  assert.equal(nominal.acqMs, Date.UTC(2026, 8, 17, 10, 6));
  assert.equal(
    high.acqMs,
    Date.UTC(2026, 8, 17, 0, 45),
    'acq_time "45" is 00:45Z',
  );
  assert.equal(high.frp, 210.4);
  assert.equal(
    low.frp,
    0,
    'a missing FRP is 0, as the parser reads an empty cell',
  );
  assert.equal(low.satellite, 'N21');
  assert.equal(alaska.sensor, 'VIIRS');
  assert.equal(snapshot.count, 4);
  assert.equal(snapshot.fetchedAt, Date.parse('2026-09-17T12:12:00+00:00'));
  assert.equal(snapshot.stale, false);
  assert.deepEqual(snapshot.sources, [
    {
      source: 'VIIRS_NOAA20_NRT',
      binding: 'world.fires.viirs_noaa20',
      count: 2,
      ok: true,
    },
    {
      source: 'VIIRS_NOAA21_NRT',
      binding: 'world.fires.viirs_noaa21',
      count: 1,
      ok: true,
    },
    {
      source: 'VIIRS_SNPP_NRT',
      binding: 'world.fires.viirs_snpp',
      count: 1,
      ok: true,
    },
  ]);
  assert.equal(snapshot.rejectedCount, 0);
  assert.equal(snapshot.withheldCount, 0);
  assert.equal(snapshot.revisionId, 'rev-1');
  assert.equal(snapshot.source, WORLD_FIRMS_SOURCE_LABEL);
  assert.equal(snapshot.coverage, WORLD_FIRMS_COVERAGE);
  assert.equal(world.label, WORLD_FIRMS_SOURCE_LABEL);
});

test('the provider payload and the world payload feed the layer the same fires', async () => {
  const csv = [HEADER, ...DETECTIONS.map((d) => d.row)].join('\n') + '\n';
  const direct = createFirmsSource({
    api: (path) => path,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          fetchedAt: NOW - 1000,
          stale: false,
          ttlMs: 1800000,
          sources: [],
          count: 4,
          fires: filterTrailing24h(parseFirmsCsv(csv), NOW),
        }),
      ),
  });
  const world = createWorldFirmsSource({
    projectionSource: fixtureProjectionSource(
      projectionOf(DETECTIONS.map((d) => d.point)),
    ),
    head: 'world/main',
    now: () => NOW,
  });
  const [a, b] = await Promise.all([direct.getSnapshot(), world.getSnapshot()]);
  assert.deepEqual(adaptFirmsRecords(b.fires), adaptFirmsRecords(a.fires));
  assert.equal(
    b.keyRequired,
    undefined,
    'the world model never asks the browser for a key',
  );
});

test('one demand per call: head, the fire type, the three bindings, wall-clock valid_at, no grant, the 24 h withhold policy, the signal', async () => {
  const projectionSource = fixtureProjectionSource(projectionOf([]));
  const source = createWorldFirmsSource({
    projectionSource,
    head: 'world/test',
    now: () => 1789600000123,
  });
  const controller = new AbortController();
  await source.getSnapshot({ signal: controller.signal });
  assert.equal(projectionSource.demands.length, 1);
  const [demand] = projectionSource.demands;
  assert.equal(demand.head, 'world/test');
  assert.equal(demand.revisionId, undefined);
  assert.deepEqual(demand.query, {
    type_filter: ['fire.detection_set.v1'],
    requested_layers: [...FIRE_BINDINGS],
    valid_at: '2026-09-16T23:06:40.000Z',
  });
  assert.deepEqual(demand.projectionSpec, {
    display_assumptions: {},
    projection_policy: {
      temporal_age: { mode: 'withhold', threshold_seconds: 86400 },
    },
  });
  assert.equal(demand.signal, controller.signal);
});

test('a feed the world model has not bound reads as a failed source; withheld detections are counted', async () => {
  const points = DETECTIONS.slice(0, 2).map((d) => d.point);
  const projection = projectionOf(points, {
    omissions: [
      {
        binding: 'world.fires.viirs_noaa20',
        reason: 'temporal-age-withheld',
        count: 1234,
        item_ids: [],
      },
    ],
  });
  // NOAA-21 is bound but every detection was withheld: mentioned by its policy echo only
  projection.assumptions.push({
    kind: 'projection-policy',
    policy: 'temporal_age',
    binding: 'world.fires.viirs_noaa21',
    withheld: 7,
  });
  const source = createWorldFirmsSource({
    projectionSource: fixtureProjectionSource(projection),
    head: 'world/main',
    now: () => NOW,
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(
    snapshot.sources.map(({ source: s, count, ok }) => [s, count, ok]),
    [
      ['VIIRS_NOAA20_NRT', 2, true],
      ['VIIRS_NOAA21_NRT', 0, true],
      ['VIIRS_SNPP_NRT', 0, false],
    ],
  );
  assert.equal(snapshot.withheldCount, 1234);
});

test('a snapshot whose newest receipt is older than an hour is stale; an empty projection is empty and current', async () => {
  const old = detection({
    lat: '1',
    lon: '1',
    known: new Date(NOW - 61 * 60_000).toISOString(),
  }).point;
  const stale = await createWorldFirmsSource({
    projectionSource: fixtureProjectionSource(projectionOf([old])),
    head: 'world/main',
    now: () => NOW,
  }).getSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, NOW - 61 * 60_000);

  const empty = await createWorldFirmsSource({
    projectionSource: fixtureProjectionSource(projectionOf([])),
    head: 'world/main',
    now: () => NOW,
  }).getSnapshot();
  assert.deepEqual(empty.fires, []);
  assert.equal(empty.count, 0);
  assert.equal(empty.stale, false);
  assert.equal(empty.fetchedAt, NOW, 'no receipt to date: the request time');
  assert.deepEqual(
    empty.sources.map((s) => s.ok),
    [false, false, false],
  );
});

test('a point the layer cannot place is rejected and counted; a projection with only such points is malformed', async () => {
  const good = DETECTIONS[0].point;
  const bad = {
    ...good,
    id: 'x',
    position: { lon: 400, lat: 0, height_m: null },
  };
  const snapshot = await createWorldFirmsSource({
    projectionSource: fixtureProjectionSource(
      projectionOf([good, bad, { id: 'y', properties: null }]),
    ),
    head: 'world/main',
    now: () => NOW,
  }).getSnapshot();
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.rejectedCount, 2);
  assert.equal(fireRecordOf(bad), null);
  assert.equal(fireRecordOf(null), null);
  for (const projection of [
    null,
    {},
    { points: 'nope' },
    projectionOf([bad]),
  ]) {
    await assert.rejects(
      createWorldFirmsSource({
        projectionSource: fixtureProjectionSource(projection),
        head: 'world/main',
      }).getSnapshot(),
      (error) => error.name === 'LiveSourceError' && error.code === 'malformed',
    );
  }
});

test('a source error propagates unchanged and an aborted signal is honoured before and after the request', async () => {
  const failure = new Error('World model unreachable');
  await assert.rejects(
    createWorldFirmsSource({
      projectionSource: {
        async getProjection() {
          throw failure;
        },
      },
      head: 'world/main',
    }).getSnapshot(),
    (error) => error === failure,
  );
  const projectionSource = fixtureProjectionSource(projectionOf([]));
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    createWorldFirmsSource({
      projectionSource,
      head: 'world/main',
    }).getSnapshot({
      signal: before.signal,
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(projectionSource.demands.length, 0);
  const during = new AbortController();
  await assert.rejects(
    createWorldFirmsSource({
      projectionSource: {
        async getProjection() {
          during.abort();
          return projectionOf([]);
        },
      },
      head: 'world/main',
    }).getSnapshot({ signal: during.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('the adapter refuses to build without a ProjectionSource or a head', () => {
  assert.throws(
    () => createWorldFirmsSource({ head: 'world/main' }),
    /requires a ProjectionSource/,
  );
  assert.throws(
    () =>
      createWorldFirmsSource({
        projectionSource: fixtureProjectionSource(projectionOf([])),
      }),
    /requires a head/,
  );
});
