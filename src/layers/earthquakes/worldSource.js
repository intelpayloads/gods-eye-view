/**
 * The earthquake layer's world adapter: the same snapshot the direct USGS
 * source returns, read from the world model instead (`world.earthquakes`,
 * bound by the `usgs` connector as `seismic.event_set.v1`).
 *
 * One projection request per refresh, against the host's head at the wall
 * clock. The projected points carry the event's USGS properties; this module
 * rebuilds the feed's GeoJSON shape from them and hands it to the SAME
 * `normalizeEarthquakeSnapshot` the provider path uses, so the M2.5 cut and
 * the validation live in one place and presentation code is untouched.
 *
 * What the world model surfaces structurally is read back structurally:
 * position (`position.lon/lat`), event time (`properties.event_time_ms`), and
 * depth (`properties.depth_km`; the point's `height_m` is the same reading
 * under the `undeclared_height_datum` grant this request makes). An event
 * with no depth is omitted by the projector, never invented here.
 */
import { wallClockValidAt } from '../worldModel/demand.js';
import { normalizeEarthquakeSnapshot } from './model.js';

export const EARTHQUAKE_PRODUCT_TYPE = 'seismic.event_set.v1';
export const EARTHQUAKE_DISPLAY_ASSUMPTIONS = Object.freeze({
  undeclared_height_datum: 'read-as-wgs84-ellipsoid',
});

/** The USGS event id a projected point carries, else the identity's suffix. */
function eventId(point) {
  const usgsId = point?.properties?.usgs_id;
  if (typeof usgsId === 'string' && usgsId) return usgsId;
  const identity = point?.semantic_ref?.semantic_identity;
  if (typeof identity === 'string' && identity) {
    return identity.slice(identity.lastIndexOf(':') + 1) || identity;
  }
  return null;
}

/** One projected point as the feed feature `normalizeEarthquakeSnapshot` reads. */
function featureOf(point) {
  const properties = point?.properties;
  return {
    type: 'Feature',
    id: eventId(point),
    geometry: {
      type: 'Point',
      coordinates: [
        point?.position?.lon,
        point?.position?.lat,
        properties?.depth_km ?? null,
      ],
    },
    properties: {
      mag: properties?.magnitude ?? null,
      place: properties?.place ?? null,
      time: properties?.event_time_ms ?? null,
    },
  };
}

/**
 * `({ projectionSource, head }) => { getSnapshot }`, the shape
 * `WORLD_LAYER_SOURCES` registers.
 * @param {object} options
 * @param {{getProjection: Function}} options.projectionSource The host's ProjectionSource.
 * @param {string} options.head Head the adapter reads (world/main).
 * @param {() => number} [options.now] Wall clock (tests).
 */
export function createWorldEarthquakeSource({
  projectionSource,
  head,
  now = () => Date.now(),
} = {}) {
  if (typeof projectionSource?.getProjection !== 'function')
    throw new TypeError(
      'The earthquake world adapter requires a ProjectionSource',
    );
  if (typeof head !== 'string' || !head)
    throw new TypeError('The earthquake world adapter requires a head');
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const projection = await projectionSource.getProjection({
        head,
        query: {
          type_filter: [EARTHQUAKE_PRODUCT_TYPE],
          valid_at: wallClockValidAt(now()),
        },
        projectionSpec: {
          display_assumptions: { ...EARTHQUAKE_DISPLAY_ASSUMPTIONS },
        },
        signal,
      });
      signal?.throwIfAborted();
      if (!Array.isArray(projection?.points))
        throw new Error('Malformed world-model projection: no points array');
      const rows = normalizeEarthquakeSnapshot({
        type: 'FeatureCollection',
        features: projection.points.map(featureOf),
      });
      if (!rows) throw new Error('Malformed world-model earthquake projection');
      return rows;
    },
  };
}
