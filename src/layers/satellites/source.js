const GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);

/** Read catalog text from the existing group endpoint using a supplied transport. */
export function createSatelliteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  api,
} = {}) {
  if (typeof api !== 'function')
    throw new TypeError('createSatelliteSource requires an api(path) resolver');
  return {
    async readGroup(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      const response = await fetchImpl(api(`/api/celestrak/${group}`), {
        signal,
      });
      const text = response.ok ? await response.text() : '';
      signal?.throwIfAborted();
      return { ok: response.ok, status: response.status, text };
    },
  };
}
