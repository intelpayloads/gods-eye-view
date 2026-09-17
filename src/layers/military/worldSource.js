/**
 * The military layer's world adapter: the snapshot and identity list
 * `createAdsbLolSource` returns, read from the world model instead
 * (`world.military_aircraft`, bound by the `adsblol` connector as
 * `aircraft.track_state_set.v1`: the same product type as `world.aircraft`,
 * so the demand names the binding, never just the type).
 *
 * One projection request per refresh, against the host's head at the wall
 * clock, under the `aircraft_height` grant the product declares (geometric
 * height read as height above the WGS84 ellipsoid; barometric height carried
 * unconverted). Each projected point becomes the record
 * `normalizeReadsbAircraft` produces for the same readsb row, admitted by the
 * SAME `admitRecords` rule, so `layers/military/ingestion.js` renders
 * unchanged: the icon and model choice still read `typeCode` and
 * `registration`, which the world product carries as `type_code` and
 * `registration` properties straight from the feed's `t` and `r`.
 *
 * What the world model surfaces structurally is read back structurally:
 * position (`position.lon/lat/height_m`), the barometric reading
 * (`height.barometric_height_m`), the position time (`time.sampled_at`) and
 * the snapshot time (`time.valid_at`, the product's selection time). The
 * last-contact time and vertical rate come from the product's `last_contact`
 * and `vertical_rate` properties (readsb `seen` and `baro_rate`, else
 * `geom_rate`). The feed has no operator field, so `operator` is '' as it is
 * on the direct path. A state the projector omits (no geometric height, or a
 * MLAT / TIS-B height the grant does not cover) is not invented here: those
 * aircraft, ground traffic without `alt_geom` among them, are absent from
 * both the snapshot and the identity list.
 *
 * `getIdentities` (the military registry the flights layer uses to suppress
 * and classify military ICAOs) reads the same projection. `getTrack`
 * (selected-aircraft trail, `/api/adsblol/trace`) delegates to the slot's
 * provider source until retained tracks (`polylines/v1`, DWM-41) exist;
 * without a provider source it reports `unsupported`, which the layer already
 * treats as "no trail", never as a snapshot failure.
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

export const MILITARY_PRODUCT_TYPE = 'aircraft.track_state_set.v1';
export const MILITARY_BINDING = 'world.military_aircraft';
export const MILITARY_DISPLAY_ASSUMPTIONS = Object.freeze({
  aircraft_height: 'adsb-geometric-as-wgs84-ellipsoid',
});
export const WORLD_MILITARY_SOURCE_LABEL = 'World model (adsb.lol)';
export const WORLD_MILITARY_COVERAGE = `world model snapshot (${MILITARY_BINDING})`;
/** Same rule as the flights world adapter: a snapshot older than this is stale. */
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

/** One projected point as the record `normalizeReadsbAircraft` returns. */
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
    originCountry: null,
    positionTimeMs,
    contactTimeMs: epoch(properties.last_contact, 1000),
    baroAltitudeM: finite(point.height?.barometric_height_m),
    ellipsoidAltitudeM: finite(point.position?.height_m),
    onGround: properties.on_ground === true,
    speedMps: finite(properties.velocity_mps),
    courseDeg: finite(properties.true_track_deg),
    verticalRateMps: finite(properties.vertical_rate),
    category: properties.category ?? null,
    typeCode: cleanText(properties.type_code),
    registration: cleanText(properties.registration),
    operator: cleanText(properties.operator),
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
 * @param {object} [options.providerSource] The slot's provider source; trails delegate to it.
 * @param {() => number} [options.now] Wall clock (tests).
 */
export function createWorldMilitarySource({
  projectionSource,
  head,
  providerSource,
  now = () => Date.now(),
} = {}) {
  if (typeof projectionSource?.getProjection !== 'function')
    throw new TypeError(
      'The military world adapter requires a ProjectionSource',
    );
  if (typeof head !== 'string' || !head)
    throw new TypeError('The military world adapter requires a head');
  const project = async (signal) => {
    signal?.throwIfAborted();
    const projection = await projectionSource.getProjection({
      head,
      query: {
        type_filter: [MILITARY_PRODUCT_TYPE],
        requested_layers: [MILITARY_BINDING],
        valid_at: wallClockValidAt(now()),
      },
      projectionSpec: {
        display_assumptions: { ...MILITARY_DISPLAY_ASSUMPTIONS },
      },
      signal,
    });
    signal?.throwIfAborted();
    if (!Array.isArray(projection?.points))
      throw new LiveSourceError(
        'malformed',
        'Malformed world-model projection: no points array',
      );
    return projection;
  };
  return {
    label: WORLD_MILITARY_SOURCE_LABEL,
    /** The military registry's identity list: every aircraft the snapshot would carry. */
    async getIdentities(_query = {}, { signal } = {}) {
      const projection = await project(signal);
      return admitRecords(
        projection.points,
        recordOf,
        'world-model aircraft',
      ).records.map((record) => record.id);
    },
    /** The viewport query is not a demand parameter: the world snapshot is worldwide. */
    async getSnapshot(_query = {}, { signal } = {}) {
      const projection = await project(signal);
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
        source: WORLD_MILITARY_SOURCE_LABEL,
        coverage: WORLD_MILITARY_COVERAGE,
        observedAtMs,
        ageMs,
        stale,
        freshness:
          observedAtMs == null ? 'unknown' : stale ? 'stale' : 'current',
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
