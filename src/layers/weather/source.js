/** Read the cockpit cloud-weather observation for one point through `/api/weather-effects`. */
export function createWeatherEffectsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  api,
} = {}) {
  if (typeof api !== 'function')
    throw new TypeError(
      'createWeatherEffectsSource requires an api(path) resolver',
    );
  return {
    async getObservation({ latitude, longitude }, { signal } = {}) {
      if (![latitude, longitude].every(Number.isFinite))
        throw new TypeError('A weather observation point is required');
      signal?.throwIfAborted();
      const params = new URLSearchParams({
        latitude: latitude.toFixed(5),
        longitude: longitude.toFixed(5),
      });
      const response = await fetchImpl(api(`/api/weather-effects?${params}`), {
        signal,
      });
      if (!response.ok)
        throw new Error(`Cloud weather unavailable (${response.status})`);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!payload?.weather)
        throw new Error('Cloud weather observation unavailable');
      return payload;
    },
  };
}
