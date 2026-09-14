import { StyleManager } from '../ui.js';
import * as Cesium from 'cesium';
import { flyToAustin } from '../camera.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';

/** Construct the existing controls and camera presentation. */
export function createStandaloneControls({
  scene: { viewer, mapStackController },
  loaderStatus,
  placeSearch,
  initialCamera = null,
  defer,
}) {
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new StyleManager(viewer, {
    mapStackController,
    placeSearch,
  });
  defer(() => styleManager.orbitController.stop());
  defer(() => styleManager.hud.destroy());
  defer(() => styleManager.dispose());
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode.
  const weatherEffects = null;
  const cockpitCloudEffects = initCockpitCloudEffects(viewer);
  defer(() => cockpitCloudEffects?.destroy());

  // A share link wins; then the host's initial camera; then the Austin fly-in.
  if (!styleManager.hasShareState && initialCamera) {
    setInitialCamera(viewer, initialCamera);
  } else if (!styleManager.hasShareState) {
    loaderStatus.textContent = 'Flying to Austin, TX...';
    defer(flyToAustin(viewer));
  } else {
    loaderStatus.textContent = 'Restoring shared view...';
  }

  return { styleManager, weatherEffects, cockpitCloudEffects };
}

/**
 * Look at `{lon, lat, heightM?, rangeM, headingDeg, pitchDeg}` (degrees,
 * meters) without a cinematic flight.
 */
function setInitialCamera(
  viewer,
  { lon, lat, heightM = 0, rangeM, headingDeg = 0, pitchDeg = -35 },
) {
  if (![lon, lat, rangeM].every(Number.isFinite)) return;
  viewer.camera.lookAt(
    Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(headingDeg),
      Cesium.Math.toRadians(pitchDeg),
      rangeM,
    ),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}
