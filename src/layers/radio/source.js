/** Read the radio station directory through the fixed `/api/radio/stations` broker. */
export function createRadioSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  api,
} = {}) {
  if (typeof api !== 'function')
    throw new TypeError('createRadioSource requires an api(path) resolver');
  return {
    async getDirectory({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(api('/api/radio/stations'), { signal });
      if (!response.ok)
        throw new Error(`Radio directory returned ${response.status}`);
      const body = await response.json();
      signal?.throwIfAborted();
      return body;
    },
  };
}
