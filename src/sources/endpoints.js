/**
 * Where the browser application reaches its provider API and static assets.
 *
 * Every provider request path stays the logical `/api/...` string it always
 * was; only the origin/prefix is the host's choice, resolved at request time
 * (module constants remain stable keys). Defaults keep the standalone shell
 * unchanged: `apiUrl('/api/x')` is `/api/x` on the page origin.
 *
 * An embedding host configures:
 *   - `apiBaseUrl`: a prefix such as `http://localhost:8200` for a provider
 *     server, `''` for same-origin, or `null` when no provider API exists.
 *     With `null`, `apiUrl()` throws `EndpointUnavailableError`, which callers
 *     already treat like any failed provider request.
 *   - `assetBaseUrl`: a prefix for bundled static assets (`/models/...`).
 */

export class EndpointUnavailableError extends Error {
  constructor(path) {
    super(`Provider API is not configured for ${path}`);
    this.name = 'EndpointUnavailableError';
    this.code = 'endpoint-unavailable';
  }
}

const DEFAULTS = Object.freeze({ apiBaseUrl: '', assetBaseUrl: undefined });
let current = DEFAULTS;

function normalizeBase(value, name) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new TypeError(`${name} must be a string or null`);
  return value.replace(/\/+$/, '');
}

function join(base, path) {
  const suffix = String(path);
  return `${base}${suffix.startsWith('/') ? '' : '/'}${suffix}`;
}

/**
 * Replace the endpoint configuration. Returns a function that restores the
 * configuration it replaced (only if nothing reconfigured it since).
 * @param {{apiBaseUrl?: string|null, assetBaseUrl?: string}} [config]
 */
export function configureEndpoints({ apiBaseUrl = '', assetBaseUrl } = {}) {
  const previous = current;
  const next = Object.freeze({
    apiBaseUrl: normalizeBase(apiBaseUrl, 'apiBaseUrl'),
    assetBaseUrl: normalizeBase(assetBaseUrl, 'assetBaseUrl') ?? undefined,
  });
  current = next;
  return () => {
    if (current === next) current = previous;
  };
}

/** Restore the standalone defaults. */
export function resetEndpoints() {
  current = DEFAULTS;
}

/** Whether a provider API is configured at all. */
export function isApiAvailable() {
  return current.apiBaseUrl !== null;
}

/** Resolve a logical `/api/...` path against the configured provider API. */
export function apiUrl(path) {
  if (current.apiBaseUrl === null) throw new EndpointUnavailableError(path);
  return current.apiBaseUrl ? join(current.apiBaseUrl, path) : String(path);
}

/** Resolve a logical static asset path (`/models/airplane.glb`). */
export function assetUrl(path) {
  if (current.assetBaseUrl !== undefined) {
    return join(current.assetBaseUrl, String(path).replace(/^\/+/, ''));
  }
  const base = import.meta.env?.BASE_URL || '/';
  return `${base}${String(path).replace(/^\//, '')}`;
}
