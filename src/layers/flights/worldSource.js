/**
 * The flights layer's world adapter: the snapshot `createOpenSkySource`
 * returns, read from the world model instead (`world.aircraft`, bound by the
 * `opensky` connector as `aircraft.track_state_set.v1`).
 *
 * One projection request per refresh, against the host's head at the wall
 * clock, for the `world.aircraft` binding by name (the military layer's
 * `world.military_aircraft` is the same product type, DWM-31), under the
 * `aircraft_height` grant the product declares (geometric
 * height read as height above the WGS84 ellipsoid; barometric height carried
 * unconverted). Each projected point becomes the record
 * `normalizeOpenSkyAircraft` produces for the same state vector, admitted by
 * the SAME `admitRecords` rule, so `layers/flights/ingestion.js` renders
 * unchanged and presentation code is untouched.
 *
 * What the world model surfaces structurally is read back structurally:
 * position (`position.lon/lat/height_m`), the barometric reading
 * (`height.barometric_height_m`), the position time (`time.sampled_at`) and
 * the snapshot time (`time.valid_at`, the product's selection time). The
 * world product carries no last-contact time, origin country or vertical
 * rate, so those are the position time, '' and null. A state the projector
 * omits (no geometric height) is not invented here.
 *
 * Only `getSnapshot` reads the world model. `getTrack` (selected-aircraft
 * trail) and `getEnrichment` (adsbdb type/route) delegate to the slot's
 * provider source until retained tracks (`polylines/v1`, DWM-41) and the
 * adsbdb reference product (DWM-31) exist; without a provider source they
 * report `unsupported`, which the layer already treats as "no trail / no
 * enrichment", never as a snapshot failure.
 */
import { wallClockValidAt } from '../worldModel/demand.js';
import {
  admitRecords,
  cleanText,
  coordinates,
  epoch,
  finite,
  LiveSourceError,
} from '../../sources/live/contract.js';

export const AIRCRAFT_PRODUCT_TYPE = 'aircraft.track_state_set.v1';
/** The binding this layer reads: `world.military_aircraft` (DWM-31) carries the same product type. */
export const AIRCRAFT_BINDING = 'world.aircraft';
export const AIRCRAFT_DISPLAY_ASSUMPTIONS = Object.freeze({
  aircraft_height: 'adsb-geometric-as-wgs84-ellipsoid',
});
export const WORLD_FLIGHT_SOURCE_LABEL = 'World model (OpenSky)';
export const WORLD_FLIGHT_COVERAGE = 'world model snapshot (world.aircraft)';
/** Same rule as `openSkySnapshot`: a snapshot older than this is stale. */
const STALE_AFTER_MS = 120000;

/** ISO-8601 → Unix milliseconds, null when absent or unreadable. */
function isoMs(value) {
  return typeof value === 'string' ? epoch(Date.parse(value)) : null;
}

/** The icao24 a projected point identifies: the identity's last segment. */
function icao24Of(point) {
  const identity = point?.semantic_ref?.semantic_identity;
  if (typeof identity !== 'string' || !identity) return '';
  return cleanText(identity.slice(identity.lastIndexOf(':') + 1)).toLowerCase();
}

/** One projected point as the record `normalizeOpenSkyAircraft` returns. */
function recordOf(point) {
  if (!point || typeof point !== 'object') return null;
  const id = icao24Of(point);
  const latitude = finite(point.position?.lat);
  const longitude = finite(point.position?.lon);
  if (!id || !coordinates(latitude, longitude)) return null;
  const properties =
    point.properties && typeof point.properties === 'object'
      ? point.properties
      : {};
  const positionTimeMs = isoMs(point.time?.sampled_at);
  return {
    id,
    reference: id,
    latitude,
    longitude,
    callsign: cleanText(properties.callsign),
    originCountry: '',
    positionTimeMs,
    contactTimeMs: positionTimeMs,
    baroAltitudeM: finite(point.height?.barometric_height_m),
    ellipsoidAltitudeM: finite(point.position?.height_m),
    onGround: properties.on_ground === true,
    speedMps: finite(properties.velocity_mps),
    courseDeg: finite(properties.true_track_deg),
    verticalRateMps: null,
    category: finite(properties.category),
    typeCode: null,
    registration: null,
    operator: null,
  };
}

/** The snapshot time: the latest selection time the projected points carry. */
function observedAt(points) {
  let latest = null;
  for (const point of points) {
    const ms = isoMs(point?.time?.valid_at);
    if (ms != null && (latest == null || ms > latest)) latest = ms;
  }
  return latest;
}

/**
 * `({ projectionSource, head, providerSource }) => source`, the shape
 * `WORLD_LAYER_SOURCES` registers.
 * @param {object} options
 * @param {{getProjection: Function}} options.projectionSource The host's ProjectionSource.
 * @param {string} options.head Head the adapter reads (world/main).
 * @param {object} [options.providerSource] The slot's provider source; trails and enrichment delegate to it.
 * @param {() => number} [options.now] Wall clock (tests).
 */
export function createWorldFlightSource({
  projectionSource,
  head,
  providerSource,
  now = () => Date.now(),
} = {}) {
  if (typeof projectionSource?.getProjection !== 'function')
    throw new TypeError(
      'The flights world adapter requires a ProjectionSource',
    );
  if (typeof head !== 'string' || !head)
    throw new TypeError('The flights world adapter requires a head');
  const delegate = (method, unavailable) => {
    const target = providerSource?.[method];
    if (typeof target !== 'function')
      throw new LiveSourceError('unsupported', unavailable);
    return target;
  };
  return {
    label: WORLD_FLIGHT_SOURCE_LABEL,
    /** The viewport query is not a demand parameter: the world snapshot is worldwide. */
    async getSnapshot(_query = {}, { signal } = {}) {
      signal?.throwIfAborted();
      const projection = await projectionSource.getProjection({
        head,
        query: {
          type_filter: [AIRCRAFT_PRODUCT_TYPE],
          requested_layers: [AIRCRAFT_BINDING],
          valid_at: wallClockValidAt(now()),
        },
        projectionSpec: {
          display_assumptions: { ...AIRCRAFT_DISPLAY_ASSUMPTIONS },
        },
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
        'world-model aircraft',
      );
      const observedAtMs = observedAt(projection.points);
      const ageMs =
        observedAtMs == null ? null : Math.max(0, now() - observedAtMs);
      const stale = ageMs != null && ageMs > STALE_AFTER_MS;
      return {
        ...admitted,
        source: WORLD_FLIGHT_SOURCE_LABEL,
        coverage: WORLD_FLIGHT_COVERAGE,
        observedAtMs,
        ageMs,
        stale,
        freshness:
          observedAtMs == null ? 'unknown' : stale ? 'stale' : 'current',
        status: 200,
      };
    },
    async getTrack(reference, options) {
      return delegate(
        'getTrack',
        'Track history unavailable from the world model',
      )(reference, options);
    },
    async getEnrichment(query, options) {
      return delegate(
        'getEnrichment',
        'Enrichment unavailable from the world model',
      )(query, options);
    },
  };
}
