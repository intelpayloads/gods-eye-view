/** Read launch records and their optional active-orbit catalog with explicit cancellation. */
export function createLaunchSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  api,
} = {}) {
  if (typeof api !== 'function')
    throw new TypeError('createLaunchSource requires an api(path) resolver');
  return {
    async getLaunches({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(api('/api/launches'), { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(payload) && !Array.isArray(payload?.results))
        throw new Error('Malformed launch snapshot');
      return payload;
    },
    async getActiveTle({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(api('/api/celestrak/active'), {
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      signal?.throwIfAborted();
      return text;
    },
  };
}
