/**
 * A C-UAS run's drone (GEN-395): every stored epoch of `simulation.uas.track`
 * (`dataforge.uas-track/1`), read once per revision, so the drone can be drawn
 * as a model flying between its epochs.
 *
 * Two things come from these rows, and they never mix:
 *  - VALUES (mode, C2 state, AGL, the lost-link timer) are the stored row at or
 *    before the display time, `storedRowAt`. Never a blend.
 *  - GEOMETRY (where the model is and which way its nose points) is
 *    `displayPoseAt`: a straight line between the two stored epochs around the
 *    display time, the chord the receiver pass draws, with the heading of that
 *    chord. A display assumption (`DRONE_DISPLAY`), never data.
 *
 * Which model draws the drone is the product's own declaration: its header's
 * `models.flight` (the kinematics it was flown with). A flight model with no
 * entry draws no model, and says so.
 *
 * Pure and Cesium-free, like the receiver pass.
 */
import { SIM_HEAD_PREFIX } from './simulationRuns.js';
import {
  PASS_HEIGHT_GRANT,
  RECEIVER_STATES,
  positionAt,
} from './receiverPass.js';
import { bearingBetweenCoordinates } from '../../cockpitMath.js';
import { lerpAngleDeg } from '../../data/motionModel.js';
import { obstructionOf } from './linkObstruction.js';

export const UAS_TRACK_BINDING = 'simulation.uas.track';
/**
 * A DronePath run's drones (GEN-455, `dataforge.drone-track-delivery/1`): many
 * drones in one head, each a position, speed and heading per epoch under its
 * scenario object's identity, with a `callsign` series key. No mode, no C2.
 */
export const DRONE_TRACK_BINDING = 'simulation.drone.track';
/** Every binding drawn as a flying drone; one `/select` reads them all. */
export const DRONE_BINDINGS = Object.freeze([
  UAS_TRACK_BINDING,
  DRONE_TRACK_BINDING,
]);

/** Display-only choices the drone adds, named like PASS_DISPLAY. */
export const DRONE_DISPLAY = Object.freeze({
  kind: 'uas-drone',
  motion: 'linear-between-stored-epochs',
  heading: 'chord-between-stored-epochs',
  height: 'stored-hae',
  turnFraction: 0.25,
  minChordM: 0.5,
});

/** What the row's facts say about the drawn motion. */
export const DRONE_DISPLAY_FACT =
  'display: the drone moves in a straight line between stored epochs; every value shown is the stored epoch’s';

/**
 * `models.flight` (the product header) -> how the drone is drawn. Every
 * model follows `public/models/README.md`: metres, glTF +Y up, nose toward -X,
 * origin at the bounding-box centre, so the heading offset is the flights
 * layer's 180 degrees. A fixed-wing flight model gets `/models/mq9.glb` when
 * Foundation has one.
 */
export const FLIGHT_MODEL_AIRFRAMES = Object.freeze({
  'dataforge.multirotor-flight/1': Object.freeze({
    airframe: 'multirotor',
    url: '/models/multirotor.glb',
    // A 0.6 m airframe is a few pixels at a follow camera's range: drawn
    // larger, as the flights layer draws aircraft (a display choice). At 96
    // px it outsized a downtown tower from a few hundred metres up.
    minimumPixelSize: 48,
    headingOffsetDeg: 180,
  }),
});

/**
 * A `simulation.drone.track` declares no flight model. Its drones are drawn
 * with the airframe its header publishes (GEN-476), else as multirotors: a
 * display choice, said in the row's facts.
 */
export const DRONE_TRACK_AIRFRAME =
  FLIGHT_MODEL_AIRFRAMES['dataforge.multirotor-flight/1'];
export const DRONE_TRACK_MODEL_FACT =
  'display: this product declares no airframe; its drones are drawn as multirotors';
/** The mesh's file under its content id, unless the header names another. */
export const AIRFRAME_ROOT = 'airframe.glb';

/**
 * The airframe a drone track's header publishes (`models.airframe`, GEN-475):
 * `{contentId, root, extentM}`, or null. The mesh is already in the stock
 * models' convention (metres, +Y up, nose toward -X, centred).
 */
export function airframeOf(header) {
  const airframe = header?.models?.airframe;
  const contentId = airframe?.content_id;
  if (typeof contentId !== 'string' || !/^[A-Za-z0-9:._-]+$/.test(contentId))
    return null;
  const root =
    typeof airframe.root === 'string' && /^[A-Za-z0-9._-]+$/.test(airframe.root)
      ? airframe.root
      : AIRFRAME_ROOT;
  const extentM = Number(airframe.extent_m);
  return {
    contentId,
    root,
    extentM: Number.isFinite(extentM) && extentM > 0 ? extentM : null,
  };
}

/** The backplane path an airframe is read at: by content id, as a region's tilesets are. */
export function airframePath(airframe) {
  return `/tilesets/${airframe.contentId}/${airframe.root}`;
}

/** `sha256:043d75f9…` -> `sha256:043d75f9`, for a fact line. */
function shortId(contentId) {
  const [scheme, digest] = String(contentId).split(':');
  return digest ? `${scheme}:${digest.slice(0, 8)}` : String(contentId).slice(0, 15);
}

/** How a fallback's reason starts: `airframe sha256:043d75f9 drawn as a multirotor`. */
export function airframeNote(airframe) {
  return `airframe ${shortId(airframe.contentId)} drawn as a multirotor`;
}

/** What the row's facts say of a drone drawn with its published airframe. */
export function airframeFact(airframe) {
  return `display: drawn with the airframe this run published (${shortId(airframe.contentId)})`;
}
/** The colour of a drone with no C2 state to colour it by. */
export const DRONE_TRACK_COLOUR = Object.freeze([0.35, 0.8, 1.0]);

/**
 * `{model, reason}`: the drawn model for the product's flight model, or null
 * and why. A `simulation.drone.track` drone always has a model: the airframe
 * its header publishes, read through the source's `resolveUrl` (the model
 * then carries `published`, and its `url` is already resolved), else
 * `DRONE_TRACK_AIRFRAME`, with `note` saying why when one was published.
 */
export function droneModelFor(
  header,
  binding = UAS_TRACK_BINDING,
  { resolveUrl = null } = {},
) {
  if (binding === DRONE_TRACK_BINDING) {
    const airframe = airframeOf(header);
    if (!airframe) return { model: DRONE_TRACK_AIRFRAME, reason: null };
    if (typeof resolveUrl !== 'function')
      return {
        model: DRONE_TRACK_AIRFRAME,
        reason: null,
        note: `${airframeNote(airframe)}: this source serves no files`,
      };
    return {
      model: Object.freeze({
        ...DRONE_TRACK_AIRFRAME,
        airframe: 'published',
        url: resolveUrl(airframePath(airframe)),
        published: airframe,
      }),
      reason: null,
    };
  }
  const flight = header?.models?.flight;
  if (typeof flight !== 'string' || !flight)
    return { model: null, reason: 'the product declares no flight model' };
  const model = FLIGHT_MODEL_AIRFRAMES[flight] ?? null;
  return model
    ? { model, reason: null }
    : { model: null, reason: `no drone model for flight model ${flight}` };
}

/** Whether this demand's layers include `binding` (no layers means all). */
export function showsBinding(demand, binding) {
  return !demand?.layers || demand.layers.includes(binding);
}

/** Whether this demand shows the run's drones with heights it may place. */
export function showsUasTrack(demand) {
  if (!demand?.head?.startsWith(SIM_HEAD_PREFIX)) return false;
  if (!(demand.modalities ?? []).includes('simulated')) return false;
  if (!DRONE_BINDINGS.some((binding) => showsBinding(demand, binding)))
    return false;
  return (
    demand.displayAssumptions?.[PASS_HEIGHT_GRANT.key] ===
    PASS_HEIGHT_GRANT.value
  );
}

/** The `/select` query for every stored epoch of the track. */
export function uasQuery() {
  return {
    modalities: ['simulated'],
    requested_layers: [...DRONE_BINDINGS],
    predicates: {
      interval: { start: '1970-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' },
    },
  };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function codeOrNull(value) {
  const number = finiteOrNull(value);
  return Number.isInteger(number) ? number : null;
}

/**
 * A track row's values (a selected row's `value`, or a projected item's
 * `properties`) in the shape the words read. Absent or non-finite is null.
 * `c2` is the GCS path's obstruction (GEN-405), `not-modelled` on a run
 * without a surface.
 */
export function uasValuesOf(value = {}) {
  return {
    modeCode: codeOrNull(value.mode_code),
    c2StateCode: codeOrNull(value.c2_state_code),
    c2ReasonCode: codeOrNull(value.c2_reason_code),
    aglM: finiteOrNull(value.height_agl_m),
    sinrDb: finiteOrNull(value.c2_sinr_db),
    groundSpeedMps: finiteOrNull(value.ground_speed_mps),
    lostLinkElapsedS: finiteOrNull(value.lost_link_elapsed_s),
    lostLinkTimeoutS: finiteOrNull(value.lost_link_timeout_s),
    c2: obstructionOf(value, 'c2_'),
  };
}

/**
 * `POST /select` answer -> one track per drone, rows in time order:
 * `{identity, binding, callsign, header, gcs, rows: [{at, validTime, position, ...uasValuesOf}]}`.
 * `binding` is which of `DRONE_BINDINGS` the product is; `callsign` is the
 * series key's (a `simulation.drone.track` drone's name), else null; such a
 * drone's rows also carry its stored `speedMps` and `headingDeg`.
 * The header (mode and C2 legends, `models.flight`) travels with the
 * selection, as the run's mission effects' do; `gcs` is the series key's GCS
 * identity (`gcs:foundation:gcs-1`), the far end of the C2 path, or null.
 */
export function uasTracksFromSelection(selection) {
  const tracks = new Map();
  for (const product of selection?.products ?? []) {
    const binding = DRONE_BINDINGS.find((name) =>
      product?.product_ref?.type_id?.startsWith(name),
    );
    if (!binding || !Array.isArray(product.values)) continue;
    for (const row of product.values) {
      const at = Date.parse(row?.valid_time);
      if (!Number.isFinite(at)) continue;
      const identity = String(row.semantic_identity ?? '');
      const key = `${binding}\0${identity}`;
      if (!tracks.has(key))
        tracks.set(key, {
          identity,
          binding,
          callsign:
            typeof row.series_key?.callsign === 'string' &&
            row.series_key.callsign
              ? row.series_key.callsign
              : null,
          header: product.semantic_metadata ?? null,
          gcs:
            typeof row.series_key?.gcs === 'string' ? row.series_key.gcs : null,
          rows: [],
        });
      const value = row.value ?? {};
      const lon = finiteOrNull(value.lon_deg);
      const lat = finiteOrNull(value.lat_deg);
      const height = finiteOrNull(value.height_m);
      tracks.get(key).rows.push({
        at,
        validTime: row.valid_time,
        position:
          lon !== null && lat !== null && height !== null
            ? { lon, lat, height }
            : null,
        ...uasValuesOf(value),
        ...(binding === DRONE_TRACK_BINDING
          ? {
              speedMps: finiteOrNull(value.speed_mps),
              headingDeg: finiteOrNull(value.heading_deg),
            }
          : {}),
      });
    }
  }
  return [...tracks.values()].map((track) => ({
    ...track,
    rows: track.rows.sort((a, b) => a.at - b.at),
  }));
}

/** The stored row at or before `ms` (the last one after the run); null before it. */
export function storedRowAt(rows, ms) {
  if (!Array.isArray(rows) || !rows.length || !Number.isFinite(ms)) return null;
  if (ms < rows[0].at) return null;
  let found = rows[0];
  for (const row of rows) {
    if (row.at > ms) break;
    found = row;
  }
  return found;
}

/** Ground distance in metres between two positions (small-angle, fine for 5 s chords). */
function groundM(a, b) {
  const R = 6_371_008.8;
  const lat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  let dLon = b.lon - a.lon;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  const x = ((dLon * Math.PI) / 180) * Math.cos(lat) * R;
  const y = (((b.lat - a.lat) * Math.PI) / 180) * R;
  return Math.hypot(x, y);
}

/** The bearing of the chord from row i to row i+1, or null when it barely moves. */
function chordBearing(rows, i) {
  const a = rows[i]?.position;
  const b = rows[i + 1]?.position;
  if (!a || !b || groundM(a, b) < DRONE_DISPLAY.minChordM) return null;
  return bearingBetweenCoordinates(a.lat, a.lon, b.lat, b.lon);
}

/**
 * The heading segment i is drawn with: its own chord's bearing; while the
 * drone hovers (climbing, holding, landing) the last bearing it flew; before
 * it has flown, the first bearing it will fly. Null for a drone that never
 * moves sideways.
 */
function segmentHeading(rows, i) {
  for (let k = i; k >= 0; k--) {
    const bearing = chordBearing(rows, k);
    if (bearing !== null) return bearing;
  }
  for (let k = i + 1; k < rows.length - 1; k++) {
    const bearing = chordBearing(rows, k);
    if (bearing !== null) return bearing;
  }
  return null;
}

/**
 * Which way the drawn drone points at `ms`: its segment's heading, eased from
 * the segment before over the first `DRONE_DISPLAY.turnFraction` of it so a
 * corner turns rather than snaps. Null outside the run or with no heading.
 */
export function headingAt(rows, ms) {
  if (!Array.isArray(rows) || rows.length < 2 || !Number.isFinite(ms))
    return null;
  if (ms < rows[0].at || ms > rows.at(-1).at) return null;
  let i = 0;
  while (i < rows.length - 2 && rows[i + 1].at <= ms) i++;
  const heading = segmentHeading(rows, i);
  if (heading === null || i === 0) return heading;
  const before = segmentHeading(rows, i - 1);
  const span = rows[i + 1].at - rows[i].at;
  const f = span > 0 ? (ms - rows[i].at) / span : 1;
  if (before === null || f >= DRONE_DISPLAY.turnFraction) return heading;
  return lerpAngleDeg(before, heading, f / DRONE_DISPLAY.turnFraction);
}

/**
 * Where the drawn drone is at `ms`: `{lon, lat, height, headingDeg}` on the
 * chord between its stored epochs (geometry only), or null outside the run
 * and across a gap.
 */
export function displayPoseAt(rows, ms) {
  const at = positionAt(rows, ms);
  if (!at) return null;
  return {
    lon: at.lon,
    lat: at.lat,
    height: at.height,
    headingDeg: headingAt(rows, ms),
  };
}

/** Every stored row whose mode differs from the row before: where the drone held, turned home, landed. */
export function modeChanges(rows) {
  const changes = [];
  for (let i = 1; i < (rows?.length ?? 0); i++) {
    const row = rows[i];
    if (row.modeCode === null || row.modeCode === rows[i - 1].modeCode)
      continue;
    if (!row.position) continue;
    changes.push(row);
  }
  return changes;
}

/** The C2 state's display colour, by the state's NAME in the product's legend. */
export function c2Colour(header, code) {
  const name = header?.c2_state_codes?.[String(code)];
  const state =
    Object.values(RECEIVER_STATES).find((s) => s.name === name) ??
    RECEIVER_STATES[4];
  return state.colorRgb;
}

/** The drone's callsign when it has one; else `platform:foundation:uas-1` -> `UAS-1`. */
export function droneName(identity, callsign = null) {
  if (typeof callsign === 'string' && callsign) return callsign;
  const tail = String(identity || '')
    .split(':')
    .at(-1);
  return tail ? tail.toUpperCase() : 'UAS';
}

/**
 * Drones per revision: a revision is immutable, so its track is read once and
 * shared by every step through the run. A source without `select` has none.
 */
export function createUasTracks(source) {
  const cache = new Map(); // revisionId -> Promise<tracks>
  return {
    async read({ revisionId } = {}) {
      if (typeof source?.select !== 'function' || !revisionId) return [];
      if (!cache.has(revisionId)) {
        const pending = source
          .select({ revisionId, query: uasQuery() })
          .then(uasTracksFromSelection);
        cache.set(revisionId, pending);
        pending.catch(() => cache.delete(revisionId));
      }
      return cache.get(revisionId);
    },
  };
}

const shared = new WeakMap(); // source -> reader

/** One reader per source: the layer and the render panel (GEN-369) read a run's track once. */
export function sharedUasTracks(source) {
  if (!source || typeof source !== 'object') return createUasTracks(source);
  let reader = shared.get(source);
  if (!reader) {
    reader = createUasTracks(source);
    shared.set(source, reader);
  }
  return reader;
}
