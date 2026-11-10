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
  layersOf,
  offAxisDeg,
  regionAt,
  renderBlockers,
  renderTargets,
  subjectOf,
  seedOf,
  siteFrame,
  viewfinderBox,
} from './request.js';
import { sunAltitudeDeg } from './sun.js';
import { headingAt, storedRowAt, uasTracksFromSelection } from '../../layers/worldModel/uasTrack.js';

const selection = JSON.parse(
  readFileSync(new URL('../../layers/worldModel/fixtures/uas-track.select.json', import.meta.url)),
);
const [track] = uasTracksFromSelection(selection);
const RUN = { head: 'sim/sha256:043d75f90515f7de017877c65345f155', revisionId: 'd6814ab5a1934efc935da93e26a9026e' };
const binding = (name) => ({ name, ref: { type_id: 't', content_id: 'sha256:00' } });
const validAt = '2026-11-05T16:02:30Z';
const MS = Date.parse(validAt);
const drone = storedRowAt(track.rows, MS);
const HEAD = 'world/main';

/** A region as the Modelled scene holds it (`regionSceneOf`): its box and the tilesets it lists. */
function region(name, [west, south, east, north], layers = ['trees', 'terrain', 'buildings', 'imagery']) {
  return {
    name,
    box: { west, south, east, north },
    drawn: layers.includes('terrain'),
    layers: Object.fromEntries(layers.map((layer) => [layer, { layer, contentId: `sha256:${layer}` }])),
  };
}
const { lon: LON, lat: LAT } = drone.position;
const DOWNTOWN = region('cs-downtown', [LON - 0.02, LAT - 0.02, LON + 0.02, LAT + 0.02]);
const TERRAIN_ONLY = region('cs-bare', [LON - 0.02, LAT - 0.02, LON + 0.02, LAT + 0.02], ['terrain']);

/** The fixture's drone again under another name, moved by degrees. */
function another(identity, callsign, dLon = 0, dLat = 0) {
  return {
    ...track,
    identity,
    callsign,
    header: null,
    rows: track.rows.map((row) => ({
      ...row,
      position: row.position && { ...row.position, lon: row.position.lon + dLon, lat: row.position.lat + dLat },
    })),
  };
}
const RAVEN_2 = another('laydown:dataforge:7:uas-2', 'RAVEN-2', 0.001, 0.001);
const RAVEN_3 = another('laydown:dataforge:7:uas-3', 'RAVEN-3', 0.002, -0.001);
const one = (camera) => renderTargets({ tracks: [track], ms: MS, observer: camera?.site ?? camera });
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

test('a region gives its listed tilesets in render order, and a revision says whether it binds sites', () => {
  assert.deepEqual(layersOf(DOWNTOWN), ['terrain', 'imagery', 'buildings', 'trees']);
  assert.deepEqual(layersOf(null), []);
  assert.equal(bindsSites({ bindings: [binding('simulation.uas.track')] }), false);
  assert.equal(bindsSites({ bindings: [binding('simulation.uas.sites')] }), true);
});

test('This view: the camera as framed, the drone at its stored epoch, the scene at the head, Unreal only when fast', () => {
  const sent = one(view);
  const heading = headingAt(track.rows, MS);
  assert.ok(heading >= 0 && heading < 360, 'the fixture drone is flying');
  const request = buildRenderRequest({ run: RUN, sceneHead: HEAD, region: DOWNTOWN, camera: view, sent, validAt, look: 'fast' });
  assert.deepEqual(request, {
    command: 'RenderRequest/v1',
    capture_id: 'run-043d75f90515-20261105T160230Z-view',
    scene: { head: 'world/main', region: 'cs-downtown', layers: ['terrain', 'imagery', 'buildings', 'trees'] },
    observer: {
      lon: view.lon,
      lat: view.lat,
      height_m: view.height,
      height_ref: 'ellipsoid',
      sensor: { horizontal_fov_deg: 50.4, image_width: 1920, image_height: 1080 },
      aim: { heading_deg: 41.2, pitch_deg: -18.04 },
    },
    targets: [
      {
        lon: drone.position.lon,
        lat: drone.position.lat,
        height_m: drone.position.height,
        height_ref: 'ellipsoid',
        id: track.identity,
        label: 'UAS-1',
        heading_deg: Number(heading.toFixed(2)),
      },
    ],
    window: { start: validAt, frames: 1 },
  });
  assert.equal('revision' in request.scene, false, 'the renderer pins the head itself');
  assert.equal(drone.validTime, '2026-11-05T16:02:30+00:00', 'the stored row, not a display pose');
});

test('every drone of the run is a target, in track order, under its identity and callsign', () => {
  const sent = renderTargets({ tracks: [track, RAVEN_2, RAVEN_3], ms: MS, observer: view });
  assert.deepEqual(
    sent.drones.map((d) => [d.target.id, d.target.label]),
    [
      [track.identity, 'UAS-1'],
      ['laydown:dataforge:7:uas-2', 'RAVEN-2'],
      ['laydown:dataforge:7:uas-3', 'RAVEN-3'],
    ],
  );
  assert.deepEqual(sent.left, []);
  for (const { target, row } of sent.drones) {
    assert.deepEqual([target.lon, target.lat, target.height_m], [row.position.lon, row.position.lat, row.position.height]);
    assert.ok(target.heading_deg >= 0 && target.heading_deg < 360);
  }
  // A drone that never moves sideways has no heading to send; the renderer places it unrotated.
  const hover = { ...RAVEN_2, rows: RAVEN_2.rows.map((row) => ({ ...row, position: RAVEN_2.rows[0].position })) };
  assert.equal('heading_deg' in renderTargets({ tracks: [hover], ms: MS, observer: view }).drones[0].target, false);
  const long = another('laydown:x:uas-9', 'N'.repeat(80));
  assert.equal(renderTargets({ tracks: [long], ms: MS }).drones[0].target.label.length, 64);
});

test('a drone beyond 5 km, not flying yet, or sharing an identity is left out and counted', () => {
  const far = another('laydown:dataforge:7:uas-far', 'RAVEN-FAR', 0, 0.06);
  const late = { ...another('laydown:dataforge:7:uas-late', 'RAVEN-LATE'), rows: track.rows.filter((row) => row.at > MS) };
  const twin = another(track.identity, 'TWIN');
  const sent = renderTargets({ tracks: [far, track, late, twin, RAVEN_2], ms: MS, observer: view, follow: RAVEN_2 });
  assert.deepEqual(sent.drones.map((d) => d.name), ['UAS-1', 'RAVEN-2']);
  assert.deepEqual(sent.left.map((d) => [d.name, d.reason]), [
    ['RAVEN-FAR', 'too-far'],
    ['RAVEN-LATE', 'no-row'],
    ['TWIN', 'duplicate'],
  ]);
  assert.ok(sent.left[0].distanceM > 6000 && sent.left[0].distanceM < 7000);
  assert.equal(sent.followIndex, 1, 'the followed drone is counted among the ones kept');
  assert.equal(renderTargets({ tracks: [far, track], ms: MS, observer: view, follow: far }).followIndex, -1);
  // The renderer takes 128: the farthest are the ones left out.
  const crowd = Array.from({ length: 130 }, (_, i) => another(`laydown:x:uas-${i}`, `D${i}`, 0, i * 1e-5));
  const many = renderTargets({ tracks: crowd, ms: MS, observer: { lon: LON, lat: LAT } });
  assert.equal(many.drones.length, 128);
  assert.deepEqual(many.left.map((d) => [d.name, d.reason]), [['D128', 'too-many'], ['D129', 'too-many']]);
});

test('the terrain region is the smallest one that lists terrain and holds the drone', () => {
  const state = region('colorado', [LON - 3, LAT - 2, LON + 3, LAT + 2]);
  const noTerrain = region('cs-photos', [LON - 0.001, LAT - 0.001, LON + 0.001, LAT + 0.001], ['imagery']);
  const elsewhere = region('denver', [LON + 0.5, LAT + 0.5, LON + 0.6, LAT + 0.6]);
  const regions = [state, noTerrain, elsewhere, DOWNTOWN, { name: 'undeclared', box: null, drawn: false, layers: {} }];
  assert.equal(regionAt(regions, drone.position), DOWNTOWN);
  assert.equal(regionAt([state, noTerrain, elsewhere], drone.position), state);
  assert.equal(regionAt([noTerrain, elsewhere], drone.position), null);
  assert.equal(regionAt(regions, null), null);
});

test('the subject is the followed drone, or for This view the one nearest the centre of the frame', () => {
  const sent = renderTargets({ tracks: [track, RAVEN_2, RAVEN_3], ms: MS, observer: view, follow: RAVEN_3 });
  assert.equal(subjectOf({ kind: 'site', site: view, fovDeg: 8 }, sent).name, 'RAVEN-3');
  // A view camera aimed straight at RAVEN-2 has it on its axis.
  const at = sent.drones[1].row.position;
  const east = (at.lon - view.lon) * Math.cos((view.lat * Math.PI) / 180);
  const north = at.lat - view.lat;
  const ground = Math.hypot(east, north) * (Math.PI / 180) * 6_371_008.8;
  const aimed = {
    ...view,
    headingDeg: (Math.atan2(east, north) * 180) / Math.PI,
    pitchDeg: (Math.atan2(at.height - view.height, ground) * 180) / Math.PI,
  };
  assert.ok(offAxisDeg(aimed, at) < 0.01);
  assert.equal(subjectOf(aimed, { ...sent, followIndex: -1 }).name, 'RAVEN-2');
  assert.equal(subjectOf(aimed, { drones: [], followIndex: -1 }), null);
});

test('photoreal takes its style photo from the scene imagery, or Mapillary without it', () => {
  const args = { run: RUN, sceneHead: HEAD, camera: view, sent: one(view), validAt, look: 'photoreal' };
  assert.deepEqual(buildRenderRequest({ ...args, region: DOWNTOWN }).neural.style_ref, { source: 'imagery' });
  assert.deepEqual(buildRenderRequest({ ...args, region: TERRAIN_ONLY }).neural.style_ref, { source: 'mapillary' });
});

test('photoreal adds Cosmos with a seed fixed by the moment and camera, and a Mapillary reference', () => {
  const args = { run: RUN, sceneHead: HEAD, region: TERRAIN_ONLY, camera: view, sent: one(view), validAt, look: 'photoreal' };
  const request = buildRenderRequest(args);
  assert.deepEqual(request.neural, { seed: seedOf(request.capture_id), style_ref: { source: 'mapillary' } });
  assert.equal(buildRenderRequest(args).neural.seed, request.neural.seed);
  assert.ok(Number.isInteger(request.neural.seed) && request.neural.seed >= 0);
});

test('a site camera sits at the site, follows its drone among all those sent, and renders at its lens shape', () => {
  const sites = cameraSites(sitesProjection);
  assert.deepEqual(
    sites.map((s) => s.identity),
    ['gcs:foundation:gcs-1', 'cuas-site:foundation:site-1'],
    'homes and lens-less sites are no camera; GCS first',
  );
  const [gcs] = sites;
  const sent = renderTargets({ tracks: [track, RAVEN_2], ms: MS, observer: gcs, follow: RAVEN_2 });
  const request = buildRenderRequest({
    run: RUN,
    sceneHead: HEAD,
    region: TERRAIN_ONLY,
    camera: { kind: 'site', site: gcs, fovDeg: 8 },
    sent,
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
    aim: { follow: 1 },
  });
  assert.deepEqual(request.targets.map((t) => t.label), ['UAS-1', 'RAVEN-2']);
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
  const sent = one(view);
  const subject = subjectOf(view, sent);
  const ok = { region: DOWNTOWN, camera: view, sent, subject, sunAltitudeDeg: 23 };
  assert.deepEqual(renderBlockers(ok), []);
  assert.match(renderBlockers({ ...ok, region: region('cs-photos', [0, 0, 1, 1], ['imagery']) })[0], /holds no terrain tiles/);
  assert.match(renderBlockers({ ...ok, regionsOffered: false })[0], /holds no terrain tiles/);
  assert.deepEqual(renderBlockers({ ...ok, region: null }), ['No terrain tiles cover UAS-1 at this time']);
  assert.match(renderBlockers({ ...ok, camera: null })[0], /No camera/);
  assert.match(renderBlockers({ ...ok, sunAltitudeDeg: -0.2 })[0], /Night/);
  const before = renderTargets({ tracks: [track], ms: Date.parse('2026-11-05T15:59:59Z'), observer: view });
  assert.deepEqual(renderBlockers({ ...ok, sent: before, subject: null, region: null }), ['No drone row at this time']);
  // One drone out of range does not stop the others; all of them out of range does.
  const far = { ...view, lat: view.lat + 0.06 };
  assert.match(renderBlockers({ ...ok, camera: far, sent: one(far), subject: null, region: null })[0], /The drone is 6\.\d km .* 5 km at most/);
  const both = renderTargets({ tracks: [track, RAVEN_2], ms: MS, observer: far });
  assert.match(renderBlockers({ ...ok, camera: far, sent: both, subject: null, region: null })[0], /Every drone is more than 5 km .* nearest is 6\.\d km/);
  const distant = another('laydown:x:uas-far', 'RAVEN-FAR', 0, 0.06);
  const mixed = renderTargets({ tracks: [distant, track], ms: MS, observer: view });
  assert.deepEqual(renderBlockers({ ...ok, sent: mixed }), []);
  // A site camera cannot follow a drone that was left out.
  const site = { kind: 'site', site: { ...view, identity: 'gcs:x:gcs-1', kind: 'gcs' }, fovDeg: 8 };
  const lost = renderTargets({ tracks: [distant, track], ms: MS, observer: view, follow: distant });
  assert.match(renderBlockers({ ...ok, camera: site, sent: lost, subject: null })[0], /RAVEN-FAR is 6\.\d km from the camera/);
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
