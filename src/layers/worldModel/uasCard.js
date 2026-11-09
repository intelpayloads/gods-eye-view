/**
 * The drone's card and map label, in words (GEN-395).
 *
 * A `simulation.uas.track` row carries `mode_code` and `c2_state_code`,
 * numbers whose meaning is the product header's `mode_codes` and
 * `c2_state_codes` legends; the words come from those, never from a copy here.
 * Without a legend the words say so and show the codes.
 *
 * Both read ONE stored row's values (`uasValuesOf`): the card the projected
 * item at the query time, the label the stored row at or before the display
 * time. Neither ever sees an interpolated position or value.
 *
 * Pure and DOM-free.
 */
import { droneName, uasValuesOf } from './uasTrack.js';
import { OBSTRUCTION_KEYS, obstructionLines } from './linkObstruction.js';

/** Row properties the card states in words; the generic value list skips them. */
export const UAS_WORDED = Object.freeze([
  'mode_code',
  'c2_state_code',
  'c2_reason_code',
  'height_agl_m',
  'c2_sinr_db',
  'ground_speed_mps',
  'lost_link_elapsed_s',
  'lost_link_timeout_s',
  ...OBSTRUCTION_KEYS.map((key) => `c2_${key}`),
]);

/** True when a projected item is a drone-track row (a mode and a C2 state). */
export function isUasRow(props) {
  return (
    !!props &&
    Object.hasOwn(props, 'mode_code') &&
    Object.hasOwn(props, 'c2_state_code')
  );
}

function legendName(legend, code) {
  if (code === null || code === undefined || !legend) return null;
  const name = legend[String(code)];
  return typeof name === 'string' && name ? name.replaceAll('_', ' ') : null;
}

function capitalised(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function seconds(value) {
  return `${Math.round(value)} s`;
}

/**
 * `link lost 15 s / 30 s` while the stored row's timer runs, or from the
 * first unavailable epoch (where it reads 0 s); null with the link up.
 */
function lostLinkText(values, words) {
  if (values.lostLinkElapsedS === null) return null;
  if (!(values.lostLinkElapsedS > 0) && words.c2 !== 'unavailable') return null;
  const timeout =
    values.lostLinkTimeoutS !== null
      ? ` / ${seconds(values.lostLinkTimeoutS)}`
      : '';
  return `link lost ${seconds(values.lostLinkElapsedS)}${timeout}`;
}

/** `{mode, c2, reason}` words for one row's values; null where the legend is missing. */
export function uasWords(values, header) {
  return {
    mode: legendName(header?.mode_codes, values.modeCode),
    c2: legendName(header?.c2_state_codes, values.c2StateCode),
    reason: legendName(header?.c2_reason_codes, values.c2ReasonCode),
  };
}

/**
 * The map label for a stored row: two lines, the name and mode, then AGL and
 * the lost-link timer. e.g. `UAS-1 · RETURN ALTITUDE` / `90 m AGL · LINK LOST 40 s / 30 s`.
 */
export function uasLabel(row, header, identity) {
  if (!row) return '';
  const words = uasWords(row, header);
  const mode = words.mode ?? `mode ${row.modeCode ?? '?'}`;
  const second = [
    row.aglM !== null ? `${Math.round(row.aglM)} m AGL` : null,
    lostLinkText(row, words),
  ].filter(Boolean);
  return [
    `${droneName(identity)} · ${mode.toUpperCase()}`,
    second.join(' · ').toUpperCase(),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * What the card says about one drone-track item.
 * @param {object} item A projected item (`properties`, `binding`, `semantic_ref`).
 * @param {object|null} header The binding's descriptor `semantic.metadata`, if read.
 * @returns {{title: string, lead: string, measures: string[], extra: string[]}|null} null for
 *   another item; `extra` is the C2 path's obstruction (GEN-405), none on a run without a surface.
 */
export function uasCard(item, header = null) {
  const props = item?.properties;
  if (!isUasRow(props)) return null;
  const identity = item?.semantic_ref?.semantic_identity || 'uas';
  const values = uasValuesOf(props);
  const words = uasWords(values, header);
  let lead;
  if (words.mode && words.c2) {
    lead = `${capitalised(words.mode)} · C2 ${words.c2}`;
    if (words.reason) lead += ` — ${words.reason}`;
  } else {
    // No legend read: say so rather than guess what the numbers mean.
    lead = `mode ${values.modeCode ?? '?'} · C2 state ${values.c2StateCode ?? '?'} (no legend in the product header)`;
  }
  return {
    title: `${droneName(identity)} (simulated) · ${identity}`,
    lead,
    measures: [
      values.aglM !== null ? `AGL ${values.aglM.toFixed(1)} m` : 'AGL unknown',
      lostLinkText(values, words) ?? 'link up',
      values.sinrDb !== null
        ? `C2 SINR ${values.sinrDb.toFixed(1)} dB`
        : 'C2 SINR unknown',
      values.groundSpeedMps !== null
        ? `ground speed ${values.groundSpeedMps.toFixed(1)} m/s`
        : null,
    ].filter(Boolean),
    extra: obstructionLines(values.c2).map((line, i) =>
      i ? line : `C2 path ${line}`,
    ),
  };
}
