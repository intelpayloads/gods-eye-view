/**
 * A ground RF path's obstruction, as a run over a pinned lidar surface
 * publishes it (GEN-404, GEN-420): the knife-edge loss, whether the path is
 * diffracted, how many edges, and the main edge (its place, its top and the
 * ground under it above the ellipsoid, whether the lidar surface set the top,
 * and its nu). A jammer path carries it on `simulation.rf.links`; the GCS path
 * on the drone's track with a `c2_` prefix.
 *
 * Only the stored values are read. A path on a run with no surface says
 * nothing about obstruction (`not-modelled`), never "clear": its columns are
 * null, and `obstruction_edges`, never null on a surface run, says which.
 * The state is the row's `obstructed`, never its `reason`: a silent jammer's
 * path is `inactive` and still obstructed.
 *
 * Pure and Cesium-free.
 */

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The record's columns, as `simulation.rf.links` names them (the track adds `c2_`). */
export const OBSTRUCTION_KEYS = Object.freeze([
  'obstruction_loss_db',
  'obstructed',
  'obstruction_edges',
  'edge_lon_deg',
  'edge_lat_deg',
  'edge_height_m',
  'edge_ground_height_m',
  'edge_roofed',
  'edge_nu',
]);

export const OBSTRUCTION_STATES = Object.freeze({
  notModelled: 'not-modelled',
  clear: 'clear',
  obstructed: 'obstructed',
  occulted: 'occulted',
});

/**
 * `{modelled, state, lossDb, edges, edge}` from a row's values (`prefix`
 * `'c2_'` for the track's GCS path). `edge` is the main edge
 * `{lon, lat, heightM, groundM, roofed, nu}` when the path is obstructed and
 * the edge is placed, else null.
 */
export function obstructionOf(values, prefix = '') {
  const get = (name) => values?.[prefix + name];
  const edges = finiteOrNull(get('obstruction_edges'));
  if (edges === null)
    return {
      modelled: false,
      state: OBSTRUCTION_STATES.notModelled,
      lossDb: null,
      edges: null,
      edge: null,
    };
  const flag = get('obstructed');
  const state =
    flag === true
      ? OBSTRUCTION_STATES.obstructed
      : flag === false
        ? OBSTRUCTION_STATES.clear
        : OBSTRUCTION_STATES.occulted;
  const lon = finiteOrNull(get('edge_lon_deg'));
  const lat = finiteOrNull(get('edge_lat_deg'));
  const heightM = finiteOrNull(get('edge_height_m'));
  const roofed = get('edge_roofed');
  const edge =
    state === OBSTRUCTION_STATES.obstructed &&
    lon !== null &&
    lat !== null &&
    heightM !== null
      ? {
          lon,
          lat,
          heightM,
          groundM: finiteOrNull(get('edge_ground_height_m')),
          roofed: roofed === true ? true : roofed === false ? false : null,
          nu: finiteOrNull(get('edge_nu')),
        }
      : null;
  return {
    modelled: true,
    state,
    lossDb: finiteOrNull(get('obstruction_loss_db')),
    edges,
    edge,
  };
}

/** The edge's top above the ground under it, m; null without both. */
export function edgeAboveGroundM(edge) {
  if (!edge || edge.groundM === null || !Number.isFinite(edge.heightM))
    return null;
  return edge.heightM - edge.groundM;
}

/** `building or tree`, `terrain`, or null when the edge does not say. */
export function edgeKind(edge) {
  if (edge?.roofed === true) return 'building or tree';
  if (edge?.roofed === false) return 'terrain';
  return null;
}

/** `1,869 m`: a height above the ellipsoid, whole metres. */
function metres(m) {
  return `${Math.round(m).toLocaleString('en-US')} m`;
}

/**
 * A card's lines for a path's obstruction; none for a run that does not model
 * it. `[]` for not-modelled, else e.g. `obstructed · building or tree`,
 * `loss 73.9 dB over 2 edges`, `edge top 1,869 m · 56 m above ground`.
 */
export function obstructionLines(obstruction) {
  if (!obstruction?.modelled) return [];
  const { state, lossDb, edges, edge } = obstruction;
  if (state === OBSTRUCTION_STATES.occulted)
    return ['path below the horizon · no obstruction computed'];
  if (state === OBSTRUCTION_STATES.clear)
    return ['line of sight clear of buildings, trees and terrain'];
  const kind = edgeKind(edge);
  const lines = [kind ? `obstructed · ${kind}` : 'obstructed'];
  if (lossDb !== null)
    lines.push(
      `loss ${lossDb.toFixed(1)} dB over ${edges} edge${edges === 1 ? '' : 's'}`,
    );
  if (edge) {
    const above = edgeAboveGroundM(edge);
    lines.push(
      above === null
        ? `edge top ${metres(edge.heightM)}`
        : `edge top ${metres(edge.heightM)} · ${Math.round(above)} m above ground`,
    );
  }
  return lines;
}
