/**
 * The RF receiver's card, in words (GEN-312).
 *
 * A receiver-track row carries `state_code` and `reason_code`, numbers whose
 * meaning is the product header's `state_codes` and `reason_codes` legends.
 * World Model keeps the header as the descriptor's `semantic.metadata`, so
 * the card names the state and reason from the product it is reading, never
 * from a copy here. Without a legend the card says so and shows the codes.
 *
 * SINR is quoted in dB as served; interference power is served in watts and
 * shown in dBW (10·log10 W), because 1.9e-18 W tells a viewer nothing. The raw
 * codes and watts stay available under provenance.
 *
 * Pure and DOM-free.
 */

/** Row properties this card states in words; the generic value list skips them. */
export const RECEIVER_WORDED = Object.freeze([
  'state_code',
  'reason_code',
  'sinr_db',
  'interference_power_w',
  'available',
]);

/** True when a projected item is a receiver-track row (it carries a state code). */
export function isReceiverRow(props) {
  return !!props && Object.hasOwn(props, 'state_code');
}

function words(name) {
  return String(name).replaceAll('_', ' ');
}

function capitalised(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function legendName(legend, code) {
  if (code === null || code === undefined || !legend) return null;
  const name = legend[String(code)];
  return typeof name === 'string' && name ? name : null;
}

/** Watts -> "-177.2 dBW"; zero is no interference, null is unknown. */
export function dbwText(watts) {
  if (watts === null || watts === undefined || watts === '')
    return 'interference unknown';
  const w = Number(watts);
  if (!Number.isFinite(w)) return 'interference unknown';
  if (w <= 0) return 'no interference';
  return `interference ${(10 * Math.log10(w)).toFixed(1)} dBW`;
}

function sinrText(db) {
  if (db === null || db === undefined || db === '') return 'SINR unknown';
  const value = Number(db);
  return Number.isFinite(value)
    ? `SINR ${value.toFixed(1)} dB`
    : 'SINR unknown';
}

/**
 * What the card says about one receiver-track item.
 * @param {object} item A projected item (`properties`, `binding`, `semantic_ref`).
 * @param {object|null} header The binding's descriptor `semantic.metadata`, if read.
 * @returns {{title: string, lead: string, measures: string[]}|null} null for a non-receiver item.
 */
export function receiverCard(item, header = null) {
  const props = item?.properties;
  if (!isReceiverRow(props)) return null;
  const identity = item?.semantic_ref?.semantic_identity || 'receiver';
  const simulated = String(item?.binding || '').startsWith('simulation.');
  const state = legendName(header?.state_codes, props.state_code);
  const reason = legendName(header?.reason_codes, props.reason_code);
  let lead;
  if (state) {
    lead = capitalised(words(state));
    if (reason) lead += ` — ${words(reason)}`;
    else if (props.reason_code !== null && props.reason_code !== undefined)
      lead += ` — reason ${props.reason_code}`;
  } else {
    // No legend read: say so rather than guess what the numbers mean.
    lead = `state ${props.state_code ?? '?'} · reason ${props.reason_code ?? '?'} (no legend in the product header)`;
  }
  return {
    title: simulated ? `${identity} (simulated)` : identity,
    lead,
    measures: [sinrText(props.sinr_db), dbwText(props.interference_power_w)],
  };
}

/** The raw values the worded card replaced, for provenance. */
export function receiverRawFragments(item) {
  const props = item?.properties;
  if (!isReceiverRow(props)) return [];
  return RECEIVER_WORDED.filter((k) => Object.hasOwn(props, k)).map(
    (k) =>
      `${k} ${props[k] === null || props[k] === undefined ? '—' : props[k]}`,
  );
}

/**
 * One revision's descriptor headers by binding (`semantic.metadata`); {} when
 * the source cannot serve a revision.
 */
export async function revisionHeaders(source, revisionId) {
  if (typeof source?.getRevision !== 'function' || !revisionId) return {};
  const revision = await source.getRevision({ revisionId });
  const out = {};
  for (const [binding, descriptor] of Object.entries(
    revision?.descriptors ?? {},
  ))
    out[binding] = descriptor?.semantic?.metadata ?? null;
  return out;
}
