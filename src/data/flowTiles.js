import { createFlowTileSource } from '../layers/traffic/flowSource.js';
import { apiUrl } from '../sources/endpoints.js';
import { createLayerSource } from '../sources/layerSources.js';
export { tilesForBounds } from './tomtomTiles.js';
export { decodeFlowTile } from '../layers/traffic/flowDecode.js';
// Flow tiles are part of the traffic layer's data: they share its slot.
const source = createLayerSource(
  'traffic',
  createFlowTileSource({ api: apiUrl }),
);
export const { fetchFlowForBounds, getFlowSessionStats, resetFlowTileCache } =
  source;
