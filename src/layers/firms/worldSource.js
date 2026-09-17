/**
 * The fires layer's world adapter: the snapshot `createFirmsSource` returns
 * from `/api/firms`, read from the world model instead. The world model's
 * `firms` connector retains NASA FIRMS' three VIIRS feeds (NOAA-20, NOAA-21,
 * Suomi NPP) as three bindings of one product type
 * (`fire.detection_set.v1` on `world.fires.viirs_noaa20`, `_noaa21` and
 * `_snpp`), so one projection request names the type and the three bindings
 * and merges them the way the proxy merged the three sources: independent
 * satellites, no cross-source dedup.
 *
 * Fire detections are surface entities: the product declares no height, the
 * projector emits 2-D points and no display assumption is granted. The
 * trailing 24 h the proxy clamped to (`filterTrailing24h`) is sent as the
 * view's `temporal_age` policy (`withhold`, 86,400 s against the wall-clock
 * valid time), so the backplane withholds older detections and reports how
 * many; nothing is re-filtered here.
 *
 * Each projected point becomes the record `parseFirmsCsv` produces for the
 * same CSV row (the product carries the cells as written: `confidence` raw,
 * `acq_date` / `acq_time` raw, `satellite`, `instrument`), so
 * `adaptFirmsRecords`, `fireDetectionKey` and the whole layer render and
 * select unchanged. `fetchedAt` is the newest knowledge time among the
 * points (when the world model received the CSV): the layer's "data age",
 * as the proxy's fetch time was. `stale` is that time older than an hour.
 * `sources` lists the three feeds with their counts; a feed is `ok` when
 * the projection mentions its binding (points or the policy echo), so a
 * feed the world model has not bound reads `ok: false, count: 0` like a
 * failed upstream source did.
 */
import { wallClockValidAt } from '../worldModel/demand.js';
import {
  cleanText,
  coordinates,
  finite,
  LiveSourceError,
} from '../../sources/live/contract.js';

export const FIRE_PRODUCT_TYPE = 'fire.detection_set.v1';
/** binding -> FIRMS source name, the order the proxy fetched them in. */
export const FIRE_FEEDS = Object.freeze({
  'world.fires.viirs_noaa20': 'VIIRS_NOAA20_NRT',
  'world.fires.viirs_noaa21': 'VIIRS_NOAA21_NRT',
  'world.fires.viirs_snpp': 'VIIRS_SNPP_NRT',
});
export const FIRE_BINDINGS = Object.freeze(Object.keys(FIRE_FEEDS));
/** The proxy's trailing window, as a projection policy. */
export const FIRE_WINDOW_SECONDS = 24 * 3600;
export const WORLD_FIRMS_SOURCE_LABEL = 'World model (NASA FIRMS)';
export const WORLD_FIRMS_COVERAGE = `world model projection (${FIRE_BINDINGS.join(', ')}; trailing ${FIRE_WINDOW_SECONDS / 3600} h by policy)`;
/** A snapshot whose newest receipt is older than this is stale (the proxy's TTL was 30 min). */
const STALE_AFTER_MS = 60 * 60_000;

/** ISO-8601 -> Unix milliseconds, null when absent or unreadable. */
function isoMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A property cell as the CSV wrote it: a trimmed string, '' when absent. */
function text(value) {
  if (value === null || value === undefined) return '';
  return cleanText(String(value));
}

/** A numeric property, 0 when absent (the parser's `finiteOrZero`). */
function finiteOrZero(value) {
  const number = finite(value);
  return number == null ? 0 : number;
}

/** One projected point as the record `parseFirmsCsv` returns, or null. */
export function fireRecordOf(point) {
  if (!point || typeof point !== 'object') return null;
  const lat = finite(point.position?.lat);
  const lon = finite(point.position?.lon);
  if (!coordinates(lat, lon)) return null;
  const properties =
    point.properties && typeof point.properties === 'object'
      ? point.properties
      : {};
  return {
    lat,
    lon,
    frp: finiteOrZero(properties.frp_mw),
    confidence: text(properties.confidence),
    brightness: finiteOrZero(properties.bright_ti4_k),
    brightnessTi5: finiteOrZero(properties.bright_ti5_k),
    daynight: text(properties.daynight),
    acqDate: text(properties.acq_date),
    acqTime: text(properties.acq_time),
    satellite: text(properties.satellite),
    instrument: text(properties.instrument),
  };
}

/** Bindings the projection mentions: points, and the per-binding echoes. */
function mentionedBindings(projection) {
  const seen = new Set();
  for (const point of projection.points) {
    if (typeof point?.binding === 'string') seen.add(point.binding);
  }
  for (const list of [projection.assumptions, projection.omissions]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry?.binding === 'string') seen.add(entry.binding);
    }
  }
  return seen;
}

/**
 * `({ projectionSource, head }) => { getSnapshot }`, the shape
 * `WORLD_LAYER_SOURCES` registers.
 * @param {object} options
 * @param {{getProjection: Function}} options.projectionSource The host's ProjectionSource.
 * @param {string} options.head Head the adapter reads (world/main).
 * @param {() => number} [options.now] Wall clock (tests).
 */
export function createWorldFirmsSource({
  projectionSource,
  head,
  now = () => Date.now(),
} = {}) {
  if (typeof projectionSource?.getProjection !== 'function')
    throw new TypeError('The fires world adapter requires a ProjectionSource');
  if (typeof head !== 'string' || !head)
    throw new TypeError('The fires world adapter requires a head');
  return {
    label: WORLD_FIRMS_SOURCE_LABEL,
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const projection = await projectionSource.getProjection({
        head,
        query: {
          type_filter: [FIRE_PRODUCT_TYPE],
          requested_layers: [...FIRE_BINDINGS],
          valid_at: wallClockValidAt(now()),
        },
        projectionSpec: {
          display_assumptions: {},
          projection_policy: {
            temporal_age: {
              mode: 'withhold',
              threshold_seconds: FIRE_WINDOW_SECONDS,
            },
          },
        },
        signal,
      });
      signal?.throwIfAborted();
      if (!Array.isArray(projection?.points))
        throw new LiveSourceError(
          'malformed',
          'Malformed world-model projection: no points array',
        );
      const fires = [];
      const counts = new Map(FIRE_BINDINGS.map((binding) => [binding, 0]));
      let rejected = 0;
      let fetchedAt = null;
      for (const point of projection.points) {
        const record = fireRecordOf(point);
        if (!record) {
          rejected += 1;
          continue;
        }
        fires.push(record);
        if (counts.has(point.binding))
          counts.set(point.binding, counts.get(point.binding) + 1);
        const known = isoMs(point.time?.known_as_of);
        if (known != null && (fetchedAt == null || known > fetchedAt))
          fetchedAt = known;
      }
      if (projection.points.length && !fires.length)
        throw new LiveSourceError(
          'malformed',
          'Malformed world-model projection: no fire detection could be placed',
        );
      const mentioned = mentionedBindings(projection);
      const withheld = Array.isArray(projection.omissions)
        ? projection.omissions
            .filter((o) => o?.reason === 'temporal-age-withheld')
            .reduce((sum, o) => sum + (Number(o.count) || 0), 0)
        : 0;
      return {
        fetchedAt: fetchedAt ?? now(),
        stale: fetchedAt != null && now() - fetchedAt > STALE_AFTER_MS,
        sources: FIRE_BINDINGS.map((binding) => ({
          source: FIRE_FEEDS[binding],
          binding,
          count: counts.get(binding),
          ok: mentioned.has(binding),
        })),
        count: fires.length,
        fires,
        rejectedCount: rejected,
        withheldCount: withheld,
        revisionId:
          typeof projection.revision_id === 'string'
            ? projection.revision_id
            : null,
        source: WORLD_FIRMS_SOURCE_LABEL,
        coverage: WORLD_FIRMS_COVERAGE,
      };
    },
  };
}
