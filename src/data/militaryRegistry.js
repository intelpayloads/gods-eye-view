import { createMilitaryRegistry } from '../layers/aircraft/classification.js';
import { createAdsbLolSource } from '../sources/live/standalone.js';
import { apiUrl } from '../sources/endpoints.js';
import { createLayerSource } from '../sources/layerSources.js';

// Identity classification is military flight data: it shares the military slot.
const registry = createMilitaryRegistry({
  source: createLayerSource('military', createAdsbLolSource({ api: apiUrl })),
});
export const isMilitaryLayerActive = registry.isMilitaryLayerActive;
export const setMilitaryLayerActive = registry.setMilitaryLayerActive;
export const onMilitaryLayerActiveChange = registry.onMilitaryLayerActiveChange;
export const registerMilitaryIcaos = registry.registerMilitaryIcaos;
export const isMilitaryIcao = registry.isMilitaryIcao;
export const refreshMilitaryRegistryIfStale =
  registry.refreshMilitaryRegistryIfStale;
