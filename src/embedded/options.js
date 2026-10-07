/**
 * What an embedding host may configure about data sources: nothing (DWM-136).
 *
 * Kept apart from `application.js` so the rule is testable without a browser.
 */
import {
  LAYER_SOURCE_KEYS,
  WORLD_LAYER_CLAIMS,
  WORLD_LAYER_SOURCES,
} from '../sources/layerSources.js';
import { REGISTERED_LAYER_IDS } from '../data/layerState.js';

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

/** The generic world-model layer's id (`WORLD_MODEL_LAYER_ID`). */
const GENERIC_WORLD_LAYER_ID = 'world-model';

/**
 * Layers left out of the embedded panel: the sourceless ones, and the generic
 * world-model layer, whose products are rows of their own here (DWM-189).
 */
export const EMBEDDED_HIDDEN_LAYER_IDS = Object.freeze([
  ...SOURCELESS_LAYER_IDS,
  GENERIC_WORLD_LAYER_ID,
]);

/** `World Model · world.aircraft` for a one-binding connector, else `World Model`. */
function claimText({ bindings = [], types = [] }) {
  return bindings.length === 1 && types.length === 0
    ? `World Model · ${bindings[0]}`
    : 'World Model';
}

/**
 * Panel section and source line per shown layer (DWM-189): every connector
 * reads the world model and its row says what of it; the static local layers
 * are reference geography. Product layers carry their own section.
 */
export const EMBEDDED_PANEL_LABELS = Object.freeze(
  Object.fromEntries([
    ...WORLD_LAYER_SOURCE_KEYS.map((key) => [
      key,
      Object.freeze({
        section: 'Connectors',
        source: claimText(WORLD_LAYER_CLAIMS[key] ?? {}),
      }),
    ]),
    ...REGISTERED_LAYER_IDS.filter(
      (id) =>
        !WORLD_LAYER_SOURCE_KEYS.includes(id) &&
        !EMBEDDED_HIDDEN_LAYER_IDS.includes(id),
    ).map((id) => [id, Object.freeze({ section: 'Reference' })]),
  ]),
);
