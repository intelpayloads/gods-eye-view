/**
 * DWM-185. Two real documents, not hand-built ones:
 *   fixtures/stations.celestrak-omm.json  CelesTrak's GP `stations` group as the
 *     world model retained it (sha256 131e29cb..., 2026-10-06)
 *   fixtures/stations.world-select.json   the backplane's `POST /select` for
 *     `world.satellites.elements_stations`, sourced from exactly those bytes
 * so the rule below compares what the world model serves with what CelesTrak
 * served, satellite by satellite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { json2satrec, propagate } from 'satellite.js';
import {
  createWorldSatelliteSource,
  elementSetBinding,
  ELEMENT_SET_TYPE,
  ommOf,
} from './worldSource.js';
import { createOrbits } from './orbits.js';
import { createHttpProjectionSource } from '../worldModel/source.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const CELESTRAK = fixture('stations.celestrak-omm.json');
const SELECTION = fixture('stations.world-select.json');
const ROWS = SELECTION.products[0].values;

function selecting(selection, calls = []) {
  return {
    getProjection() {},
    async select(args) {
      calls.push(args);
      return selection;
    },
  };
}

test('every satellite the world model serves propagates where CelesTrak\'s own record puts it', () => {
  const raw = new Map(CELESTRAK.map((omm) => [omm.NORAD_CAT_ID, omm]));
  assert.ok(ROWS.length > 0, 'the rule is vacuous with no rows');
  assert.deepEqual(new Set(ROWS.map((r) => ommOf(r).NORAD_CAT_ID)), new Set(raw.keys()));
  const instants = [0, 45, 6 * 60, 3 * 24 * 60].map(
    (minutes) => new Date(Date.parse('2026-10-06T12:00:00Z') + minutes * 60_000),
  );
  for (const row of ROWS) {
    const world = ommOf(row);
    const source = raw.get(world.NORAD_CAT_ID);
    assert.equal(world.OBJECT_NAME, source.OBJECT_NAME);
    assert.equal(world.OBJECT_ID, source.OBJECT_ID);
    const a = json2satrec(world);
    const b = json2satrec(source);
    assert.equal(a.error, 0, world.OBJECT_NAME);
    for (const at of instants) {
      assert.deepEqual(propagate(a, at), propagate(b, at), `${world.OBJECT_NAME} at ${at.toISOString()}`);
    }
  }
});

test('a row missing an element SGP4 reads is dropped, never read as zero', () => {
  const [row] = ROWS;
  assert.ok(ommOf(row));
  for (const column of ['eccentricity', 'bstar_per_earth_radius', 'mean_motion_rev_per_day']) {
    assert.equal(ommOf({ ...row, value: { ...row.value, [column]: null } }), null, column);
    const { [column]: _, ...without } = row.value;
    assert.equal(ommOf({ ...row, value: without }), null, column);
  }
  assert.equal(ommOf({ ...row, semantic_identity: 'spacecraft:gracefo:C' }), null);
  assert.equal(ommOf({ ...row, valid_time: 'not a time' }), null);
});

test('a group reads its own binding and hands the layer OMM records it can build', async () => {
  const calls = [];
  const source = createWorldSatelliteSource({
    projectionSource: selecting(SELECTION, calls),
    head: 'world/main',
  });
  const res = await source.readGroup('gps-ops');
  assert.deepEqual(calls[0].query, {
    type_filter: [ELEMENT_SET_TYPE],
    requested_layers: ['world.satellites.elements_gps_ops'],
  });
  assert.equal(calls[0].head, 'world/main');
  assert.equal(res.ok, true);
  assert.equal(res.elements.length, ROWS.length);

  const orbits = createOrbits({ state: {}, services: {}, parts: {}, source });
  const built = orbits.groupEntries(res).map((e) => [e.name, orbits.satrecOf(e)]);
  assert.ok(built.every(([, satrec]) => satrec), 'every world record builds a satrec');
  assert.ok(built.some(([name]) => name === 'ISS (ZARYA)'));
});

test('an unbound group, withheld values or a source without select read as an unavailable group', async () => {
  const product = SELECTION.products[0];
  for (const [projectionSource, status] of [
    [selecting({ ...SELECTION, products: [] }), /not bound/],
    [selecting({ ...SELECTION, products: [{ ...product, values: null }] }), /withheld/],
    [{ getProjection() {} }, /no select/],
  ]) {
    const res = await createWorldSatelliteSource({ projectionSource }).readGroup('geo');
    assert.equal(res.ok, false);
    assert.match(String(res.status), status);
    assert.deepEqual(res.elements, []);
  }
});

test('group bindings spell CelesTrak groups with underscores', () => {
  for (const group of ['stations', 'visual', 'gps-ops', 'glo-ops', 'galileo', 'geo', 'starlink'])
    assert.match(elementSetBinding(group), /^world\.satellites\.elements_[a-z_]+$/);
});

test('the HTTP ProjectionSource selects with values', async () => {
  const requests = [];
  const source = createHttpProjectionSource({
    baseUrl: 'http://backplane.test/',
    fetchImpl: async (url, init) => {
      requests.push([url, init.method, JSON.parse(init.body)]);
      return { ok: true, status: 200, json: async () => SELECTION };
    },
  });
  const query = { type_filter: [ELEMENT_SET_TYPE] };
  assert.equal(await source.select({ head: 'world/main', query }), SELECTION);
  assert.deepEqual(requests, [
    ['http://backplane.test/select', 'POST', { head: 'world/main', query, include_values: true }],
  ]);
  const malformed = createHttpProjectionSource({
    baseUrl: 'http://backplane.test',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  await assert.rejects(malformed.select({ head: 'world/main' }), { code: 'malformed' });
});
