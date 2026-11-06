/**
 * Simulated runs (`sim/<run>` heads) the generic layer can switch to.
 *
 * A Foundation run binds into its own head, forked from the revision it was
 * computed from, and its products are `simulated`: Select's observed-only
 * default never shows them. Viewing one means three demand changes at once —
 * the head, the `simulated` modality, and a query time inside the run — so
 * this module finds runs and says which params to apply; the layer's row
 * chips carry them, the DataLayerManager writes them.
 *
 * A run is found from facts the backplane already serves: `GET /heads` for
 * the `sim/` names, `GET /status?head=` for each binding's valid range and
 * representations. Only the run's own `simulated` bindings with a
 * `positioned_entities/v1` representation count — the head also carries its
 * base's observed products — and the query time starts at their earliest epoch. A sample series answers an instant only at a stored epoch,
 * so stepping between epochs draws nothing rather than an interpolated state.
 */

export const SIM_HEAD_PREFIX = 'sim/';
export const DRAWABLE = 'positioned_entities/v1';
export const STEP_SECONDS = 60;

/** `{ head, revisionId, earliest, latest, bindings }` from one head's status, or null if nothing is drawable. */
export function runOf(head, revisionId, status) {
  // A run head also carries its base revision's observed bindings; only the
  // run's own (simulated) products say when the run happened.
  const drawable = (status?.bindings ?? []).filter(
    (binding) =>
      binding.modality === 'simulated' &&
      (binding.representations ?? []).some((r) => r?.kind === DRAWABLE),
  );
  const times = (key) =>
    drawable
      .map((binding) => binding.valid?.[key])
      .filter((at) => typeof at === 'string' && Number.isFinite(Date.parse(at)))
      .sort((a, b) => Date.parse(a) - Date.parse(b));
  const earliest = times('earliest')[0];
  const latest = times('latest').at(-1);
  if (!earliest) return null;
  return {
    head,
    revisionId,
    earliest,
    latest: latest ?? earliest,
    bindings: drawable.map((binding) => binding.binding),
  };
}

/**
 * A reader with a per-revision cache: a head's status is re-read only when
 * the head moved. A source without `getHeads` or `getStatus` has no runs.
 *
 * Every moved head is read at once: one after another, 30 runs took 23 s on
 * prod (2026-11-06). A read in flight is shared, and belongs to no caller's
 * signal, so one layer's abort never fails another's read; a failed one is
 * dropped and re-read next time.
 */
export function createSimulationRuns(source) {
  const cache = new Map(); // head -> { revisionId, run: Promise<run | null> }
  const runFor = (head, revisionId) => {
    const known = cache.get(head);
    if (known?.revisionId === revisionId) return known.run;
    const entry = {
      revisionId,
      run: source
        .getStatus({ head, modality: 'simulated' })
        .then((status) => runOf(head, revisionId, status)),
    };
    entry.run.catch(() => {
      if (cache.get(head) === entry) cache.delete(head);
    });
    cache.set(head, entry);
    return entry.run;
  };
  return {
    async read({ signal } = {}) {
      if (
        typeof source?.getHeads !== 'function' ||
        typeof source?.getStatus !== 'function'
      )
        return [];
      const heads = await source.getHeads({ signal });
      signal?.throwIfAborted();
      const runs = await Promise.all(
        Object.entries(heads)
          .filter(([head]) => head.startsWith(SIM_HEAD_PREFIX))
          .map(([head, revisionId]) => runFor(head, revisionId)),
      );
      signal?.throwIfAborted();
      return runs
        .filter(Boolean)
        .sort((a, b) => Date.parse(b.earliest) - Date.parse(a.earliest));
    },
  };
}

const shared = new WeakMap(); // source -> reader

/** One reader per source: every row of a world reads its runs once, not once each. */
export function sharedSimulationRuns(source) {
  if (!source || typeof source !== 'object') return createSimulationRuns(source);
  let reader = shared.get(source);
  if (!reader) {
    reader = createSimulationRuns(source);
    shared.set(source, reader);
  }
  return reader;
}

/** The params that view `run` at `validAt` (its first epoch by default). */
export function viewRunParams(run, validAt = run.earliest) {
  return {
    head: run.head,
    modalities: ['simulated'],
    validAt: new Date(Date.parse(validAt)).toISOString().replace('.000Z', 'Z'),
  };
}

/** The params that leave a run for the live world. */
export function leaveRunParams(head) {
  return { head, modalities: null, validAt: null };
}

/** `validAt` moved by `seconds`, clamped to the run. */
export function stepRunParams(run, validAt, seconds) {
  const lo = Date.parse(run.earliest);
  const hi = Date.parse(run.latest);
  const at = Math.min(hi, Math.max(lo, Date.parse(validAt) + seconds * 1000));
  return viewRunParams(run, new Date(at).toISOString());
}
