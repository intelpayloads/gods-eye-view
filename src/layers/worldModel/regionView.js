/**
 * The Photoreal | Modelled scene, drawn (GEN-403). The rules are in
 * `regionScene.js`; this module only puts them on the globe.
 *
 * Photoreal is the map stack's Google tiles. Modelled is the map stack's
 * keyless globe (`globeStack`, today's look without a key) with each region
 * the world has drawn over it:
 *  - its NAIP imagery as an imagery layer above the base imagery, limited to
 *    the region's box;
 *  - its buildings and trees as 3D tilesets, shown only while the region
 *    holds the globe's terrain, so they never stand on another ground;
 *  - its terrain as the globe's terrain while the camera is over its ring
 *    (`mapStackController.setTerrainOverride`), the base globe's elsewhere.
 *
 * Every file is read at its content-id URL through the source's `resolveUrl`.
 * Credits are each layer's own attribution, on screen while it is drawn.
 * The regions are read on each switch to Modelled; nothing polls.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../../renderGovernor.js';
import { sourceFeatures } from './source.js';
import {
  REGION_DISPLAY_FACT,
  SCENES,
  SCENE_STORAGE_KEY,
  activeRegionAt,
  imageryOf,
  initialScene,
  regionCamera,
  regionLine,
  regionNamesOf,
  regionSceneOf,
} from './regionScene.js';

const RENDER_OWNER = 'region-scene';
const FLY_SECONDS = 2;

const DEFAULT_LOADERS = Object.freeze({
  terrain: (url) =>
    Cesium.CesiumTerrainProvider.fromUrl(url, { requestVertexNormals: true }),
  tileset: (url) => Cesium.Cesium3DTileset.fromUrl(url),
  imagery: (options) => new Cesium.UrlTemplateImageryProvider(options),
  async json(url, signal) {
    const response = await globalThis.fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.json();
  },
  async groundAt(provider, lon, lat) {
    const [point] = await Cesium.sampleTerrainMostDetailed(provider, [
      Cesium.Cartographic.fromDegrees(lon, lat),
    ]);
    return point?.height;
  },
});

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {object} options.viewer
 * @param {object} options.mapStackController The scene's map stacks; Photoreal is its `photoreal`.
 * @param {string} [options.globeStack] The keyless stack Modelled draws over.
 * @param {object} options.source The ProjectionSource; without region methods Modelled is the base globe.
 * @param {string} [options.head] The world head regions are read on.
 * @param {Storage|null} [options.storage] Where the choice is remembered.
 * @param {object} [options.loaders] Test seams for Cesium's loaders and fetch.
 */
export function createRegionScene({
  viewer,
  mapStackController,
  globeStack = 'esri-imagery',
  source,
  head,
  storage = browserStorage(),
  loaders = {},
}) {
  const load = { ...DEFAULT_LOADERS, ...loaders };
  const offered = sourceFeatures(source).regions;
  const controller = new AbortController();
  const signal = controller.signal;
  const listeners = new Set();
  const terrains = new Map(); // terrain content id -> Promise<TerrainProvider>
  const drawn = new Map(); // region name -> what Modelled added for it
  let scene = null;
  let regions = [];
  let reading = null;
  let readError = null;
  let loaded = false; // this Modelled entry's regions are read
  let active = null;
  let switching = Promise.resolve();
  let removeCameraListeners = null;
  let destroyed = false;

  const photorealAvailable = () =>
    Boolean(mapStackController?.isStackAvailable?.(SCENES.photoreal));
  const creditDisplay = () => viewer.scene?.frameState?.creditDisplay ?? null;
  const render = () => governorRequestRender(RENDER_OWNER);

  function readStored() {
    try {
      return storage?.getItem(SCENE_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  function store(id) {
    try {
      storage?.setItem(SCENE_STORAGE_KEY, id);
    } catch {
      // A blocked storage only forgets the choice.
    }
  }

  function state() {
    return Object.freeze({
      scene,
      available: Object.freeze({
        [SCENES.photoreal]: photorealAvailable()
          ? null
          : 'Google 3D tiles did not load here (no key, offline, or refused)',
        [SCENES.modelled]: null,
      }),
      error: scene === SCENES.modelled ? readError : null,
      reading: scene === SCENES.modelled && !loaded && !readError,
      active,
      regions: Object.freeze(
        scene === SCENES.modelled
          ? regions.map((region) => {
              const entry = drawn.get(region.name);
              const notes = entry?.notes ?? [];
              return Object.freeze({
                name: region.name,
                drawn: region.drawn,
                line: [regionLine(region), ...notes].join(' · '),
                title: [entry?.heights, REGION_DISPLAY_FACT]
                  .filter(Boolean)
                  .join('\n'),
              });
            })
          : [],
      ),
    });
  }

  function emit() {
    if (destroyed) return;
    const snapshot = state();
    for (const listener of listeners) listener(snapshot);
  }

  function note(entry, text) {
    if (!entry.notes.includes(text)) entry.notes.push(text);
    emit();
  }

  function readRegions() {
    if (!offered) {
      readError = 'this World Model source serves no regions';
      return Promise.resolve([]);
    }
    reading ??= (async () => {
      const names = regionNamesOf(await source.getRegions({ head, signal }));
      return Promise.all(
        names.map(async (name) => {
          const [region, listing] = await Promise.all([
            source.getRegion({ name, head, signal }),
            source
              .getRegionTilesets({ name, head, signal })
              .catch((error) =>
                error?.status === 404 ? null : Promise.reject(error),
              ),
          ]);
          return regionSceneOf({
            name,
            region,
            listing,
            resolveUrl: (path) => source.resolveUrl(path),
          });
        }),
      );
    })().then(
      (read) => {
        readError = null;
        return read;
      },
      (error) => {
        reading = null;
        if (error?.name !== 'AbortError')
          readError = `regions not read: ${error?.message || error}`;
        return [];
      },
    );
    return reading;
  }

  function terrainFor(region) {
    const meta = region.layers.terrain;
    if (!meta) return Promise.resolve(null);
    if (!terrains.has(meta.contentId)) {
      const pending = Promise.resolve(load.terrain(meta.url));
      terrains.set(meta.contentId, pending);
      pending.catch(() => terrains.delete(meta.contentId));
    }
    return terrains.get(meta.contentId).catch((error) => {
      const entry = drawn.get(region.name);
      if (entry)
        note(entry, `terrain did not load: ${error?.message || error}`);
      return null;
    });
  }

  function syncShown(entry) {
    const show = scene === SCENES.modelled && active === entry.region.name;
    for (const item of entry.tilesets) {
      item.tileset.show = show;
      if (item.credit && item.shown !== show) {
        try {
          if (show) creditDisplay()?.addStaticCredit(item.credit);
          else creditDisplay()?.removeStaticCredit(item.credit);
        } catch {
          // A Cesium build without static credits must not break the scene.
        }
      }
      item.shown = show;
    }
    render();
  }

  const stillDrawn = (entry) =>
    !destroyed &&
    scene === SCENES.modelled &&
    drawn.get(entry.region.name) === entry;

  function drawRegion(region) {
    if (drawn.has(region.name)) return;
    const entry = {
      region,
      imagery: null,
      tilesets: [],
      heights: null,
      notes: [],
    };
    drawn.set(region.name, entry);
    const { terrain, imagery } = region.layers;
    load.json(terrain.rootUrl, signal).then(
      (layer) => {
        if (stillDrawn(entry) && typeof layer?.heights === 'string') {
          entry.heights = `terrain: ${layer.heights}`;
          emit();
        }
      },
      () => {},
    );
    if (imagery) {
      load
        .json(imagery.rootUrl, signal)
        .then((tilejson) => {
          if (!stillDrawn(entry)) return;
          const { imagery: drawable, reason } = imageryOf(
            tilejson,
            imagery.url,
          );
          if (!drawable) return note(entry, reason);
          const { west, south, east, north } = drawable.box;
          const provider = load.imagery({
            url: drawable.url,
            tilingScheme: new Cesium.WebMercatorTilingScheme(),
            rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
            maximumLevel: drawable.maximumLevel,
            tileWidth: drawable.tileSize,
            tileHeight: drawable.tileSize,
            credit: drawable.attribution
              ? new Cesium.Credit(drawable.attribution)
              : undefined,
          });
          entry.imagery = viewer.imageryLayers.addImageryProvider(provider);
          render();
        })
        .catch((error) => {
          if (stillDrawn(entry))
            note(entry, `imagery did not load: ${error?.message || error}`);
        });
    }
    for (const layer of ['buildings', 'trees']) {
      const meta = region.layers[layer];
      if (!meta) continue;
      Promise.resolve(load.tileset(meta.rootUrl))
        .then((tileset) => {
          if (!stillDrawn(entry)) {
            if (!tileset.isDestroyed?.()) tileset.destroy?.();
            return;
          }
          tileset.show = false;
          viewer.scene.primitives.add(tileset);
          const attribution = tileset.extras?.attribution;
          entry.tilesets.push({
            layer,
            tileset,
            credit:
              typeof attribution === 'string' && attribution
                ? new Cesium.Credit(attribution)
                : null,
            shown: false,
          });
          syncShown(entry);
        })
        .catch((error) => {
          if (stillDrawn(entry))
            note(entry, `${layer} did not load: ${error?.message || error}`);
        });
    }
  }

  function cameraAt() {
    const carto = viewer.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height,
    };
  }

  async function updateActive() {
    if (destroyed || scene !== SCENES.modelled) return;
    const region = activeRegionAt(regions, cameraAt(), active);
    const name = region?.name ?? null;
    if (name === active) return;
    active = name;
    for (const entry of drawn.values()) syncShown(entry);
    const provider = region ? await terrainFor(region) : null;
    // A later move or a scene switch owns the terrain now.
    if (destroyed || active !== name || scene !== SCENES.modelled) return;
    await mapStackController.setTerrainOverride(provider);
    emit();
  }

  function watchCamera() {
    if (removeCameraListeners) return;
    const onMove = () => void updateActive();
    const removers = [
      viewer.camera?.changed?.addEventListener(onMove),
      viewer.camera?.moveEnd?.addEventListener(onMove),
    ].filter((remove) => typeof remove === 'function');
    removeCameraListeners = () => {
      for (const remove of removers) remove();
    };
  }

  function takeDown() {
    removeCameraListeners?.();
    removeCameraListeners = null;
    for (const entry of drawn.values()) {
      if (entry.imagery) viewer.imageryLayers.remove(entry.imagery, true);
      for (const item of entry.tilesets) {
        if (item.shown && item.credit) {
          try {
            creditDisplay()?.removeStaticCredit(item.credit);
          } catch {
            // As in syncShown.
          }
        }
        viewer.scene.primitives.remove(item.tileset);
      }
    }
    drawn.clear();
    regions = [];
    loaded = false;
    active = null;
    reading = null;
    render();
  }

  const stackShown = () => mapStackController.getState?.().activeId ?? null;

  async function enter(next) {
    if (next === SCENES.photoreal) {
      takeDown();
      await mapStackController.setTerrainOverride(null);
      if (stackShown() !== SCENES.photoreal)
        await mapStackController.setStack(SCENES.photoreal);
      return;
    }
    // Modelled draws over the globe stack on screen; from Photoreal, over the keyless one.
    if (stackShown() === SCENES.photoreal)
      await mapStackController.setStack(globeStack);
    const read = await readRegions();
    if (destroyed || scene !== SCENES.modelled) return;
    regions = read;
    loaded = true;
    emit();
    for (const region of regions) if (region.drawn) drawRegion(region);
    watchCamera();
    await updateActive();
  }

  /**
   * Show a scene; Photoreal without Google tiles shows Modelled. Resolves once
   * the scene is up (Modelled: its regions read and the camera's region taken).
   */
  function setScene(id, { remember = true } = {}) {
    if (destroyed) return Promise.resolve(state());
    const next =
      id === SCENES.photoreal && photorealAvailable()
        ? SCENES.photoreal
        : SCENES.modelled;
    if (remember) store(next);
    if (next === scene) return switching.then(state);
    scene = next;
    emit();
    switching = switching
      .then(() => (scene === next ? enter(next) : undefined))
      .catch((error) => {
        readError = `scene did not switch: ${error?.message || error}`;
      })
      .then(emit);
    return switching.then(state);
  }

  /**
   * Fly to a region's box, looking from the south at its ground (the region's
   * terrain sampled at the centre); in either scene. False when the world has
   * no such region.
   */
  async function flyTo(name) {
    if (destroyed) return false;
    const known = regions.length ? regions : await readRegions();
    const region = known.find((r) => r.name === name && r.box);
    if (!region || destroyed) return false;
    let ground = 0;
    const provider = await terrainFor(region);
    if (provider) {
      try {
        ground = (await load.groundAt(provider, ...centre(region))) ?? 0;
      } catch {
        ground = 0;
      }
    }
    if (destroyed) return false;
    const view = regionCamera(region, ground);
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        0,
      ),
      {
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(view.headingDeg),
          Cesium.Math.toRadians(view.pitchDeg),
          view.rangeM,
        ),
        duration: FLY_SECONDS,
      },
    );
    render();
    return true;
  }

  // Google's tiles shown from elsewhere (a voice command, the standalone chips) end Modelled:
  // the two scenes never stack.
  const onStackChanged = (event) => {
    const detail = event?.detail;
    if (
      scene === SCENES.modelled &&
      detail?.status === 'ready' &&
      detail.activeId === SCENES.photoreal
    )
      void setScene(SCENES.photoreal);
  };
  globalThis.addEventListener?.('gev:map-stack-changed', onStackChanged);

  return Object.freeze({
    /** Open in the remembered scene if it is still on offer, else as `initialScene` says. */
    start() {
      return setScene(
        initialScene({
          stored: readStored(),
          photorealAvailable: photorealAvailable(),
        }),
        { remember: false },
      );
    },
    scene: () => scene,
    state,
    setScene,
    flyTo,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      controller.abort();
      globalThis.removeEventListener?.('gev:map-stack-changed', onStackChanged);
      takeDown();
      void mapStackController.setTerrainOverride?.(null);
      destroyed = true;
      listeners.clear();
    },
  });
}

function centre(region) {
  return [
    (region.box.west + region.box.east) / 2,
    (region.box.south + region.box.north) / 2,
  ];
}
