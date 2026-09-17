/**
 * Where each Gods Eye layer reads its data: its provider source or the world model.
 *
 * Every layer composition wraps its provider source (the compat provider API,
 * or direct USGS for earthquakes) in `createLayerSource(key, providerSource)`.
 * The wrapper has the provider source's method names and picks the source per
 * call, so import-time layer singletons follow the configuration a host sets
 * later:
 *
 *   'provider'  the provider source, as the standalone shell always did
 *   'world'     the layer's world adapter from `WORLD_LAYER_SOURCES`
 *
 * A world adapter is `({ projectionSource, head }) => source`. It reads the
 * host's ProjectionSource (the same transport as the world-model layer) and
 * returns what the provider source returns, method for method, so the layer
 * renders unchanged. The adapter lives next to its layer
 * (`src/layers/<layer>/worldSource.js`); a connector ticket registers it here.
 * Registered so far: earthquakes (DWM-28, `world.earthquakes`).
 *
 * The standalone default is every layer on 'provider'; a host that embeds
 * the application (the Dataforge client) flips a registered layer to 'world'.
 */
import { HEAD } from '../layers/worldModel/view.js';
import { createWorldEarthquakeSource } from '../layers/earthquakes/worldSource.js';

/** Layer ids (and the cockpit weather effect) whose data source is switchable. */
export const LAYER_SOURCE_KEYS = Object.freeze([
  'flights',
  'military',
  'ais-live-vessels',
  'satellites',
  'earthquakes',
  'local-firms',
  'rocket-launches',
  'traffic',
  'cctv',
  'military-installations',
  'bikeshare',
  'radio',
  'weather-effects',
]);

export const LAYER_SOURCE_MODES = Object.freeze(['provider', 'world']);

/** Registered world adapters, key -> `({ projectionSource, head }) => source`. */
export const WORLD_LAYER_SOURCES = Object.freeze({
  earthquakes: createWorldEarthquakeSource,
});

const DEFAULTS = Object.freeze({
  modes: Object.freeze({}),
  adapters: Object.freeze({}),
});
let current = DEFAULTS;
const created = new Set();

/**
 * Replace the layer source configuration. Returns a function that restores the
 * configuration it replaced (only if nothing reconfigured it since).
 *
 * @param {object} [config]
 * @param {Record<string, 'provider'|'world'>} [config.layerSources] Unlisted keys stay 'provider'.
 * @param {object} [config.projectionSource] Required when any key is 'world'.
 * @param {string} [config.head] Head the world adapters read (world/main).
 * @param {Record<string, Function>} [config.worldSources] Adapter registry (tests).
 */
export function configureLayerSources({
  layerSources = {},
  projectionSource,
  head = HEAD,
  worldSources = WORLD_LAYER_SOURCES,
} = {}) {
  if (
    !layerSources ||
    typeof layerSources !== 'object' ||
    Array.isArray(layerSources)
  )
    throw new TypeError('layerSources must be an object of layer key -> mode');
  const modes = {};
  const adapters = {};
  for (const [key, mode] of Object.entries(layerSources)) {
    if (!LAYER_SOURCE_KEYS.includes(key))
      throw new TypeError(`Unknown layer source key: ${key}`);
    if (!LAYER_SOURCE_MODES.includes(mode))
      throw new TypeError(
        `Layer source for ${key} must be 'provider' or 'world', received ${JSON.stringify(mode)}`,
      );
    modes[key] = mode;
    if (mode !== 'world') continue;
    if (
      !Object.hasOwn(worldSources, key) ||
      typeof worldSources[key] !== 'function'
    )
      throw new TypeError(
        `Layer ${key} has no world adapter; keep it 'provider' until one is registered`,
      );
    if (typeof projectionSource?.getProjection !== 'function')
      throw new TypeError(
        `Layer ${key} reads the world model and requires a ProjectionSource`,
      );
    const adapter = worldSources[key]({ projectionSource, head });
    if (!adapter || typeof adapter !== 'object')
      throw new TypeError(`The world adapter for ${key} returned no source`);
    adapters[key] = adapter;
  }
  const previous = current;
  const next = Object.freeze({
    modes: Object.freeze(modes),
    adapters: Object.freeze(adapters),
  });
  current = next;
  return () => {
    if (current === next) current = previous;
  };
}

/** Restore the standalone defaults (every layer on its provider source). */
export function resetLayerSources() {
  current = DEFAULTS;
}

/** The configured mode for one layer key. */
export function layerSourceMode(key) {
  return current.modes[key] ?? 'provider';
}

/** Keys a composition has wrapped with `createLayerSource` in this runtime. */
export function createdLayerSourceKeys() {
  return [...created];
}

/**
 * Wrap a layer's provider source in its slot.
 *
 * Methods delegate per call to the world adapter when the key is 'world',
 * else to the provider source; other properties (a source `label`) read from
 * the active source.
 * @param {string} key One of LAYER_SOURCE_KEYS.
 * @param {object} providerSource
 */
export function createLayerSource(key, providerSource) {
  if (!LAYER_SOURCE_KEYS.includes(key))
    throw new TypeError(`Unknown layer source key: ${key}`);
  if (!providerSource || typeof providerSource !== 'object')
    throw new TypeError(`Layer ${key} requires a provider source`);
  const active = () =>
    current.modes[key] === 'world' ? current.adapters[key] : providerSource;
  const slot = {};
  for (const name of Object.keys(providerSource)) {
    if (typeof providerSource[name] === 'function') {
      slot[name] = (...args) => {
        const source = active();
        if (typeof source[name] !== 'function')
          throw new TypeError(
            `The world adapter for ${key} does not implement ${name}()`,
          );
        return source[name](...args);
      };
    } else {
      Object.defineProperty(slot, name, {
        enumerable: true,
        get: () => active()[name],
      });
    }
  }
  created.add(key);
  return Object.freeze(slot);
}
