import { readRequestBodyCapped } from './common/request.js';

/**
 * Gods Eye standalone DEVELOPMENT adapter: forwards `/api/world/*` to the
 * Dataforge World Model backplane at `WORLD_API_URL` (default
 * http://127.0.0.1:8080) so the standalone shell can reach it same-origin.
 *
 * This is not the world-model browser architecture. The world-model layer's
 * transport is injected (`src/layers/worldModel/source.js`); the Dataforge
 * client integration routes through Dataforge Serve v2 (forwarding the
 * caller's token/context) instead of this proxy. Keep rendering out of here
 * and keep this path out of the layer.
 *
 * Routes (world operations only, no provider endpoints):
 *   GET  /api/world/healthz | /capabilities | /heads | /heads/<name>
 *        /revisions[?head=&limit=] | /revisions/<id> | /provenance/<ref> | /status[?head=]
 *        /regions | /regions/<name> | /regions/<name>/tilesets      (GEN-403)
 *        /tilesets/<content_id>/<file>   a region's tile files, passed through as bytes
 *   POST /api/world/select | /project      (JSON bodies, capped)
 * Anything else → 404; wrong method → 405; upstream down → 502.
 * A tile keeps the backplane's content type, cache policy and ETag (its
 * files are immutable); every JSON answer stays `no-store`.
 *
 * @returns {import('vite').Plugin}
 */
const DEFAULT_UPSTREAM = 'http://127.0.0.1:8080';
const TILE_FILE = /^\/tilesets\/[^/]+\/.+$/;
const TILE_HEADERS = Object.freeze([
  'cache-control',
  'etag',
  'access-control-allow-origin',
]);
const ROUTES = Object.freeze([
  { method: 'GET', pattern: /^\/healthz$/ },
  { method: 'GET', pattern: /^\/capabilities$/ },
  { method: 'GET', pattern: /^\/heads(\/.+)?$/ },
  { method: 'GET', pattern: /^\/revisions(\/[^/]+)?$/ },
  { method: 'GET', pattern: /^\/provenance\/.+$/ },
  { method: 'GET', pattern: /^\/status$/ },
  { method: 'GET', pattern: /^\/regions(\/[^/]+(\/tilesets)?)?$/ },
  { method: 'GET', pattern: TILE_FILE, bytes: true },
  { method: 'POST', pattern: /^\/select$/ },
  { method: 'POST', pattern: /^\/project$/ },
]);

function hasDotSegment(path) {
  return path.split('/').some((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === '.' || decoded === '..';
  });
}

export function worldModelDevProxy({
  upstream = () => process.env.WORLD_API_URL || DEFAULT_UPSTREAM,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 20_000,
  maxBodyBytes = 64 * 1024,
} = {}) {
  const json = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  async function handle(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = req.url || '/';
    const path = url.split('?')[0];
    // URL normalisation would turn `..` (or `%2e%2e`) into another backplane route.
    if (hasDotSegment(path))
      return json(res, 404, { error: 'Unknown world-model route' });
    const matched = ROUTES.filter((route) => route.pattern.test(path));
    const allowed = matched.map((route) => route.method);
    const bytes = matched.some((route) => route.bytes);
    if (!allowed.length)
      return json(res, 404, { error: 'Unknown world-model route' });
    if (!allowed.includes(method))
      return json(res, 405, { error: 'Method Not Allowed' });

    let body;
    if (method === 'POST') {
      try {
        body = await readRequestBodyCapped(req, maxBodyBytes);
      } catch (error) {
        return json(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
          error: 'World-model request body rejected',
        });
      }
    }
    const base = String(
      typeof upstream === 'function' ? upstream() : upstream,
    ).replace(/\/+$/, '');
    let target;
    try {
      target = new URL(base + url);
    } catch {
      return json(res, 500, { error: 'WORLD_API_URL is not a valid URL' });
    }
    try {
      const response = await fetchImpl(target, {
        method,
        headers: bytes
          ? {
              accept: req.headers?.accept || '*/*',
              ...(req.headers?.['if-none-match']
                ? { 'if-none-match': req.headers['if-none-match'] }
                : {}),
            }
          : {
              accept: 'application/json',
              ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
            },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (bytes) {
        const payload = Buffer.from(await response.arrayBuffer());
        const headers = {};
        const type = response.headers.get('content-type');
        if (type) headers['Content-Type'] = type;
        for (const name of TILE_HEADERS) {
          const value = response.headers.get(name);
          if (value) headers[name] = value;
        }
        res.writeHead(response.status, headers);
        res.end(payload);
        return;
      }
      const text = await response.text();
      res.writeHead(response.status, {
        'Content-Type':
          response.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(text);
    } catch (error) {
      console.warn(
        '[world-proxy] upstream unreachable:',
        base,
        error?.message || error,
      );
      json(res, 502, { error: 'world-backplane-unreachable', upstream: base });
    }
  }

  const install = (server) => {
    server.middlewares.use('/api/world', (req, res) => {
      handle(req, res).catch(() =>
        json(res, 500, { error: 'World-model proxy error' }),
      );
    });
  };
  return {
    name: 'gev-world-model-dev-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
