/**
 * The run timeline (GEN-310). Real documents from a backplane holding the
 * Foundation ISS RF run (head sim/sha256:d6eca085…, revision 19c61635…):
 *   fixtures/receiver-track.select.json  `POST /select` of the receiver track
 *     over the run's interval (as in receiverPass.test.mjs)
 *   fixtures/run-emitters.select.json    `POST /select` of the emitter set at
 *     each of the track's 40 epochs (per-row source refs dropped)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bannerOf,
  cadenceOf,
  createRunTimelines,
  emitterQuery,
  isoInstant,
  jammerActiveFromSelection,
  nearestIndex,
  rowAt,
  stripGeometry,
  timelineFrom,
} from './runTimeline.js';
import { passQuery } from './receiverPass.js';
import { createRunClock } from './runClock.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const TRACK = fixture('receiver-track.select.json');
const EMITTERS = fixture('run-emitters.select.json');
const JAMMER = new Map(
  EMITTERS.map(({ valid_at, selection }) => [
    Date.parse(valid_at),
    jammerActiveFromSelection(selection),
  ]),
);
const TIMELINE = timelineFrom(TRACK, JAMMER);
const at = (hms) => Date.parse(`2026-10-07T${hms}Z`);

test('the ISS run is 40 epochs, 30 s apart, 13:55:00 to 14:14:30', () => {
  assert.equal(TIMELINE.rows.length, 40);
  assert.equal(TIMELINE.cadenceMs, 30_000);
  assert.equal(TIMELINE.start, at('13:55:00'));
  assert.equal(TIMELINE.end, at('14:14:30'));
  assert.equal(TIMELINE.label, 'ISS (simulated)');
  assert.equal(TIMELINE.rows[0].validAt, '2026-10-07T13:55:00Z');
});

test('the banner goes nominal → degraded → unavailable → recovering → nominal', () => {
  const states = [];
  for (const row of TIMELINE.rows)
    if (states.at(-1) !== row.stateName) states.push(row.stateName);
  assert.deepEqual(states, [
    'nominal',
    'degraded',
    'unavailable',
    'recovering',
    'degraded',
    'nominal',
  ]);
  assert.equal(
    bannerOf(rowAt(TIMELINE, at('13:55:00'))).text,
    'NOMINAL · SINR 20 dB · jammer silent',
  );
  assert.match(
    bannerOf(rowAt(TIMELINE, at('14:06:00'))).text,
    /^UNAVAILABLE · SINR −\d+ dB · jammer active$/,
  );
});

test('the banner reads state_code, sinr_db and active; nothing is re-derived', () => {
  const row = {
    ...TIMELINE.rows[0],
    state: 2,
    stateName: 'unavailable',
    sinrDb: 25,
    jammerActive: false,
  };
  assert.equal(bannerOf(row).text, 'UNAVAILABLE · SINR 25 dB · jammer silent');
  assert.equal(
    bannerOf({ ...row, sinrDb: null, jammerActive: null }).text,
    'UNAVAILABLE · SINR unknown',
  );
  assert.equal(
    bannerOf({ ...row, sinrDb: -0.4 }).text,
    'UNAVAILABLE · SINR 0 dB · jammer silent',
  );
});

test('a time between epochs is the epoch in force; the nearest epoch is where a scrub lands', () => {
  assert.equal(rowAt(TIMELINE, at('14:06:10')).validAt, '2026-10-07T14:06:00Z');
  assert.equal(rowAt(TIMELINE, at('13:00:00')), null);
  assert.equal(
    TIMELINE.rows[nearestIndex(TIMELINE, at('14:06:20'))].validAt,
    '2026-10-07T14:06:30Z',
  );
});

test('the strip shades the jammer from 13:58:00 to 14:12:00 and breaks at an unknown SINR', () => {
  const g = stripGeometry(TIMELINE, { width: 480, height: 56 });
  assert.equal(g.windows.length, 1);
  assert.equal(g.windows[0].fromMs, at('13:58:00'));
  assert.equal(g.windows[0].untilMs, at('14:12:00'));
  assert.equal(g.x(TIMELINE.start), 0);
  assert.equal(g.x(TIMELINE.end), 480);
  assert.equal(g.lines.length, 1);
  assert.equal(g.lines[0].length, 40);

  const gap = {
    ...TIMELINE,
    rows: TIMELINE.rows.map((r, i) => (i === 10 ? { ...r, sinrDb: null } : r)),
  };
  assert.deepEqual(
    stripGeometry(gap, { width: 480, height: 56 }).lines.map((l) => l.length),
    [10, 29],
  );
});

test('a run without a receiver track has no timeline; no emitter says nothing about a jammer', () => {
  assert.equal(timelineFrom({ products: [] }), null);
  assert.equal(jammerActiveFromSelection({ products: [] }), null);
  assert.equal(timelineFrom(TRACK).rows[0].jammerActive, null);
  assert.deepEqual(
    timelineFrom(TRACK).thresholds,
    [],
    'the run carries no thresholds',
  );
});

test('the timeline is read once per revision: one track select, one emitter select per epoch', async () => {
  const calls = [];
  const byInstant = new Map(EMITTERS.map((e) => [e.valid_at, e.selection]));
  const reader = createRunTimelines({
    async select({ revisionId, query }) {
      calls.push({ revisionId, query });
      if (query.requested_layers[0] === 'simulation.rf.receiver_track')
        return TRACK;
      return byInstant.get(
        new Date(Date.parse(query.valid_at))
          .toISOString()
          .replace('.000Z', '+00:00'),
      );
    },
  });
  const a = await reader.read({ revisionId: 'rev' });
  const b = await reader.read({ revisionId: 'rev' });
  assert.equal(a, b);
  assert.equal(calls.length, 41);
  assert.deepEqual(calls[0], { revisionId: 'rev', query: passQuery() });
  assert.deepEqual(calls[1].query, emitterQuery('2026-10-07T13:55:00Z'));
  assert.deepEqual(
    a.rows.map((r) => r.jammerActive),
    TIMELINE.rows.map((r) => r.jammerActive),
  );
  assert.equal(await createRunTimelines({}).read({ revisionId: 'rev' }), null);
});

test('helpers: cadence is the common gap; instants print without milliseconds', () => {
  assert.equal(cadenceOf([0, 30, 60, 120, 150]), 30);
  assert.equal(cadenceOf([5]), null);
  assert.equal(isoInstant(at('14:06:00')), '2026-10-07T14:06:00Z');
});

test('at 60× the ISS pass plays in 20 s and pauses on the last epoch', () => {
  const clock = createRunClock({ count: 40, cadenceMs: 30_000 });
  assert.equal(clock.speed, 60);
  clock.play();
  let realMs = 0;
  while (clock.playing && realMs < 60_000) {
    clock.advance(100);
    realMs += 100;
  }
  assert.equal(clock.index, 39);
  assert.equal(clock.playing, false);
  assert.ok(realMs >= 19_000 && realMs <= 20_000, `played in ${realMs} ms`);
});

test('speed is simulated seconds per real second; pause holds; play from the end restarts', () => {
  const clock = createRunClock({ count: 40, cadenceMs: 30_000, speed: 10 });
  clock.play();
  assert.equal(clock.advance(2_999), false);
  assert.equal(clock.advance(1), true);
  assert.equal(clock.index, 1);
  clock.setSpeed(1);
  assert.equal(clock.advance(29_999), false);
  clock.setSpeed(7);
  assert.equal(clock.speed, 1, 'only 1×, 10× and 60×');
  clock.pause();
  assert.equal(clock.advance(1_000_000), false);
  assert.equal(clock.index, 1);
  clock.seek(99);
  assert.equal(clock.index, 39);
  clock.play();
  assert.equal(clock.index, 0);
  clock.step(-5);
  assert.equal(clock.index, 0);
  // Late callers catch up in one call.
  clock.setSpeed(60);
  clock.advance(1_500);
  assert.equal(clock.index, 3);
});

test('without a known revision the timeline is read by head name', async () => {
  const calls = [];
  const reader = createRunTimelines({
    async select(args) {
      calls.push(args);
      return args.query.requested_layers[0] === 'simulation.rf.receiver_track'
        ? TRACK
        : { products: [] };
    },
  });
  const timeline = await reader.read({ head: 'sim/x' });
  assert.equal(timeline.rows.length, 40);
  assert.ok(calls.every((c) => c.head === 'sim/x' && !('revisionId' in c)));
});

// GEN-313: the receiver response's thresholds, from a run published with them
// (head sim/sha256:ac86cb66…, revision 51b2ead1…, world-demo after DWM-216).
const WITH_THRESHOLDS = fixture('receiver-track-thresholds.select.json');

test('a run published with thresholds draws nominal 15 dB and unavailable 0 dB', () => {
  const timeline = timelineFrom(WITH_THRESHOLDS);
  assert.deepEqual(timeline.thresholds, [
    { name: 'nominal', db: 15 },
    { name: 'unavailable', db: 0 },
  ]);
  const g = stripGeometry(timeline, { width: 480, height: 56 });
  assert.deepEqual(
    g.thresholds.map((t) => [t.name, t.db]),
    [
      ['nominal', 15],
      ['unavailable', 0],
    ],
  );
  // Each line sits where the SINR line would cross that level.
  for (const t of g.thresholds) assert.equal(t.y, g.y(t.db));
  assert.ok(g.thresholds[0].y < g.thresholds[1].y, 'nominal above unavailable');
});

test('the y range covers a threshold the SINR never reaches', () => {
  const flat = {
    ...TIMELINE,
    rows: TIMELINE.rows.map((r) => ({ ...r, sinrDb: 20 })),
    thresholds: [
      { name: 'nominal', db: 15 },
      { name: 'unavailable', db: 0 },
    ],
  };
  const g = stripGeometry(flat, { width: 480, height: 56 });
  assert.equal(g.sinrMinDb, 0);
  assert.equal(g.sinrMaxDb, 20);
  for (const t of g.thresholds) assert.ok(t.y >= 0 && t.y <= 56);
});

test('a run published before GEN-313 draws no threshold; a column that changes is not one line', () => {
  assert.deepEqual(TIMELINE.thresholds, []);
  const product = WITH_THRESHOLDS.products[0];
  const varying = {
    ...WITH_THRESHOLDS,
    products: [
      {
        ...product,
        values: product.values.map((row, i) => ({
          ...row,
          value: { ...row.value, nominal_min_sinr_db: i < 20 ? 15 : 12 },
        })),
      },
    ],
  };
  assert.deepEqual(timelineFrom(varying).thresholds, [
    { name: 'unavailable', db: 0 },
  ]);
  const partial = {
    ...WITH_THRESHOLDS,
    products: [
      {
        ...product,
        values: product.values.map((row, i) =>
          i === 3
            ? {
                ...row,
                value: { ...row.value, unavailable_below_sinr_db: null },
              }
            : row,
        ),
      },
    ],
  };
  assert.deepEqual(timelineFrom(partial).thresholds, [
    { name: 'nominal', db: 15 },
  ]);
});
