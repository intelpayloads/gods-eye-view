import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRequest,
  createDemand,
  demandBbox,
  formatAge,
  policyModeOf,
  requestKey,
  temporalAgePolicy,
  wallClockValidAt,
} from './demand.js';

const T0 = Date.UTC(2026, 8, 10, 22, 57, 25, 731);
const CHAIN = [
  { id: 'rev-2', parent_id: 'rev-1', created_at: '2026-09-10T22:00:00Z' },
  { id: 'rev-1', parent_id: null, created_at: '2026-09-10T21:00:00Z' },
];

test('demandBbox rounds outward to 0.01°, clamps, widens across the antimeridian, null for the horizon', () => {
  assert.deepEqual(
    demandBbox({ west: -122.4194, south: 37.7749, east: -121.0001, north: 38 }),
    [-122.42, 37.77, -121, 38],
  );
  assert.deepEqual(
    demandBbox([-122.4194, 37.7749, -121.0001, 38]),
    [-122.42, 37.77, -121, 38],
  );
  assert.deepEqual(
    demandBbox({ west: 179.5, south: -10, east: -179.5, north: 10 }),
    [-180, -10, 180, 10],
  );
  assert.deepEqual(
    demandBbox({ west: -190, south: -95, east: 190, north: 95 }),
    [-180, -90, 180, 90],
  );
  assert.equal(demandBbox(undefined), null);
  assert.equal(demandBbox(null), null);
  assert.equal(
    demandBbox({ west: Number.NaN, south: 0, east: 1, north: 1 }),
    null,
  );
  // sub-pixel settles land on the same grid cell
  assert.deepEqual(
    demandBbox({ west: -122.4194, south: 37.7749, east: -121.0001, north: 38 }),
    demandBbox({
      west: -122.4191,
      south: 37.7742,
      east: -121.0009,
      north: 37.9995,
    }),
  );
});

test('live requests pin to the newest chain revision and use the wall clock in whole seconds', () => {
  const demand = createDemand({
    bbox: [-123, 37, -121, 39],
    predicates: { pressure_hpa: 850 },
    displayAssumptions: { aircraft_height: 'x' },
  });
  const request = buildRequest(demand, CHAIN, T0);
  assert.equal(request.revisionId, 'rev-2');
  assert.deepEqual(request.query, {
    spatial_scope: { bbox: [-123, 37, -121, 39] },
    valid_at: '2026-09-10T22:57:25.000Z',
    predicates: { pressure_hpa: 850 },
  });
  assert.deepEqual(request.projectionSpec, {
    display_assumptions: { aircraft_height: 'x' },
  });
  assert.equal(wallClockValidAt(T0), '2026-09-10T22:57:25.000Z');
  // no chain yet: nothing to ask (a head-resolved request would be re-issued by id)
  assert.equal(buildRequest(demand, [], T0), null);
  assert.equal(buildRequest(demand, null, T0), null);
  // an explicit user time wins over the wall clock
  const explicit = buildRequest(
    { ...demand, validAt: '2026-01-01T00:00:00Z' },
    CHAIN,
    T0,
  );
  assert.equal(explicit.query.valid_at, '2026-01-01T00:00:00Z');
  // no bbox: no spatial scope at all (never a guessed extent)
  const horizon = buildRequest({ ...demand, bbox: null }, CHAIN, T0);
  assert.equal('spatial_scope' in horizon.query, false);
});

test('pinned requests freeze the revision, times and policy while the chain moves', () => {
  const pinned = createDemand({
    follow: 'pinned',
    pinnedRevisionId: 'rev-1',
    validAt: '2026-09-10T22:57:25Z',
    knownAsOf: '2026-09-10T22:57:26Z',
    layers: ['world.weather'],
    projectionPolicy: temporalAgePolicy('withhold', 30),
  });
  const a = buildRequest(pinned, CHAIN, T0);
  const b = buildRequest(pinned, [{ id: 'rev-9' }, ...CHAIN], T0 + 3_600_000);
  assert.deepEqual(a, b);
  assert.equal(a.revisionId, 'rev-1');
  assert.equal(a.query.valid_at, '2026-09-10T22:57:25Z');
  assert.equal(a.query.known_as_of, '2026-09-10T22:57:26Z');
  assert.deepEqual(a.query.requested_layers, ['world.weather']);
  assert.deepEqual(a.projectionSpec.projection_policy, {
    temporal_age: { mode: 'withhold', threshold_seconds: 30 },
  });
  assert.equal(requestKey(a), requestKey(b));
  assert.notEqual(requestKey(a, 1), requestKey(b, 2));
  assert.equal(requestKey(null), null);
  assert.throws(() => createDemand({ follow: 'pinned' }), /pinnedRevisionId/);
  assert.throws(() => createDemand({ follow: 'sideways' }), /follow/);
});

test('policy shorthand and ages', () => {
  assert.deepEqual(temporalAgePolicy('off'), {});
  assert.deepEqual(temporalAgePolicy('mark', 45), {
    temporal_age: { mode: 'mark', threshold_seconds: 45 },
  });
  assert.throws(() => temporalAgePolicy('hide'), /policy/);
  assert.throws(() => temporalAgePolicy('mark', -1), /threshold/);
  assert.equal(policyModeOf(createDemand()), 'off');
  assert.equal(
    policyModeOf(
      createDemand({ projectionPolicy: temporalAgePolicy('withhold', 1) }),
    ),
    'withhold',
  );
  assert.equal(formatAge(42), '42s');
  assert.equal(formatAge(420), '7m');
  assert.equal(formatAge(3 * 3600), '3h');
  assert.equal(formatAge(2 * 86400), '2d');
  assert.equal(formatAge(-5), '-5s');
  assert.equal(formatAge(null), '—');
});
