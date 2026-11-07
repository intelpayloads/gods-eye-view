/** A run's display time (GEN-395) and the run clock's continuous time and starting speed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayMsAt,
  isDisplayClock,
  pausedAt,
  runningFrom,
} from './displayClock.js';
import {
  SPEEDS,
  TARGET_PLAY_MS,
  createRunClock,
  speedFor,
} from './runClock.js';

test('a paused clock holds its time however long it waits', () => {
  const clock = pausedAt(1_000, 50);
  assert.equal(displayMsAt(clock, 50), 1_000);
  assert.equal(displayMsAt(clock, 60_000), 1_000);
});

test('a running clock advances at its speed and stops at the end of the run', () => {
  const clock = runningFrom(10_000, 200, 10);
  assert.equal(displayMsAt(clock, 200), 10_000);
  assert.equal(displayMsAt(clock, 700), 15_000);
  assert.equal(displayMsAt(clock, 10_000, { start: 0, end: 50_000 }), 50_000);
  // A frame stamped before the anchor never runs the clock backwards.
  assert.equal(displayMsAt(clock, 100), 10_000);
  assert.equal(displayMsAt(runningFrom(0, 0, 10), 0, { start: 5_000 }), 5_000);
});

test('no clock, or a malformed one, has no display time', () => {
  assert.equal(displayMsAt(null, 0), null);
  assert.equal(
    isDisplayClock({ atMs: Number.NaN, anchorPerf: 0, rate: 0 }),
    false,
  );
  assert.equal(isDisplayClock(runningFrom(0, 0, -3)), true);
  assert.equal(runningFrom(0, 0, -3).rate, 0);
});

test('re-anchoring where the clock is keeps drawn motion continuous across an epoch', () => {
  // The player re-anchors when its index moves; the time it gives is the
  // epoch plus the carry, which is where the old clock already was.
  const run = createRunClock({ count: 4, cadenceMs: 5_000, speed: 10 });
  const epochs = [0, 5_000, 10_000, 15_000];
  run.play();
  let clock = runningFrom(epochs[run.index], 0, run.speed);
  run.advance(620); // one epoch is 500 ms at 10x: index 1, 120 ms carried
  assert.equal(run.index, 1);
  assert.equal(run.carryMs, 120);
  const before = displayMsAt(clock, 620);
  clock = runningFrom(
    epochs[run.index] + run.carryMs * run.speed,
    620,
    run.speed,
  );
  assert.equal(displayMsAt(clock, 620), before);
  run.pause();
  assert.equal(run.carryMs, 0);
});

test('a run starts at the slowest speed that plays it in 30 s', () => {
  // The C-UAS return-home run: 2.5 minutes -> 10x, 15 s.
  assert.equal(speedFor({ start: 0, end: 150_000 }), 10);
  // A 25 s hover plays in real time.
  assert.equal(speedFor({ start: 0, end: 25_000 }), 1);
  // The ISS pass: 20 minutes -> 60x, as before.
  assert.equal(speedFor({ start: 0, end: 1_200_000 }), 60);
  // Longer than any speed manages: the fastest.
  assert.equal(speedFor({ start: 0, end: 10 * 3_600_000 }), SPEEDS.at(-1));
  assert.equal(speedFor({}), SPEEDS.at(-1));
  for (const span of [25_000, 150_000, 1_200_000]) {
    const speed = speedFor({ start: 0, end: span });
    assert.ok(span / speed <= TARGET_PLAY_MS);
    const slower = SPEEDS.filter((s) => s < speed);
    assert.ok(slower.every((s) => span / s > TARGET_PLAY_MS));
  }
});
