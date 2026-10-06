/**
 * The satellites layer's world adapter (DWM-185): the groups
 * `createSatelliteSource` reads from `/api/celestrak/<group>`, read from the
 * world model instead. The world model's `celestrak-elements` connector
 * retains CelesTrak's GP element sets as CCSDS OMM, one binding per group
 * (`world.satellites.elements_<group>`, hyphens as underscores), as a
 * `sample_series/v1` product: numbers, not positions. The projection draws
 * nothing from it, so the adapter reads it through the ProjectionSource's
 * `select` and hands the layer OMM records (`{ ok, status, elements }`); the
 * layer builds each satrec with satellite.js `json2satrec` and propagates for
 * display exactly as it does a TLE. Display only, not simulation truth.
 *
 * Each selected row becomes the OMM record CelesTrak served for that object:
 * the NORAD number from the identity (`satellite:norad:<id>`), EPOCH from the
 * row's valid time, the names from its series key and the elements from its
 * values, each under the column the descriptor declared. A row missing an
 * element SGP4 reads is dropped, never zero-filled: `json2satrec` reads an
 * absent number as 0, which would draw a satellite on a wrong orbit.
 *
 * A group the world has not bound, values the backplane withheld for size, or
 * a host source without `select` read as an unavailable group (`ok: false`),
 * which the layer already degrades around.
 */
import { HEAD } from '../worldModel/view.js';

export const ELEMENT_SET_TYPE = 'satellite.element_set_sample_series.v1';
export const WORLD_SATELLITES_SOURCE_LABEL = 'World model (CelesTrak)';

const IDENTITY = /^satellite:norad:(\d+)$/;

/** OMM field -> the element-set column it is stored under. SGP4 reads all of these. */
const ELEMENTS = Object.freeze({
  MEAN_MOTION: 'mean_motion_rev_per_day',
  ECCENTRICITY: 'eccentricity',
  INCLINATION: 'inclination_deg',
  RA_OF_ASC_NODE: 'raan_deg',
  ARG_OF_PERICENTER: 'arg_of_pericenter_deg',
  MEAN_ANOMALY: 'mean_anomaly_deg',
  BSTAR: 'bstar_per_earth_radius',
  MEAN_MOTION_DOT: 'mean_motion_dot',
  MEAN_MOTION_DDOT: 'mean_motion_ddot',
});
/** Carried when present; SGP4 does not read them. */
const BOOKKEEPING = Object.freeze({
  EPHEMERIS_TYPE: 'ephemeris_type',
  ELEMENT_SET_NO: 'element_set_no',
  REV_AT_EPOCH: 'rev_at_epoch',
});

/** The binding a CelesTrak group is retained under. */
export function elementSetBinding(group) {
  return `world.satellites.elements_${String(group).replace(/-/g, '_')}`;
}

/** One selected sample as the OMM record CelesTrak served, or null. */
export function ommOf(row) {
  const norad = IDENTITY.exec(String(row?.semantic_identity ?? ''))?.[1];
  const epochMs = Date.parse(row?.valid_time);
  const value = row?.value;
  if (
    !norad ||
    !Number.isFinite(epochMs) ||
    !value ||
    typeof value !== 'object'
  )
    return null;
  const omm = {
    OBJECT_NAME: String(row.series_key?.object_name ?? ''),
    OBJECT_ID: String(row.series_key?.object_id ?? ''),
    // json2satrec reads EPOCH with Date, to the millisecond, as UTC.
    EPOCH: new Date(epochMs).toISOString(),
    NORAD_CAT_ID: Number(norad),
  };
  for (const [field, column] of Object.entries(ELEMENTS)) {
    const number = value[column];
    if (typeof number !== 'number' || !Number.isFinite(number)) return null;
    omm[field] = number;
  }
  for (const [field, column] of Object.entries(BOOKKEEPING)) {
    if (typeof value[column] === 'number') omm[field] = value[column];
  }
  return omm;
}

/**
 * `({ projectionSource, head }) => { readGroup }`, the shape
 * `WORLD_LAYER_SOURCES` registers.
 */
export function createWorldSatelliteSource({
  projectionSource,
  head = HEAD,
} = {}) {
  if (typeof projectionSource?.getProjection !== 'function')
    throw new TypeError(
      'The satellites world adapter requires a ProjectionSource',
    );
  return {
    label: WORLD_SATELLITES_SOURCE_LABEL,
    async readGroup(group, { signal } = {}) {
      signal?.throwIfAborted();
      if (typeof projectionSource.select !== 'function')
        return {
          ok: false,
          status: 'no select on this ProjectionSource',
          elements: [],
        };
      const binding = elementSetBinding(group);
      const selection = await projectionSource.select({
        head,
        query: { type_filter: [ELEMENT_SET_TYPE], requested_layers: [binding] },
        signal,
      });
      signal?.throwIfAborted();
      const [product] = selection.products;
      if (!product)
        return { ok: false, status: `${binding} not bound`, elements: [] };
      if (!Array.isArray(product.values))
        return {
          ok: false,
          status: `${binding} values withheld`,
          elements: [],
        };
      const elements = product.values.map(ommOf).filter(Boolean);
      return { ok: elements.length > 0, status: 200, elements };
    },
  };
}
