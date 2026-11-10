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
  AIRFRAME_ROOT,
  DRONE_BINDINGS,
  DRONE_DISPLAY_FACT,
  DRONE_TRACK_AIRFRAME,
  DRONE_TRACK_BINDING,
  DRONE_TRACK_COLOUR,
  DRONE_TRACK_MODEL_FACT,
  UAS_TRACK_BINDING,
  airframeFact,
  airframeOf,
  airframePath,
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

test('a drone track with no airframe in its header is drawn as a multirotor; the C-UAS rule is unchanged', () => {
  assert.deepEqual(droneModelFor(TRACKS[0].header, DRONE_TRACK_BINDING), {
    model: DRONE_TRACK_AIRFRAME,
    reason: null,
  });
  assert.equal(DRONE_TRACK_AIRFRAME.url, '/models/multirotor.glb');
  assert.equal(droneModelFor(TRACKS[0].header).model, null);
  assert.equal(droneModelFor(null, UAS_TRACK_BINDING).model, null);
});

const AIRFRAME_ID = `sha256:${'5e'.repeat(32)}`;
const WITH_AIRFRAME = {
  schema: 'dataforge.drone-track-delivery/1',
  models: { airframe: { content_id: AIRFRAME_ID, extent_m: 1.4 } },
};
const resolveUrl = (path) => `/world${path}`;

test('a header\'s airframe is read by content id through the source, in the stock model\'s convention (GEN-476)', () => {
  const airframe = airframeOf(WITH_AIRFRAME);
  assert.deepEqual(airframe, { contentId: AIRFRAME_ID, root: AIRFRAME_ROOT, extentM: 1.4 });
  assert.equal(airframePath(airframe), `/tilesets/${AIRFRAME_ID}/airframe.glb`);
  const { model, reason, note } = droneModelFor(WITH_AIRFRAME, DRONE_TRACK_BINDING, { resolveUrl });
  assert.equal(model.url, `/world/tilesets/${AIRFRAME_ID}/airframe.glb`);
  assert.deepEqual(model.published, airframe);
  assert.deepEqual(
    [model.headingOffsetDeg, model.minimumPixelSize],
    [DRONE_TRACK_AIRFRAME.headingOffsetDeg, DRONE_TRACK_AIRFRAME.minimumPixelSize],
    'nose toward -X, and a small airframe stays visible',
  );
  assert.equal(reason, null);
  assert.equal(note, undefined);
  // The header may name the file; a name that is a path is not taken.
  const named = (root) => airframeOf({ models: { airframe: { content_id: AIRFRAME_ID, root } } }).root;
  assert.equal(named('raven.glb'), 'raven.glb');
  assert.equal(named('../secrets'), AIRFRAME_ROOT);
  // Nothing published, or an id that is not one: the multirotor, with today's fact.
  for (const header of [null, {}, { models: {} }, { models: { airframe: { content_id: '' } } }, { models: { airframe: { content_id: 'a/b' } } }])
    assert.equal(airframeOf(header), null);
  // A source that serves no files cannot show it, and says so.
  const without = droneModelFor(WITH_AIRFRAME, DRONE_TRACK_BINDING);
  assert.equal(without.model, DRONE_TRACK_AIRFRAME);
  assert.match(without.note, /^airframe sha256:5e5e5e5e drawn as a multirotor: this source serves no files$/);
  // The C-UAS track never reads it.
  assert.equal(droneModelFor(WITH_AIRFRAME, UAS_TRACK_BINDING).model, null);
});

function drawn(source, loaders) {
  const added = [];
  const viewer = { dataSources: { add: (s) => added.push(s), remove() {} }, isDestroyed: () => false };
  let changes = 0;
  const view = createDroneView({
    id: `world-product:${DRONE_TRACK_BINDING}`,
    source,
    displayMs: () => ms(5),
    onModelChange: () => changes++,
    loaders,
  });
  view.init(viewer);
  view.show(true);
  const tracks = TRACKS.map((track, i) => (i === 0 ? { ...track, header: WITH_AIRFRAME } : track));
  view.draw(tracks, { revisionId: REVISION, sites: new Map() });
  const uri = (i) =>
    added[0].entities.values.find((e) => e.id === droneItemId(tracks[i].identity, DRONE_TRACK_BINDING)).model.uri.getValue();
  return { view, uri, tracks, changes: () => changes };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a drone is drawn with its published airframe once the mesh has been read; the others stay multirotors', async () => {
  const probed = [];
  const { view, uri, changes } = drawn({ resolveUrl }, { probe: async (url) => void probed.push(url) });
  assert.ok(uri(0).endsWith('/models/multirotor.glb'), 'the multirotor until the mesh is read');
  await settled();
  assert.deepEqual(probed, [`/world/tilesets/${AIRFRAME_ID}/airframe.glb`]);
  assert.equal(uri(0), `/world/tilesets/${AIRFRAME_ID}/airframe.glb`);
  assert.ok(uri(1).endsWith('/models/multirotor.glb'));
  assert.equal(changes(), 1);
  assert.deepEqual(view.facts(), [
    {
      label: DRONE_TRACK_BINDING,
      lines: [DRONE_DISPLAY_FACT, airframeFact(airframeOf(WITH_AIRFRAME)), DRONE_TRACK_MODEL_FACT],
    },
  ]);
  assert.match(airframeFact(airframeOf(WITH_AIRFRAME)), /published \(sha256:5e5e5e5e\)$/);
  view.destroy();
});

test('an airframe that does not load, or a source with no files, leaves the multirotor and says why', async () => {
  const failed = drawn({ resolveUrl }, { probe: async () => Promise.reject(new Error('HTTP 404')) });
  await settled();
  assert.ok(failed.uri(0).endsWith('/models/multirotor.glb'));
  assert.deepEqual(failed.view.facts()[0].lines, [
    DRONE_DISPLAY_FACT,
    DRONE_TRACK_MODEL_FACT,
    `display: ${failed.tracks[0].identity}: airframe sha256:5e5e5e5e drawn as a multirotor: it did not load (HTTP 404)`,
  ]);
  assert.equal(failed.changes(), 1);
  failed.view.destroy();

  let probes = 0;
  const bare = drawn({}, { probe: async () => void probes++ });
  await settled();
  assert.equal(probes, 0, 'nothing to read it through');
  assert.ok(bare.uri(0).endsWith('/models/multirotor.glb'));
  assert.equal(
    bare.view.facts()[0].lines.at(-1),
    `display: ${bare.tracks[0].identity}: airframe sha256:5e5e5e5e drawn as a multirotor: this source serves no files`,
  );
  bare.view.destroy();
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
