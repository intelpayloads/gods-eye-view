/**
 * The run player's clock (GEN-310): an index into a run's stored epochs,
 * playing or paused, at 1x, 10x or 60x.
 *
 * Speed is simulated seconds per real second, so one step of the track's
 * cadence takes `cadence / speed` of real time: at 60x the ISS run's 30 s
 * epochs go by every half second and its 40 epochs play in 20 s. Playing to
 * the last epoch pauses there. Pure: the UI feeds it elapsed real time.
 */
export const SPEEDS = Object.freeze([1, 10, 60]);

export function createRunClock({ count, cadenceMs, index = 0, speed = 60 }) {
  if (!(count > 0) || !(cadenceMs > 0))
    throw new TypeError('A run clock needs epochs and a cadence');
  const state = {
    index: clamp(index, count),
    playing: false,
    speed: SPEEDS.includes(speed) ? speed : SPEEDS.at(-1),
    carryMs: 0,
  };
  const stepMs = () => cadenceMs / state.speed;

  return {
    get index() {
      return state.index;
    },
    get playing() {
      return state.playing;
    },
    get speed() {
      return state.speed;
    },
    get atEnd() {
      return state.index === count - 1;
    },
    /** Play; from the last epoch, start again at the first. */
    play() {
      if (state.index === count - 1) state.index = 0;
      state.playing = true;
      state.carryMs = 0;
    },
    pause() {
      state.playing = false;
      state.carryMs = 0;
    },
    toggle() {
      if (state.playing) this.pause();
      else this.play();
    },
    setSpeed(speed) {
      if (SPEEDS.includes(speed)) state.speed = speed;
    },
    /** Jump to an epoch; playing carries on from there. */
    seek(index) {
      state.index = clamp(index, count);
      state.carryMs = 0;
    },
    step(delta) {
      this.seek(state.index + delta);
    },
    /**
     * Real time passed: returns whether the index moved. Several epochs can
     * pass in one call when the caller was late; the end pauses the clock.
     */
    advance(elapsedMs) {
      if (!state.playing || !(elapsedMs > 0)) return false;
      state.carryMs += elapsedMs;
      const steps = Math.floor(state.carryMs / stepMs());
      if (!steps) return false;
      state.carryMs -= steps * stepMs();
      const before = state.index;
      state.index = clamp(state.index + steps, count);
      if (state.index === count - 1) this.pause();
      return state.index !== before;
    },
  };
}

function clamp(index, count) {
  return Math.min(count - 1, Math.max(0, Math.round(index) || 0));
}
