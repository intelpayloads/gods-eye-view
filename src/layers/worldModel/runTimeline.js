/**
 * A simulated run as a timeline the run player plays (GEN-310).
 *
 * The epochs are the receiver track's stored ones: the player steps at the
 * track's own cadence (30 s for the ISS run) and never lands between two
 * epochs, where a sample series answers nothing. Each epoch carries what the
 * run said about it, read, never re-derived: the receiver's `state_code` and
 * `sinr_db` from ONE `POST /select` of the track, and whether a jammer was
 * on from the emitter set at that epoch. The entity index answers an emitter
 * "as of" one instant, so its activity is one small select per epoch, read
 * a few at a time. Both depend only on the revision and are read once.
 *
 * Thresholds are drawn only if the run carries them: the receiver
 * response's `nominal_min_sinr_db` and `unavailable_below_sinr_db`, columns
 * of every track row since GEN-313. A run published before them draws none
 * rather than lines re-derived here.
 *
 * Pure and DOM-free: `ui/runPlayer.js` draws what this module computes.
 */
import {
  RECEIVER_STATES,
  RECEIVER_TRACK_BINDING,
  passQuery,
  receiverName,
  trackSeriesFromSelection,
} from './receiverPass.js';

export const EMITTER_BINDING = 'simulation.rf.emitters';
const EMITTER_READS_IN_FLIGHT = 4;

/** `2026-10-07T14:06:00Z`: the form the layers' `validAt` takes. */
export function isoInstant(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** The emitter query for one instant. */
export function emitterQuery(validAt) {
  return {
    modalities: ['simulated'],
    requested_layers: [EMITTER_BINDING],
    valid_at: validAt,
  };
}

/**
 * One emitter-set selection -> any emitter active at that instant: true,
 * false, or null when the run has no emitter or does not say.
 */
export function jammerActiveFromSelection(selection) {
  const flags = (selection?.products ?? [])
    .flatMap((product) =>
      Array.isArray(product?.values) ? product.values : [],
    )
    .map((row) => row?.value?.active)
    .filter((flag) => typeof flag === 'boolean');
  return flags.length ? flags.includes(true) : null;
}

/** The most common gap between consecutive epochs (the series' cadence). */
export function cadenceOf(epochs) {
  const counts = new Map();
  for (let i = 1; i < epochs.length; i++) {
    const gap = epochs[i] - epochs[i - 1];
    if (gap > 0) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best = null;
  for (const [gap, count] of counts)
    if (!best || count > best.count) best = { gap, count };
  return best?.gap ?? null;
}

/** Threshold columns the strip draws, in the order it lists them. */
export const THRESHOLDS = Object.freeze([
  Object.freeze({ key: 'nominalMinSinrDb', name: 'nominal' }),
  Object.freeze({ key: 'unavailableBelowSinrDb', name: 'unavailable' }),
]);

/**
 * The run's thresholds: a column's value when every row carries the same
 * one. A column some rows lack, or whose value changes within the run, is
 * not one line, so it is left out rather than averaged or picked.
 */
export function thresholdsOf(rows) {
  return THRESHOLDS.flatMap(({ key, name }) => {
    const values = new Set(rows.map((row) => row.thresholds?.[key] ?? null));
    const [db] = values;
    return values.size === 1 && db !== null ? [{ name, db }] : [];
  });
}

/**
 * Track rows + per-epoch jammer flags -> the timeline, or null when the run
 * has no receiver track (nothing to step through at the track's cadence).
 * @param {object} trackSelection `POST /select` of the receiver track
 * @param {Map<number, boolean|null>} [jammer] epoch ms -> active
 */
export function timelineFrom(trackSelection, jammer = new Map()) {
  const [series] = trackSeriesFromSelection(trackSelection);
  if (!series?.rows.length) return null;
  const rows = series.rows.map((row) => ({
    at: row.at,
    validAt: isoInstant(row.at),
    state: row.state,
    stateName: RECEIVER_STATES[row.state].name,
    sinrDb: row.sinrDb,
    jammerActive: jammer.has(row.at) ? jammer.get(row.at) : null,
  }));
  return {
    binding: RECEIVER_TRACK_BINDING,
    receiver: series.receiver,
    identity: series.identity,
    label: `${receiverName(series.receiver, series.identity)} (simulated)`,
    start: rows[0].at,
    end: rows.at(-1).at,
    cadenceMs: cadenceOf(rows.map((row) => row.at)),
    rows,
    thresholds: thresholdsOf(series.rows),
  };
}

/** The row in force at `ms`: the last stored epoch at or before it. */
export function rowAt(timeline, ms) {
  if (!timeline?.rows.length || !Number.isFinite(ms)) return null;
  let found = null;
  for (const row of timeline.rows) {
    if (row.at > ms) break;
    found = row;
  }
  return found;
}

/** Index of the epoch nearest `ms`. */
export function nearestIndex(timeline, ms) {
  let best = 0;
  timeline.rows.forEach((row, index) => {
    if (Math.abs(row.at - ms) < Math.abs(timeline.rows[best].at - ms))
      best = index;
  });
  return best;
}

function sinrText(db) {
  if (db === null) return 'SINR unknown';
  const rounded = Math.round(db);
  // A typographic minus, and never "−0".
  return `SINR ${rounded < 0 ? `−${-rounded}` : rounded} dB`;
}

/**
 * The banner at one row: "UNAVAILABLE · SINR −3 dB · jammer active". Every
 * word comes from the row: the state from `state_code`, the number from
 * `sinr_db`, the jammer from the emitters' `active`.
 */
export function bannerOf(row) {
  if (!row) return null;
  const jammer =
    row.jammerActive === null
      ? null
      : row.jammerActive
        ? 'jammer active'
        : 'jammer silent';
  return {
    state: row.stateName,
    colorRgb: RECEIVER_STATES[row.state].colorRgb,
    text: [row.stateName.toUpperCase(), sinrText(row.sinrDb), jammer]
      .filter(Boolean)
      .join(' · '),
  };
}

/**
 * The strip's geometry in a `width` x `height` box: the SINR line (broken
 * at an unknown SINR), the jammer's active windows as x ranges, the
 * thresholds as y levels, and the x of a time. A window spans an active
 * epoch to the next epoch, like the pass. The y range covers the thresholds
 * too, so a line the SINR never reaches is still drawn.
 */
export function stripGeometry(timeline, { width, height, pad = 4 }) {
  const span = Math.max(1, timeline.end - timeline.start);
  const x = (ms) => ((ms - timeline.start) / span) * width;
  const known = [
    ...timeline.rows.map((row) => row.sinrDb),
    ...timeline.thresholds.map((t) => t.db),
  ].filter((db) => db !== null);
  const lo = known.length ? Math.min(...known) : 0;
  const hi = known.length ? Math.max(...known) : 1;
  const range = hi - lo || 1;
  const y = (db) => pad + (1 - (db - lo) / range) * (height - 2 * pad);

  const lines = [];
  let current = null;
  for (const row of timeline.rows) {
    if (row.sinrDb === null) {
      current = null;
      continue;
    }
    if (!current) lines.push((current = []));
    current.push([x(row.at), y(row.sinrDb)]);
  }

  const windows = [];
  timeline.rows.forEach((row, index) => {
    if (row.jammerActive !== true) return;
    const until = timeline.rows[index + 1]?.at ?? row.at;
    const last = windows.at(-1);
    if (last && last.untilMs === row.at) last.untilMs = until;
    else windows.push({ fromMs: row.at, untilMs: until });
  });

  return {
    x,
    y,
    sinrMinDb: lo,
    sinrMaxDb: hi,
    lines,
    thresholds: timeline.thresholds.map((t) => ({ ...t, y: y(t.db) })),
    windows: windows.map((w) => ({
      ...w,
      x0: x(w.fromMs),
      x1: x(w.untilMs),
    })),
  };
}

async function inBatches(items, size, read) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(read))));
  }
  return out;
}

/**
 * Timelines per revision (one read each; a failed read is retried). A
 * source without `select` has no timeline.
 */
export function createRunTimelines(source) {
  const cache = new Map(); // revisionId (or head) -> Promise<timeline|null>
  async function load(at) {
    const track = await source.select({ ...at, query: passQuery() });
    const draft = timelineFrom(track);
    if (!draft) return null;
    const flags = await inBatches(
      draft.rows,
      EMITTER_READS_IN_FLIGHT,
      async (row) => [
        row.at,
        jammerActiveFromSelection(
          await source.select({ ...at, query: emitterQuery(row.validAt) }),
        ),
      ],
    );
    return timelineFrom(track, new Map(flags));
  }
  return {
    /** By revision; by head name when the revision is not known. */
    async read({ revisionId = null, head = null } = {}) {
      if (typeof source?.select !== 'function' || !(revisionId || head))
        return null;
      const key = revisionId ?? `head:${head}`;
      if (!cache.has(key)) {
        const pending = load(revisionId ? { revisionId } : { head });
        cache.set(key, pending);
        pending.catch(() => cache.delete(key));
      }
      return cache.get(key);
    },
  };
}
