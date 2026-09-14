/**
 * World view controller: demand -> ordered, cancellable projections.
 *
 * Promise + AbortController, no RxJS, no Cesium, and NO internal timer: the
 * host's data-layer loop is the only clock (`tick()`), and demand changes
 * are coalesced by a debounce whose `setTimeout` is injected so tests drive
 * it. What it owns is demand and the last chain it read; never world state.
 *
 * Rules (the DWM-9 interaction semantics; `README.md` in the backplane repo):
 *  - every issued request carries a sequence number; a response is applied
 *    only if its sequence, head and pin are still current; superseded
 *    requests are aborted;
 *  - previous geometry stays while a replacement loads for the same world;
 *    changing world/head or `stop()` cancels immediately;
 *  - LIVE ticks re-project even when the revision did not move (the wall
 *    clock moved, so ages did); PINNED ticks never re-project, they only
 *    re-read the chain to report `headAdvanced`.
 */
import {
  buildRequest,
  createDemand,
  requestKey,
  sameBbox,
  temporalAgePolicy,
} from './demand.js';
import { assertProjectionSource, sourceFeatures } from './source.js';

function pinKey(demand) {
  return `${demand.head}|${demand.follow}|${demand.pinnedRevisionId || ''}`;
}

function linkAbort(controller, signal) {
  if (!signal) return;
  if (signal.aborted) controller.abort(signal.reason);
  else
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      once: true,
    });
}

function itemCount(projection) {
  return (
    (projection?.points?.length || 0) +
    (projection?.field_samples?.length || 0) +
    (projection?.lines?.length || 0) +
    (projection?.polygons?.length || 0)
  );
}

function isAbort(error) {
  return error?.name === 'AbortError';
}

/**
 * @param {object} options
 * @param {object} options.source ProjectionSource (see source.js)
 * @param {object} [options.initial] ViewDemand overrides (createDemand)
 * @param {number} [options.debounceMs] quiet period before a demand change is issued
 * @param {number} [options.chainLimit] revisions read per tick
 * @param {() => number} [options.now] wall clock (ms)
 * @param {typeof setTimeout} [options.setTimeout]
 * @param {typeof clearTimeout} [options.clearTimeout]
 */
export function createWorldViewController({
  source,
  initial = {},
  debounceMs = 300,
  chainLimit = 20,
  now = () => Date.now(),
  setTimeout: schedule = (...args) => globalThis.setTimeout(...args),
  clearTimeout: unschedule = (...args) => globalThis.clearTimeout(...args),
} = {}) {
  assertProjectionSource(source);
  const features = sourceFeatures(source);
  const state = {
    demand: createDemand(initial),
    chain: [],
    chainError: null,
    chainErrorCode: null,
    chainCheckedAt: null,
    status: null,
    statusError: null,
    projection: null,
    request: null,
    requestKey: null,
    load: 'idle',
    error: null,
    errorCode: null,
    appliedAt: null,
    sequence: 0,
    inflight: null,
    tickRequest: null,
    timer: null,
    stopped: false,
    ticks: 0,
    issued: 0,
    applied: 0,
    discarded: 0,
    listeners: new Set(),
  };

  function abortInflight() {
    state.inflight?.controller.abort();
    state.inflight = null;
  }

  function cancelTimer() {
    if (state.timer !== null) {
      unschedule(state.timer);
      state.timer = null;
    }
  }

  function current(seq, pin) {
    return (
      !state.stopped && seq === state.sequence && pin === pinKey(state.demand)
    );
  }

  function apply(projection, request) {
    state.projection = projection;
    state.request = request;
    state.load = itemCount(projection) > 0 ? 'ready' : 'empty';
    state.error = null;
    state.errorCode = null;
    state.appliedAt = now();
    state.applied++;
    for (const listener of state.listeners) {
      try {
        listener(projection, { request, demand: { ...state.demand } });
      } catch (error) {
        console.warn('[WorldView] projection listener failed:', error);
      }
    }
  }

  /** Issue the current demand now (sequence, abort of the previous request). */
  async function issue({ signal } = {}) {
    if (state.stopped) return false;
    const request = buildRequest(state.demand, state.chain, now());
    if (!request) {
      if (!state.projection) state.load = 'loading';
      return false;
    }
    const seq = ++state.sequence;
    const pin = pinKey(state.demand);
    abortInflight();
    const controller = new AbortController();
    linkAbort(controller, signal);
    state.inflight = { controller, seq };
    state.issued++;
    state.request = request;
    state.requestKey = requestKey(request, state.demand.nonce);
    if (!state.projection) state.load = 'loading';
    try {
      const projection = await source.getProjection({
        ...request,
        signal: controller.signal,
      });
      if (!current(seq, pin) || controller.signal.aborted) {
        state.discarded++;
        return false;
      }
      apply(projection, request);
      return true;
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted || !current(seq, pin)) {
        state.discarded++;
        return false;
      }
      state.error = error?.message || 'World model unavailable';
      state.errorCode = error?.code || null;
      if (!state.projection) {
        state.load =
          state.errorCode === 'unreachable' ? 'unavailable' : 'error';
      }
      return false;
    } finally {
      if (state.inflight?.seq === seq) state.inflight = null;
    }
  }

  function scheduleIssue() {
    if (state.stopped) return;
    cancelTimer();
    state.timer = schedule(() => {
      state.timer = null;
      void issue();
    }, debounceMs);
  }

  function update(next, { hardCut = false } = {}) {
    if (state.stopped) return;
    state.demand = next;
    if (hardCut) {
      // The world or the pin changed: nothing in flight may land any more.
      abortInflight();
      cancelTimer();
    }
    scheduleIssue();
  }

  const controller = {
    features,

    /**
     * One host clock tick: read the chain (and status when offered), then
     * LIVE re-projects the current demand by the newest revision id with a
     * fresh wall-clock `valid_at`; PINNED only re-reads facts.
     * Never throws: transport failures land in `getState()`.
     */
    async tick({ signal } = {}) {
      if (state.stopped) return false;
      state.ticks++;
      state.tickRequest?.abort();
      const tickController = new AbortController();
      linkAbort(tickController, signal);
      state.tickRequest = tickController;
      const head = state.demand.head;
      let chainOk = false;
      try {
        const chain = await source.getRevisions({
          head,
          limit: chainLimit,
          signal: tickController.signal,
        });
        if (tickController.signal.aborted || state.stopped) return false;
        if (state.demand.head !== head) return false;
        state.chain = [...chain.revisions];
        state.chainError = null;
        state.chainErrorCode = null;
        state.chainCheckedAt = now();
        chainOk = true;
      } catch (error) {
        if (isAbort(error) || tickController.signal.aborted || state.stopped)
          return false;
        state.chainError = error?.message || 'World model unavailable';
        state.chainErrorCode = error?.code || null;
        state.chainCheckedAt = now();
        if (!state.projection) {
          state.error = state.chainError;
          state.errorCode = state.chainErrorCode;
          state.load =
            state.chainErrorCode === 'unreachable' ? 'unavailable' : 'error';
        }
      }
      if (features.status) {
        try {
          const status = await source.getStatus({
            head,
            signal: tickController.signal,
          });
          if (tickController.signal.aborted || state.stopped) return false;
          if (state.demand.head === head) {
            state.status = status;
            state.statusError = null;
          }
        } catch (error) {
          if (isAbort(error) || tickController.signal.aborted || state.stopped)
            return false;
          state.statusError = error?.message || 'status unavailable';
        }
      }
      if (state.demand.follow === 'live' && chainOk) {
        cancelTimer(); // this tick supersedes a pending debounce
        await issue({ signal: tickController.signal });
      }
      if (state.tickRequest === tickController) state.tickRequest = null;
      // false = this tick was cancelled (disable/stop/newer tick); nothing it did landed.
      return !state.stopped && !tickController.signal.aborted;
    },

    /** Camera-derived scope (demandBbox); null = no spatial scope. */
    setViewport(bbox) {
      if (sameBbox(bbox, state.demand.bbox)) return;
      update({ ...state.demand, bbox: bbox ? [...bbox] : null });
    },

    /** null = every binding of the revision. */
    setLayers(layers) {
      const next = layers ? [...layers].sort() : null;
      if (JSON.stringify(next) === JSON.stringify(state.demand.layers)) return;
      update({ ...state.demand, layers: next });
    },

    /** Explicit query time (null = wall clock at issue time in LIVE). */
    setQueryTime(validAt, knownAsOf = state.demand.knownAsOf) {
      const next = {
        ...state.demand,
        validAt: validAt || null,
        knownAsOf: knownAsOf || null,
      };
      if (
        next.validAt === state.demand.validAt &&
        next.knownAsOf === state.demand.knownAsOf
      )
        return;
      update(next);
    },

    setPredicates(predicates) {
      update({
        ...state.demand,
        predicates: predicates ? { ...predicates } : null,
      });
    },

    setDisplayAssumptions(displayAssumptions) {
      update({
        ...state.demand,
        displayAssumptions: { ...displayAssumptions },
      });
    },

    /** A projection_policy block, or the layer's `off|mark|withhold` shorthand. */
    setPolicy(policy, thresholdSeconds = 30) {
      const block =
        typeof policy === 'string'
          ? temporalAgePolicy(policy, thresholdSeconds)
          : { ...(policy || {}) };
      if (
        JSON.stringify(block) === JSON.stringify(state.demand.projectionPolicy)
      )
        return;
      update({ ...state.demand, projectionPolicy: block });
    },

    /** Pin a revision; defaults to the one on screen so the view is kept exactly. */
    pin(revisionId = state.projection?.revision_id || state.chain[0]?.id) {
      if (!revisionId) return false;
      if (
        state.demand.follow === 'pinned' &&
        state.demand.pinnedRevisionId === revisionId
      )
        return true;
      // Freeze the time the pinned view was issued with, so the pin is exact.
      const validAt =
        state.demand.validAt ||
        (state.projection && state.request?.revisionId === revisionId
          ? state.request.query.valid_at
          : null);
      update(
        {
          ...state.demand,
          follow: 'pinned',
          pinnedRevisionId: revisionId,
          validAt,
        },
        { hardCut: true },
      );
      return true;
    },

    followLive({ keepQueryTime = false } = {}) {
      if (state.demand.follow === 'live') return;
      update(
        {
          ...state.demand,
          follow: 'live',
          pinnedRevisionId: null,
          validAt: keepQueryTime ? state.demand.validAt : null,
        },
        { hardCut: true },
      );
    },

    /** Select another world (head): leaves any pin behind, cancels at once. */
    setWorld(head) {
      if (!head || head === state.demand.head) return;
      state.chain = [];
      state.status = null;
      state.projection = null;
      state.request = null;
      state.load = 'loading';
      update(
        {
          ...state.demand,
          head,
          follow: 'live',
          pinnedRevisionId: null,
          layers: null,
        },
        { hardCut: true },
      );
    },

    /** Re-issue the current demand even if nothing changed. */
    refresh() {
      update({ ...state.demand, nonce: state.demand.nonce + 1 });
    },

    /** Subscribe to applied projections; returns an unsubscribe. */
    onProjection(listener) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },

    /** Abort whatever is in flight or pending without stopping (the layer is disabled, not destroyed). */
    cancel() {
      abortInflight();
      state.tickRequest?.abort();
      state.tickRequest = null;
      cancelTimer();
    },

    /** Everything above, aborted and silenced. Nothing lands afterwards. */
    stop() {
      state.stopped = true;
      abortInflight();
      state.tickRequest?.abort();
      state.tickRequest = null;
      cancelTimer();
      state.listeners.clear();
    },

    /** Issue now, bypassing the debounce (tests, explicit user actions). */
    flush() {
      cancelTimer();
      return issue();
    },

    getDemand() {
      return { ...state.demand };
    },

    getState() {
      const headRevision = state.chain[0] || null;
      const created = headRevision ? Date.parse(headRevision.created_at) : NaN;
      const displayedRevisionId = state.projection?.revision_id ?? null;
      return {
        demand: { ...state.demand },
        follow: state.demand.follow,
        chain: state.chain,
        headRevisionId: headRevision?.id ?? null,
        headAgeSeconds: Number.isFinite(created)
          ? Math.max(0, Math.round((now() - created) / 1000))
          : null,
        displayedRevisionId,
        headAdvanced:
          state.demand.follow === 'pinned' &&
          !!headRevision &&
          headRevision.id !== state.demand.pinnedRevisionId,
        projection: state.projection,
        request: state.request,
        requestKey: state.requestKey,
        load: state.load,
        loading: Boolean(state.inflight),
        pending: state.timer !== null,
        error: state.error,
        errorCode: state.errorCode,
        stale:
          Boolean(state.projection) && Boolean(state.error || state.chainError),
        chainError: state.chainError,
        chainErrorCode: state.chainErrorCode,
        chainCheckedAt: state.chainCheckedAt,
        status: state.status,
        statusError: state.statusError,
        appliedAt: state.appliedAt,
        counters: {
          ticks: state.ticks,
          issued: state.issued,
          applied: state.applied,
          discarded: state.discarded,
        },
        stopped: state.stopped,
      };
    },
  };
  return controller;
}
