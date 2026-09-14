/**
 * The world-model view this layer requests.
 *
 * DWM-8 renders ONE completed projection: the retained Experiment 002 view
 * (97 aircraft points and 81 temperature samples over the San Francisco Bay
 * Area at 2026-09-10T22:57:25Z, 850 hPa). It mirrors `EXPERIMENT_002_QUERY`
 * and `EXPERIMENT_002_SPEC` in the backplane (`worldmodel.projection.domain`).
 *
 * Every display grant below is explicit: the backplane refuses to invent a
 * height datum or a map frame, so the consumer must say what it accepts.
 * DWM-9 replaces this constant with camera-driven demand and pinned/live
 * revision modes; nothing in the layer depends on these specific numbers.
 */
export const HEAD = 'world/main';

export const DEFAULT_VIEW = Object.freeze({
  query: Object.freeze({
    spatial_scope: Object.freeze({
      bbox: Object.freeze([-123, 37, -121, 39]),
    }),
    valid_at: '2026-09-10T22:57:25Z',
    predicates: Object.freeze({ pressure_hpa: 850 }),
  }),
  projection_spec: Object.freeze({
    display_assumptions: Object.freeze({
      // ADS-B geometric height read as height above the WGS84 ellipsoid.
      aircraft_height: 'adsb-geometric-as-wgs84-ellipsoid',
      // Native sphere-grid angles labeled directly on the WGS84 map.
      field_frame: 'sphere-grid-labeled-on-wgs84',
      // A pressure level is drawn at display height 0 m; pressure is not altitude.
      field_height: 'pressure-level-at-display-height-zero',
    }),
  }),
});

/**
 * The view's bounding box as a degrees rectangle for callers that own the
 * camera (QA scripts, the UI). The layer itself never moves the camera.
 * @param {{query?: {spatial_scope?: {bbox?: number[]}}}} [view]
 * @returns {?{west: number, south: number, east: number, north: number}}
 */
export function viewRectangleDegrees(view = DEFAULT_VIEW) {
  const bbox = view?.query?.spatial_scope?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [west, south, east, north] = bbox.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}
