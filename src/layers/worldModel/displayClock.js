/**
 * A run's display time (GEN-395): where drawn things are, between stored
 * epochs, while the run player plays.
 *
 * The query time (`validAt`) stays on stored epochs: the projection, cards,
 * labels and colours all read the stored epoch at or before the display time.
 * Only geometry -- a drone's position and heading, a receiver's marker, a
 * link's end, a card's anchor -- follows this clock, by straight-line display
 * interpolation between the stored epochs around it. That is a labelled
 * display assumption, never data.
 *
 * The clock is linear: `atMs + (perfNow - anchorPerf) * rate`, with `rate`
 * the player's speed (simulated ms per real ms) while it plays and 0 paused.
 * The player re-anchors it whenever its own clock moves, so drawn motion is
 * continuous across epochs. Pure: callers pass `performance.now()`.
 */

/** A paused clock at `atMs`. */
export function pausedAt(atMs, perfNow = 0) {
  return Object.freeze({ atMs, anchorPerf: perfNow, rate: 0 });
}

/** A clock at `atMs` now, moving at `rate` simulated ms per real ms. */
export function runningFrom(atMs, perfNow, rate) {
  return Object.freeze({
    atMs,
    anchorPerf: perfNow,
    rate: Number.isFinite(rate) && rate > 0 ? rate : 0,
  });
}

/** Whether `clock` is a clock this module made (finite time, finite anchor). */
export function isDisplayClock(clock) {
  return (
    !!clock &&
    Number.isFinite(clock.atMs) &&
    Number.isFinite(clock.anchorPerf) &&
    Number.isFinite(clock.rate) &&
    clock.rate >= 0
  );
}

/**
 * The display time at `perfNow`, clamped to `[start, end]` when given; null
 * for no clock.
 * @param {{atMs: number, anchorPerf: number, rate: number}|null} clock
 * @param {number} perfNow
 * @param {{start?: number, end?: number}} [range]
 */
export function displayMsAt(clock, perfNow, { start, end } = {}) {
  if (!isDisplayClock(clock)) return null;
  const elapsed = Math.max(0, perfNow - clock.anchorPerf);
  let ms = clock.atMs + elapsed * clock.rate;
  if (Number.isFinite(end)) ms = Math.min(end, ms);
  if (Number.isFinite(start)) ms = Math.max(start, ms);
  return ms;
}
