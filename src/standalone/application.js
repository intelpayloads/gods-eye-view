import { createStandalonePlaceSearch } from './placeSearch.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { acquirePageOwnership } from './ownership.js';
import { resetContextStore } from '../data/contextStore.js';

/**
 * Compose the application from the standalone phases.
 *
 * Both the standalone page (`src/main.js`) and an embedding host
 * (`src/embedded/application.js`) go through this one composition. Only one
 * composed application runs per page at a time: ownership is acquired when
 * the scene phase starts and released after the last cleanup, so a new
 * application may start once the previous one is destroyed.
 *
 * @param {object} options
 * @param {string|null} [options.googleApiKey]
 * @param {string|null} [options.cesiumToken]
 * @param {boolean} [options.allowQaRegistration]
 * @param {() => HTMLElement} options.loadingScreen Resolves `#loading-screen` once the scene phase has run host setup.
 * @param {() => object} options.createWorldModelLayer Builds this application's world-model layer.
 * @param {object} [options.features] See STANDALONE_FEATURES in ./tools.js.
 * @param {object|null} [options.initialCamera] Camera when no share link is present.
 * @param {(context: object) => void} [options.beforeScene] Host setup run first in the scene phase (context has `defer`, `signal`).
 * @param {string} [options.ownerLabel]
 */
export function composeApplication({
  googleApiKey,
  cesiumToken,
  allowQaRegistration = false,
  loadingScreen,
  createWorldModelLayer,
  features,
  initialCamera = null,
  beforeScene = null,
  ownerLabel = 'standalone',
}) {
  if (typeof createWorldModelLayer !== 'function')
    throw new TypeError('createWorldModelLayer must be a function');
  let placeSearch;
  let loaderStatus;
  return createApplication({
    createScene: (context) => {
      // Registered first, so it is released after every other cleanup.
      context.defer(acquirePageOwnership(ownerLabel));
      // Selection/context records point at this application's entities.
      context.defer(resetContextStore);
      beforeScene?.(context);
      loaderStatus = loadingScreen().querySelector('.loader-status');
      placeSearch = createStandalonePlaceSearch({
        resolveApiKey: () => googleApiKey,
        signal: context.signal,
      });
      return createStandaloneScene({
        ...context,
        googleApiKey,
        cesiumToken,
        loaderStatus,
      });
    },
    createControls: (context) =>
      createStandaloneControls({
        ...context,
        loaderStatus,
        placeSearch,
        initialCamera,
      }),
    createData: (context) =>
      createStandaloneData({
        ...context,
        allowQaRegistration,
        worldModelLayer: createWorldModelLayer(),
      }),
    createTools: (context) =>
      createStandaloneTools({
        ...context,
        loadingScreen: loadingScreen(),
        placeSearch,
        features,
      }),
  });
}

/** Compose the standalone application that owns this page's document. */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  allowQaRegistration = false,
  createWorldModelLayer,
}) {
  return composeApplication({
    googleApiKey,
    cesiumToken,
    allowQaRegistration,
    loadingScreen: () => document.getElementById('loading-screen'),
    createWorldModelLayer,
  });
}
