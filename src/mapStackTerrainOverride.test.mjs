/** A terrain override (GEN-403's region terrain) wins over the stack's own terrain until it is cleared. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MapStackController } from './mapStackController.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function controllerOnGlobe() {
  const viewer = {
    scene: { globe: { show: true } },
    terrainProvider: 'cesium-default',
  };
  const controller = new MapStackController(viewer, {});
  const keyless = deferred();
  controller._getKeylessTerrainProvider = () => keyless.promise;
  return { viewer, controller, keyless };
}

test('a keyless terrain that resolves after the override never displaces it', async () => {
  const { viewer, controller, keyless } = controllerOnGlobe();
  const switching = controller._setWorldTerrainEnabled(
    false,
    controller._switchGen,
  );
  await controller.setTerrainOverride('region-terrain');
  assert.equal(viewer.terrainProvider, 'region-terrain');
  keyless.resolve('reearth');
  await switching;
  assert.equal(viewer.terrainProvider, 'region-terrain');
  // A globe stack switched meanwhile keeps the override too.
  await controller._setWorldTerrainEnabled(false, controller._switchGen);
  assert.equal(viewer.terrainProvider, 'region-terrain');
});

test('clearing the override puts the stack’s own terrain back', async () => {
  const { viewer, controller, keyless } = controllerOnGlobe();
  keyless.resolve('reearth');
  await controller._setWorldTerrainEnabled(false, controller._switchGen);
  assert.equal(viewer.terrainProvider, 'reearth');
  await controller.setTerrainOverride('region-terrain');
  assert.equal(viewer.terrainProvider, 'region-terrain');
  await controller.setTerrainOverride(null);
  assert.equal(viewer.terrainProvider, 'reearth');
});

test('cleared under Photoreal, the next globe stack re-derives its terrain', async () => {
  const { viewer, controller, keyless } = controllerOnGlobe();
  keyless.resolve('reearth');
  await controller._setWorldTerrainEnabled(false, controller._switchGen);
  await controller.setTerrainOverride('region-terrain');
  viewer.scene.globe.show = false; // Photoreal hides the globe; its terrain is inert
  await controller.setTerrainOverride(null);
  assert.equal(viewer.terrainProvider, 'region-terrain');
  viewer.scene.globe.show = true;
  await controller._setWorldTerrainEnabled(false, controller._switchGen);
  assert.equal(viewer.terrainProvider, 'reearth');
});
