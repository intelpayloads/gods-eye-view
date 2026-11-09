/**
 * The run's drone, drawn (GEN-395): a glTF model flying the stored track,
 * labelled with the stored epoch's mode, AGL and lost-link timer, and the
 * epochs where its mode changed marked on the path.
 *
 * It lives in its own data source, built once per revision: a projection
 * replaces the layer's points on every step, and a model rebuilt each time
 * would reload, flicker and drop the follow camera. Position and heading are
 * the display pose at the display time (`displayPoseAt`); the label, colours
 * and markers read stored rows only (`storedRowAt`). Height is the stored
 * height above the ellipsoid, never snapped to a tileset.
 *
 * The model entity takes the projected item's id, so clicking it selects
 * the stored epoch's item and opens its card.
 */
import * as Cesium from 'cesium';
import { assetUrl } from '../../sources/endpoints.js';
import { applyTrackedCameraFrame } from '../../data/trackedCamera.js';
import {
  UAS_TRACK_BINDING,
  c2Colour,
  displayPoseAt,
  droneModelFor,
  modeChanges,
  storedRowAt,
} from './uasTrack.js';
import { uasLabel, uasWords } from './uasCard.js';

const OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.75);
const keys = () => (typeof window !== 'undefined' ? window : null);

/**
 * The follow camera's start: behind the drone and above it. Its minimum range
 * is also, under terrain collision, the camera's least height above the
 * ground, so it is a drone's, not an aircraft's 150 m: at 150 m a drone on its
 * pad put the camera straight overhead and kept it there for the whole run.
 * Rising more than the minimum keeps a landed drone's camera behind it.
 */
export const FOLLOW_VIEW = Object.freeze({
  backM: 60,
  upM: 40,
  minimumRangeM: 30,
});

/**
 * The drones drawn right now, by any layer, per source and revision. A run's
 * C2 receiver rides on its drone under the same identity, so the receiver's
 * marker gives way to the model even when another row draws the drone (the
 * embedded app draws each product in its own row).
 */
const drawnDrones = new WeakMap(); // source -> Map(`${revisionId}\0${identity}` -> Set(ownerId))

/** Whether some layer draws `identity` of `revisionId` from `source` as a drone. */
export function droneDrawn(source, revisionId, identity) {
  if (!source || typeof source !== 'object') return false;
  return (
    (drawnDrones.get(source)?.get(`${revisionId}\0${identity}`)?.size ?? 0) > 0
  );
}

function recordDrawn(source, ownerId, revisionId, identities) {
  if (!source || typeof source !== 'object') return;
  let drawn = drawnDrones.get(source);
  if (!drawn) drawnDrones.set(source, (drawn = new Map()));
  for (const [key, owners] of drawn) {
    owners.delete(ownerId);
    if (!owners.size) drawn.delete(key);
  }
  for (const identity of identities) {
    const key = `${revisionId}\0${identity}`;
    if (!drawn.has(key)) drawn.set(key, new Set());
    drawn.get(key).add(ownerId);
  }
}

/** The projected item id of a drone (`<binding>/<semantic identity>`, as `positioned_entities/v1` names it). */
export function droneItemId(identity) {
  return `${UAS_TRACK_BINDING}/${identity}`;
}

/** The follow camera's offset in the drone's ENU frame: behind its heading. */
export function followOffset(headingDeg, { backM, upM } = FOLLOW_VIEW) {
  const heading = Cesium.Math.toRadians(
    Number.isFinite(headingDeg) ? headingDeg : 0,
  );
  // ENU: x east, y north. Behind is the opposite of the heading.
  return new Cesium.Cartesian3(
    -Math.sin(heading) * backM,
    -Math.cos(heading) * backM,
    upM,
  );
}

/**
 * The model's orientation for a heading: the shared model convention (nose
 * toward glTF -X) turned by the model's offset, level.
 */
export function droneOrientation(position, headingDeg, offsetDeg) {
  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(
      (Number.isFinite(headingDeg) ? headingDeg : 0) + offsetDeg,
    ),
    0,
    0,
  );
  return Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
}

/**
 * @param {{id: string, source?: object, displayMs: (range?: {start?: number, end?: number}) => number|null,
 *   onFollowChange?: (following: boolean) => void}} options
 */
export function createDroneView({
  id,
  source: projectionSource = null,
  displayMs,
  onFollowChange = () => {},
}) {
  const state = {
    viewer: null,
    source: null,
    revisionId: null,
    shown: false,
    drones: [], // { identity, itemId, track, model, entity }
    reasons: [], // why a drone track draws no model
    follow: null, // { drone, stop, onKey, onTracked }
  };

  /** One drone's display pose and stored row at the display time, computed once per display time. */
  function sampler(track) {
    const rows = track.rows;
    const range = { start: rows[0].at, end: rows.at(-1).at };
    let lastMs = null;
    let pose = null;
    let row = null;
    let cartesian = null;
    return () => {
      const ms = displayMs(range);
      if (ms !== lastMs) {
        lastMs = ms;
        pose = Number.isFinite(ms) ? displayPoseAt(rows, ms) : null;
        row = Number.isFinite(ms) ? storedRowAt(rows, ms) : null;
        cartesian = pose
          ? Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.height)
          : null;
      }
      return { pose, row, cartesian };
    };
  }

  function droneEntity(track, model, itemId) {
    const sample = sampler(track);
    const colour = () => {
      const { row } = sample();
      return new Cesium.Color(...c2Colour(track.header, row?.c2StateCode), 1);
    };
    let labelRow = null;
    let labelText = '';
    const entity = new Cesium.Entity({
      id: itemId,
      name: `${itemId} (simulated)`,
      position: new Cesium.CallbackProperty(
        () => sample().cartesian ?? undefined,
        false,
      ),
      orientation: new Cesium.CallbackProperty(() => {
        const { pose, cartesian } = sample();
        return cartesian
          ? droneOrientation(cartesian, pose.headingDeg, model.headingOffsetDeg)
          : undefined;
      }, false),
      // The follow camera and the card both read the frame's display position.
      trackingReferenceFrame: Cesium.TrackingReferenceFrame.ENU,
      model: {
        uri: assetUrl(model.url),
        minimumPixelSize: model.minimumPixelSize,
        silhouetteColor: new Cesium.CallbackProperty(colour, false),
        // A hairline in the C2 colour: the label carries the state too.
        silhouetteSize: 1,
      },
      label: {
        text: new Cesium.CallbackProperty(() => {
          const { row } = sample();
          if (row !== labelRow) {
            labelRow = row;
            labelText = uasLabel(row, track.header, track.identity);
          }
          return labelText;
        }, false),
        font: '13px sans-serif',
        fillColor: new Cesium.CallbackProperty(colour, false),
        outlineColor: OUTLINE_COLOR,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(44, 0),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { kind: 'uas-drone', binding: UAS_TRACK_BINDING },
    });
    entity.gevDisplayPosition = () => sample().cartesian ?? undefined;
    return entity;
  }

  /** A stored epoch where the mode changed: a dot and its mode and time, in that epoch's C2 colour. */
  function markerEntity(track, row, index) {
    const words = uasWords(row, track.header);
    const colour = new Cesium.Color(
      ...c2Colour(track.header, row.c2StateCode),
      0.95,
    );
    return new Cesium.Entity({
      id: `${droneItemId(track.identity)}/mode/${index}`,
      name: `${words.mode ?? `mode ${row.modeCode}`} at ${row.validTime}`,
      position: Cesium.Cartesian3.fromDegrees(
        row.position.lon,
        row.position.lat,
        row.position.height,
      ),
      point: {
        pixelSize: 8,
        color: colour,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `${(words.mode ?? `mode ${row.modeCode}`).toUpperCase()} ${row.validTime.slice(11, 19)}`,
        font: '11px sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: OUTLINE_COLOR,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { kind: 'uas-mode-change', binding: UAS_TRACK_BINDING },
    });
  }

  /** Tell other layers which drones this one draws (none while hidden). */
  function announce() {
    recordDrawn(
      projectionSource,
      id,
      state.revisionId,
      state.shown ? state.drones.map((drone) => drone.identity) : [],
    );
  }

  function stopFollowing() {
    const follow = state.follow;
    if (!follow) return;
    state.follow = null;
    keys()?.removeEventListener('keydown', follow.onKey);
    follow.removeTracked?.();
    follow.stop?.();
    const viewer = state.viewer;
    if (
      viewer &&
      !viewer.isDestroyed?.() &&
      viewer.trackedEntity === follow.drone.entity
    )
      viewer.trackedEntity = undefined;
    onFollowChange(false);
  }

  return {
    init(viewer) {
      state.viewer = viewer;
      state.source = new Cesium.CustomDataSource(`${id}-uas`);
      state.source.show = false;
      viewer.dataSources.add(state.source);
    },

    show(on) {
      state.shown = !!on;
      if (state.source) state.source.show = state.shown;
      if (!on) stopFollowing();
      announce();
    },

    /** Replace the drawn drones with `tracks` (one revision's). */
    draw(tracks, { revisionId = null } = {}) {
      const entities = state.source?.entities;
      if (!entities) return;
      state.revisionId = revisionId;
      const following = state.follow?.drone.identity ?? null;
      stopFollowing();
      entities.removeAll();
      state.drones = [];
      state.reasons = [];
      entities.suspendEvents();
      for (const track of tracks) {
        if (track.rows.length < 2) continue;
        const { model, reason } = droneModelFor(track.header);
        if (!model) {
          state.reasons.push(`${track.identity}: ${reason}`);
          continue;
        }
        const itemId = droneItemId(track.identity);
        const entity = droneEntity(track, model, itemId);
        entities.add(entity);
        modeChanges(track.rows).forEach((row, index) =>
          entities.add(markerEntity(track, row, index)),
        );
        state.drones.push({
          identity: track.identity,
          itemId,
          track,
          model,
          entity,
        });
      }
      entities.resumeEvents();
      announce();
      if (following) this.follow(true, following);
    },

    clear() {
      this.draw([]);
    },

    /** Item ids of the projected points a drawn drone replaces. */
    drawnItemIds() {
      return new Set(state.drones.map((drone) => drone.itemId));
    },

    /** The drawn drone's current display position, for a card anchored to it. */
    anchorFor(itemId) {
      const drone = state.drones.find((d) => d.itemId === itemId);
      return drone ? () => drone.entity.gevDisplayPosition() : null;
    },

    hasDrone() {
      return state.drones.length > 0;
    },

    /** Why a drone track on screen draws no model ("<identity>: no drone model for …"). */
    reasons() {
      return [...state.reasons];
    },

    following() {
      return !!state.follow;
    },

    /**
     * Follow a drone (the first, or `identity`) with the flights layer's
     * tracking camera, starting behind it; false stops. Escape, another
     * layer taking the camera, or the drone going away also stops it.
     */
    follow(on, identity = null) {
      if (!on) {
        stopFollowing();
        return false;
      }
      const viewer = state.viewer;
      const drone = identity
        ? state.drones.find((d) => d.identity === identity)
        : state.drones[0];
      if (!viewer || !drone) return false;
      if (state.follow?.drone === drone) return true;
      stopFollowing();
      const heading = displayPoseAt(
        drone.track.rows,
        displayMs({
          start: drone.track.rows[0].at,
          end: drone.track.rows.at(-1).at,
        }),
      )?.headingDeg;
      const offset = followOffset(heading);
      drone.entity.viewFrom = new Cesium.ConstantProperty(offset);
      viewer.trackedEntity = drone.entity;
      const follow = { drone, stop: null, onKey: null, removeTracked: null };
      follow.stop = applyTrackedCameraFrame(viewer, drone.entity, offset, {
        minimumRangeM: FOLLOW_VIEW.minimumRangeM,
      });
      follow.onKey = (event) => {
        if (event?.key === 'Escape') stopFollowing();
      };
      keys()?.addEventListener('keydown', follow.onKey);
      const changed = viewer.trackedEntityChanged;
      if (changed?.addEventListener) {
        const listener = () => {
          if (viewer.trackedEntity !== drone.entity && state.follow === follow)
            stopFollowing();
        };
        follow.removeTracked = changed.addEventListener(listener);
      }
      state.follow = follow;
      onFollowChange(true);
      return true;
    },

    destroy() {
      stopFollowing();
      state.drones = [];
      state.shown = false;
      announce();
      if (state.source && state.viewer && !state.viewer.isDestroyed?.())
        state.viewer.dataSources.remove(state.source, true);
      state.source = null;
      state.drones = [];
      state.viewer = null;
    },
  };
}
