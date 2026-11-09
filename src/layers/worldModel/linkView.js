/**
 * A run's RF paths to its drone, drawn at the run player's time (GEN-405).
 *
 * - The C2 path: a line from the ground control station the drone's track
 *   names (`simulation.uas.sites`) to the drone, in the stored epoch's C2
 *   colour (GEN-395), dashed while a building, tree or the terrain obstructs
 *   it, with its main edge marked. It belongs to the drone view: it ends on
 *   the drawn model, at the model's display pose.
 * - A jammer's path (`simulation.rf.links`, styled by `rfStyle.js`): its
 *   drone end follows the drawn drone between stored epochs, and its main
 *   edge is marked while obstructed.
 *
 * Geometry moves with the drone's display pose; colour, dash and edge change
 * only at stored epochs. Lines keep depth testing, so a building hides the
 * segment inside it; an edge marker is drawn over everything.
 */
import * as Cesium from 'cesium';
import {
  UAS_TRACK_BINDING,
  c2Colour,
  displayPoseAt,
  droneName,
} from './uasTrack.js';
import { OBSTRUCTION_STATES, edgeAboveGroundM } from './linkObstruction.js';
import { siteName } from './uasSites.js';

/** Display-only choices for the paths, named so an inspector can show them. */
export const LINK_VIEW_DISPLAY = Object.freeze({
  c2WidthPx: 2.5,
  c2Alpha: 0.9,
  dashLength: 16,
  dashPatternClear: 0xffff,
  dashPatternObstructed: 0xff00,
  edgePixelSize: 9,
});

const OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.75);

/** Ids of a drone's C2 path entities, under the drone's item id. */
export function c2PathIds(itemId) {
  return { line: `${itemId}/c2`, edge: `${itemId}/c2/edge` };
}

/** The id of a projected link's edge marker. */
export function linkEdgeId(itemId) {
  return `${itemId}/edge`;
}

/** The item a click on a path's line or marker means: `<item>/c2…` or `<item>/edge`, else null. */
export function pathOwner(pickedId) {
  const id = String(pickedId ?? '');
  const c2 = id.indexOf('/c2');
  if (c2 > 0 && (id.endsWith('/c2') || id.endsWith('/c2/edge')))
    return id.slice(0, c2);
  return id.endsWith('/edge') ? id.slice(0, -'/edge'.length) : null;
}

/** `EDGE · 56 m above ground`, or `EDGE` when the ground is not known. */
export function edgeLabel(edge) {
  const above = edgeAboveGroundM(edge);
  return above === null ? 'EDGE' : `EDGE · ${Math.round(above)} m ABOVE GROUND`;
}

function edgeGraphics({ position, color, text, show }) {
  return {
    position,
    point: {
      pixelSize: LINK_VIEW_DISPLAY.edgePixelSize,
      color,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      ...(show ? { show } : {}),
    },
    label: {
      text,
      font: '11px sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: OUTLINE_COLOR,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -16),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      ...(show ? { show } : {}),
    },
  };
}

/**
 * One drone's C2 path: `[line, edge]`.
 * @param {{track: object, itemId: string, site: object,
 *   sample: () => {row: object|null, cartesian: Cesium.Cartesian3|null}}} options
 *   `sample` is the drone view's own (display pose, stored row) for this drone.
 */
export function c2PathEntities({ track, itemId, site, sample }) {
  const ids = c2PathIds(itemId);
  const start = Cesium.Cartesian3.fromDegrees(
    site.position.lon,
    site.position.lat,
    site.position.height,
  );
  const colour = () =>
    new Cesium.Color(
      ...c2Colour(track.header, sample().row?.c2StateCode),
      LINK_VIEW_DISPLAY.c2Alpha,
    );
  let lastEnd = null;
  let positions = [];
  const line = new Cesium.Entity({
    id: ids.line,
    name: `C2 ${siteName(site.identity)} → ${droneName(track.identity)} (simulated)`,
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        const { cartesian } = sample();
        if (cartesian !== lastEnd) {
          lastEnd = cartesian;
          positions = cartesian ? [start, cartesian] : [];
        }
        return positions;
      }, false),
      width: LINK_VIEW_DISPLAY.c2WidthPx,
      // A radio path is a chord through space, not a great-circle arc.
      arcType: Cesium.ArcType.NONE,
      material: new Cesium.PolylineDashMaterialProperty({
        color: new Cesium.CallbackProperty(colour, false),
        dashLength: LINK_VIEW_DISPLAY.dashLength,
        dashPattern: new Cesium.CallbackProperty(
          () =>
            sample().row?.c2?.state === OBSTRUCTION_STATES.obstructed
              ? LINK_VIEW_DISPLAY.dashPatternObstructed
              : LINK_VIEW_DISPLAY.dashPatternClear,
          false,
        ),
      }),
    },
    properties: { kind: 'uas-c2-path', binding: UAS_TRACK_BINDING },
  });
  let edgeRow;
  let edgeAt;
  let text = '';
  const edgeNow = () => {
    const { row } = sample();
    if (row !== edgeRow) {
      edgeRow = row;
      const edge = row?.c2?.edge ?? null;
      edgeAt = edge
        ? Cesium.Cartesian3.fromDegrees(edge.lon, edge.lat, edge.heightM)
        : undefined;
      text = edge ? `C2 ${edgeLabel(edge)}` : '';
    }
    return edgeAt;
  };
  const edge = new Cesium.Entity({
    id: ids.edge,
    name: `C2 path edge · ${droneName(track.identity)} (simulated)`,
    ...edgeGraphics({
      position: new Cesium.CallbackProperty(edgeNow, false),
      color: new Cesium.CallbackProperty(colour, false),
      text: new Cesium.CallbackProperty(() => (edgeNow(), text), false),
      show: new Cesium.CallbackProperty(() => edgeNow() !== undefined, false),
    }),
    properties: { kind: 'uas-c2-edge', binding: UAS_TRACK_BINDING },
  });
  return [line, edge];
}

/** A projected link's edge marker while its path is obstructed, else null. */
export function linkEdgeEntity(render) {
  const edge = render?.obstruction?.edge;
  if (!edge) return null;
  return new Cesium.Entity({
    id: linkEdgeId(render.id),
    name: `${render.id} · edge`,
    ...edgeGraphics({
      position: Cesium.Cartesian3.fromDegrees(edge.lon, edge.lat, edge.heightM),
      color: new Cesium.Color(...render.colorRgb, 1),
      text: edgeLabel(edge),
    }),
    properties: { kind: 'link-edge', binding: render.binding },
  });
}

/**
 * Bind a projected link's drone end to the drone's display pose: its site
 * end stays where it is served. `displayMs(range)` is the layer's clock.
 * Returns the moving end's cartesian, for a card anchored to it.
 */
export function followDrone(entity, render, track, displayMs) {
  const rows = track.rows;
  const range = { start: rows[0].at, end: rows.at(-1).at };
  const site = render.positions[0];
  const start = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, site.height);
  const served = render.positions.at(-1);
  let lastMs = null;
  let end = Cesium.Cartesian3.fromDegrees(
    served.lon,
    served.lat,
    served.height,
  );
  const at = () => {
    const ms = displayMs(range);
    if (ms !== lastMs) {
      lastMs = ms;
      const pose = Number.isFinite(ms) ? displayPoseAt(rows, ms) : null;
      if (pose)
        end = Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.height);
    }
    return end;
  };
  let lastEnd = null;
  let positions = [];
  entity.polyline.positions = new Cesium.CallbackProperty(() => {
    const now = at();
    if (now !== lastEnd) {
      lastEnd = now;
      positions = [start, now];
    }
    return positions;
  }, false);
  return at;
}
