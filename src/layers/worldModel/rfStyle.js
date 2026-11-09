/**
 * The jammer and its path to the receiver, drawn so they read as an attack
 * (GEN-311).
 *
 * `simulation.rf.emitters` is the site with an `active` flag per epoch, and
 * `simulation.rf.links` one LineString per instant from the site to the
 * receiver with the path's `reason`. Both arrive from the projection as
 * ordinary items; this module only decides how they look, from the row's
 * own `active` and `reason`, never from a recomputed geometry:
 *
 *  - an active emitter is red, larger, and pulses; a silent one is dim;
 *  - a clear path (`free_space`, `unknown_eirp`) is a solid beam coloured by
 *    the received jammer power, or amber when that power is unknown;
 *  - a blocked path (`earth_occulted`, `below_horizon_mask`) is dashed grey;
 *  - a path with nothing on it (`inactive`, `zero_eirp`) is faint.
 *
 * Over a pinned lidar surface (GEN-404, GEN-405) a path also says whether a
 * building, tree or the terrain obstructs it (`linkObstruction.js`): an
 * obstructed path that still reaches (`diffracted`) is a dashed beam, still
 * coloured by the power it delivers, and a silent jammer's obstructed path is
 * faint and dashed, so the shield shows before the jammer keys. Obstruction
 * is read from `obstructed`, never from `reason`.
 *
 * The link carries the received jammer power, not J/S (J/S is the coverage
 * field's variable, GEN-307), so the beam's colour is that power in dBW.
 *
 * Pure and Cesium-free; the layer turns these into entities.
 */

import { EMITTER_BINDING } from './runTimeline.js';
import { OBSTRUCTION_STATES, obstructionOf } from './linkObstruction.js';

export { EMITTER_BINDING };
export const LINK_BINDING = 'simulation.rf.links';

/** Received jammer power the beam ramp spans, dBW; outside is clamped for colour only. */
export const LINK_POWER_RAMP_DBW = Object.freeze({ min: -190, max: -150 });

const RED = Object.freeze([1.0, 0.22, 0.18]);
const GREY = Object.freeze([0.62, 0.62, 0.66]);
const AMBER = Object.freeze([1.0, 0.7, 0.0]);

/** Every look this module chooses, named so an inspector can show what the renderer added. */
export const RF_DISPLAY = Object.freeze({
  'emitter-active': Object.freeze({
    kind: 'emitter',
    pixelSize: 12,
    alpha: 1,
    pulse: Object.freeze({
      periodS: 1.6,
      minRadiusM: 30_000,
      maxRadiusM: 160_000,
    }),
    colour: 'jammer-red',
    keyedBy: 'properties.active',
  }),
  'emitter-silent': Object.freeze({
    kind: 'emitter',
    pixelSize: 8,
    alpha: 0.35,
    pulse: null,
    colour: 'jammer-red-dimmed',
    keyedBy: 'properties.active',
  }),
  'link-clear': Object.freeze({
    kind: 'link',
    widthPx: 3,
    alpha: 0.95,
    dashed: false,
    colour: 'received-power-dbw-ramp',
    arc: 'straight-line-of-sight',
    keyedBy: 'properties.reason',
  }),
  'link-diffracted': Object.freeze({
    kind: 'link',
    widthPx: 3,
    alpha: 0.9,
    dashed: true,
    colour: 'received-power-dbw-ramp',
    arc: 'straight-line-of-sight',
    keyedBy: 'properties.obstructed',
  }),
  'link-power-unknown': Object.freeze({
    kind: 'link',
    widthPx: 2,
    alpha: 0.9,
    dashed: true,
    colour: 'amber',
    arc: 'straight-line-of-sight',
    keyedBy: 'properties.reason',
  }),
  'link-blocked': Object.freeze({
    kind: 'link',
    widthPx: 2,
    alpha: 0.6,
    dashed: true,
    colour: 'grey',
    arc: 'straight-line-of-sight',
    keyedBy: 'properties.reason',
  }),
  'link-idle': Object.freeze({
    kind: 'link',
    widthPx: 1,
    alpha: 0.15,
    dashed: false,
    colour: 'grey',
    arc: 'straight-line-of-sight',
    keyedBy: 'properties.reason',
  }),
  'link-idle-obstructed': Object.freeze({
    kind: 'link',
    widthPx: 1,
    alpha: 0.4,
    dashed: true,
    colour: 'grey',
    arc: 'straight-line-of-sight',
    keyedBy: 'properties.obstructed',
  }),
});

const CLEAR = new Set(['free_space']);
const BLOCKED = new Set(['earth_occulted', 'below_horizon_mask']);
const IDLE = new Set(['inactive', 'zero_eirp']);

/** Received power in dBW, or null when the row has none (0 W reaches nothing). */
export function receivedDbw(watts) {
  if (watts === null || watts === undefined || watts === '') return null;
  const w = Number(watts);
  return Number.isFinite(w) && w > 0 ? 10 * Math.log10(w) : null;
}

/** Yellow (weak) to red (strong) over LINK_POWER_RAMP_DBW. */
export function linkPowerColor(dbw, ramp = LINK_POWER_RAMP_DBW) {
  if (!Number.isFinite(dbw)) return [...GREY];
  const t = Math.min(
    1,
    Math.max(0, (dbw - ramp.min) / (ramp.max - ramp.min || 1)),
  );
  const weak = [1.0, 0.92, 0.3];
  return [0, 1, 2].map((i) => weak[i] + (RED[i] - weak[i]) * t);
}

/**
 * How one link row looks.
 * @param {object} props The link's projected properties (`reason`,
 *   `received_power_w`, and over a surface its obstruction columns).
 * @returns {{display: object, colorRgb: number[], label: string, obstruction: object}}
 */
export function linkStyle(props) {
  const obstruction = obstructionOf(props);
  return { ...pathStyle(props, obstruction), obstruction };
}

function pathStyle(props, obstruction) {
  const reason = String(props?.reason ?? '');
  const obstructed = obstruction.state === OBSTRUCTION_STATES.obstructed;
  const loss =
    obstruction.lossDb === null ? '' : ` ${obstruction.lossDb.toFixed(0)} dB`;
  if (obstructed && (reason === 'diffracted' || CLEAR.has(reason))) {
    const dbw = receivedDbw(props?.received_power_w);
    return {
      display: RF_DISPLAY['link-diffracted'],
      colorRgb: dbw === null ? [...AMBER] : linkPowerColor(dbw),
      label: `obstructed${loss} · ${dbw === null ? 'power unknown' : `${dbw.toFixed(1)} dBW at receiver`}`,
    };
  }
  if (CLEAR.has(reason)) {
    const dbw = receivedDbw(props?.received_power_w);
    return dbw === null
      ? {
          display: RF_DISPLAY['link-power-unknown'],
          colorRgb: [...AMBER],
          label: 'clear path · power unknown',
        }
      : {
          display: RF_DISPLAY['link-clear'],
          colorRgb: linkPowerColor(dbw),
          label: `clear path · ${dbw.toFixed(1)} dBW at receiver`,
        };
  }
  if (reason === 'unknown_eirp')
    return {
      display: RF_DISPLAY['link-power-unknown'],
      colorRgb: [...AMBER],
      label: 'clear path · emitter power unknown',
    };
  if (BLOCKED.has(reason))
    return {
      display: RF_DISPLAY['link-blocked'],
      colorRgb: [...GREY],
      label: `blocked · ${reason.replaceAll('_', ' ')}`,
    };
  if (IDLE.has(reason)) {
    const idle = reason === 'inactive' ? 'jammer silent' : 'no emitted power';
    return obstructed
      ? {
          display: RF_DISPLAY['link-idle-obstructed'],
          colorRgb: [...GREY],
          label: `${idle} · path obstructed${loss}`,
        }
      : { display: RF_DISPLAY['link-idle'], colorRgb: [...GREY], label: idle };
  }
  // An unnamed reason is shown, never hidden: it is a path we cannot classify.
  return {
    display: RF_DISPLAY['link-blocked'],
    colorRgb: [...GREY],
    label: reason ? `path ${reason}` : 'path reason unknown',
  };
}

/**
 * How one emitter row looks. `active` null is unknown: drawn like a silent
 * site (no pulse), and labelled as unknown, never as on.
 * @param {object} props The emitter's projected properties (`active`).
 * @param {string} identity Its semantic identity, the label.
 */
export function emitterStyle(props, identity) {
  const active = props?.active === true;
  const state =
    props?.active === true
      ? 'active'
      : props?.active === false
        ? 'silent'
        : 'activity unknown';
  return {
    display: RF_DISPLAY[active ? 'emitter-active' : 'emitter-silent'],
    colorRgb: [...RED],
    active,
    label: `${identity || 'emitter'} · ${state}`,
  };
}

/** The pulse ring's radius at time `seconds`, or null when the emitter does not pulse. */
export function pulseRadiusM(display, seconds) {
  const pulse = display?.pulse;
  if (!pulse) return null;
  const phase = ((seconds % pulse.periodS) + pulse.periodS) % pulse.periodS;
  return (
    pulse.minRadiusM +
    (pulse.maxRadiusM - pulse.minRadiusM) * (phase / pulse.periodS)
  );
}
