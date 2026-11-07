/**
 * The Modelled scene's rules (GEN-403), on real reads of prod's backplane
 * (2026-11-07, revision 2d4997e2…):
 *   fixtures/region.cs-downtown.json            `GET /regions/cs-downtown`
 *   fixtures/tilesets.cs-downtown.json          `GET /regions/cs-downtown/tilesets?head=world/main`
 *   fixtures/imagery.cs-downtown.tilejson.json  the imagery's `tilejson.json` (`mosaic` dropped)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REGION_DISPLAY,
  REGION_LAYERS,
  SCENES,
  activeRegionAt,
  ceilingM,
  imageryOf,
  initialScene,
  regionCamera,
  regionLine,
  regionNamesOf,
  regionSceneOf,
  runRegionOf,
} from './regionScene.js';
import { RENDER_LAYERS } from '../../ui/runRender/request.js';

const read = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const REGION = read('region.cs-downtown.json');
const LISTING = read('tilesets.cs-downtown.json');
const TILEJSON = read('imagery.cs-downtown.tilejson.json');
const resolveUrl = (path) => `/world${path}`;
const CS = regionSceneOf({
  name: 'cs-downtown',
  region: REGION,
  listing: LISTING,
  resolveUrl,
});

function closeTo(actual, expected, tolerance, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message} ${actual} is not within ${tolerance} of ${expected}`,
  );
}

test('a region with its terrain listed is drawn, every layer at its content-id URL', () => {
  assert.equal(CS.drawn, true);
  assert.equal(CS.reason, null);
  assert.deepEqual(Object.keys(CS.layers).sort(), [...REGION_LAYERS].sort());
  for (const entry of LISTING.tilesets) {
    const layer = CS.layers[entry.layer];
    // Content-addressed, never the listing's revision-pinned url.
    assert.equal(layer.url, `/world/tilesets/${entry.content_id}/`);
    assert.equal(layer.rootUrl, `${layer.url}${entry.root}`);
    assert.doesNotMatch(layer.url, /\/revisions\//);
  }
  assert.equal(CS.layers.terrain.root, 'layer.json');
  assert.equal(
    regionLine(CS),
    'cs-downtown · terrain, imagery, buildings, trees',
  );
  // The renderer takes the same layers in the same order (GEN-369).
  assert.equal(RENDER_LAYERS, REGION_LAYERS);
});

test('the ring is the declared box grown by the declared margin', () => {
  const [west, south, east, north] = REGION.declaration.bounds;
  const margin = REGION.declaration.ring;
  assert.deepEqual(CS.box, { west, south, east, north });
  closeTo(CS.ring.west, west - margin, 1e-9);
  closeTo(CS.ring.north, north + margin, 1e-9);
  // About 31 x 38 km, so the terrain holds below about 38 km.
  closeTo(ceilingM(CS), 38_100, 200);
});

test('an incomplete region is not drawn, and says what it is waiting for', () => {
  const without = (layers) => ({
    ...LISTING,
    tilesets: LISTING.tilesets.filter((t) => !layers.includes(t.layer)),
  });
  const noTerrain = regionSceneOf({
    name: 'cs-downtown',
    region: REGION,
    listing: without(['terrain']),
    resolveUrl,
  });
  assert.equal(noTerrain.drawn, false);
  assert.equal(noTerrain.reason, 'no terrain tileset yet');
  assert.equal(
    regionLine(noTerrain),
    'cs-downtown not drawn: no terrain tileset yet',
  );
  const empty = regionSceneOf({
    name: 'cs-downtown',
    region: REGION,
    listing: { ...LISTING, tilesets: [] },
    resolveUrl,
  });
  assert.equal(empty.reason, 'no tilesets yet');
  // The listing 404s for a region never requested on the head.
  assert.equal(
    regionSceneOf({
      name: 'cs-downtown',
      region: REGION,
      listing: null,
      resolveUrl,
    }).drawn,
    false,
  );
  const undeclared = regionSceneOf({
    name: 'x',
    region: { regions: [] },
    listing: LISTING,
    resolveUrl,
  });
  assert.equal(undeclared.drawn, false);
  assert.equal(undeclared.reason, 'it declares no bounds');
  // Imagery without buildings or trees still draws on its terrain.
  const bare = regionSceneOf({
    name: 'cs-downtown',
    region: REGION,
    listing: without(['buildings', 'trees']),
    resolveUrl,
  });
  assert.equal(bare.drawn, true);
  assert.deepEqual(bare.missing, ['buildings', 'trees']);
});

test('region names come from the coverage rows, once each', () => {
  assert.deepEqual(regionNamesOf(REGION), ['cs-downtown']);
  assert.deepEqual(regionNamesOf({ regions: [] }), []);
  assert.deepEqual(regionNamesOf(null), []);
});

test('the globe takes a region’s terrain only while the camera is over its ring', () => {
  const centre = { lon: -104.836, lat: 38.836 };
  const at = (camera, previous) =>
    activeRegionAt([CS], camera, previous)?.name ?? null;
  assert.equal(at({ ...centre, height: 3_000 }), 'cs-downtown');
  // Over the ring but outside the box: the 10 m terrain is still the region's.
  assert.equal(at({ lon: -104.98, lat: 38.7, height: 3_000 }), 'cs-downtown');
  // Denver, or high enough to see well past the ring: the base globe.
  assert.equal(at({ lon: -104.99, lat: 39.74, height: 3_000 }), null);
  assert.equal(at({ ...centre, height: 60_000 }), null);
  assert.equal(at({ ...centre, height: Number.NaN }), null);
  // A region not drawn never takes the terrain.
  const notDrawn = regionSceneOf({
    name: 'cs-downtown',
    region: REGION,
    listing: null,
    resolveUrl,
  });
  assert.equal(activeRegionAt([notDrawn], { ...centre, height: 3_000 }), null);
});

test('leaving a region needs the margin, so the terrain does not flap at the edge', () => {
  const justOutside = { lon: CS.ring.east + 0.01, lat: 38.836, height: 3_000 };
  assert.equal(activeRegionAt([CS], justOutside, null), null);
  assert.equal(
    activeRegionAt([CS], justOutside, 'cs-downtown')?.name,
    'cs-downtown',
  );
  const above = { lon: -104.836, lat: 38.836, height: ceilingM(CS) * 1.05 };
  assert.equal(activeRegionAt([CS], above, null), null);
  assert.equal(activeRegionAt([CS], above, 'cs-downtown')?.name, 'cs-downtown');
  const farAbove = {
    ...above,
    height: ceilingM(CS) * (1 + REGION_DISPLAY.exitMargin) + 1,
  };
  assert.equal(activeRegionAt([CS], farAbove, 'cs-downtown'), null);
});

test('of overlapping rings the smallest region wins', () => {
  const inner = regionSceneOf({
    name: 'inner',
    region: {
      declaration: { bounds: [-104.84, 38.83, -104.83, 38.84], ring: 0.01 },
    },
    listing: LISTING,
    resolveUrl,
  });
  const camera = { lon: -104.835, lat: 38.835, height: 1_000 };
  assert.equal(activeRegionAt([CS, inner], camera)?.name, 'inner');
  assert.equal(activeRegionAt([inner, CS], camera)?.name, 'inner');
});

test('the scene opens as remembered if it can, else Photoreal with Google, else Modelled', () => {
  assert.equal(initialScene({ photorealAvailable: true }), SCENES.photoreal);
  assert.equal(initialScene({ photorealAvailable: false }), SCENES.modelled);
  assert.equal(
    initialScene({ stored: 'modelled', photorealAvailable: true }),
    SCENES.modelled,
  );
  assert.equal(
    initialScene({ stored: 'photoreal', photorealAvailable: false }),
    SCENES.modelled,
  );
  assert.equal(
    initialScene({ stored: 'photoreal', photorealAvailable: true }),
    SCENES.photoreal,
  );
  assert.equal(
    initialScene({ stored: 'nonsense', photorealAvailable: true }),
    SCENES.photoreal,
  );
});

test('a run names its region in its products’ terrain header', () => {
  const projection = read('uas-track.project.json');
  assert.equal(runRegionOf(projection.semantic_metadata), 'cs-downtown');
  assert.equal(
    runRegionOf({ 'simulation.rf.receiver_track': { mode_codes: {} } }),
    null,
  );
  assert.equal(runRegionOf(null), null);
});

test('the fly-to looks at the box centre from the south, as far off as its diagonal', () => {
  const view = regionCamera(CS, 1820);
  closeTo(view.lon, (CS.box.west + CS.box.east) / 2, 1e-9);
  closeTo(view.lat, (CS.box.south + CS.box.north) / 2, 1e-9);
  assert.equal(view.height, 1820);
  assert.equal(view.headingDeg, 0);
  assert.ok(view.pitchDeg < 0);
  closeTo(view.rangeM, 7_060, 100);
  // From there the camera is still over the ring, so the region holds the terrain.
  const behind = view.rangeM * Math.cos((-view.pitchDeg * Math.PI) / 180);
  const camera = {
    lon: view.lon,
    lat: view.lat - behind / 110_574,
    height: 1820 + view.rangeM * 0.57,
  };
  assert.equal(activeRegionAt([CS], camera)?.name, 'cs-downtown');
});

test('imagery is read as XYZ web-mercator (Cesium’s {y}) and nothing else is re-mapped', () => {
  const url = CS.layers.imagery.url;
  const { imagery, reason } = imageryOf(TILEJSON, url);
  assert.equal(reason, null);
  assert.equal(imagery.url, `${url}{z}/{x}/{y}.png`);
  assert.doesNotMatch(imagery.url, /reverseY/);
  assert.deepEqual(Object.values(imagery.box), TILEJSON.bounds);
  assert.equal(imagery.maximumLevel, TILEJSON.maxzoom);
  assert.match(imagery.attribution, /NAIP/);
  assert.match(
    imageryOf({ ...TILEJSON, scheme: 'tms' }, url).reason,
    /not xyz EPSG:3857/,
  );
  assert.match(
    imageryOf({ ...TILEJSON, projection: 'EPSG:4326' }, url).reason,
    /not xyz/,
  );
  assert.match(
    imageryOf({ ...TILEJSON, tiles: [] }, url).reason,
    /no tile template/,
  );
});
