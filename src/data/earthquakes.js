import {
  createEarthquakesLayer as createLayer,
  createUsgsEarthquakeSource,
} from '../layers/earthquakes/index.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { createLayerSource } from '../sources/layerSources.js';
export * from '../layers/earthquakes/index.js';
/** Wire the standalone source (direct USGS, in its layer source slot) and application overlay owner. */
export function createEarthquakesLayer({
  source = createLayerSource('earthquakes', createUsgsEarthquakeSource()),
  overlayHost = {
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
  },
} = {}) {
  return createLayer({ source, overlayHost });
}
export default createEarthquakesLayer();
