/**
 * A DronePath run's drones (GEN-455): `simulation.drone.track`, drawn by the
 * drone view the C-UAS track uses. The selection is in the shape World
 * Model's `/select` answers for the product (`dataforge-drone-track.yaml`,
 * DWM-285): many drones in one head, each under its scenario object's
 * identity with a `callsign` series key, and no mode or C2 state.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDroneView, droneItemId } from './droneView.js';
import {
  DRONE_BINDINGS,
  DRONE_DISPLAY_FACT,
  DRONE_TRACK_AIRFRAME,
  DRONE_TRACK_BINDING,
  DRONE_TRACK_COLOUR,
  DRONE_TRACK_MODEL_FACT,
  UAS_TRACK_BINDING,
  displayPoseAt,
  droneModelFor,
  droneName,
  modeChanges,
  showsBinding,
  showsUasTrack,
  uasQuery,
  uasTracksFromSelection,
} from './uasTrack.js';
import { droneTrackLabel } from './uasCard.js';
import { DEFAULT_DISPLAY_ASSUMPTIONS } from './view.js';

const REVISION = 'a'.repeat(32);
const SCENARIO = '7d0c2a1e';
const identity = (key) => `laydown:dataforge:${SCENARIO}:${key}`;
const at = (s) => `2026-11-10T15:00:${String(s).padStart(2, '0')}+00:00`;

function rows(key, callsign, lon0) {
  return [0, 5, 10].map((s, i) => ({
    semantic_identity: identity(key),
    valid_time: at(s),
    series_key: { callsign },
    value: {
      lon_deg: lon0 + i * 0.0005,
      lat_deg: 38.994 + i * 0.0005,
      height_m: 1900 + i * 10,
      speed_mps: i === 2 ? null : 14.04,
      heading_deg: 37.5,
    },
  }));
}

/** Two drones' rows, the second drone's first, as one stored product. */
const SELECTION = {
  revision_id: REVISION,
  products: [
    {
      product_ref: { type_id: 'simulation.drone.track_sample_series.v1' },
      binding: DRONE_TRACK_BINDING,
      semantic_metadata: { schema: 'dataforge.drone-track-delivery/1' },
      values: [
        ...rows('drone-2', 'RAVEN-2', -104.99),
        ...rows('drone-1', 'RAVEN-1', -104.98),
      ],
    },
  ],
};
const TRACKS = uasTracksFromSelection(SELECTION);
const ms = (s) => Date.parse(at(s));

test('one read asks for both drone bindings, the C-UAS track first', () => {
  assert.deepEqual(uasQuery().requested_layers, [
    UAS_TRACK_BINDING,
    DRONE_TRACK_BINDING,
  ]);
  assert.deepEqual([...DRONE_BINDINGS], uasQuery().requested_layers);
});

test('the track reads every drone of the head, under its identity and callsign', () => {
  assert.equal(TRACKS.length, 2);
  const byName = new Map(TRACKS.map((t) => [t.callsign, t]));
  const one = byName.get('RAVEN-1');
  assert.equal(one.identity, identity('drone-1'));
  assert.equal(one.binding, DRONE_TRACK_BINDING);
  assert.equal(one.gcs, null);
  assert.equal(one.rows.length, 3);
  assert.deepEqual(one.rows[0].position, {
    lon: -104.98,
    lat: 38.994,
    height: 1900,
  });
  assert.equal(one.rows[0].speedMps, 14.04);
  assert.equal(one.rows[0].headingDeg, 37.5);
  assert.equal(one.rows[2].speedMps, null, 'an absent speed stays absent');
  // No mode and no C2 state: nothing to mark, nothing to colour by.
  assert.ok(one.rows.every((r) => r.modeCode === null));
  assert.ok(one.rows.every((r) => r.c2StateCode === null));
  assert.deepEqual(modeChanges(one.rows), []);
  // Geometry is the same chord between stored epochs.
  const pose = displayPoseAt(one.rows, ms(0) + 2500);
  assert.ok(Math.abs(pose.height - 1905) < 1e-6);
});

test('a C-UAS track and a drone track with one identity stay two tracks', () => {
  const shared = 'platform:foundation:uas-1';
  const row = (extra) => ({
    semantic_identity: shared,
    valid_time: at(0),
    value: { lon_deg: 1, lat_deg: 2, height_m: 3, ...extra },
  });
  const tracks = uasTracksFromSelection({
    products: [
      {
        product_ref: { type_id: 'simulation.uas.track_sample_series.v1' },
        values: [row({ mode_code: 0, c2_state_code: 0 })],
      },
      {
        product_ref: { type_id: 'simulation.drone.track_sample_series.v1' },
        values: [row({ speed_mps: 5 })],
      },
      {
        product_ref: { type_id: 'simulation.rf.links_sample_series.v1' },
        values: [row({})],
      },
    ],
  });
  assert.deepEqual(
    tracks.map((t) => t.binding),
    [UAS_TRACK_BINDING, DRONE_TRACK_BINDING],
  );
  assert.equal(tracks[0].rows[0].speedMps, undefined);
  assert.equal(tracks[0].callsign, null);
});

test('a drone track is drawn as a multirotor whatever its header says; the C-UAS rule is unchanged', () => {
  assert.deepEqual(droneModelFor(TRACKS[0].header, DRONE_TRACK_BINDING), {
    model: DRONE_TRACK_AIRFRAME,
    reason: null,
  });
  assert.equal(DRONE_TRACK_AIRFRAME.url, '/models/multirotor.glb');
  assert.equal(droneModelFor(TRACKS[0].header).model, null);
  assert.equal(droneModelFor(null, UAS_TRACK_BINDING).model, null);
});

test('the label is the callsign, then the stored height and speed', () => {
  const [track] = TRACKS.filter((t) => t.callsign === 'RAVEN-1');
  assert.equal(
    droneTrackLabel(track.rows[1], track),
    'RAVEN-1\n1910 M HAE · 14.0 M/S',
  );
  assert.equal(droneTrackLabel(track.rows[2], track), 'RAVEN-1\n1920 M HAE');
  assert.equal(droneTrackLabel(null, track), '');
  // Without a callsign the name is the identity's tail, as before.
  assert.equal(droneName(identity('drone-1')), 'DRONE-1');
  assert.equal(droneName(identity('drone-1'), ''), 'DRONE-1');
  assert.equal(
    droneTrackLabel(track.rows[2], { identity: identity('drone-1') }),
    'DRONE-1\n1920 M HAE',
  );
});

test('a row shows the drones only for a run, simulated, granted heights and its own binding', () => {
  const demand = (extra = {}) => ({
    head: 'sim/sha256:abc',
    modalities: ['simulated'],
    layers: [DRONE_TRACK_BINDING],
    displayAssumptions: { ...DEFAULT_DISPLAY_ASSUMPTIONS },
    ...extra,
  });
  assert.equal(showsUasTrack(demand()), true);
  assert.equal(showsUasTrack(demand({ layers: null })), true);
  assert.equal(showsUasTrack(demand({ layers: ['world.weather'] })), false);
  assert.equal(showsUasTrack(demand({ head: 'world/main' })), false);
  assert.equal(showsUasTrack(demand({ displayAssumptions: {} })), false);
  assert.equal(showsBinding(demand(), DRONE_TRACK_BINDING), true);
  assert.equal(showsBinding(demand(), UAS_TRACK_BINDING), false);
  assert.equal(showsBinding(demand({ layers: null }), UAS_TRACK_BINDING), true);
});

test('every drone of the head is a model under its own item id, with no C2 path and no mode marks', () => {
  const added = [];
  const viewer = {
    dataSources: { add: (s) => added.push(s), remove() {} },
    isDestroyed: () => false,
  };
  let displayAt = ms(5);
  const view = createDroneView({
    id: `world-product:${DRONE_TRACK_BINDING}`,
    source: {},
    displayMs: () => displayAt,
  });
  view.init(viewer);
  view.show(true);
  view.draw(TRACKS, { revisionId: REVISION, sites: new Map() });
  const entities = added[0].entities.values;
  assert.equal(entities.length, 2, 'two models and nothing else');
  const ids = entities.map((e) => e.id).sort();
  assert.deepEqual(ids, [
    droneItemId(identity('drone-1'), DRONE_TRACK_BINDING),
    droneItemId(identity('drone-2'), DRONE_TRACK_BINDING),
  ]);
  assert.equal(ids[0], `simulation.drone.track/${identity('drone-1')}`);
  assert.deepEqual(view.drawnItemIds(), new Set(ids));
  const one = entities.find((e) => e.id === ids[0]);
  assert.equal(one.properties.binding.getValue(), DRONE_TRACK_BINDING);
  assert.equal(one.label.text.getValue(), 'RAVEN-1\n1910 M HAE · 14.0 M/S');
  const colour = one.label.fillColor.getValue();
  assert.deepEqual(
    [colour.red, colour.green, colour.blue],
    [...DRONE_TRACK_COLOUR],
  );
  assert.ok(one.model.uri.getValue().endsWith('/models/multirotor.glb'));
  // The label follows the stored epoch as the display time moves.
  displayAt = ms(10);
  assert.equal(one.label.text.getValue(), 'RAVEN-1\n1920 M HAE');
  // The row's facts say both display choices, under the product's binding.
  assert.deepEqual(view.facts(), [
    {
      label: DRONE_TRACK_BINDING,
      lines: [DRONE_DISPLAY_FACT, DRONE_TRACK_MODEL_FACT],
    },
  ]);
  view.destroy();
});
