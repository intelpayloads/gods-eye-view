/**
 * The renders of a run (GEN-369): each request's life from submit to images,
 * behind the host's `renderSource`:
 *
 *   submit(request, {signal})          -> {id}
 *   status(id, {signal})               -> {state: queued|rendering|transferring|completed|failed, reason?}
 *   outputs(id, {signal})              -> [{id, name}]
 *   download(id, outputId, {signal})   -> Blob
 *   cancel(id, {signal})               -> anything; optional, and only a queued render (GEN-465)
 *
 * A call the server refuses throws an Error with the HTTP `status` and a
 * `message` a person can read. A 404 means the server no longer keeps the
 * render (the render gateway deletes one 14 days after it ended).
 *
 * The host's job is the transport (its login, its server); what a render
 * means and which of its files to show is God's Eye's. Status is polled
 * every POLL_MS, one request at a time per job. Each run's list is kept in
 * the viewer's storage by the run's head, so a reload lists the renders
 * again and fetches their images from the server; until DWM-277 keeps renders
 * in the World Model, that list is the only index of them.
 */
import { frameOf, mediaTypeOf, pickOutputs } from './outputs.js';

export const RENDERS_STORAGE_KEY = 'gev:run-renders:v1';
export const POLL_MS = 2000;
/** A run keeps its newest renders; images stay in memory for the few last shown. */
const KEPT_PER_RUN = 40;
const IMAGES_KEPT = 8;
/** Consecutive unreadable statuses before a job is shown failed (a reload asks again). */
const STATUS_ATTEMPTS = 5;

const TERMINAL = new Set(['completed', 'failed']);

/** What a render reads as once the server answers 404 for it. */
export const GONE_REASON = 'The server no longer keeps this render';
const isGone = (error) => (error?.status ?? null) === 404;

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function abortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Words for a refused submit: a server with no agent for the plugin says so by 409/412. */
export function submitReason(error) {
  const status = error?.status ?? null;
  if (status === 409 || status === 412)
    return 'No render node is running: the server has no agent for RenderRequest';
  if (error?.code === 'unauthorized' || status === 401 || status === 403)
    return 'Not signed in to the Dataforge server, or not allowed to render';
  return error?.message
    ? String(error.message)
    : 'The server refused the request';
}

/**
 * The fields a render keeps across reloads (no images, no live state).
 * `finishedAt` is this session's only: when it watched the render finish.
 */
function stored(entry) {
  const {
    id,
    runKey,
    validAt,
    camera,
    look,
    fovDeg,
    captureId,
    submittedAt,
    state,
    reason,
  } = entry;
  const kept = {
    id,
    runKey,
    validAt,
    camera,
    look,
    fovDeg,
    captureId,
    submittedAt,
    state,
    reason,
  };
  // Remembered, so a reload does not ask a server for files it has said are gone.
  if (entry.gone) kept.gone = true;
  return kept;
}

/**
 * @param {{renderSource: object, storage?: Storage|null, onChange?: () => void,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>, now?: () => number,
 *   objectUrls?: {create: (blob: Blob) => string, revoke: (url: string) => void}}} options
 */
export function createRenderJobs({
  renderSource,
  storage = safeStorage(),
  onChange = () => {},
  sleep = abortable,
  now = () => Date.now(),
  objectUrls = {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
}) {
  const runs = new Map(); // runKey -> entries, newest first
  const controllers = new Set();
  const following = new Set(); // job ids being polled
  const shown = []; // job ids whose images are in memory, most recent last
  let disposed = false;

  function readStore() {
    try {
      const raw = storage?.getItem(RENDERS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function save(runKey) {
    if (!storage) return;
    try {
      const all = readStore();
      all[runKey] = (runs.get(runKey) ?? [])
        .filter((entry) => entry.id)
        .slice(0, KEPT_PER_RUN)
        .map(stored);
      storage.setItem(RENDERS_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // A full or blocked store keeps this session's list only.
    }
  }

  function changed(entry) {
    if (entry) save(entry.runKey);
    if (!disposed) onChange();
  }

  function entriesOf(runKey) {
    if (!runs.has(runKey)) {
      const kept = readStore()[runKey];
      const entries = Array.isArray(kept)
        ? kept
            .filter((e) => e && typeof e.id === 'string')
            .map((e) => ({ ...e, images: null, frame: null }))
        : [];
      runs.set(runKey, entries);
      for (const entry of entries)
        if (!TERMINAL.has(entry.state)) void follow(entry);
    }
    return runs.get(runKey);
  }

  function track() {
    const controller = new AbortController();
    controllers.add(controller);
    return {
      signal: controller.signal,
      done: () => controllers.delete(controller),
    };
  }

  async function follow(entry) {
    if (following.has(entry.id) || disposed) return;
    following.add(entry.id);
    const { signal, done } = track();
    let misses = 0;
    try {
      while (!disposed) {
        let status;
        try {
          status = await renderSource.status(entry.id, { signal });
          misses = 0;
        } catch (error) {
          if (signal.aborted) return;
          if (isGone(error)) {
            // Not a miss to try again: the server answered, and it has no such render.
            Object.assign(entry, {
              state: 'failed',
              reason: GONE_REASON,
              gone: true,
              finishedAt: now(),
            });
            changed(entry);
            return;
          }
          if (++misses >= STATUS_ATTEMPTS) {
            Object.assign(entry, {
              state: 'failed',
              reason: `Status unreadable: ${error?.message ?? error}`,
              finishedAt: now(),
            });
            changed(entry);
            return;
          }
          await sleep(POLL_MS, signal);
          continue;
        }
        // Finished here while the answer was on its way (a cancel): that stands.
        if (TERMINAL.has(entry.state)) return;
        const state = status?.state ?? 'queued';
        if (
          state !== entry.state ||
          (status?.reason ?? null) !== (entry.reason ?? null)
        ) {
          Object.assign(entry, { state, reason: status?.reason ?? null });
          if (TERMINAL.has(state)) entry.finishedAt = now();
          changed(entry);
        }
        if (TERMINAL.has(state)) return;
        await sleep(POLL_MS, signal);
      }
    } catch (error) {
      if (!signal.aborted)
        console.warn('[RunRender] following a render failed:', error);
    } finally {
      following.delete(entry.id);
      done();
    }
  }

  function forget(entry) {
    for (const url of Object.values(entry.images ?? {}))
      if (url) objectUrls.revoke(url);
    entry.images = null;
  }

  /** Fetch a completed render's images and frame record, once; the oldest shown are let go. */
  async function ensureImages(entry) {
    if (entry.state !== 'completed' || entry.images || entry.loading)
      return entry;
    if (entry.gone) {
      entry.imageError = GONE_REASON;
      if (!disposed) onChange();
      return entry;
    }
    entry.loading = true;
    const { signal, done } = track();
    try {
      const picked = pickOutputs(
        await renderSource.outputs(entry.id, { signal }),
      );
      if (!picked.unreal && !picked.photo)
        throw new Error('the render finished without a frame');
      const fetchFile = async (output) => {
        if (!output) return null;
        const blob = await renderSource.download(entry.id, output.id, {
          signal,
        });
        return new Blob([blob], { type: mediaTypeOf(output.name) });
      };
      const [photo, unreal, labels, record] = await Promise.all(
        ['photo', 'unreal', 'labels', 'record'].map((key) =>
          fetchFile(picked[key]),
        ),
      );
      if (disposed) return entry;
      entry.frame = record
        ? frameOf(JSON.parse(await record.text()))
        : frameOf(null);
      entry.images = {
        photo: photo ? objectUrls.create(photo) : null,
        unreal: unreal ? objectUrls.create(unreal) : null,
        labels: labels ? objectUrls.create(labels) : null,
      };
      entry.imageError = null;
      shown.push(entry.id);
      while (shown.length > IMAGES_KEPT) {
        const oldest = shown.shift();
        for (const list of runs.values())
          for (const other of list)
            if (other.id === oldest && other !== entry) forget(other);
      }
    } catch (error) {
      if (signal.aborted) {
        // Left mid-fetch: nothing to say about the render.
      } else if (isGone(error)) {
        entry.gone = true;
        entry.imageError = GONE_REASON;
        save(entry.runKey);
      } else entry.imageError = error?.message ?? String(error);
    } finally {
      entry.loading = false;
      done();
      if (!disposed) onChange();
    }
    return entry;
  }

  return {
    /** The run's renders, newest first. */
    list(runKey) {
      return runKey ? entriesOf(runKey) : [];
    },

    /** Send one request; the entry is listed at once and follows the job. */
    async submit({ runKey, validAt, camera, look, fovDeg, request }) {
      const entry = {
        id: null,
        runKey,
        validAt,
        camera,
        look,
        fovDeg,
        captureId: request.capture_id,
        submittedAt: new Date(now()).toISOString(),
        state: 'submitting',
        reason: null,
        images: null,
        frame: null,
      };
      entriesOf(runKey).unshift(entry);
      onChange();
      const { signal, done } = track();
      try {
        const answer = await renderSource.submit(request, { signal });
        if (!answer?.id) throw new Error('the server gave the render no id');
        Object.assign(entry, { id: String(answer.id), state: 'queued' });
        changed(entry);
        void follow(entry);
      } catch (error) {
        if (signal.aborted) return entry;
        Object.assign(entry, {
          state: 'failed',
          reason: submitReason(error),
          finishedAt: now(),
        });
        if (!entry.id) {
          // Never sent: shown failed this session, not kept.
          onChange();
        } else changed(entry);
      } finally {
        done();
      }
      return entry;
    },

    ensureImages,

    /** Whether this render can be cancelled: the host can, and it has not started. */
    canCancel(entry) {
      return (
        typeof renderSource.cancel === 'function' &&
        Boolean(entry?.id) &&
        entry.state === 'queued'
      );
    },

    /**
     * Cancel a queued render. A refusal (it started meanwhile) leaves the
     * entry as it is, to keep following; its words are returned.
     * @returns {Promise<{cancelled: boolean, reason?: string}>}
     */
    async cancel(entry) {
      if (!this.canCancel(entry))
        return {
          cancelled: false,
          reason: 'This render can no longer be cancelled',
        };
      const { signal, done } = track();
      try {
        await renderSource.cancel(entry.id, { signal });
        Object.assign(entry, {
          state: 'failed',
          reason: 'Cancelled',
          finishedAt: now(),
        });
        changed(entry);
        return { cancelled: true };
      } catch (error) {
        if (!signal.aborted && isGone(error)) {
          Object.assign(entry, {
            state: 'failed',
            reason: GONE_REASON,
            gone: true,
            finishedAt: now(),
          });
          changed(entry);
        }
        return { cancelled: false, reason: error?.message ?? String(error) };
      } finally {
        done();
      }
    },

    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      for (const list of runs.values()) for (const entry of list) forget(entry);
    },
  };
}
