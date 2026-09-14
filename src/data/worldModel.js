/**
 * Standalone wiring for the world-model layer.
 *
 * Transport choice of the STANDALONE shell only: an HTTP ProjectionSource
 * pointed at the local development proxy `/api/world` (see
 * `server/providers/world.js`, which forwards to `WORLD_API_URL`). This is a
 * development adapter, not the world-model browser architecture. The
 * layer/source contract does not require it: the Dataforge client supplies
 * its own ProjectionSource (Dataforge Serve v2 forwarding the caller's
 * token/context). Nothing under `src/layers/worldModel/` knows this path.
 */
import * as Cesium from 'cesium';
import {
  createHttpProjectionSource,
  createWorldModelLayer,
} from '../layers/worldModel/index.js';
import * as context from './contextStore.js';
import * as picking from './pickRegistry.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
export * from '../layers/worldModel/index.js';

export const STANDALONE_WORLD_MODEL_BASE_URL = '/api/world';

/** Wire the standalone source and the application's shared service owners. */
export function createStandaloneWorldModelLayer({
  source = createHttpProjectionSource({
    baseUrl: STANDALONE_WORLD_MODEL_BASE_URL,
  }),
  overlayHost = {
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
  },
} = {}) {
  return createWorldModelLayer({
    source,
    services: { context, picking },
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  });
}
export default createStandaloneWorldModelLayer();
