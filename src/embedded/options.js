/**
 * What an embedding host may configure about data sources: nothing (DWM-136).
 *
 * Kept apart from `application.js` so the rule is testable without a browser.
 */
import {
  LAYER_SOURCE_KEYS,
  WORLD_LAYER_SOURCES,
} from '../sources/layerSources.js';

/** Layer source keys that have a world adapter. */
export const WORLD_LAYER_SOURCE_KEYS = Object.freeze(
  Object.keys(WORLD_LAYER_SOURCES),
);

/** Every layer with a world adapter, on 'world': the embedded source table. */
export const EMBEDDED_LAYER_SOURCES = Object.freeze(
  Object.fromEntries(WORLD_LAYER_SOURCE_KEYS.map((key) => [key, 'world'])),
);

/**
 * Layers hidden from the embedded panel: a source key is its layer's id, so a
 * key with no world adapter is a layer with nothing to read. It stays
 * registered; it appears once its adapter lands.
 */
export const SOURCELESS_LAYER_IDS = Object.freeze(
  LAYER_SOURCE_KEYS.filter((key) => !WORLD_LAYER_SOURCE_KEYS.includes(key)),
);

const REMOVED_OPTIONS = Object.freeze(['apiBaseUrl', 'layerSources']);

/** Refuse options a host may no longer pass: refused, never ignored. */
export function refuseRemovedOptions(options) {
  for (const name of REMOVED_OPTIONS)
    if (options && Object.hasOwn(options, name))
      throw new TypeError(
        `${name} was removed (DWM-136): the embedded application reads only the world model`,
      );
}
