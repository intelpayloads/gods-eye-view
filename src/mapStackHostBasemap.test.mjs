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
