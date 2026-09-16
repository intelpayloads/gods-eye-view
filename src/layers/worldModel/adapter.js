/**
 * Projection adapter: neutral-v1 items -> render records.
 *
 * Pure and Cesium-free. Every record keeps the projected item verbatim
 * (`record`), so semantic refs, source refs, times and the height reading
 * survive into picking and inspection. The adapter adds DISPLAY choices
 * (a colour, a pixel size, clamp-to-ground) next to the numbers; it never
 * rewrites a numeric field, smooths a position, or invents a height.
 *
 * Nothing here knows a provider: a point is a point whatever binding it
 * came from, colour is keyed by the binding name, and the card reads the
 * item's own `semantic_identity`, `properties` and grants.
 */

/**
 * Every display-only choice this adapter or the layer makes, named so an
 * inspector can show "what the renderer added" apart from "what the world
 * model said". Numeric truth lives in `record`; these never overwrite it.
 */
export const DISPLAY_CHOICES = Object.freeze({
  point: Object.freeze({
    kind: 'point',
    pixelSize: 7,
    alpha: 1,
    positionSmoothing: 'none',
    heightOffsetM: 0,
    colour: 'by-binding',
  }),
  // A point the backplane MARKED stale under the view's temporal_age policy
  // (`time.stale === true`): drawn smaller and dimmer, never moved or hidden.
  'point-stale': Object.freeze({
    kind: 'point',
    pixelSize: 5,
    alpha: 0.35,
    positionSmoothing: 'none',
    heightOffsetM: 0,
    colour: 'by-binding-dimmed',
    keyedBy: 'time.stale',
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

/** Small palette for point bindings; a binding's colour is stable across sessions (hash), never a provider rule. */
export const BINDING_PALETTE = Object.freeze([
  Object.freeze([0.0, 1.0, 1.0]), // cyan
  Object.freeze([1.0, 0.6, 0.0]), // orange
  Object.freeze([0.6, 1.0, 0.4]), // lime
  Object.freeze([1.0, 0.4, 0.8]), // pink
  Object.freeze([0.7, 0.7, 1.0]), // periwinkle
  Object.freeze([1.0, 1.0, 0.4]), // yellow
]);

function isFinite3(...values) {
  return values.every((value) => Number.isFinite(value));
}

/** FNV-1a over the binding name -> palette index. Deterministic, order-free. */
export function bindingColor(binding, palette = BINDING_PALETTE) {
  const text = String(binding || '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return palette[hash % palette.length];
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
 * Points -> render records (any binding: aircraft, vessels, a synthetic
 * third product; the adapter does not care).
 * @param {object} projection neutral-v1 projection
 * @returns {{records: Array<object>, skipped: Array<{id: string, reason: string}>}}
 */
export function pointRecordsFromProjection(projection) {
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
    const stale = point?.time?.stale === true;
    records.push({
      id,
      kind: 'point',
      binding: typeof point.binding === 'string' ? point.binding : '',
      longitude,
      latitude,
      height,
      stale,
      colorRgb: bindingColor(point.binding),
      display: stale ? DISPLAY_CHOICES['point-stale'] : DISPLAY_CHOICES.point,
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
export function fieldSampleRecordsFromProjection(projection) {
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
      binding: typeof sample.binding === 'string' ? sample.binding : '',
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

/** Items per binding, per kind: what the log line and the stats row say. */
export function countByBinding(records) {
  const counts = new Map();
  for (const record of records) {
    const key = record.binding || '?';
    const entry = counts.get(key) || { points: 0, samples: 0 };
    if (record.kind === 'field-sample') entry.samples++;
    else entry.points++;
    counts.set(key, entry);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([binding, entry]) => ({ binding, ...entry }));
}

/** Counts and the explanatory lists a status row or inspector shows. */
export function summarizeProjection(projection) {
  const counts = projection?.counts || {};
  const assumptions = [...(projection?.assumptions || [])];
  const omissions = [...(projection?.omissions || [])];
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
      assumptions: Number(counts.assumptions ?? assumptions.length),
      omissions: Number(counts.omissions ?? omissions.length),
    },
    annotations: (projection?.annotations || []).map((a) =>
      String(a?.text || ''),
    ),
    assumptions,
    omissions,
    // What the backplane did with the view's policies: applied (with counts) or dropped (with a reason).
    policies: assumptions.filter(
      (a) =>
        a?.kind === 'projection-policy' || a?.kind === 'policy-not-applicable',
    ),
    withheld: omissions
      .filter((o) => o?.reason === 'temporal-age-withheld')
      .reduce((sum, o) => sum + Number(o.count || 0), 0),
    marked: (projection?.points || []).filter((p) => p?.time?.stale === true)
      .length,
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

function shortId(value) {
  return typeof value === 'string' ? value.slice(0, 8) : '?';
}

function propertyText(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.trim() || '—';
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

/**
 * One card fragment per property; a plain object is flattened one level
 * (`identity.key icao24`) so no single fragment carries a JSON blob.
 */
function propertyFragments(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(
      ([k, v]) => `${key}.${k} ${propertyText(v)}`,
    );
  }
  return [`${key} ${propertyText(value)}`];
}

/**
 * Longest card line this layer authors, in characters. The overlay host
 * places a card as ONE rectangle and never lets it cover chrome that
 * composites below the host, so a viewport-wide line (a lineage chain, a
 * grant name next to a timestamp) makes the whole card unplaceable and it
 * silently never paints (DWM-60). Facts are therefore authored as short
 * fragments and packed into lines of at most this many characters; the host
 * ellipsizes anything longer as a last resort (`MAX_OVERLAY_LINE_CHARS`).
 */
export const MAX_CARD_LINE_CHARS = 72;
const SEPARATOR = ' · ';
const CONTINUATION = '  ';

/**
 * Pack fragments into card lines: fragments are joined with ` · ` while the
 * line stays within `max`; the next fragment starts a new, indented
 * continuation line. A fragment longer than `max` stands on its own line.
 * @param {Array<string|null|undefined>} fragments
 * @param {number} [max]
 * @returns {string[]}
 */
export function packCardLines(fragments, max = MAX_CARD_LINE_CHARS) {
  const lines = [];
  let line = '';
  for (const fragment of fragments) {
    const text = fragment == null ? '' : String(fragment).trim();
    if (!text) continue;
    if (!line) {
      line = text;
      continue;
    }
    if (line.length + SEPARATOR.length + text.length <= max) {
      line += SEPARATOR + text;
      continue;
    }
    lines.push(line);
    line = CONTINUATION + text;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Lines for the selected card: [title, ...details]. Every line quotes the
 * projection's own numbers and grants; nothing is recomputed. "age" is the
 * product's own (age at product time T); "age at query" is what the view's
 * temporal_age policy computed against the query's valid time.
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
      ...packCardLines([
        'pressure level, not altitude',
        `drawn at ${formatNumber(renderRecord.height)} m (${item.frame || 'map overlay'})`,
      ]),
      ...packCardLines([
        `native lon ${formatNumber(Number(native.lon), 3)} (${native.lon_convention || '?'})`,
        `lat ${formatNumber(Number(native.lat), 3)}`,
      ]),
      ...packCardLines([
        `valid ${time.valid_at || '?'}`,
        `cycle ${time.run_at || '?'}`,
        `lag ${formatNumber(Number(time.lag_seconds))} s`,
      ]),
      ...packCardLines([
        `product ${shortRef(item.semantic_ref?.product_ref)}`,
        `block ${shortRef(item.source_ref?.block_ref)}`,
      ]),
    ];
  }
  const time = item.time || {};
  const height = item.height || {};
  const props =
    item.properties && typeof item.properties === 'object'
      ? item.properties
      : {};
  const identity =
    item.semantic_ref?.semantic_identity || renderRecord?.id || 'item';
  // Opportunistic: a callsign-like property leads the title when present;
  // otherwise the first two properties are shown generically.
  const keys = Object.keys(props);
  const lead = keys.includes('callsign') ? 'callsign' : null;
  const leadText = lead ? propertyText(props[lead]) : '';
  const shown = (lead ? [lead, ...keys.filter((k) => k !== lead)] : keys).slice(
    0,
    lead ? 3 : 2,
  );
  const lines = [
    leadText && leadText !== '—' ? `${leadText} · ${identity}` : identity,
    ...packCardLines([
      item.binding || '?',
      `height ${formatNumber(Number(height.value_m))} m from ${height.source_field || '?'}`,
      Number.isFinite(Number(height.barometric_height_m))
        ? `baro ${formatNumber(Number(height.barometric_height_m))} m`
        : null,
    ]),
    `grant ${height.assumption || 'none'}`,
    ...packCardLines([
      `valid ${time.valid_at || '?'}`,
      time.temporal_status || '?',
      `age at product time ${formatNumber(Number(time.age_seconds))} s`,
    ]),
  ];
  if (time.age_at_query_seconds !== undefined) {
    lines.push(
      `age at query ${formatNumber(Number(time.age_at_query_seconds))} s` +
        (time.stale === true
          ? ' · STALE (view policy)'
          : time.stale === false
            ? ' · within policy'
            : ''),
    );
  }
  lines.push(`known ${time.known_as_of || '?'}`);
  if (shown.length) {
    lines.push(
      ...packCardLines(
        shown
          .filter((k) => k !== lead)
          .flatMap((k) => propertyFragments(k, props[k])),
      ),
    );
  }
  lines.push(
    ...packCardLines([
      `product ${shortRef(item.semantic_ref?.product_ref)}`,
      `source ${shortRef(item.source_ref?.source)} row ${item.source_ref?.row_index ?? '?'}`,
    ]),
  );
  return lines.filter((line) => line !== '');
}

function domainText(domain) {
  if (!domain || typeof domain !== 'object') return '—';
  if (domain.kind === 'instant') return `instant ${domain.at}`;
  if (domain.kind === 'instants') {
    const ats = Array.isArray(domain.at) ? domain.at : [];
    return `${ats.length} instants ${ats[0] ?? '?'}..${ats.at(-1) ?? '?'}`;
  }
  if (domain.kind === 'interval')
    return `interval ${domain.start}..${domain.end}`;
  if (domain.frame) {
    const box = domain.bbox || domain.bbox_native;
    return `${domain.frame}${Array.isArray(box) ? ` bbox ${box.map((v) => formatNumber(Number(v), 2)).join(',')}` : ''}`;
  }
  return JSON.stringify(domain);
}

/**
 * The ADMITTED descriptor, as served in a provenance report, as card lines:
 * semantic type + domains, access kind + dimensions, representations with
 * capabilities and requirements, admission status.
 * @param {object|null|undefined} descriptor `report.descriptors[i]`
 * @returns {string[]}
 */
export function descriptorCardLines(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return [];
  const sem = descriptor.semantic || {};
  const acc = descriptor.access || {};
  const lines = [
    ...packCardLines([
      `descriptor ${shortId(descriptor.id)}`,
      descriptor.status || '?',
      sem.type_id || '?',
    ]),
    ...packCardLines([
      `valid ${domainText(sem.valid_domain)}`,
      `known ${domainText(sem.knowledge_domain)}`,
    ]),
    `spatial ${domainText(sem.spatial_domain)}`,
    ...packCardLines([
      `access ${acc.access_kind || '?'} @ ${acc.access_target || '?'}`,
      `dimensions ${(acc.supported_query_dimensions || []).join(',') || '—'}`,
    ]),
  ];
  for (const rep of descriptor.representations || []) {
    const req = rep.requirements || {};
    const requires = Object.keys(req).map((key) => {
      const value = req[key];
      return value && typeof value === 'object' && !Array.isArray(value)
        ? `${key}{${Object.keys(value).join(',')}}`
        : key;
    });
    lines.push(
      ...packCardLines([
        `representation ${rep.kind || '?'}`,
        `capabilities ${(rep.capabilities || []).join(',') || '—'}`,
        `requires ${requires[0] || '—'}`,
        ...requires.slice(1),
      ]),
    );
  }
  const failed = (descriptor.admission || []).filter(
    (f) => f && f.ok === false,
  );
  lines.push(
    failed.length
      ? `admission failed: ${failed.map((f) => f.check).join(', ')}`
      : `admission ${(descriptor.admission || []).length} checks passed`,
  );
  return lines;
}

/**
 * Lineage from a provenance report: the producing run, the revisions the
 * product is bound in, and the retained source evidence (with the derived
 * chain walked to reach it).
 * @param {object|null|undefined} report `GET /provenance/{ref}`
 * @returns {string[]}
 */
export function lineageCardLines(report) {
  if (!report || typeof report !== 'object') return [];
  const lines = [];
  const run = report.transform_run;
  if (run) {
    lines.push(
      ...packCardLines([
        `produced by ${run.transformation || '?'}`,
        run.status || '?',
        `${(run.inputs || []).length} inputs`,
      ]),
    );
  }
  const bound = report.bound_in || [];
  if (bound.length) {
    lines.push(
      ...packCardLines(
        bound.map(
          (b, i) =>
            `${i === 0 ? 'bound in ' : ''}${b.binding}@${shortId(b.revision_id)}`,
        ),
      ),
    );
  }
  for (const source of (report.sources || []).slice(0, 4)) {
    const ref = shortRef(source.ref);
    // The source type is only news when it differs from the ref's own type.
    const sourceType =
      source.source_type && source.source_type !== source.ref?.type_id
        ? `(${source.source_type})`
        : null;
    const via = (source.via || []).map((r) => shortRef(r));
    lines.push(
      ...packCardLines([
        `source ${ref}`,
        sourceType,
        `connector ${source.connector_instance_id || '?'}`,
        `publication ${shortId(source.publication_id)}`,
        `received ${source.received_at || '?'}`,
        ...(via.length ? [`via ${via.join(' <- ')}`] : []),
      ]),
    );
  }
  if ((report.sources || []).length > 4) {
    lines.push(`… ${report.sources.length - 4} more retained sources`);
  }
  if (report.truncated) lines.push('source walk truncated (depth limit)');
  return lines;
}

/**
 * The inspection block for a selected item: ITS admitted descriptor
 * (`semantic_ref.descriptor_id` looked up in the report) then the lineage.
 * @param {object} item projected item (`record`)
 * @param {object} report provenance report for `item.semantic_ref.product_ref`
 * @returns {string[]}
 */
export function inspectionLines(item, report) {
  const wanted = item?.semantic_ref?.descriptor_id;
  const descriptors = report?.descriptors || [];
  const descriptor =
    descriptors.find((d) => d?.id === wanted) ||
    (wanted ? null : descriptors.at(-1));
  const lines = descriptor
    ? descriptorCardLines(descriptor)
    : wanted
      ? [`descriptor ${shortId(wanted)} not in the provenance report`]
      : [];
  return [...lines, ...lineageCardLines(report)];
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
