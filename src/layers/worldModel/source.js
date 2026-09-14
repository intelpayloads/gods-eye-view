/**
 * ProjectionSource: the transport seam of the world-model layer.
 *
 * The layer depends only on this contract:
 *
 *   getHeadRevision({ signal }) -> Promise<string>       the revision a head points at
 *   getProjection({ revisionId, signal }) -> Promise<Projection>   neutral-v1 JSON, pinned
 *
 * How the request reaches the world model is the host's business: the
 * standalone Gods Eye shell wires an HTTP source at a local development
 * proxy; the Dataforge client supplies its own transport (Dataforge Serve v2
 * forwarding the caller's token/context). This module knows nothing about
 * Vite, proxies, or Dataforge. `createHttpProjectionSource` is ONE
 * implementation over the world-model REST shape; an in-memory fixture source
 * that satisfies `assertProjectionSource` is just as valid.
 */
import { DEFAULT_VIEW, HEAD } from './view.js';

export const PROJECTION_SOURCE_ERROR_CODES = Object.freeze([
  'unreachable',
  'unauthorized',
  'head-missing',
  'http',
  'malformed',
]);

export class ProjectionSourceError extends Error {
  /**
   * @param {string} code One of PROJECTION_SOURCE_ERROR_CODES.
   * @param {string} message Human-readable, safe to show in the layer row.
   * @param {{status?: number, cause?: unknown}} [details]
   */
  constructor(code, message, { status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectionSourceError';
    this.code = PROJECTION_SOURCE_ERROR_CODES.includes(code) ? code : 'http';
    this.status = Number.isFinite(status) ? status : null;
  }
}

/** Require the ProjectionSource shape before a layer accepts a source. */
export function assertProjectionSource(source) {
  if (
    typeof source?.getHeadRevision !== 'function' ||
    typeof source?.getProjection !== 'function'
  ) {
    throw new TypeError(
      'World model layer requires a ProjectionSource with getHeadRevision() and getProjection()',
    );
  }
  return source;
}

const PROJECTION_ARRAYS = Object.freeze([
  'points',
  'lines',
  'polygons',
  'field_samples',
  'annotations',
  'assumptions',
  'omissions',
]);

/**
 * Validate a neutral-v1 projection payload structurally (never semantically:
 * the adapter decides what it can draw). Returns the payload unchanged.
 */
export function validateProjection(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProjectionSourceError('malformed', 'Projection is not an object');
  }
  if (typeof payload.revision_id !== 'string' || !payload.revision_id) {
    throw new ProjectionSourceError(
      'malformed',
      'Projection is missing revision_id',
    );
  }
  for (const key of PROJECTION_ARRAYS) {
    if (!Array.isArray(payload[key])) {
      throw new ProjectionSourceError(
        'malformed',
        `Projection is missing the ${key} array`,
      );
    }
  }
  return payload;
}

function messageFromBody(payload, fallback) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.message === 'string' && payload.message)
      return payload.message;
    if (typeof payload.error === 'string' && payload.error)
      return payload.error;
  }
  return fallback;
}

/**
 * HTTP implementation over the world-model REST shape
 * (`GET {baseUrl}/heads`, `POST {baseUrl}/project`).
 *
 * @param {object} options
 * @param {string} options.baseUrl Origin and/or prefix the host chose:
 *   a prefix behind the host's own proxy, a Serve v2 route, or a
 *   direct backplane URL. Never hard-coded here.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => (object|Promise<object>)} [options.headers] Awaited per
 *   request so a host can attach `Authorization` / caller context.
 * @param {object} [options.view] Query + projection_spec (DEFAULT_VIEW).
 * @param {string} [options.head] Head name (world/main).
 */
export function createHttpProjectionSource({
  baseUrl,
  fetchImpl = (...args) => globalThis.fetch(...args),
  headers = async () => ({}),
  view = DEFAULT_VIEW,
  head = HEAD,
} = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new TypeError('createHttpProjectionSource requires a baseUrl');
  }
  const root = baseUrl.trim().replace(/\/+$/, '');

  async function request(path, { method = 'GET', body, signal } = {}) {
    signal?.throwIfAborted();
    const extraHeaders = (await headers()) || {};
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ProjectionSourceError(
        'unreachable',
        `World model unreachable at ${root}: ${error?.message || error}`,
        { cause: error },
      );
    }
    signal?.throwIfAborted();
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      if (response.ok) {
        throw new ProjectionSourceError(
          'malformed',
          `World model returned non-JSON for ${path}`,
          { status: response.status, cause: error },
        );
      }
    }
    signal?.throwIfAborted();
    if (response.status === 401 || response.status === 403) {
      throw new ProjectionSourceError(
        'unauthorized',
        messageFromBody(
          payload,
          `World model refused the request (${response.status})`,
        ),
        { status: response.status },
      );
    }
    if (
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    ) {
      throw new ProjectionSourceError(
        'unreachable',
        messageFromBody(
          payload,
          `World model unreachable (${response.status})`,
        ),
        { status: response.status },
      );
    }
    if (!response.ok) {
      throw new ProjectionSourceError(
        'http',
        messageFromBody(
          payload,
          `World model HTTP ${response.status} for ${path}`,
        ),
        { status: response.status },
      );
    }
    return payload;
  }

  return Object.freeze({
    async getHeadRevision({ signal } = {}) {
      const heads = await request('/heads', { signal });
      if (!heads || typeof heads !== 'object') {
        throw new ProjectionSourceError(
          'malformed',
          'Heads response is not an object',
        );
      }
      const revisionId = heads[head];
      if (typeof revisionId !== 'string' || !revisionId) {
        throw new ProjectionSourceError(
          'head-missing',
          `Head ${head} is not set; run \`worldmodel noaa replay\` and \`worldmodel opensky replay\``,
        );
      }
      return revisionId;
    },
    async getProjection({ revisionId, signal } = {}) {
      if (typeof revisionId !== 'string' || !revisionId) {
        throw new TypeError('getProjection requires a revisionId');
      }
      const payload = await request('/project', {
        method: 'POST',
        body: {
          revision_id: revisionId,
          query: view.query,
          projection_spec: view.projection_spec,
        },
        signal,
      });
      const projection = validateProjection(payload);
      if (projection.revision_id !== revisionId) {
        throw new ProjectionSourceError(
          'malformed',
          `Projection revision ${projection.revision_id} does not match the requested ${revisionId}`,
        );
      }
      return projection;
    },
    describe() {
      return { transport: 'http', baseUrl: root, head };
    },
  });
}
