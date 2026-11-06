/**
 * The drone's track (GEN-395). One real document from prod's backplane
 * holding a Foundation C-UAS return-home run (contested: the link is jammed,
 * the failsafe fires and the drone flies home; head sim/sha256:043d75f9…,
 * revision d6814ab5…):
 *   fixtures/uas-track.select.json  `POST /select` for the run's
 *     `simulation.uas.track` over its whole interval (plan trimmed to the
 *     track, per-row source refs dropped)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DRONE_DISPLAY,
  FLIGHT_MODEL_AIRFRAMES,
  UAS_TRACK_BINDING,
  c2Colour,
  createUasTracks,
  displayPoseAt,
  droneModelFor,
  droneName,
  headingAt,
  modeChanges,
  showsUasTrack,
  storedRowAt,
  uasQuery,
  uasTracksFromSelection,
} from './uasTrack.js';
import { RECEIVER_STATES } from './receiverPass.js';
import { uasLabel } from './uasCard.js';
import { DEFAULT_DISPLAY_ASSUMPTIONS } from './view.js';

const SELECTION = JSON.parse(
  readFileSync(new URL('./fixtures/uas-track.select.json', import.meta.url)),
);
const [TRACK] = uasTracksFromSelection(SELECTION);
const ms = (hms) => Date.parse(`2026-11-05T${hms}Z`);

/** Rows along a list of [lat, lon] at 5 s, a stand-in for a kernel's legs. */
function rowsAlong(points, { modeCode = 0 } = {}) {
  return points.map(([lat, lon], i) => ({
    at: i * 5000,
    position: { lat, lon, height: 100 },
    modeCode,
  }));
}

function closeTo(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? ''} ${actual} is not within ${tolerance} of ${expected}`,
  );
}

test('the track reads one drone, every stored epoch in order, with its header', () => {
  const tracks = uasTracksFromSelection(SELECTION);
  assert.equal(tracks.length, 1);
  assert.equal(TRACK.identity, 'platform:foundation:uas-1');
  assert.equal(TRACK.rows.length, SELECTION.products[0].values.length);
  for (let i = 1; i < TRACK.rows.length; i++)
    assert.ok(TRACK.rows[i - 1].at < TRACK.rows[i].at);
  assert.equal(TRACK.header.models.flight, 'dataforge.multirotor-flight/1');
  // Codes are served as floats (0.0) and read as the integers they are.
  assert.ok(TRACK.rows.every((row) => Number.isInteger(row.modeCode)));
  assert.ok(TRACK.rows.every((row) => Number.isInteger(row.c2StateCode)));
  // Nothing but the track is read.
  assert.deepEqual(uasTracksFromSelection({ products: [] }), []);
  assert.deepEqual(uasQuery().requested_layers, [UAS_TRACK_BINDING]);
});

test('mode changes are where the stored mode changes: return altitude, transit, landing, landed', () => {
  const names = TRACK.header.mode_codes;
  const changes = modeChanges(TRACK.rows);
  assert.deepEqual(
    changes.map((row) => [row.validTime.slice(11, 19), names[row.modeCode]]),
    [
      ['16:01:10', 'return_altitude'],
      ['16:01:35', 'return_transit'],
      ['16:02:10', 'landing'],
      ['16:02:30', 'landed'],
    ],
  );
  // The GEN-381 hold reads the same way: mission until the timeout, then holding.
  const hover = TRACK.rows
    .slice(0, 21)
    .map((row) => ({ ...row, modeCode: row.at >= ms('16:01:10') ? 4 : 0 }));
  assert.deepEqual(
    modeChanges(hover).map((row) => [
      row.validTime.slice(11, 19),
      names[row.modeCode],
    ]),
    [['16:01:10', 'holding']],
  );
  assert.deepEqual(
    modeChanges(
      rowsAlong([
        [0, 0],
        [0, 1],
      ]),
    ),
    [],
  );
});

test('a chord north, east, south or west points the drone that way', () => {
  const cases = [
    [[0, 0.001], 0],
    [[0.001, 0], 90],
    [[0, -0.001], 180],
    [[-0.001, 0], 270],
  ];
  for (const [[dLon, dLat], expected] of cases) {
    const rows = rowsAlong([
      [10, 20],
      [10 + dLat, 20 + dLon],
      [10 + 2 * dLat, 20 + 2 * dLon],
    ]);
    // Past the turn at the second segment's start, and on the first.
    for (const at of [2500, 7500]) {
      const heading = headingAt(rows, at);
      const off = Math.abs(((heading - expected + 540) % 360) - 180);
      assert.ok(off < 0.5, `heading ${heading} for ${expected}`);
    }
  }
});

test('a corner turns over the first quarter of the segment instead of snapping', () => {
  // North, then east.
  const rows = rowsAlong([
    [0, 0],
    [0.001, 0],
    [0.001, 0.001],
  ]);
  const quarter = 5000 * DRONE_DISPLAY.turnFraction;
  closeTo(headingAt(rows, 5000), 0, 0.5, 'at the corner');
  closeTo(headingAt(rows, 5000 + quarter / 2), 45, 0.5, 'half way round');
  closeTo(headingAt(rows, 5000 + quarter), 90, 0.5, 'round');
  closeTo(headingAt(rows, 9000), 90, 0.5, 'on the new leg');
});

test('a drone that hovers keeps the bearing it last flew, or the first it will fly', () => {
  const at = (hms) => headingAt(TRACK.rows, ms(hms));
  // Climbing straight up from home: the outbound leg's bearing, ~34 degrees.
  closeTo(at('16:00:10'), 34, 1, 'climbing out');
  closeTo(at('16:00:50'), 34, 1, 'outbound');
  // Descending to the return height in place: still the outbound bearing.
  closeTo(at('16:01:22'), 34, 1, 'return altitude');
  // Home is behind it.
  closeTo(at('16:01:50'), 214, 1, 'return transit');
  closeTo(at('16:02:20'), 214, 1, 'landing');
  // A drone that never moves sideways has no heading to draw.
  const still = rowsAlong([
    [0, 0],
    [0, 0],
  ]);
  assert.equal(headingAt(still, 2500), null);
});

test('between epochs the drawn drone is on the chord: the midpoint at mid-segment', () => {
  const [a, b] = [TRACK.rows[9], TRACK.rows[10]];
  const pose = displayPoseAt(TRACK.rows, (a.at + b.at) / 2);
  closeTo(pose.lon, (a.position.lon + b.position.lon) / 2, 1e-9);
  closeTo(pose.lat, (a.position.lat + b.position.lat) / 2, 1e-9);
  closeTo(pose.height, (a.position.height + b.position.height) / 2, 1e-6);
  assert.equal(displayPoseAt(TRACK.rows, TRACK.rows[0].at - 1), null);
  assert.equal(displayPoseAt(TRACK.rows, TRACK.rows.at(-1).at + 1), null);
});

test('the interpolation never feeds a value: everything shown is the stored epoch at or before', () => {
  const rows = TRACK.rows;
  for (let i = 0; i < rows.length - 1; i++) {
    for (const f of [0, 0.1, 0.5, 0.9, 0.999]) {
      const t = rows[i].at + f * (rows[i + 1].at - rows[i].at);
      const stored = storedRowAt(rows, t);
      assert.equal(stored, rows[i], `at ${new Date(t).toISOString()}`);
      assert.ok(stored.at <= t);
      assert.equal(
        uasLabel(stored, TRACK.header, TRACK.identity),
        uasLabel(rows[i], TRACK.header, TRACK.identity),
      );
    }
  }
  // Mid-descent (120 m -> 105 m AGL) the label says the stored 120, not 112.
  const label = uasLabel(
    storedRowAt(rows, ms('16:01:12.500')),
    TRACK.header,
    TRACK.identity,
  );
  assert.match(label, /\b120 M AGL\b/);
  assert.equal(storedRowAt(rows, rows[0].at - 1), null);
  assert.equal(storedRowAt(rows, rows.at(-1).at + 60_000), rows.at(-1));
});

test('the drawn model is the product’s declared flight model, or none and why', () => {
  const declared = droneModelFor(TRACK.header);
  assert.equal(declared.reason, null);
  assert.equal(declared.model.url, '/models/multirotor.glb');
  assert.equal(declared.model.airframe, 'multirotor');
  const unknown = droneModelFor({
    models: { flight: 'dataforge.ornithopter/1' },
  });
  assert.equal(unknown.model, null);
  assert.match(unknown.reason, /dataforge\.ornithopter\/1/);
  assert.equal(droneModelFor(null).model, null);
  assert.equal(droneModelFor({ models: {} }).model, null);
  // Every entry is a model file under public/models with the shared convention's offset.
  for (const entry of Object.values(FLIGHT_MODEL_AIRFRAMES)) {
    assert.match(entry.url, /^\/models\/[\w-]+\.glb$/);
    assert.equal(entry.headingOffsetDeg, 180);
  }
});

test('the C2 colour is the state the product’s legend names, in the receiver pass’s colours', () => {
  const header = TRACK.header;
  assert.deepEqual(c2Colour(header, 0), RECEIVER_STATES[0].colorRgb);
  assert.deepEqual(c2Colour(header, 2), RECEIVER_STATES[2].colorRgb);
  // A legend that names states in another order still colours by name.
  const swapped = { c2_state_codes: { 0: 'unavailable', 2: 'nominal' } };
  assert.deepEqual(c2Colour(swapped, 0), RECEIVER_STATES[2].colorRgb);
  assert.deepEqual(c2Colour(null, 0), RECEIVER_STATES[4].colorRgb);
  assert.equal(droneName('platform:foundation:uas-1'), 'UAS-1');
});

test('the drone is shown only inside a run, in the simulated modality, under the height grant', () => {
  const demand = {
    head: 'sim/sha256:043d75f9',
    modalities: ['simulated'],
    layers: [UAS_TRACK_BINDING],
    displayAssumptions: DEFAULT_DISPLAY_ASSUMPTIONS,
  };
  assert.equal(showsUasTrack(demand), true);
  assert.equal(showsUasTrack({ ...demand, layers: null }), true);
  assert.equal(showsUasTrack({ ...demand, head: 'world/main' }), false);
  assert.equal(showsUasTrack({ ...demand, modalities: ['observed'] }), false);
  assert.equal(
    showsUasTrack({ ...demand, layers: ['simulation.rf.receiver_track'] }),
    false,
  );
  assert.equal(showsUasTrack({ ...demand, displayAssumptions: {} }), false);
});

test('a revision’s track is read once and re-read after a failure', async () => {
  let calls = 0;
  let fail = true;
  const source = {
    async select({ revisionId, query }) {
      calls++;
      assert.equal(revisionId, 'rev-1');
      assert.deepEqual(query, uasQuery());
      if (fail) throw new Error('backplane down');
      return SELECTION;
    },
  };
  const tracks = createUasTracks(source);
  await assert.rejects(tracks.read({ revisionId: 'rev-1' }));
  fail = false;
  const [first] = await tracks.read({ revisionId: 'rev-1' });
  await tracks.read({ revisionId: 'rev-1' });
  assert.equal(calls, 2);
  assert.equal(first.rows.length, TRACK.rows.length);
  assert.deepEqual(await createUasTracks({}).read({ revisionId: 'rev-1' }), []);
});
