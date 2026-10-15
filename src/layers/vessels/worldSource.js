/**
 * The vessel layer's world adapter: the snapshot `createAisStreamSource`
 * returns, read from the world model instead (`world.vessels`, bound by the
 * `digitraffic` connector as `vessel.track_state_set.v1`, DWM-231).
 *
 * One projection request per refresh, against the host's head at the wall
 * clock. No display assumption: a vessel maps no height, so the projector
 * has none to grant. Each projected point becomes the record
 * `normalizeVesselObservation` produces, so `layers/vessels/ingestion.js`
 * renders unchanged.
 *
 * AIS writes "not available" in-band as numbers -- speed 102.3 kn, course
 * 360, heading 511 -- and the product keeps them raw (`sog_kn`, `cog_deg`,
 * `heading_deg`). Here they become null: as numbers the layer would point a
 * moored ship due north and extrapolate it at 52 m/s.
 *
 * Name, IMO, type and destination come from Digitraffic's vessel register,
 * which the world model reads by MMSI beside the positions (`acquire.lookup`,
 * DWM-234). A vessel the register does not list once has none, and is
 * labelled by its MMSI, as the provider path does for a row with no name.
 * `ship_type` is the ITU-R M.1371 code; the layer shows the coarse label the
 * provider path does. `getTrack` delegates to the slot's provider source until retained
 * tracks exist; without one it reports `unsupported`, which the layer treats
 * as "no trail".
 */
import { wallClockValidAt } from '../worldModel/demand.js';
import {
  admitRecords,
  coordinates,
  epoch,
  finite,
  LiveSourceError,
} from '../../sources/live/contract.js';

export const VESSEL_PRODUCT_TYPE = 'vessel.track_state_set.v1';
export const VESSEL_BINDING = 'world.vessels';
export const WORLD_VESSEL_SOURCE_LABEL = 'World model (Digitraffic AIS)';
export const WORLD_VESSEL_COVERAGE = `world model snapshot (${VESSEL_BINDING})`;
/** A snapshot whose newest position is older than this is stale. */
const STALE_AFTER_MS = 300000;
const KNOT_MPS = 0.514444;

/** ISO-8601 -> Unix milliseconds, null when absent or unreadable. */
function isoMs(value) {
  return typeof value === 'string' ? epoch(Date.parse(value)) : null;
}

/** A reading, or null when AIS says "not available" (`value >= unavailable`). */
function available(value, unavailable) {
  const n = finite(value);
  return n == null || n >= unavailable ? null : n;
}

/** ITU-R M.1371 ship type code -> the label a card shows, '' when unknown. */
export function shipTypeLabel(code) {
  const n = finite(code);
  if (n == null) return '';
  const exact = {
    30: 'Fishing',
    31: 'Towing',
    32: 'Towing',
    33: 'Dredging',
    34: 'Diving',
    35: 'Military',
    36: 'Sailing',
    37: 'Pleasure craft',
    50: 'Pilot',
    51: 'Search and rescue',
    52: 'Tug',
    53: 'Port tender',
    55: 'Law enforcement',
    58: 'Medical transport',
  }[n];
  if (exact) return exact;
  const decade = {
    2: 'Wing in ground',
    4: 'High-speed craft',
    6: 'Passenger',
    7: 'Cargo',
    8: 'Tanker',
    9: 'Other',
  }[Math.floor(n / 10)];
  return decade ?? '';
}

/** A trimmed text property, '' when absent. */
function text(value) {
  return value == null ? '' : String(value).trim();
}

/** The MMSI a projected point identifies: the identity's last segment. */
function mmsiOf(point) {
  const identity = point?.semantic_ref?.semantic_identity;
  if (typeof identity !== 'string' || !identity) return '';
  return identity.slice(identity.lastIndexOf(':') + 1).trim();
}

/** One projected point as the record `normalizeVesselObservation` returns. */
function recordOf(point) {
  if (!point || typeof point !== 'object') return null;
  const id = mmsiOf(point);
  const latitude = finite(point.position?.lat);
  const longitude = finite(point.position?.lon);
  if (!id || !coordinates(latitude, longitude)) return null;
  const properties =
    point.properties && typeof point.properties === 'object'
      ? point.properties
      : {};
  const speedKts = available(properties.sog_kn, 102.3);
  return {
    id,
    reference: id,
    latitude,
    longitude,
    name: text(properties.vessel_name) || id,
    imo: finite(properties.imo) ? String(properties.imo) : '',
    type: shipTypeLabel(properties.ship_type),
    destination: text(properties.destination),
    speedMps: speedKts == null ? null : speedKts * KNOT_MPS,
    courseDeg: available(properties.cog_deg, 360),
    headingDeg: available(properties.heading_deg, 360),
    observedAtMs: isoMs(point.time?.sampled_at),
    altitudeDatum: 'sea-surface',
  };
}

/** The snapshot time: the newest position the admitted records carry. */
function newest(records) {
  let latest = null;
  for (const record of records)
    if (
      record.observedAtMs != null &&
      (latest == null || record.observedAtMs > latest)
    )
      latest = record.observedAtMs;
  return latest;
}

/**
 * `({ projectionSource, head, providerSource }) => source`, the shape
 * `WORLD_LAYER_SOURCES` registers.
 * @param {object} options
 * @param {{getProjection: Function}} options.projectionSource The host's ProjectionSource.
 * @param {string} options.head Head the adapter reads (world/main).
 * @param {object} [options.providerSource] The slot's provider source; trails delegate to it.
 * @param {() => number} [options.now] Wall clock (tests).
 */
export function createWorldVesselSource({
  projectionSource,
  head,
  providerSource,
  now = () => Date.now(),
} = {}) {
  if (typeof projectionSource?.getProjection !== 'function')
    throw new TypeError('The vessel world adapter requires a ProjectionSource');
  if (typeof head !== 'string' || !head)
    throw new TypeError('The vessel world adapter requires a head');
  return {
    label: WORLD_VESSEL_SOURCE_LABEL,
    /** `maxRows` is the provider's request cap; the world snapshot is the whole binding. */
    async getSnapshot(_query = {}, { signal } = {}) {
      signal?.throwIfAborted();
      const projection = await projectionSource.getProjection({
        head,
        query: {
          type_filter: [VESSEL_PRODUCT_TYPE],
          requested_layers: [VESSEL_BINDING],
          valid_at: wallClockValidAt(now()),
        },
        projectionSpec: { display_assumptions: {} },
        signal,
      });
      signal?.throwIfAborted();
      if (!Array.isArray(projection?.points))
        throw new LiveSourceError(
          'malformed',
          'Malformed world-model projection: no points array',
        );
      const admitted = admitRecords(
        projection.points,
        recordOf,
        'world-model vessel',
      );
      const observedAtMs = newest(admitted.records);
      const ageMs =
        observedAtMs == null ? null : Math.max(0, now() - observedAtMs);
      const stale = ageMs != null && ageMs > STALE_AFTER_MS;
      return {
        ...admitted,
        source: WORLD_VESSEL_SOURCE_LABEL,
        coverage: WORLD_VESSEL_COVERAGE,
        observedAtMs,
        ageMs,
        stale,
        freshness:
          observedAtMs == null ? 'unknown' : stale ? 'stale' : 'current',
        transportStatus: null,
        rawRowCount: projection.points.length,
        status: 200,
      };
    },
    async getTrack(reference, options) {
      const target = providerSource?.getTrack;
      if (typeof target !== 'function')
        throw new LiveSourceError(
          'unsupported',
          'Track history unavailable from the world model',
        );
      return target(reference, options);
    },
  };
}
