/** A host-supplied basemap (embedded `basemap` option, GEN-367): the offline map posture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MapStackController, MAP_STACKS } from './mapStackController.js';

const BASEMAP = Object.freeze({
  tileUrl: '/tiles/{z}/{x}/{y}.png',
  attribution: 'Protomaps © OpenStreetMap contributors',
  maxZoom: 14,
});

test('a host basemap makes osm the keyless default and the only stack that can be picked', () => {
  const controller = new MapStackController({}, { basemap: BASEMAP });
  const state = controller.getState();
  assert.equal(state.activeId, 'osm');
  for (const stack of MAP_STACKS)
    assert.equal(controller.isStackAvailable(stack.id), stack.id === 'osm', stack.id);
  const esri = state.stacks.find((s) => s.id === 'esri-imagery');
  assert.match(esri.unavailableReason, /Offline: only the configured basemap/);
});

test('without a host basemap nothing changes: Esri stays the keyless default', () => {
  const controller = new MapStackController({});
  assert.equal(controller.getState().activeId, 'esri-imagery');
  assert.equal(controller.isStackAvailable('osm'), true);
  assert.equal(controller.isStackAvailable('esri-imagery'), true);
});

test('the osm stack draws the host template, never tile.openstreetmap.org, over flat terrain', async () => {
  const controller = new MapStackController({}, { basemap: BASEMAP });
  const { provider, effectiveStackId } = await controller._getImageryProvider(controller.getStack('osm'));
  assert.equal(effectiveStackId, 'osm');
  assert.ok(provider instanceof Cesium.UrlTemplateImageryProvider);
  assert.equal(provider.url, BASEMAP.tileUrl);
  assert.equal(provider.maximumLevel, 14);
  // No Re:Earth terrain fetch: the keyless terrain is the ellipsoid.
  assert.ok((await controller._getKeylessTerrainProvider()) instanceof Cesium.EllipsoidTerrainProvider);
});

/** Enough of a Cesium viewer for a globe-stack switch: records terrain installs. */
function fakeViewer() {
  const calls = { setTerrain: 0, imagery: 0 };
  return {
    calls,
    imageryLayers: { add: () => { calls.imagery++; }, remove: () => {} },
    scene: { globe: { show: false }, setTerrain: () => { calls.setTerrain++; } },
    terrainProvider: null,
  };
}

test('a host basemap wins over a photoreal tileset the host also has: osm, and photoreal unavailable', () => {
  const tileset = { show: false };
  const controller = new MapStackController(fakeViewer(), {
    basemap: BASEMAP,
    googleTileset: tileset,
    initialStack: 'photoreal',
  });
  const state = controller.getState();
  assert.equal(state.activeId, 'osm');
  assert.equal(controller.isStackAvailable('photoreal'), false);
  assert.match(state.stacks.find((s) => s.id === 'photoreal').unavailableReason, /Offline/);
});

test('with a host basemap and an ion token, the osm switch installs no Cesium World Terrain', async () => {
  const viewer = fakeViewer();
  const controller = new MapStackController(viewer, { basemap: BASEMAP, cesiumToken: 'ion-token' });
  for (const id of ['bing-aerial', 'bing-labels', 'esri-imagery'])
    assert.equal(controller.isStackAvailable(id), false, id);
  const state = await controller.setStack('osm', { silent: true });
  assert.equal(state.activeId, 'osm');
  assert.equal(viewer.calls.imagery, 1);
  assert.equal(viewer.calls.setTerrain, 0, 'no ion world terrain');
  assert.ok(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider);
});

test('a failed osm switch under a host basemap never falls back to the photoreal tileset', async () => {
  const tileset = { show: false };
  const viewer = fakeViewer();
  const controller = new MapStackController(viewer, { basemap: BASEMAP, googleTileset: tileset });
  controller._getImageryProvider = async () => {
    throw new Error('tile template unreachable');
  };
  const state = await controller.setStack('osm', { silent: true });
  assert.equal(tileset.show, false, 'photoreal stayed hidden');
  assert.notEqual(state.activeId, 'photoreal');
  assert.equal(state.lastError, 'tile template unreachable');
});
