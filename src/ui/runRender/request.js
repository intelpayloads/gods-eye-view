/**
 * One moment of a run as a `RenderRequest/v1` (GEN-369): the camera the
 * render panel names, every drone of the run at its stored epoch (GEN-468),
 * and the region whose terrain is under them, read at the world head the
 * Modelled scene draws. The Spark's renderer (droneimages `RENDER.md`) runs it;
 * this module only writes the request and says, before anything is sent, why
 * the renderer would refuse it.
 *
 * Two cameras:
 *  - `site`: a GCS or C-UAS site's camera (`simulation.uas.sites`, its lens
 *    `camera_*`), at the site's ellipsoid height, following the drone.
 *  - `view`: exactly what God's Eye shows inside the 16:9 viewfinder, the
 *    Cesium camera's position (ellipsoid), heading and pitch.
 *
 * A drone is its STORED row at or before the moment (`storedRowAt`), never
 * the interpolated display pose GEN-395 draws; only its heading is the drawn
 * model's. Pure and Cesium-free.
 */
import { REGION_LAYERS } from '../../layers/worldModel/regionScene.js';
import { droneName, headingAt, storedRowAt } from '../../layers/worldModel/uasTrack.js';

export const RENDER_COMMAND = 'RenderRequest/v1';

/** The renderer's `MAX_OBSERVER_TARGET_DISTANCE_M` (render_request.rs). */
export const MAX_TARGET_DISTANCE_M = 5000;

/** The renderer's `MAX_TARGETS`: the most drones one shot holds. */
export const MAX_TARGETS = 128;

/** The renderer's cap on a target's `label`. */
const MAX_LABEL_CHARS = 64;

/** Region tilesets the renderer draws, in the order it takes them. */
export const RENDER_LAYERS = REGION_LAYERS;

/** The render's frame for This view; the viewfinder shows its shape. */
export const VIEW_FRAME = Object.freeze({ width: 1920, height: 1080 });

/** A site camera renders at its own lens's shape, at most this wide (Cosmos's cost grows with pixels). */
export const MAX_SITE_WIDTH_PX = 1920;

/**
 * Auto zoom: the field of view at which the drone is about `AUTO_DRONE_PX`
 * wide. `DRONE_SPAN_M` is how wide the renderer's drone boxes, measured: the
 * first Spark render boxed it 63 px wide at 72 m through a 60° lens (the
 * diagonal of the Unreal airframe's 2.0 × 1.8 m footprint).
 */
export const DRONE_SPAN_M = 2.7;
export const AUTO_DRONE_PX = 60;
export const MIN_FOV_DEG = 0.5;

const SITE_KINDS = Object.freeze(['gcs', 'cuas_site']);
const SITES_BINDING = 'simulation.uas.sites';
const D2R = Math.PI / 180;
const R_M = 6_371_008.8;

/** Ground distance in metres, haversine on the mean sphere as the renderer measures it. */
export function groundDistanceM(a, b) {
  const p1 = a.lat * D2R;
  const p2 = b.lat * D2R;
  const dp = (b.lat - a.lat) * D2R;
  const dl = (b.lon - a.lon) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Straight-line distance between two `{lon, lat, height}` points (small-angle; fine within 5 km). */
export function slantDistanceM(a, b) {
  return Math.hypot(groundDistanceM(a, b), (b.height ?? 0) - (a.height ?? 0));
}

/** The tilesets a region lists at the head (a `regionSceneOf` region), in RENDER_LAYERS order. */
export function layersOf(region) {
  return RENDER_LAYERS.filter((layer) => Boolean(region?.layers?.[layer]));
}

/**
 * The region whose terrain is under `position`: of the regions that list a
 * terrain tileset (`drawn`), those whose box holds the point; the smallest
 * box wins. Null when none does.
 */
export function regionAt(regions, position) {
  if (!position) return null;
  const area = ({ box }) => (box.east - box.west) * (box.north - box.south);
  return (
    (regions ?? [])
      .filter(
        (region) =>
          region?.drawn &&
          region.box &&
          position.lon >= region.box.west &&
          position.lon <= region.box.east &&
          position.lat >= region.box.south &&
          position.lat <= region.box.north,
      )
      .sort((a, b) => area(a) - area(b))[0] ?? null
  );
}

/**
 * Every drone of the run at `ms`, as the request's targets (GEN-468), in
 * track order: `{drones: [{track, row, name, distanceM, target}], left:
 * [{track, name, reason, distanceM}], follow, followIndex}`. A drone is left out when it has
 * no stored row yet (`no-row`), is beyond the renderer's 5 km (`too-far`), or
 * repeats an identity already sent (`duplicate`); past MAX_TARGETS the
 * farthest are left out (`too-many`). `followIndex` is where `follow`'s drone
 * sits among the kept ones, -1 when it was left out.
 */
export function renderTargets({ tracks, ms, observer = null, follow = null }) {
  let drones = [];
  const left = [];
  const taken = new Set();
  for (const track of tracks ?? []) {
    const name = droneName(track.identity, track.callsign);
    const row = storedRowAt(track.rows, ms);
    if (!row?.position) {
      left.push({ track, name, reason: 'no-row', distanceM: null });
      continue;
    }
    const distanceM = observer ? groundDistanceM(observer, row.position) : null;
    if (taken.has(track.identity)) {
      left.push({ track, name, reason: 'duplicate', distanceM });
      continue;
    }
    if (distanceM !== null && distanceM > MAX_TARGET_DISTANCE_M) {
      left.push({ track, name, reason: 'too-far', distanceM });
      continue;
    }
    taken.add(track.identity);
    const heading = headingAt(track.rows, ms);
    drones.push({
      track,
      row,
      name,
      distanceM,
      target: {
        lon: row.position.lon,
        lat: row.position.lat,
        height_m: row.position.height,
        height_ref: 'ellipsoid',
        id: track.identity,
        label: [...name].slice(0, MAX_LABEL_CHARS).join(''),
        ...(Number.isFinite(heading)
          ? { heading_deg: Number((((heading % 360) + 360) % 360).toFixed(2)) % 360 }
          : {}),
      },
    });
  }
  if (drones.length > MAX_TARGETS) {
    const nearest = new Set(
      [...drones]
        .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))
        .slice(0, MAX_TARGETS),
    );
    for (const drone of drones)
      if (!nearest.has(drone))
        left.push({ track: drone.track, name: drone.name, reason: 'too-many', distanceM: drone.distanceM });
    drones = drones.filter((drone) => nearest.has(drone));
  }
  return {
    drones,
    left,
    follow,
    followIndex: follow ? drones.findIndex((drone) => drone.track === follow) : -1,
  };
}

/** Degrees between a view camera's axis and the line from it to `position`. */
export function offAxisDeg(camera, position) {
  const east =
    (position.lon - camera.lon) * D2R * Math.cos(camera.lat * D2R) * R_M;
  const north = (position.lat - camera.lat) * D2R * R_M;
  const up = (position.height ?? 0) - (camera.height ?? 0);
  const length = Math.hypot(east, north, up);
  if (!(length > 0)) return 0;
  const h = camera.headingDeg * D2R;
  const p = camera.pitchDeg * D2R;
  const dot =
    (east * Math.sin(h) * Math.cos(p) + north * Math.cos(h) * Math.cos(p) + up * Math.sin(p)) /
    length;
  return Math.acos(Math.max(-1, Math.min(1, dot))) / D2R;
}

/**
 * The drone the shot is about, whose ground chooses the terrain region: the
 * one a site camera follows, or for This view the one nearest the frame's
 * centre. Null when no drone is sent.
 */
export function subjectOf(camera, { drones, followIndex }) {
  if (!drones?.length) return null;
  if (camera?.kind === 'site') return drones[followIndex] ?? null;
  if (!camera) return drones[0];
  return [...drones].sort(
    (a, b) => offAxisDeg(camera, a.row.position) - offAxisDeg(camera, b.row.position),
  )[0];
}

/** Whether the run's revision binds its sites at all (GEN-379 publishes them). */
export function bindsSites(revision) {
  return (revision?.bindings ?? []).some((binding) => binding?.name === SITES_BINDING);
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The projection query for a run's sites: every site, no viewport scope (an off-screen site still renders). */
export function sitesQuery() {
  return { modalities: ['simulated'], requested_layers: [SITES_BINDING] };
}

/**
 * The run's camera sites from a `simulation.uas.sites` projection: GCS and
 * C-UAS sites whose lens is declared. A home, or a site with no camera, is no
 * observer. `{identity, kind, lon, lat, height, hfovDeg, widthPx, heightPx}`.
 */
export function cameraSites(projection) {
  const sites = [];
  for (const point of projection?.points ?? []) {
    if (point?.binding !== SITES_BINDING) continue;
    const p = point.properties ?? {};
    const position = point.position ?? {};
    const kind = p.site_kind;
    if (!SITE_KINDS.includes(kind)) continue;
    const site = {
      identity: String(point.semantic_ref?.semantic_identity ?? point.id ?? ''),
      kind,
      lon: finite(position.lon),
      lat: finite(position.lat),
      height: finite(position.height_m),
      hfovDeg: finite(p.camera_hfov_deg),
      widthPx: finite(p.camera_width_px),
      heightPx: finite(p.camera_height_px),
    };
    if ([site.lon, site.lat, site.height, site.hfovDeg, site.widthPx, site.heightPx].includes(null))
      continue;
    sites.push(site);
  }
  return sites.sort((a, b) => SITE_KINDS.indexOf(a.kind) - SITE_KINDS.indexOf(b.kind));
}

/** A site camera's frame: its lens's shape, scaled down to MAX_SITE_WIDTH_PX. */
export function siteFrame(site) {
  const scale = Math.min(1, MAX_SITE_WIDTH_PX / site.widthPx);
  return {
    width: Math.max(64, Math.round(site.widthPx * scale)),
    height: Math.max(64, Math.round(site.heightPx * scale)),
  };
}

/** The field of view that makes the drone about AUTO_DRONE_PX wide, within the site's lens. */
export function autoFovDeg(distanceM, widthPx, maxFovDeg) {
  if (!(distanceM > 0) || !(widthPx > 0)) return maxFovDeg;
  const halfTan = ((DRONE_SPAN_M / 2) * (widthPx / AUTO_DRONE_PX)) / distanceM;
  const fov = (2 * Math.atan(halfTan)) / D2R;
  return Math.min(maxFovDeg, Math.max(MIN_FOV_DEG, fov));
}

/**
 * The 16:9 viewfinder inside a canvas and its horizontal field of view.
 * Cesium's `frustum.fovy` is the vertical angle whatever the canvas shape.
 */
export function viewfinderBox({ width, height, fovyRad }) {
  const aspect = VIEW_FRAME.width / VIEW_FRAME.height;
  const boxWidth = Math.min(width, height * aspect);
  const boxHeight = boxWidth / aspect;
  const hfovRad = 2 * Math.atan(Math.tan(fovyRad / 2) * (boxWidth / height));
  return {
    left: (width - boxWidth) / 2,
    top: (height - boxHeight) / 2,
    width: boxWidth,
    height: boxHeight,
    hfovDeg: hfovRad / D2R,
  };
}

/** Where the camera is: a site's position, or the view's. */
function observerPoint(camera) {
  return camera.kind === 'site' ? camera.site : camera;
}

/**
 * Why the renderer would refuse this moment, as words for the panel; empty
 * when it can render. The renderer stays the authority: a refusal it makes
 * that this misses (dusk, a tile that will not load) comes back as a failed
 * job with its reason.
 */
export function renderBlockers({ region, regionsOffered = true, camera, sent, subject, sunAltitudeDeg }) {
  const reasons = [];
  const drones = sent?.drones ?? [];
  const left = sent?.left ?? [];
  const km = (m) => `${(m / 1000).toFixed(1)} km`;
  if (!camera) reasons.push('No camera: this run has no site with a camera');
  if (camera && Number.isFinite(sunAltitudeDeg) && sunAltitudeDeg <= 0)
    reasons.push('Night here at this time: the renderer draws daylight only');
  const far = left.filter((drone) => drone.reason === 'too-far');
  if (!drones.length) {
    if (far.length && camera)
      reasons.push(
        far.length === 1
          ? `The drone is ${km(far[0].distanceM)} from the camera; the renderer takes 5 km at most`
          : `Every drone is more than 5 km from the camera (the nearest is ${km(Math.min(...far.map((d) => d.distanceM)))})`,
      );
    else reasons.push('No drone row at this time');
    return reasons;
  }
  if (camera?.kind === 'site' && sent.followIndex < 0) {
    const followed = far.find((drone) => drone.track === sent.follow);
    reasons.push(
      followed
        ? `${followed.name} is ${km(followed.distanceM)} from the camera; the renderer takes 5 km at most`
        : 'The drone this camera follows has no row at this time',
    );
  }
  if (!regionsOffered || (region && !layersOf(region).includes('terrain')))
    reasons.push("This run's world holds no terrain tiles for its region");
  else if (!region && subject)
    reasons.push(`No terrain tiles cover ${subject.name} at this time`);
  return reasons;
}

/** `2026-11-05T16:02:30Z` -> `20261105T160230Z`. */
function compactTime(validAt) {
  return new Date(Date.parse(validAt)).toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

/** `sim/sha256:043d75f9…` -> `043d75f90515`. */
export function runShortId(head) {
  const tail = String(head ?? '').split(':').at(-1) ?? '';
  return tail.slice(0, 12) || 'run';
}

/** A camera's name in ids and labels: `view`, or the site identity's tail. */
export function cameraKey(camera) {
  if (camera.kind !== 'site') return 'view';
  return (String(camera.site.identity).split(':').at(-1) || camera.site.kind).replace(/[^A-Za-z0-9_-]/g, '-');
}

/** A seed from the capture id, so one moment and camera renders the same Cosmos frame again. */
export function seedOf(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/**
 * The request for one moment. `run` is `{head, revisionId}`; `sceneHead` the
 * world head the region's tilesets are read at (the renderer pins and records
 * its revision); `region` a `regionSceneOf` region; `sent` is `renderTargets`'
 * answer; `validAt` the player's epoch; `look` `fast` (Unreal) or `photoreal`
 * (Unreal, then Cosmos).
 */
export function buildRenderRequest({ run, sceneHead, region, camera, sent, validAt, look }) {
  const start = new Date(Date.parse(validAt)).toISOString().replace(/\.\d+Z$/, 'Z');
  const captureId = `run-${runShortId(run.head)}-${compactTime(start)}-${cameraKey(camera)}`;
  const point = observerPoint(camera);
  const frame = camera.kind === 'site' ? siteFrame(camera.site) : VIEW_FRAME;
  const layers = layersOf(region);
  const request = {
    command: RENDER_COMMAND,
    capture_id: captureId,
    scene: { head: sceneHead, region: region.name, layers },
    observer: {
      lon: point.lon,
      lat: point.lat,
      height_m: point.height,
      height_ref: 'ellipsoid',
      sensor: {
        horizontal_fov_deg: Number(camera.fovDeg.toFixed(3)),
        image_width: frame.width,
        image_height: frame.height,
      },
      aim:
        camera.kind === 'site'
          ? { follow: sent.followIndex }
          : {
              heading_deg: Number(camera.headingDeg.toFixed(3)),
              pitch_deg: Number(Math.max(-90, Math.min(90, camera.pitchDeg)).toFixed(3)),
            },
    },
    targets: sent.drones.map((drone) => drone.target),
    window: { start, frames: 1 },
  };
  // GEN-417: Cosmos's style photo is the scene's own aerial imagery, cut to the ground in
  // frame; a scene without imagery gets the nearest Mapillary street photo instead.
  if (look === 'photoreal')
    request.neural = {
      seed: seedOf(captureId),
      style_ref: { source: layers.includes('imagery') ? 'imagery' : 'mapillary' },
    };
  return request;
}
