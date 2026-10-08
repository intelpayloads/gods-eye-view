/**
 * The receiver pass (GEN-309). One real document from a backplane holding the
 * Foundation ISS RF run (head sim/sha256:d6eca085…, revision 19c61635…):
 *   fixtures/receiver-track.select.json  `POST /select` for the run's
 *     receiver track over its whole interval (plan trimmed to the track,
 *     per-row source refs dropped)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PASS_HEIGHT_GRANT,
  RECEIVER_STATES,
  RECEIVER_TRACK_BINDING,
  createReceiverPasses,
  passQuery,
  passesFromSelection,
  receiverName,
  segmentsOf,
  showsReceiverPass,
} from './receiverPass.js';
import { DEFAULT_DISPLAY_ASSUMPTIONS } from './view.js';

const SELECTION = JSON.parse(
  readFileSync(
    new URL('./fixtures/receiver-track.select.json', import.meta.url),
  ),
);
const RUN_HEAD = SELECTION.plan[0].head;

const RUN_DEMAND = {
  head: RUN_HEAD,
  modalities: ['simulated'],
  layers: null,
  displayAssumptions: { ...DEFAULT_DISPLAY_ASSUMPTIONS },
};

test('the ISS pass is every stored epoch, Atlantic to Red Sea, red over the East Med from 14:04:30 to 14:08:30', () => {
  const [pass] = passesFromSelection(SELECTION);
  assert.equal(pass.samples, 40);
  assert.equal(pass.first, '2026-10-07T13:55:00+00:00');
  assert.equal(pass.last, '2026-10-07T14:14:30+00:00');
  assert.equal(pass.identity, 'satellite:norad:25544');
  assert.equal(pass.label, 'ISS (simulated)');

  assert.deepEqual(
    pass.segments.map((s) => [
      s.name,
      s.from.slice(11, 19),
      s.until.slice(11, 19),
    ]),
    [
      ['nominal', '13:55:00', '14:03:30'],
      ['degraded', '14:03:30', '14:04:30'],
      ['unavailable', '14:04:30', '14:08:30'],
      ['recovering', '14:08:30', '14:09:30'],
      ['degraded', '14:09:30', '14:10:00'],
      ['nominal', '14:10:00', '14:14:30'],
    ],
  );
  // The path is continuous: each stretch starts where the last one ended.
  for (let i = 1; i < pass.segments.length; i++) {
    assert.deepEqual(
      pass.segments[i].positions[0],
      pass.segments[i - 1].positions.at(-1),
    );
  }
  const all = pass.segments.flatMap((s) => s.positions);
  assert.ok(all[0].lon < -20, 'starts over the Atlantic');
  assert.ok(
    all.at(-1).lon > 32 && all.at(-1).lat < 30,
    'ends over the Red Sea',
  );
  const red = pass.segments.find((s) => s.name === 'unavailable');
  assert.ok(
    red.positions.every((p) => p.lon > 15 && p.lon < 36),
    'red over the East Med',
  );
  // At altitude, exactly as stored.
  const row = SELECTION.products[0].values[0].value;
  assert.deepEqual(all[0], {
    lon: row.lon_deg,
    lat: row.lat_deg,
    height: row.height_m,
  });
});

test('colour comes from state_code, never from sinr_db', () => {
  const rows = SELECTION.products[0].values.slice(0, 3).map((row, i) => ({
    ...row,
    // A SINR that would read as nominal, under a state that says unavailable.
    value: { ...row.value, sinr_db: 30, state_code: i < 2 ? 2 : 0 },
  }));
  const [pass] = passesFromSelection({
    products: [{ ...SELECTION.products[0], values: rows }],
  });
  assert.equal(pass.segments[0].name, 'unavailable');
  assert.deepEqual(pass.segments[0].colorRgb, RECEIVER_STATES[2].colorRgb);
});

test('a missing or out-of-legend state is unknown, grey', () => {
  const at = (s) => `2026-10-07T13:5${s}:00+00:00`;
  const sample = (s, code) => ({
    semantic_identity: 'x',
    valid_time: at(s),
    value: { lon_deg: s, lat_deg: 0, height_m: 1, state_code: code },
  });
  const [pass] = passesFromSelection({
    products: [
      {
        product_ref: {
          type_id: 'simulation.rf.receiver_track_sample_series.v1',
        },
        values: [sample(0, null), sample(1, 9), sample(2, 0)],
      },
    ],
  });
  assert.deepEqual(
    pass.segments.map((s) => s.name),
    ['unknown'],
  );
});

test('a row without a finite position breaks the path instead of being bridged', () => {
  const p = (lon) => ({ lon, lat: 0, height: 1 });
  const segments = segmentsOf([
    { at: 0, state: 0, position: p(0) },
    { at: 1, state: 0, position: p(1) },
    { at: 2, state: 0, position: null },
    { at: 3, state: 0, position: p(3) },
    { at: 4, state: 0, position: p(4) },
  ]);
  assert.deepEqual(
    segments.map((s) => s.positions.map((q) => q.lon)),
    [
      [0, 1],
      [3, 4],
    ],
  );
});

test('a run without a receiver track draws nothing extra', () => {
  assert.deepEqual(passesFromSelection({ products: [] }), []);
  assert.deepEqual(passesFromSelection(null), []);
  // Values withheld for size: no rows to draw, not an error.
  assert.deepEqual(
    passesFromSelection({
      products: [{ ...SELECTION.products[0], values: null }],
    }),
    [],
  );
});

test('only a run head showing the simulated track under the height grant draws a pass', () => {
  assert.equal(showsReceiverPass(RUN_DEMAND), true);
  assert.equal(
    showsReceiverPass({ ...RUN_DEMAND, layers: [RECEIVER_TRACK_BINDING] }),
    true,
  );
  assert.equal(showsReceiverPass({ ...RUN_DEMAND, head: 'world/main' }), false);
  assert.equal(showsReceiverPass({ ...RUN_DEMAND, modalities: null }), false);
  assert.equal(
    showsReceiverPass({ ...RUN_DEMAND, layers: ['simulation.rf.emitters'] }),
    false,
  );
  const { [PASS_HEIGHT_GRANT.key]: _, ...ungranted } =
    DEFAULT_DISPLAY_ASSUMPTIONS;
  assert.equal(
    showsReceiverPass({ ...RUN_DEMAND, displayAssumptions: ungranted }),
    false,
  );
});

test('the pass is read once per revision with one select over the whole interval', async () => {
  const calls = [];
  const passes = createReceiverPasses({
    async select(args) {
      calls.push(args);
      return SELECTION;
    },
  });
  const [a] = await passes.read({ revisionId: SELECTION.revision_id });
  const [b] = await passes.read({ revisionId: SELECTION.revision_id });
  assert.equal(a, b);
  assert.deepEqual(calls, [
    { revisionId: SELECTION.revision_id, query: passQuery() },
  ]);
  assert.deepEqual(calls[0].query.requested_layers, [RECEIVER_TRACK_BINDING]);
  assert.ok(
    calls[0].query.predicates.interval,
    'the whole series, not one valid_at',
  );
});

test('a failed read is retried; a source without select has no passes', async () => {
  let fail = true;
  const passes = createReceiverPasses({
    async select() {
      if (fail) throw new Error('backplane down');
      return SELECTION;
    },
  });
  await assert.rejects(passes.read({ revisionId: 'r' }), /backplane down/);
  fail = false;
  assert.equal((await passes.read({ revisionId: 'r' })).length, 1);
  assert.deepEqual(
    await createReceiverPasses({}).read({ revisionId: 'r' }),
    [],
  );
});

test('the label is the receiver name, else the identity', () => {
  assert.equal(receiverName('receiver:foundation:iss-receiver'), 'ISS');
  assert.equal(
    receiverName('', 'satellite:norad:25544'),
    'satellite:norad:25544',
  );
});
