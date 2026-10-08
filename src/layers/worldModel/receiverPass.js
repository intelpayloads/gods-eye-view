/**
 * A run's whole receiver pass (GEN-309): every stored epoch of
 * `simulation.rf.receiver_track`, as a path at its own height coloured by the
 * state the RF kernel gave each epoch.
 *
 * The projection answers one `valid_at`, so it draws one point: the receiver
 * at the selected instant. The pass comes from ONE `POST /select` over the
 * run's whole interval instead -- the sample series' own rows, in order,
 * exactly as stored. Forty projections would ask the same question forty
 * times, and a line representation would need a new World Model product for
 * what the series already holds. The answer depends only on the revision, so
 * it is read once per revision and stepping the query time costs nothing.
 *
 * Pure and Cesium-free, like the adapter. Colour comes from `state_code`
 * (the header's legend), never from `sinr_db` re-thresholded here. Nothing is
 * interpolated: the segment from one epoch to the next carries the first
 * epoch's state, and a row without a finite position breaks the path rather
 * than being bridged.
 */
import { SIM_HEAD_PREFIX } from './simulationRuns.js';

export const RECEIVER_TRACK_BINDING = 'simulation.rf.receiver_track';

/** The display grant the projection places this track's heights under; the pass honours the same one. */
export const PASS_HEIGHT_GRANT = Object.freeze({
  key: 'geodetic_height',
  value: 'declared-wgs84-ellipsoidal',
});

/** `state_code` legend (dataforge.rf-receiver-track/1) -> display colour. */
export const RECEIVER_STATES = Object.freeze({
  0: Object.freeze({
    name: 'nominal',
    colorRgb: Object.freeze([0.2, 0.8, 0.35]),
  }),
  1: Object.freeze({
    name: 'degraded',
    colorRgb: Object.freeze([1.0, 0.7, 0.0]),
  }),
  2: Object.freeze({
    name: 'unavailable',
    colorRgb: Object.freeze([0.95, 0.2, 0.2]),
  }),
  3: Object.freeze({
    name: 'recovering',
    colorRgb: Object.freeze([0.25, 0.55, 1.0]),
  }),
  4: Object.freeze({
    name: 'unknown',
    colorRgb: Object.freeze([0.6, 0.6, 0.6]),
  }),
});
const UNKNOWN_STATE = 4;

/** Display-only choices the pass adds, named like the adapter's DISPLAY_CHOICES. */
export const PASS_DISPLAY = Object.freeze({
  kind: 'receiver-pass',
  widthPx: 3,
  alpha: 0.9,
  arc: 'straight-between-stored-epochs',
  colour: 'by-state_code',
  heightOffsetM: 0,
});

/** Whether this demand shows the run's receiver track with heights it may place. */
export function showsReceiverPass(demand) {
  if (!demand?.head?.startsWith(SIM_HEAD_PREFIX)) return false;
  if (!(demand.modalities ?? []).includes('simulated')) return false;
  if (demand.layers && !demand.layers.includes(RECEIVER_TRACK_BINDING))
    return false;
  return (
    demand.displayAssumptions?.[PASS_HEIGHT_GRANT.key] ===
    PASS_HEIGHT_GRANT.value
  );
}

/** The `/select` query for every stored epoch of the track. */
export function passQuery() {
  return {
    modalities: ['simulated'],
    requested_layers: [RECEIVER_TRACK_BINDING],
    predicates: {
      interval: { start: '1970-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' },
    },
  };
}

/** `receiver:foundation:iss-receiver` -> `ISS`; the identity when there is no receiver key. */
export function receiverName(receiverKey, identity = '') {
  const tail = String(receiverKey || '')
    .split(':')
    .at(-1)
    .replace(/[-_]?receiver$/i, '');
  return tail ? tail.toUpperCase() : String(identity || 'Receiver');
}

function stateOf(code) {
  const value = code === null || code === undefined ? Number.NaN : Number(code);
  return Number.isInteger(value) && RECEIVER_STATES[value]
    ? value
    : UNKNOWN_STATE;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return Number.NaN;
  return Number(value);
}

/**
 * One series' rows -> runs of one state. A segment holds the positions from
 * its first epoch through the first epoch of the next state, so the path is
 * continuous and each stretch is the state that held over it.
 */
export function segmentsOf(samples) {
  const segments = [];
  let current = null;
  for (const sample of samples) {
    if (!sample.position) {
      current = null; // a gap: never bridged
      continue;
    }
    if (current && current.state === sample.state) {
      current.positions.push(sample.position);
      current.until = sample.at;
      continue;
    }
    if (current) {
      current.positions.push(sample.position);
      current.until = sample.at;
    }
    current = {
      state: sample.state,
      name: RECEIVER_STATES[sample.state].name,
      colorRgb: RECEIVER_STATES[sample.state].colorRgb,
      from: sample.at,
      until: sample.at,
      positions: [sample.position],
    };
    segments.push(current);
  }
  // A lone epoch (last row, or one boxed in by gaps) has no extent: the
  // marker shows it, a polyline cannot.
  return segments.filter((segment) => segment.positions.length >= 2);
}

/**
 * `POST /select` answer -> one pass per receiver series, or [] when the run
 * has no track (or its values were withheld for size).
 */
export function passesFromSelection(selection) {
  const products = (selection?.products ?? []).filter(
    (product) =>
      product?.product_ref?.type_id?.startsWith(
        'simulation.rf.receiver_track',
      ) && Array.isArray(product.values),
  );
  const series = new Map();
  for (const product of products) {
    for (const row of product.values) {
      const at = Date.parse(row?.valid_time);
      if (!Number.isFinite(at)) continue;
      const identity = String(row.semantic_identity ?? '');
      const receiver = String(row.series_key?.receiver ?? '');
      const key = `${identity}\u0000${receiver}`;
      if (!series.has(key)) series.set(key, { identity, receiver, rows: [] });
      const value = row.value ?? {};
      const lon = finiteNumber(value.lon_deg);
      const lat = finiteNumber(value.lat_deg);
      const height = finiteNumber(value.height_m);
      series.get(key).rows.push({
        at,
        validTime: row.valid_time,
        state: stateOf(value.state_code),
        position: [lon, lat, height].every(Number.isFinite)
          ? { lon, lat, height }
          : null,
      });
    }
  }
  return [...series.values()].map(({ identity, receiver, rows }) => {
    const samples = rows.sort((a, b) => a.at - b.at);
    const name = receiverName(receiver, identity);
    return {
      id: `${RECEIVER_TRACK_BINDING}/pass/${identity}/${receiver}`,
      identity,
      receiver,
      label: `${name} (simulated)`,
      first: samples[0]?.validTime ?? null,
      last: samples.at(-1)?.validTime ?? null,
      samples: samples.length,
      segments: segmentsOf(samples).map((segment) => ({
        ...segment,
        from: new Date(segment.from).toISOString(),
        until: new Date(segment.until).toISOString(),
      })),
    };
  });
}

/**
 * Passes per revision: a revision is immutable, so its answer is read once.
 * The read is shared by every step through the run, so no one step's abort
 * cancels it. A source without `select` has no passes.
 */
export function createReceiverPasses(source) {
  const cache = new Map(); // revisionId -> Promise<passes>
  return {
    async read({ revisionId } = {}) {
      if (typeof source?.select !== 'function' || !revisionId) return [];
      if (!cache.has(revisionId)) {
        const pending = source
          .select({ revisionId, query: passQuery() })
          .then(passesFromSelection);
        cache.set(revisionId, pending);
        // A failed read is retried on the next projection.
        pending.catch(() => cache.delete(revisionId));
      }
      return cache.get(revisionId);
    },
  };
}
