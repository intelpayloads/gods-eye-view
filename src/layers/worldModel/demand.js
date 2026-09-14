/**
 * View demand: what this consumer asks the world model for, and how a camera
 * rectangle, a follow mode and a chain of completed revisions turn into ONE
 * Projection request. Pure and Cesium-free.
 *
 * Interaction semantics (renderer-neutral; the Angular `WorldViewController`
 * satisfies the same rules natively):
 *  - a viewport change produces new demand; it never creates or moves a revision;
 *  - LIVE issues every request against the head's newest completed revision
 *    BY ID, with `valid_at` = the user's explicit time, else the wall clock at
 *    issue time (never derived from bound products);
 *  - PINNED freezes revision, times, grants and policy until the user changes
 *    them; `headAdvanced` is a fact about the chain, not a mode change.
 */

/** @typedef {[number, number, number, number]} Bbox west, south, east, north (degrees) */

/**
 * @typedef {object} ViewDemand
 * @property {string} head
 * @property {'live'|'pinned'} follow
 * @property {string|null} pinnedRevisionId
 * @property {string|null} validAt ISO-8601; null = wall clock at issue time (live)
 * @property {string|null} knownAsOf
 * @property {string[]|null} layers null = every binding of the revision
 * @property {Bbox|null} bbox null = no spatial scope (whole world / horizon in view)
 * @property {Record<string, unknown>|null} predicates
 * @property {Record<string, string>} displayAssumptions
 * @property {Record<string, object>} projectionPolicy
 * @property {number} nonce bumped by refresh() so an identical request is issued again
 */

export const FOLLOW_MODES = Object.freeze(['live', 'pinned']);
export const POLICY_MODES = Object.freeze(['off', 'mark', 'withhold']);

/** A complete demand with defaults; `overrides` wins field by field. */
export function createDemand(overrides = {}) {
  const demand = {
    head: 'world/main',
    follow: 'live',
    pinnedRevisionId: null,
    validAt: null,
    knownAsOf: null,
    layers: null,
    bbox: null,
    predicates: null,
    displayAssumptions: {},
    projectionPolicy: {},
    nonce: 0,
    ...overrides,
  };
  if (!FOLLOW_MODES.includes(demand.follow)) {
    throw new TypeError(`follow must be one of ${FOLLOW_MODES.join('|')}`);
  }
  if (demand.follow === 'pinned' && !demand.pinnedRevisionId) {
    throw new TypeError('a pinned demand needs a pinnedRevisionId');
  }
  return demand;
}

/**
 * A camera view rectangle (degrees) as query demand: rounded OUTWARD to a
 * 0.01 degree grid so sub-pixel camera settles do not issue new requests,
 * clamped to WGS84, widened to all longitudes when the view crosses the
 * antimeridian (the backplane accepts only west <= east), and null when
 * there is no rectangle at all (the horizon is in view: no spatial scope is
 * sent and the stats say so).
 * @param {{west:number,south:number,east:number,north:number}|number[]|null|undefined} rect
 * @param {number} [step]
 * @returns {Bbox|null}
 */
export function demandBbox(rect, step = 0.01) {
  const values = Array.isArray(rect)
    ? rect
    : rect && typeof rect === 'object'
      ? [rect.west, rect.south, rect.east, rect.north]
      : null;
  if (!values || values.length !== 4 || values.some((v) => !Number.isFinite(v)))
    return null;
  const down = (v) => Math.floor(v / step + 1e-9) * step;
  const up = (v) => Math.ceil(v / step - 1e-9) * step;
  const fix = (v) => Math.round(v * 1e6) / 1e6;
  const clamp = (v, limit) => Math.max(-limit, Math.min(limit, v));
  let [west, south, east, north] = values;
  if (west > east) {
    west = -180;
    east = 180;
  }
  return [
    fix(clamp(down(west), 180)),
    fix(clamp(down(south), 90)),
    fix(clamp(up(east), 180)),
    fix(clamp(up(north), 90)),
  ];
}

export function sameBbox(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.length === 4 && a.every((v, i) => v === b[i]);
}

/** Wall clock as the query's valid time: whole seconds, UTC, ISO-8601 `Z`. */
export function wallClockValidAt(nowMs) {
  return new Date(Math.floor(nowMs / 1000) * 1000).toISOString();
}

/**
 * The Projection request for a demand against a chain of completed revisions
 * (newest first), or null while the live revision is not known yet (a
 * head-resolved request would only be re-issued by id a moment later).
 * @param {ViewDemand} demand
 * @param {Array<{id: string}>|null} chain
 * @param {number} nowMs
 */
export function buildRequest(demand, chain, nowMs) {
  let revisionId;
  if (demand.follow === 'pinned') {
    if (!demand.pinnedRevisionId) return null;
    revisionId = demand.pinnedRevisionId;
  } else {
    revisionId = chain?.[0]?.id ?? null;
    if (!revisionId) return null;
  }
  const query = {};
  if (demand.bbox) query.spatial_scope = { bbox: [...demand.bbox] };
  query.valid_at = demand.validAt || wallClockValidAt(nowMs);
  if (demand.knownAsOf) query.known_as_of = demand.knownAsOf;
  if (demand.layers) query.requested_layers = [...demand.layers];
  if (demand.predicates) query.predicates = { ...demand.predicates };
  const projectionSpec = {
    display_assumptions: { ...demand.displayAssumptions },
  };
  if (demand.projectionPolicy && Object.keys(demand.projectionPolicy).length) {
    projectionSpec.projection_policy = clonePolicy(demand.projectionPolicy);
  }
  return { revisionId, query, projectionSpec };
}

function clonePolicy(policy) {
  return Object.fromEntries(
    Object.entries(policy).map(([name, params]) => [name, { ...params }]),
  );
}

/** Stable identity of a request (equal demand -> equal key), for dedupe and tests. */
export function requestKey(request, nonce = 0) {
  return request ? `${JSON.stringify(request)}#${nonce}` : null;
}

/**
 * The layer's `policy` param (`off` | `mark` | `withhold`) as a
 * `projection_policy` block. The threshold is the view's rule; the backplane
 * applies it only to representations that declare `temporal_age`.
 */
export function temporalAgePolicy(mode, thresholdSeconds) {
  if (!POLICY_MODES.includes(mode)) {
    throw new TypeError(`policy must be one of ${POLICY_MODES.join('|')}`);
  }
  if (mode === 'off') return {};
  const threshold = Number(thresholdSeconds);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new TypeError('policy threshold must be a non-negative number');
  }
  return { temporal_age: { mode, threshold_seconds: threshold } };
}

/** Read the layer's `policy` param back out of a demand. */
export function policyModeOf(demand) {
  return demand?.projectionPolicy?.temporal_age?.mode || 'off';
}

/** Short human age: 42s, 7m, 3h, 2d. */
export function formatAge(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds))
    return '—';
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(seconds);
  if (s < 90) return `${sign}${Math.round(s)}s`;
  if (s < 90 * 60) return `${sign}${Math.round(s / 60)}m`;
  if (s < 36 * 3600) return `${sign}${Math.round(s / 3600)}h`;
  return `${sign}${Math.round(s / 86400)}d`;
}
