/**
 * Projection adapter: neutral-v1 items -> render records.
 *
 * Pure and Cesium-free. Every record keeps the projected item verbatim
 * (`record`), so semantic refs, source refs, times and the height reading
 * survive into picking and inspection. The adapter adds DISPLAY choices
 * (a colour, a pixel size, clamp-to-ground) next to the numbers; it never
 * rewrites a numeric field, smooths a position, or invents a height.
 */

/**
 * Every display-only choice this adapter or the layer makes, named so an
 * inspector can show "what the renderer added" apart from "what the world
 * model said". Numeric truth lives in `record`; these never overwrite it.
 */
export const DISPLAY_CHOICES = Object.freeze({
  aircraft: Object.freeze({
    kind: 'aircraft',
    pixelSize: 7,
    positionSmoothing: 'none',
    heightOffsetM: 0,
    colour: 'fixed-cyan',
  }),
  'field-sample': Object.freeze({
    kind: 'field-sample',
    pixelSize: 9,
    clampToGround: true,
    depthTest: false,
    heightOffsetM: 0,
    colour: 'kelvin-ramp',
  }),
});

/** Kelvin range the display ramp spans; values outside are clamped for colour only. */
export const TEMPERATURE_RAMP_K = Object.freeze({ min: 270, max: 305 });

const RAMP_STOPS = Object.freeze([
  Object.freeze([0.16, 0.38, 1.0]), // cold: blue
  Object.freeze([0.98, 0.9, 0.25]), // mid: yellow
  Object.freeze([1.0, 0.24, 0.12]), // warm: red
]);

function isFinite3(...values) {
  return values.every((value) => Number.isFinite(value));
}

/**
 * Display colour for a temperature. Colour is lossy by design; the sample's
 * `value`/`units` remain the authoritative numbers.
 * @param {number} valueK
 * @param {{min: number, max: number}} [ramp]
 * @returns {[number, number, number]} RGB in 0..1
 */
export function temperatureColor(valueK, ramp = TEMPERATURE_RAMP_K) {
  if (!Number.isFinite(valueK)) return [0.6, 0.6, 0.6];
  const span = ramp.max - ramp.min || 1;
  const t = Math.min(1, Math.max(0, (valueK - ramp.min) / span));
  const [a, b, local] =
    t < 0.5
      ? [RAMP_STOPS[0], RAMP_STOPS[1], t * 2]
      : [RAMP_STOPS[1], RAMP_STOPS[2], (t - 0.5) * 2];
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * local);
}

/** Strict numeric read: null/undefined/'' are NOT zero, they are missing. */
function numberOrNaN(value) {
  if (value === null || value === undefined || value === '') return Number.NaN;
  return typeof value === 'number' ? value : Number(value);
}

function positionOf(item) {
  const position = item?.position;
  return {
    longitude: numberOrNaN(position?.lon),
    latitude: numberOrNaN(position?.lat),
    height: numberOrNaN(position?.height_m),
  };
}

/**
 * Aircraft points -> render records.
 * @param {object} projection neutral-v1 projection
 * @returns {{records: Array<object>, skipped: Array<{id: string, reason: string}>}}
 */
export function aircraftRecordsFromProjection(projection) {
  const records = [];
  const skipped = [];
  for (const point of projection?.points || []) {
    const id = typeof point?.id === 'string' ? point.id : '';
    if (!id) {
      skipped.push({ id: '', reason: 'missing-id' });
      continue;
    }
    const { longitude, latitude, height } = positionOf(point);
    if (!isFinite3(longitude, latitude, height)) {
      skipped.push({ id, reason: 'non-finite-position' });
      continue;
    }
    records.push({
      id,
      kind: 'aircraft',
      longitude,
      latitude,
      height,
      display: DISPLAY_CHOICES.aircraft,
      record: point,
    });
  }
  return { records, skipped };
}

/**
 * Field samples -> render records. The backend already placed the sample at
 * display height 0 under an explicit grant; the adapter only adds a colour.
 * @param {object} projection neutral-v1 projection
 * @returns {{records: Array<object>, skipped: Array<{id: string, reason: string}>}}
 */
export function weatherRecordsFromProjection(projection) {
  const records = [];
  const skipped = [];
  for (const sample of projection?.field_samples || []) {
    const id = typeof sample?.id === 'string' ? sample.id : '';
    if (!id) {
      skipped.push({ id: '', reason: 'missing-id' });
      continue;
    }
    const { longitude, latitude, height } = positionOf(sample);
    const value = numberOrNaN(sample?.value);
    if (!isFinite3(longitude, latitude, height)) {
      skipped.push({ id, reason: 'non-finite-position' });
      continue;
    }
    if (!Number.isFinite(value)) {
      skipped.push({ id, reason: 'non-finite-value' });
      continue;
    }
    records.push({
      id,
      kind: 'field-sample',
      longitude,
      latitude,
      height,
      value,
      units: typeof sample.units === 'string' ? sample.units : '',
      colorRgb: temperatureColor(value),
      display: DISPLAY_CHOICES['field-sample'],
      record: sample,
    });
  }
  return { records, skipped };
}

/** Counts and the explanatory lists a status row or inspector shows. */
export function summarizeProjection(projection) {
  const counts = projection?.counts || {};
  return {
    revisionId: projection?.revision_id || null,
    counts: {
      points: Number(counts.points ?? projection?.points?.length ?? 0),
      field_samples: Number(
        counts.field_samples ?? projection?.field_samples?.length ?? 0,
      ),
      annotations: Number(
        counts.annotations ?? projection?.annotations?.length ?? 0,
      ),
      assumptions: Number(
        counts.assumptions ?? projection?.assumptions?.length ?? 0,
      ),
      omissions: Number(counts.omissions ?? projection?.omissions?.length ?? 0),
    },
    annotations: (projection?.annotations || []).map((a) =>
      String(a?.text || ''),
    ),
    assumptions: [...(projection?.assumptions || [])],
    omissions: [...(projection?.omissions || [])],
  };
}

/** `type@sha256:abcdef12` -> short, readable reference text. */
export function shortRef(ref) {
  if (!ref || typeof ref !== 'object') return '';
  const typeId = ref.type_id ? String(ref.type_id) : '';
  const contentId = ref.content_id ? String(ref.content_id) : '';
  const digest = contentId.replace(/^sha256:/, '').slice(0, 8);
  return digest ? `${typeId}@${digest}` : typeId;
}

function formatNumber(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : '?';
}

/**
 * Lines for the selected card: [title, ...details]. Every line quotes the
 * projection's own numbers and grants; nothing is recomputed.
 * @param {object} renderRecord A record from the functions above.
 * @returns {string[]}
 */
export function selectionCardLines(renderRecord) {
  const item = renderRecord?.record || {};
  if (renderRecord?.kind === 'field-sample') {
    const time = item.time || {};
    const native = item.native || {};
    return [
      `${formatNumber(Number(item.value), 2)} ${item.units || ''} ${item.variable || 'field'} @ ${formatNumber(Number(item.pressure_hpa))} hPa`.trim(),
      `pressure level, not altitude · drawn at ${formatNumber(renderRecord.height)} m (${item.frame || 'map overlay'})`,
      `native lon ${formatNumber(Number(native.lon), 3)} (${native.lon_convention || '?'}) · lat ${formatNumber(Number(native.lat), 3)}`,
      `valid ${time.valid_at || '?'} · cycle ${time.run_at || '?'} · lag ${formatNumber(Number(time.lag_seconds))} s`,
      `product ${shortRef(item.semantic_ref?.product_ref)} · block ${shortRef(item.source_ref?.block_ref)}`,
    ];
  }
  const time = item.time || {};
  const height = item.height || {};
  const props = item.properties || {};
  const callsign =
    typeof props.callsign === 'string' ? props.callsign.trim() : '';
  const identity =
    item.semantic_ref?.semantic_identity || renderRecord?.id || 'aircraft';
  return [
    callsign ? `${callsign} · ${identity}` : identity,
    `height ${formatNumber(Number(height.value_m))} m from ${height.source_field || '?'} (${height.assumption || 'no grant'})` +
      (Number.isFinite(Number(height.barometric_height_m))
        ? ` · baro ${formatNumber(Number(height.barometric_height_m))} m`
        : ''),
    `valid ${time.valid_at || '?'} · ${time.temporal_status || '?'} · age ${formatNumber(Number(time.age_seconds))} s`,
    `known ${time.known_as_of || '?'}`,
    `product ${shortRef(item.semantic_ref?.product_ref)} · source ${shortRef(item.source_ref?.source)} row ${item.source_ref?.row_index ?? '?'}`,
  ];
}

/**
 * Shared context-store metadata for one render record (what voice / the
 * selection slot see). `properties` carries the refs verbatim.
 */
export function contextRecordFor(
  renderRecord,
  { layerId, layerName, source, revisionId, dataSource = null } = {},
) {
  const item = renderRecord.record || {};
  const lines = selectionCardLines(renderRecord);
  const common = {
    kind: renderRecord.kind,
    revision_id: revisionId ?? null,
    binding: item.binding ?? null,
    semantic_ref: item.semantic_ref ?? null,
    source_ref: item.source_ref ?? null,
    time: item.time ?? null,
    display: renderRecord.display,
  };
  const specific =
    renderRecord.kind === 'field-sample'
      ? {
          value: item.value,
          units: item.units,
          variable: item.variable,
          pressure_hpa: item.pressure_hpa,
          vertical: item.vertical,
          native: item.native ?? null,
          frame: item.frame,
        }
      : {
          height: item.height ?? null,
          frame: item.frame,
          properties: item.properties ?? null,
        };
  return {
    id: renderRecord.id,
    layerId,
    layerName,
    source,
    dataSource,
    label: lines[0],
    latitude: renderRecord.latitude,
    longitude: renderRecord.longitude,
    properties: { ...common, ...specific },
  };
}
