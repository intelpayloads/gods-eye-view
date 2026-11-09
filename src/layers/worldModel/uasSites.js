/**
 * A C-UAS run's fixed sites (GEN-405): `simulation.uas.sites`
 * (`dataforge.uas-sites/1`), each drone's home and each ground control
 * station, one row each at the run's first epoch. Sites do not move during a
 * run, so the set is read once per revision "as of" one instant inside it,
 * and the drone layer draws the C2 path from the GCS its track names.
 *
 * A run published before the sites (GEN-420) has none: its C2 path has no
 * near end and is not drawn, never guessed.
 *
 * Pure and Cesium-free.
 */
export const UAS_SITES_BINDING = 'simulation.uas.sites';

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The `/select` for the run's sites, as of `validAt` (any instant of the run). */
export function uasSitesQuery(validAt) {
  return {
    modalities: ['simulated'],
    requested_layers: [UAS_SITES_BINDING],
    valid_at: validAt,
  };
}

/**
 * `POST /select` answer -> `Map(identity -> {identity, kind, position, eirpW,
 * frequencyHz})`; a site without a finite position is left out.
 */
export function uasSitesFromSelection(selection) {
  const sites = new Map();
  for (const product of selection?.products ?? []) {
    if (!product?.product_ref?.type_id?.startsWith('simulation.uas.site'))
      continue;
    for (const row of product.values ?? []) {
      const identity = String(row?.semantic_identity ?? '');
      const lon = finiteOrNull(row?.lon);
      const lat = finiteOrNull(row?.lat);
      const height = finiteOrNull(row?.geometric_height_m);
      if (!identity || lon === null || lat === null || height === null)
        continue;
      const value = row.value ?? {};
      sites.set(identity, {
        identity,
        kind: typeof value.site_kind === 'string' ? value.site_kind : null,
        position: { lon, lat, height },
        eirpW: finiteOrNull(value.gcs_eirp_w),
        frequencyHz: finiteOrNull(value.gcs_frequency_hz),
      });
    }
  }
  return sites;
}

/** `gcs:foundation:gcs-1` -> `GCS-1`. */
export function siteName(identity) {
  const tail = String(identity || '')
    .split(':')
    .at(-1);
  return tail ? tail.toUpperCase() : 'SITE';
}

/**
 * Sites per revision, read once: `read({revisionId, validAt})` resolves to
 * the Map (empty for a source without `select`, or a run with no sites).
 */
export function createUasSites(source) {
  const cache = new Map(); // revisionId -> Promise<Map>
  return {
    async read({ revisionId, validAt } = {}) {
      if (typeof source?.select !== 'function' || !revisionId || !validAt)
        return new Map();
      if (!cache.has(revisionId)) {
        const pending = source
          .select({ revisionId, query: uasSitesQuery(validAt) })
          .then(uasSitesFromSelection);
        cache.set(revisionId, pending);
        pending.catch(() => cache.delete(revisionId));
      }
      return cache.get(revisionId);
    },
  };
}

const shared = new WeakMap(); // source -> reader

/** One reader per source, as the drone track's (`sharedUasTracks`). */
export function sharedUasSites(source) {
  if (!source || typeof source !== 'object') return createUasSites(source);
  let reader = shared.get(source);
  if (!reader) {
    reader = createUasSites(source);
    shared.set(source, reader);
  }
  return reader;
}
