/**
 * The Gods Eye application, embeddable in a host page.
 *
 * The host owns the page and one root element; this module owns everything
 * inside that element while the application runs. It is the standalone
 * composition (`composeApplication`) with host-supplied configuration instead
 * of Vite's `import.meta.env`, the application chrome inserted into `root`,
 * runtime-created floating DOM kept under `root`, asset URLs from the host,
 * and the world-model layer built from the host's ProjectionSource.
 *
 * The world model is the only data source (DWM-136). There is no provider
 * API: every layer with a registered world adapter (`WORLD_LAYER_SOURCE_KEYS`)
 * reads the host's `worldModelSource`; every other source-backed layer has no
 * source, stays registered, and is left out of the panel
 * (`SOURCELESS_LAYER_IDS`). Projected products with no bespoke layer render
 * through the generic world-model layer. A host cannot choose otherwise -- the removed
 * `apiBaseUrl` and `layerSources` options are refused, not ignored, so a host
 * still passing them fails at once instead of silently losing its layers.
 *
 * Styles: load the package's `src/embedded/embedded.css` as a stylesheet
 * (generated from style.css, every rule scoped under `.gods-eye-root`, which
 * this module adds to `root`). The host sizes and positions `root`; static
 * assets come from the package's `public/` directory served at `assetBaseUrl`.
 *
 * Lifecycle: the returned handle is the `createApplication` handle
 * (start/destroy/subscribe/getState/getComponents). One application runs per
 * page at a time; after `destroy()` resolves, a new one may start. Destroy
 * removes the chrome and the font stylesheets it added to <head>, and restores
 * <body> classes, endpoint, layer source and host settings.
 *
 * Nothing here imports server, build or provider modules.
 */
import { composeApplication } from '../standalone/application.js';
import { createStandaloneWorldModelLayer } from '../data/worldModel.js';
import { configureEndpoints } from '../sources/endpoints.js';
import { configureLayerSources } from '../sources/layerSources.js';
import {
  EMBEDDED_LAYER_SOURCES,
  SOURCELESS_LAYER_IDS,
  refuseRemovedOptions,
} from './options.js';
import { configureHostElement } from '../app/host.js';
import {
  attachApplicationStylesheets,
  renderApplicationMarkup,
  ROOT_CLASS,
} from './chrome.js';

export {
  APPLICATION_MARKUP,
  APPLICATION_STYLESHEETS,
  renderApplicationMarkup,
  ROOT_CLASS,
} from './chrome.js';
export { WORLD_MODEL_LAYER_ID } from '../layers/worldModel/index.js';
export { pageOwner } from '../standalone/ownership.js';
export { LAYER_SOURCE_KEYS } from '../sources/layerSources.js';

export {
  EMBEDDED_LAYER_SOURCES,
  SOURCELESS_LAYER_IDS,
  WORLD_LAYER_SOURCE_KEYS,
} from './options.js';

/** Embedded defaults: no page-owning provider dialogs or voice dock. */
export const EMBEDDED_FEATURES = Object.freeze({
  voice: false,
  keySetup: false,
  firstRun: false,
});

/**
 * @param {object} options
 * @param {HTMLElement} options.root Host element, attached to the document.
 * @param {object} options.worldModelSource ProjectionSource for the world-model layer.
 * @param {string|null} [options.googleApiKey] Google Map Tiles key (browser-restricted).
 * @param {string|null} [options.cesiumToken] Cesium ion token.
 * @param {string} [options.assetBaseUrl] Prefix for the package's `public/` assets.
 * @param {object} [options.worldModel] Extra world-model layer options (head, predicates, modalities, displayAssumptions, policyThresholdSeconds, updateInterval, debounceMs).
 * @param {object|null} [options.initialCamera] `{lon, lat, heightM?, rangeM, headingDeg, pitchDeg}`.
 * @param {object} [options.features] Opt in to `voice`, `keySetup`, `firstRun`.
 */
export function createEmbeddedApplication(options = {}) {
  refuseRemovedOptions(options);
  const {
    root,
    worldModelSource,
    googleApiKey = null,
    cesiumToken = null,
    assetBaseUrl,
    worldModel = {},
    initialCamera = null,
    features = {},
  } = options;
  if (!root || typeof root.appendChild !== 'function')
    throw new TypeError('An embedding root element is required');
  if (!worldModelSource)
    throw new TypeError('A world-model ProjectionSource is required');
  let queryRoot = null;
  return composeApplication({
    googleApiKey: googleApiKey || undefined,
    cesiumToken: cesiumToken || undefined,
    features: { ...EMBEDDED_FEATURES, ...features },
    initialCamera,
    ownerLabel: 'embedded',
    hiddenLayerIds: SOURCELESS_LAYER_IDS,
    loadingScreen: () => queryRoot.querySelector('#loading-screen'),
    createWorldModelLayer: () =>
      createStandaloneWorldModelLayer({
        ...worldModel,
        source: worldModelSource,
      }),
    beforeScene({ defer }) {
      if (!root.isConnected)
        throw new Error('The embedding root must be attached to the document');
      const bodyClasses = document.body.className;
      defer(() => {
        document.body.className = bodyClasses;
      });
      defer(configureEndpoints({ apiBaseUrl: null, assetBaseUrl }));
      defer(
        configureLayerSources({
          layerSources: EMBEDDED_LAYER_SOURCES,
          projectionSource: worldModelSource,
          head: worldModel.head,
        }),
      );
      defer(configureHostElement(root));
      defer(attachApplicationStylesheets(document));
      root.classList.add(ROOT_CLASS);
      root.innerHTML = renderApplicationMarkup(assetBaseUrl);
      queryRoot = root;
      defer(() => {
        root.replaceChildren();
        root.classList.remove(ROOT_CLASS);
        queryRoot = null;
      });
    },
  });
}
