/**
 * The Photoreal | Modelled scene on a fake viewer (GEN-403), with prod's
 * cs-downtown reads (see regionScene.test.mjs) and stand-in loaders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { createRegionScene } from './regionView.js';
import { SCENES, SCENE_STORAGE_KEY } from './regionScene.js';

const read = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const REGION = read('region.cs-downtown.json');
const LISTING = read('tilesets.cs-downtown.json');
const TILEJSON = read('imagery.cs-downtown.tilejson.json');
const OVER_DOWNTOWN = [-104.836, 38.836, 3_000];
const DENVER = [-104.99, 39.74, 3_000];

const settle = async () => {
  for (let i = 0; i < 6; i++)
    await new Promise((resolve) => setImmediate(resolve));
};

function regionSource(overrides = {}) {
  return {
    async getRegions() {
      return { head: 'world/main', regions: REGION.regions };
    },
    async getRegion() {
      return REGION;
    },
    async getRegionTilesets() {
      return LISTING;
    },
    resolveUrl: (path) => `/world${path}`,
    ...overrides,
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

function harness({
  google = true,
  source = regionSource(),
  storage = memoryStorage(),
  at = OVER_DOWNTOWN,
} = {}) {
  const imageryLayers = {
    list: [],
    addImageryProvider(provider) {
      const layer = { provider };
      this.list.push(layer);
      return layer;
    },
    remove(layer) {
      this.list = this.list.filter((l) => l !== layer);
      return true;
    },
  };
  const primitives = {
    list: [],
    add(primitive) {
      this.list.push(primitive);
      return primitive;
    },
    remove(primitive) {
      this.list = this.list.filter((p) => p !== primitive);
      primitive.destroyed = true;
      return true;
    },
  };
  const credits = new Set();
  const camera = {
    positionCartographic: Cesium.Cartographic.fromDegrees(...at),
    changed: new Cesium.Event(),
    moveEnd: new Cesium.Event(),
    flights: [],
    flyToBoundingSphere(sphere, options) {
      this.flights.push({ sphere, options });
    },
  };
  const viewer = {
    imageryLayers,
    camera,
    scene: {
      primitives,
      frameState: {
        creditDisplay: {
          addStaticCredit: (credit) => credits.add(credit.html),
          removeStaticCredit: (credit) => credits.delete(credit.html),
        },
      },
    },
  };
  const stack = {
    active: google ? 'photoreal' : 'esri-imagery',
    override: null,
    calls: [],
    isStackAvailable: (id) => (id === 'photoreal' ? google : true),
    getState() {
      return { activeId: this.active };
    },
    async setStack(id) {
      this.calls.push(id);
      this.active = id;
    },
    async setTerrainOverride(provider) {
      this.override = provider ?? null;
    },
  };
  const loads = { terrain: 0, tileset: 0 };
  const loaders = {
    async terrain(url) {
      loads.terrain++;
      return { kind: 'terrain', url };
    },
    async tileset(url) {
      loads.tileset++;
      return {
        kind: 'tileset',
        url,
        show: true,
        extras: { attribution: `© ${url.split('/').at(-2).slice(0, 14)}` },
        destroy() {},
      };
    },
    imagery: (options) => ({ kind: 'imagery', ...options }),
    async json(url) {
      if (url.endsWith('tilejson.json')) return TILEJSON;
      return {
        heights: 'quantized-mesh heights are NAD83(2011) ellipsoid metres',
      };
    },
    groundAt: async () => 1820,
  };
  const scene = createRegionScene({
    viewer,
    mapStackController: stack,
    globeStack: 'esri-imagery',
    source,
    head: 'world/main',
    storage,
    loaders,
  });
  const moveTo = async (lonLatHeight) => {
    camera.positionCartographic = Cesium.Cartographic.fromDegrees(
      ...lonLatHeight,
    );
    camera.changed.raiseEvent();
    await settle();
  };
  return {
    scene,
    viewer,
    stack,
    credits,
    loads,
    storage,
    camera,
    imageryLayers,
    primitives,
    moveTo,
  };
}

test('Modelled over cs-downtown draws its NAIP, buildings, trees and terrain', async () => {
  const h = harness();
  await h.scene.setScene(SCENES.modelled);
  await settle();
  assert.deepEqual(h.stack.calls, ['esri-imagery']);
  assert.equal(h.imageryLayers.list.length, 1);
  const naip = h.imageryLayers.list[0].provider;
  const imagery = LISTING.tilesets.find((t) => t.layer === 'imagery');
  assert.equal(
    naip.url,
    `/world/tilesets/${imagery.content_id}/{z}/{x}/{y}.png`,
  );
  assert.ok(naip.tilingScheme instanceof Cesium.WebMercatorTilingScheme);
  assert.equal(naip.maximumLevel, TILEJSON.maxzoom);
  assert.equal(h.primitives.list.length, 2);
  assert.ok(h.primitives.list.every((tileset) => tileset.show));
  assert.ok(
    h.primitives.list.every((tileset) =>
      /^\/world\/tilesets\/sha256:/.test(tileset.url),
    ),
  );
  const terrain = LISTING.tilesets.find((t) => t.layer === 'terrain');
  assert.equal(h.stack.override?.url, `/world/tilesets/${terrain.content_id}/`);
  assert.equal(h.credits.size, 2);
  const state = h.scene.state();
  assert.equal(state.scene, SCENES.modelled);
  assert.equal(state.active, 'cs-downtown');
  assert.equal(
    state.regions[0].line,
    'cs-downtown · terrain, imagery, buildings, trees',
  );
  assert.match(state.regions[0].title, /NAD83\(2011\)/);
  assert.equal(h.storage.values.get(SCENE_STORAGE_KEY), SCENES.modelled);
});

test('away from the region the base globe is back: no override, no buildings, none of their credits', async () => {
  const h = harness();
  await h.scene.setScene(SCENES.modelled);
  await settle();
  await h.moveTo(DENVER);
  assert.equal(h.stack.override, null);
  assert.ok(h.primitives.list.every((tileset) => !tileset.show));
  assert.equal(h.credits.size, 0);
  assert.equal(h.scene.state().active, null);
  // NAIP stays: it is limited to the box and drapes on whichever ground is there.
  assert.equal(h.imageryLayers.list.length, 1);
  await h.moveTo(OVER_DOWNTOWN);
  assert.equal(h.stack.override?.kind, 'terrain');
  assert.ok(h.primitives.list.every((tileset) => tileset.show));
  // The terrain is built once per content id.
  assert.equal(h.loads.terrain, 1);
});

test('Photoreal takes everything down, and back to Modelled leaks nothing', async () => {
  const h = harness();
  await h.scene.setScene(SCENES.modelled);
  await settle();
  const first = [...h.primitives.list];
  await h.scene.setScene(SCENES.photoreal);
  await settle();
  assert.deepEqual(h.stack.calls, ['esri-imagery', 'photoreal']);
  assert.equal(h.stack.override, null);
  assert.equal(h.imageryLayers.list.length, 0);
  assert.equal(h.primitives.list.length, 0);
  assert.ok(first.every((tileset) => tileset.destroyed));
  assert.equal(h.credits.size, 0);
  assert.deepEqual(h.scene.state().regions, []);
  await h.scene.setScene(SCENES.modelled);
  await settle();
  assert.equal(h.imageryLayers.list.length, 1);
  assert.equal(h.primitives.list.length, 2);
  assert.equal(h.credits.size, 2);
});

test('the scene opens as remembered, else Photoreal with Google; without Google only Modelled', async () => {
  const fresh = harness();
  await fresh.scene.start();
  assert.equal(fresh.scene.scene(), SCENES.photoreal);
  // Already on Google's tiles: nothing is switched, nothing is remembered.
  assert.deepEqual(fresh.stack.calls, []);
  assert.equal(fresh.storage.values.size, 0);

  const remembered = harness({
    storage: memoryStorage({ [SCENE_STORAGE_KEY]: 'modelled' }),
  });
  await remembered.scene.start();
  assert.equal(remembered.scene.scene(), SCENES.modelled);

  const keyless = harness({ google: false });
  await keyless.scene.start();
  assert.equal(keyless.scene.scene(), SCENES.modelled);
  assert.deepEqual(keyless.stack.calls, [], 'already on the keyless globe');
  assert.match(
    keyless.scene.state().available.photoreal,
    /Google 3D tiles did not load/,
  );
  await keyless.scene.setScene(SCENES.photoreal);
  assert.equal(keyless.scene.scene(), SCENES.modelled);
});

test('a source without regions shows the base globe and says so', async () => {
  const h = harness({ source: {} });
  await h.scene.setScene(SCENES.modelled);
  await settle();
  assert.equal(h.imageryLayers.list.length, 0);
  assert.equal(h.primitives.list.length, 0);
  assert.equal(h.stack.override, null);
  assert.equal(
    h.scene.state().error,
    'this World Model source serves no regions',
  );
});

test('a region without its terrain is listed as not drawn and adds nothing', async () => {
  const listing = {
    ...LISTING,
    tilesets: LISTING.tilesets.filter((t) => t.layer !== 'terrain'),
  };
  const h = harness({
    source: regionSource({ getRegionTilesets: async () => listing }),
  });
  await h.scene.setScene(SCENES.modelled);
  await settle();
  assert.equal(h.imageryLayers.list.length, 0);
  assert.equal(h.primitives.list.length, 0);
  assert.equal(h.stack.override, null);
  assert.equal(
    h.scene.state().regions[0].line,
    'cs-downtown not drawn: no terrain tileset yet',
  );
});

test('a failed region read is said, not drawn as an empty world', async () => {
  const error = Object.assign(new Error('World model unreachable (502)'), {
    status: 502,
  });
  const h = harness({
    source: regionSource({ getRegions: async () => Promise.reject(error) }),
  });
  await h.scene.setScene(SCENES.modelled);
  await settle();
  assert.match(
    h.scene.state().error,
    /^regions not read: World model unreachable/,
  );
});

test('flyTo looks at the region from the south at its sampled ground, in either scene', async () => {
  const h = harness({ at: DENVER });
  await h.scene.start();
  assert.equal(h.scene.scene(), SCENES.photoreal);
  assert.equal(await h.scene.flyTo('cs-downtown'), true);
  const [flight] = h.camera.flights;
  const centre = Cesium.Cartographic.fromCartesian(flight.sphere.center);
  assert.ok(Math.abs(centre.height - 1820) < 1e-3);
  assert.equal(flight.options.offset.heading, 0);
  assert.ok(flight.options.offset.pitch < 0);
  assert.equal(await h.scene.flyTo('nowhere'), false);
});

test('destroy takes the scene down and clears the terrain', async () => {
  const h = harness();
  await h.scene.setScene(SCENES.modelled);
  await settle();
  let emitted = 0;
  h.scene.subscribe(() => emitted++);
  h.scene.destroy();
  await settle();
  assert.equal(h.imageryLayers.list.length, 0);
  assert.equal(h.primitives.list.length, 0);
  assert.equal(h.stack.override, null);
  await h.moveTo(DENVER);
  assert.equal(emitted, 0);
});

test('Google’s tiles shown from elsewhere end Modelled', async () => {
  const target = new EventTarget();
  globalThis.addEventListener = target.addEventListener.bind(target);
  globalThis.removeEventListener = target.removeEventListener.bind(target);
  try {
    const h = harness();
    await h.scene.setScene(SCENES.modelled);
    await settle();
    h.stack.active = 'photoreal';
    target.dispatchEvent(
      new CustomEvent('gev:map-stack-changed', {
        detail: { status: 'ready', activeId: 'photoreal' },
      }),
    );
    await settle();
    assert.equal(h.scene.scene(), SCENES.photoreal);
    assert.equal(h.primitives.list.length, 0);
    h.scene.destroy();
  } finally {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
  }
});

test('a storage that throws only forgets the choice', async () => {
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const h = harness({ storage: broken });
  await h.scene.start();
  assert.equal(h.scene.scene(), SCENES.photoreal);
  await h.scene.setScene(SCENES.modelled);
  assert.equal(h.scene.scene(), SCENES.modelled);
});
