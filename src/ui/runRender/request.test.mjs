/** A run moment as a RenderRequest/v1 (GEN-369): what is sent, and why Render is refused. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  autoFovDeg,
  DRONE_SPAN_M,
  bindsSites,
  buildRenderRequest,
  cameraSites,
  regionLayers,
  renderBlockers,
  seedOf,
  siteFrame,
  viewfinderBox,
} from './request.js';
import { sunAltitudeDeg } from './sun.js';
import { storedRowAt, uasTracksFromSelection } from '../../layers/worldModel/uasTrack.js';

const selection = JSON.parse(
  readFileSync(new URL('../../layers/worldModel/fixtures/uas-track.select.json', import.meta.url)),
);
const [track] = uasTracksFromSelection(selection);
const RUN = { head: 'sim/sha256:043d75f90515f7de017877c65345f155', revisionId: 'd6814ab5a1934efc935da93e26a9026e' };
const REGION = track.header.terrain.region;
const binding = (name) => ({ name, ref: { type_id: 't', content_id: 'sha256:00' } });
const revision = {
  bindings: [
    binding('simulation.uas.track'),
    binding('world.tilesets.trees.cs-downtown'),
    binding('world.tilesets.terrain.cs-downtown'),
    binding('world.tilesets.buildings.cs-downtown'),
    binding('world.tilesets.imagery.cs-downtown'),
    binding('world.tilesets.terrain.elsewhere'),
    binding('world.buildings.footprints.cs-downtown'),
  ],
};
const validAt = '2026-11-05T16:02:30Z';
const drone = storedRowAt(track.rows, Date.parse(validAt));
const view = {
  kind: 'view',
  lon: drone.position.lon - 0.0006,
  lat: drone.position.lat - 0.0005,
  height: drone.position.height + 40,
  headingDeg: 41.2,
  pitchDeg: -18.04,
  fovDeg: 50.4,
};

const sitesProjection = {
  points: [
    site('gcs:foundation:gcs-1', 'gcs', { camera_hfov_deg: 60, camera_width_px: 3840, camera_height_px: 2160 }),
    site('cuas-site:foundation:site-1', 'cuas_site', { camera_hfov_deg: 30, camera_width_px: 1280, camera_height_px: 1024 }),
    site('home:foundation:uas-1', 'home', { camera_hfov_deg: null, camera_width_px: null, camera_height_px: null }),
    site('gcs:foundation:gcs-2', 'gcs', { camera_hfov_deg: null, camera_width_px: null, camera_height_px: null }),
  ],
};

function site(identity, kind, lens) {
  return {
    binding: 'simulation.uas.sites',
    semantic_ref: { semantic_identity: identity },
    position: { lon: -104.8228, lat: 38.8377, height_m: 1820.9 },
    properties: { site_kind: kind, ...lens },
  };
}

test('the region tilesets are the ones the run revision binds, in render order', () => {
  assert.deepEqual(regionLayers(revision, REGION), ['terrain', 'imagery', 'buildings', 'trees']);
  assert.deepEqual(regionLayers(revision, 'nowhere'), []);
  assert.equal(bindsSites(revision), false);
  assert.equal(bindsSites({ bindings: [binding('simulation.uas.sites')] }), true);
});

test('This view: the camera as framed, the drone at its stored epoch, Unreal only when fast', () => {
  const request = buildRenderRequest({
    run: RUN,
    region: REGION,
    layers: regionLayers(revision, REGION),
    camera: view,
    drone,
    validAt,
    look: 'fast',
  });
  assert.deepEqual(request, {
    command: 'RenderRequest/v1',
    capture_id: 'run-043d75f90515-20261105T160230Z-view',
    scene: { revision: RUN.revisionId, region: 'cs-downtown', layers: ['terrain', 'imagery', 'buildings', 'trees'] },
    observer: {
      lon: view.lon,
      lat: view.lat,
      height_m: view.height,
      height_ref: 'ellipsoid',
      sensor: { horizontal_fov_deg: 50.4, image_width: 1920, image_height: 1080 },
      aim: { heading_deg: 41.2, pitch_deg: -18.04 },
    },
    targets: [
      { lon: drone.position.lon, lat: drone.position.lat, height_m: drone.position.height, height_ref: 'ellipsoid' },
    ],
    window: { start: validAt, frames: 1 },
  });
  assert.equal(drone.validTime, '2026-11-05T16:02:30+00:00', 'the stored row, not a display pose');
});

test('photoreal adds Cosmos with a seed fixed by the moment and camera, and a Mapillary reference', () => {
  const args = { run: RUN, region: REGION, layers: ['terrain'], camera: view, drone, validAt, look: 'photoreal' };
  const request = buildRenderRequest(args);
  assert.deepEqual(request.neural, { seed: seedOf(request.capture_id), style_ref: { source: 'mapillary' } });
  assert.equal(buildRenderRequest(args).neural.seed, request.neural.seed);
  assert.ok(Number.isInteger(request.neural.seed) && request.neural.seed >= 0);
});

test('a site camera sits at the site, follows the drone, and renders at its lens shape', () => {
  const sites = cameraSites(sitesProjection);
  assert.deepEqual(
    sites.map((s) => s.identity),
    ['gcs:foundation:gcs-1', 'cuas-site:foundation:site-1'],
    'homes and lens-less sites are no camera; GCS first',
  );
  const [gcs] = sites;
  const request = buildRenderRequest({
    run: RUN,
    region: REGION,
    layers: ['terrain'],
    camera: { kind: 'site', site: gcs, fovDeg: 8 },
    drone,
    validAt,
    look: 'fast',
  });
  assert.equal(request.capture_id, 'run-043d75f90515-20261105T160230Z-gcs-1');
  assert.deepEqual(request.observer, {
    lon: gcs.lon,
    lat: gcs.lat,
    height_m: gcs.height,
    height_ref: 'ellipsoid',
    sensor: { horizontal_fov_deg: 8, image_width: 1920, image_height: 1080 },
    aim: { follow: 0 },
  });
  assert.deepEqual(siteFrame(sites[1]), { width: 1280, height: 1024 });
});

test('auto zoom frames the drone about 60 px wide, never wider than the lens or tighter than 0.5°', () => {
  const fov = autoFovDeg(1200, 1920, 60);
  const pxPerRad = 1920 / (2 * Math.tan((fov * Math.PI) / 360));
  assert.ok(Math.abs((DRONE_SPAN_M / 1200) * pxPerRad - 60) < 1);
  assert.equal(autoFovDeg(5, 1920, 60), 60);
  assert.equal(autoFovDeg(50_000, 1920, 60), 0.5);
});

test('the viewfinder is the largest 16:9 box in the canvas, and its fov is its own width', () => {
  const fovy = (60 * Math.PI) / 180;
  const wide = viewfinderBox({ width: 2400, height: 1000, fovyRad: fovy });
  assert.deepEqual([wide.width, wide.height, wide.top], [1000 * (16 / 9), 1000, 0]);
  assert.ok(Math.abs(wide.hfovDeg - (2 * Math.atan(Math.tan(fovy / 2) * (16 / 9)) * 180) / Math.PI) < 1e-9);
  const tall = viewfinderBox({ width: 900, height: 1200, fovyRad: fovy });
  assert.equal(tall.width, 900);
  assert.equal(tall.left, 0);
  assert.ok(tall.hfovDeg < 60);
});

test('Render says why it is refused, one reason each', () => {
  const layers = ['terrain', 'imagery'];
  assert.deepEqual(renderBlockers({ layers, camera: view, drone, sunAltitudeDeg: 23 }), []);
  assert.match(renderBlockers({ layers: [], camera: view, drone, sunAltitudeDeg: 23 })[0], /terrain tiles/);
  assert.match(renderBlockers({ layers, camera: null, drone, sunAltitudeDeg: 23 })[0], /No camera/);
  assert.match(renderBlockers({ layers, camera: view, drone: null, sunAltitudeDeg: 23 })[0], /No drone row/);
  assert.match(renderBlockers({ layers, camera: view, drone, sunAltitudeDeg: -0.2 })[0], /Night/);
  const far = { ...view, lat: view.lat + 0.06 };
  assert.match(renderBlockers({ layers, camera: far, drone, sunAltitudeDeg: 23 })[0], /6\.\d km .* 5 km at most/);
  assert.equal(storedRowAt(track.rows, Date.parse('2026-11-05T15:59:59Z')), null, 'before the first row');
});

test('the sun is the renderer\'s: up mid-morning, down at night, its own test points', () => {
  const where = { lon: -104.8228, lat: 38.8377 };
  const morning = sunAltitudeDeg(where, '2026-11-05T16:00:00Z');
  assert.ok(morning > 20 && morning < 26, `about 23° at 09:00 MST, got ${morning}`);
  assert.ok(sunAltitudeDeg(where, '2026-11-05T06:00:00Z') < -30);
  // solar.rs: Colorado Springs at the 2024 summer solstice's solar noon, the equator at the equinox.
  const solstice = sunAltitudeDeg({ lon: -104.9, lat: 38.73 }, '2024-06-21T19:00:00Z');
  assert.ok(solstice >= 70 && solstice <= 76, `about 73°, got ${solstice}`);
  assert.ok(sunAltitudeDeg({ lon: 0, lat: 0 }, '2024-03-20T12:00:00Z') >= 85);
  assert.equal(sunAltitudeDeg(where, 'not a time'), null);
  assert.equal(sunAltitudeDeg({ lon: Number.NaN, lat: 0 }, '2024-03-20T12:00:00Z'), null);
});
