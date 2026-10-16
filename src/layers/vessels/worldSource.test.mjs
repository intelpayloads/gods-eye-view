import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorldVesselSource,
  shipTypeLabel,
  VESSEL_BINDINGS,
  VESSEL_GLOBAL_BINDING,
  VESSEL_BINDING,
  VESSEL_PRODUCT_TYPE,
} from './worldSource.js';

const NOW = Date.parse('2026-10-15T02:05:00Z');

/** A projected point the way the backplane's positioned_entities projector emits `world.vessels`. */
function point({
  mmsi,
  lon = 24.9,
  lat = 60.1,
  sampledAt = '2026-10-15T02:04:00Z',
  ...properties
}) {
  const identity = `track:digitraffic:mmsi:${mmsi}`;
  return {
    id: `${VESSEL_BINDING}/${identity}`,
    binding: VESSEL_BINDING,
    frame: 'WGS84',
    position: { lon, lat, height_m: null },
    time: {
      valid_at: sampledAt,
      sampled_at: sampledAt,
      known_as_of: sampledAt,
    },
    semantic_ref: { type_id: VESSEL_PRODUCT_TYPE, semantic_identity: identity },
    properties: {
      mmsi,
      sog_kn: 10,
      cog_deg: 90,
      heading_deg: 88,
      nav_status: 0,
      ...properties,
    },
  };
}

function sourceAnswering(points) {
  const demands = [];
  return {
    demands,
    async getProjection(demand) {
      demands.push(demand);
      return { revision_id: 'rev-1', points };
    },
  };
}

test('one demand names the vessel binding at the wall clock and grants no height', async () => {
  const projectionSource = sourceAnswering([point({ mmsi: 230000001 })]);
  await createWorldVesselSource({
    projectionSource,
    head: 'world/main',
    now: () => NOW,
  }).getSnapshot();
  const [demand] = projectionSource.demands;
  assert.equal(demand.head, 'world/main');
  assert.deepEqual(demand.query.type_filter, [VESSEL_PRODUCT_TYPE]);
  assert.deepEqual(demand.query.requested_layers, [...VESSEL_BINDINGS]);
  assert.ok(demand.query.valid_at.startsWith('2026-10-15T02:05'));
  assert.deepEqual(demand.projectionSpec.display_assumptions, {});
});

test('a projected vessel becomes the record the provider path produces', async () => {
  const projectionSource = sourceAnswering([point({ mmsi: 230000001 })]);
  const snapshot = await createWorldVesselSource({
    projectionSource,
    head: 'world/main',
    now: () => NOW,
  }).getSnapshot();
  const [record] = snapshot.records;
  assert.equal(record.id, '230000001');
  assert.equal(
    record.name,
    '230000001',
    'no name in the positions feed: labelled by MMSI',
  );
  assert.equal(record.latitude, 60.1);
  assert.ok(Math.abs(record.speedMps - 5.14444) < 1e-9);
  assert.equal(record.courseDeg, 90);
  assert.equal(record.headingDeg, 88);
  assert.equal(record.observedAtMs, Date.parse('2026-10-15T02:04:00Z'));
  assert.equal(snapshot.freshness, 'current');
  assert.equal(
    snapshot.transportStatus,
    null,
    'no transport state: never a feed failure',
  );
});

test('AIS "not available" readings are null, never motion', async () => {
  const projectionSource = sourceAnswering([
    point({ mmsi: 1, sog_kn: 102.3, cog_deg: 360, heading_deg: 511 }),
  ]);
  const [record] = (
    await createWorldVesselSource({
      projectionSource,
      head: 'world/main',
      now: () => NOW,
    }).getSnapshot()
  ).records;
  assert.equal(record.speedMps, null);
  assert.equal(record.courseDeg, null);
  assert.equal(record.headingDeg, null);
});

test('a snapshot whose newest position is old is stale', async () => {
  const projectionSource = sourceAnswering([
    point({ mmsi: 1, sampledAt: '2026-10-14T13:15:26Z' }),
  ]);
  const snapshot = await createWorldVesselSource({
    projectionSource,
    head: 'world/main',
    now: () => NOW,
  }).getSnapshot();
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.freshness, 'stale');
});

test('trails delegate to the provider source, or are unsupported', async () => {
  const projectionSource = sourceAnswering([]);
  const calls = [];
  const providerSource = {
    async getTrack(reference) {
      calls.push(reference);
      return { records: [], complete: false };
    },
  };
  await createWorldVesselSource({
    projectionSource,
    head: 'world/main',
    providerSource,
  }).getTrack('230000001');
  assert.deepEqual(calls, ['230000001']);
  await assert.rejects(
    createWorldVesselSource({ projectionSource, head: 'world/main' }).getTrack(
      '1',
    ),
    /unavailable from the world model/,
  );
});

test('a register-named vessel carries its name, IMO, type and destination', async () => {
  const projectionSource = sourceAnswering([
    point({
      mmsi: 230000001,
      vessel_name: 'STOC BALTIC ',
      imo: 9000001,
      ship_type: 80,
      destination: 'FIHEL',
    }),
  ]);
  const [record] = (
    await createWorldVesselSource({
      projectionSource,
      head: 'world/main',
      now: () => NOW,
    }).getSnapshot()
  ).records;
  assert.equal(record.name, 'STOC BALTIC');
  assert.equal(record.imo, '9000001');
  assert.equal(record.type, 'Tanker');
  assert.equal(record.destination, 'FIHEL');
});

test('ship type codes read as the coarse label; an unknown code is blank', () => {
  assert.equal(shipTypeLabel(70), 'Cargo');
  assert.equal(shipTypeLabel(52), 'Tug');
  assert.equal(shipTypeLabel(0), '');
  assert.equal(shipTypeLabel(null), '');
});

test('a ship both sources hear is one record: the newer position, the name kept', async () => {
  const baltic = point({
    mmsi: 230000001,
    vessel_name: 'STOC BALTIC',
    sampledAt: '2026-10-15T02:03:00Z',
  });
  const global = {
    ...point({ mmsi: 230000001, lon: 25.5, sampledAt: '2026-10-15T02:04:30Z' }),
    binding: VESSEL_GLOBAL_BINDING,
  };
  const elsewhere = {
    ...point({ mmsi: 247000002, vessel_name: 'MALTA STAR', lat: 36.1 }),
    binding: VESSEL_GLOBAL_BINDING,
  };
  const { records } = await createWorldVesselSource({
    projectionSource: sourceAnswering([baltic, global, elsewhere]),
    head: 'world/main',
    now: () => NOW,
  }).getSnapshot();
  assert.equal(records.length, 2);
  const ship = records.find((r) => r.id === '230000001');
  assert.equal(ship.longitude, 25.5, 'the newer position');
  assert.equal(ship.name, 'STOC BALTIC', 'the name the newer record lacked');
  assert.equal(records.find((r) => r.id === '247000002').name, 'MALTA STAR');
});
