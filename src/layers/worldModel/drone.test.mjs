/**
 * The run's drone in the layer (GEN-395), on two real documents from prod's
 * backplane for one Foundation C-UAS return-home run (revision d6814ab5…):
 *   fixtures/uas-track.select.json   the drone's whole track (`POST /select`)
 *   fixtures/uas-track.project.json  the track projected at 16:00:55Z, the
 *     link 15 s lost (`POST /project`, the layer's own request shape)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createWorldModelLayer } from './index.js';
import { runningFrom } from './displayClock.js';
import { DRONE_DISPLAY_FACT, UAS_TRACK_BINDING } from './uasTrack.js';
import {
  FOLLOW_VIEW,
  createDroneView,
  droneDrawn,
  droneItemId,
  droneOrientation,
  followOffset,
} from './droneView.js';
import { uasTracksFromSelection } from './uasTrack.js';

const read = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );
const SELECTION = read('uas-track.select.json');
const PROJECTION = read('uas-track.project.json');
const REVISION = SELECTION.revision_id;
const HEAD = 'sim/sha256:043d75f90';
const DRONE = droneItemId('platform:foundation:uas-1');
const ID = `world-product:${UAS_TRACK_BINDING}`;
const ms = (hms) => Date.parse(`2026-11-05T${hms}Z`);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const now = Cesium.JulianDate.now();

function rowAt(hms) {
  return SELECTION.products[0].values.find(
    (r) => r.valid_time.slice(11, 19) === hms,
  ).value;
}

/** A source holding the run: its chain, the projection (re-timed to the asked epoch), the track. */
function runSource({ selection = SELECTION } = {}) {
  const calls = { select: 0 };
  return {
    calls,
    async getRevisions({ head }) {
      return {
        head,
        revisions: [
          { id: REVISION, parent_id: null, created_at: '2026-11-06T20:53:23Z' },
        ],
      };
    },
    async getProjection(request) {
      const validAt = request.query.valid_at;
      const hms = new Date(Date.parse(validAt)).toISOString().slice(11, 19);
      const value = rowAt(hms);
      const { lon_deg, lat_deg, height_m, ...properties } = value;
      const [point] = PROJECTION.points;
      return {
        ...PROJECTION,
        revision_id: request.revisionId,
        points: [
          {
            ...point,
            time: { ...point.time, valid_at: validAt },
            properties,
            position: { lon: lon_deg, lat: lat_deg, height_m },
            height: { ...point.height, value_m: height_m },
          },
        ],
      };
    },
    async select({ query } = {}) {
      // The track's reads; the run's sites (GEN-405) are read beside it.
      if (query?.requested_layers?.[0] === UAS_TRACK_BINDING) calls.select++;
      return selection;
    },
  };
}

function harness(source) {
  const sources = [];
  const cards = [];
  let handler = null;
  let pickResult;
  const viewer = {
    dataSources: {
      add: (value) => sources.push(value),
      remove: (value) => sources.splice(sources.indexOf(value), 1),
    },
    scene: {
      pick: () => pickResult,
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      preUpdate: new Cesium.Event(),
      screenSpaceCameraController: { inertiaZoom: 0.8, minimumZoomDistance: 1 },
    },
    trackedEntity: undefined,
    trackedEntityChanged: new Cesium.Event(),
    isDestroyed: () => false,
  };
  const layer = createWorldModelLayer({
    source,
    id: ID,
    layers: [UAS_TRACK_BINDING],
    modalities: ['simulated'],
    head: HEAD,
    validAt: '2026-11-05T16:00:55Z',
    simulatedBinding: UAS_TRACK_BINDING,
    services: {
      context: {
        registerEntityContext() {},
        selectEntityContext() {},
        clearSelectedEntityContextForLayer() {},
        removeEntityContextsForLayer() {},
      },
      picking: {
        registerPickOwner() {},
        unregisterPickOwner() {},
        resolvePickId: (picked) =>
          picked?.id?.id ? String(picked.id.id) : null,
        isOwnedByOtherLayer: () => false,
      },
    },
    overlayHost: {
      setEntries: (...args) => cards.push(args),
      setVisible() {},
      clearSource() {},
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => {
      handler = {
        setInputAction(fn) {
          this.fn = fn;
        },
        destroy() {},
      };
      return handler;
    },
    debounceMs: 0,
  });
  layer.init(viewer);
  layer.enable(viewer);
  return {
    layer,
    viewer,
    cards,
    points: () => sources.find((s) => s.name === ID).entities,
    drones: () => sources.find((s) => s.name === `${ID}-uas`).entities,
    click(entity) {
      pickResult = { id: entity };
      handler.fn({ position: { x: 1, y: 1 } });
    },
  };
}

async function settle(h) {
  await h.layer.update(h.viewer);
  for (let i = 0; i < 4; i++) await flush();
}

function degrees(cartesian) {
  const c = Cesium.Cartographic.fromCartesian(cartesian);
  return {
    lon: Cesium.Math.toDegrees(c.longitude),
    lat: Cesium.Math.toDegrees(c.latitude),
    height: c.height,
  };
}

test('the drone is one model in its own data source; its dot gives way; a step keeps the same entity', async () => {
  const source = runSource();
  const h = harness(source);
  await settle(h);
  const drone = h.drones().getById(DRONE);
  assert.ok(drone, 'the model entity takes the projected item id');
  assert.match(
    drone.model.uri.getValue(now).url ?? String(drone.model.uri.getValue(now)),
    /models\/multirotor\.glb$/,
  );
  assert.equal(h.layer.hasDrone(), true);
  // The four mode changes of the return home are marked on the path.
  assert.equal(
    h.drones().values.filter((e) => e.id.includes('/mode/')).length,
    4,
  );
  assert.equal(h.points().getById(DRONE).point.show.getValue(now), false);
  // Paused at the query time: the stored epoch's own position.
  const at = degrees(drone.position.getValue(now));
  const row = rowAt('16:00:55');
  assert.ok(
    Math.abs(at.lon - row.lon_deg) < 1e-9 &&
      Math.abs(at.lat - row.lat_deg) < 1e-9,
  );
  assert.ok(Math.abs(at.height - row.height_m) < 1e-3);
  // A step re-projects; the drone is the same entity, at the new epoch.
  assert.equal(h.layer.setParams({ validAt: '2026-11-05T16:01:00Z' }), true);
  await settle(h);
  assert.equal(h.drones().getById(DRONE), drone);
  assert.equal(source.calls.select, 1, 'the track is read once per revision');
  assert.ok(
    Math.abs(
      degrees(drone.position.getValue(now)).lat - rowAt('16:01:00').lat_deg,
    ) < 1e-9,
  );
  assert.equal(h.points().getById(DRONE).point.show.getValue(now), false);
  assert.ok(
    h.layer
      .getStats()
      .facts.some(
        (g) =>
          g.label === UAS_TRACK_BINDING && g.lines.includes(DRONE_DISPLAY_FACT),
      ),
    'the row says the drawn motion is a display assumption',
  );
});

test('while the run plays the drone moves between epochs; its label stays on the stored epoch', async () => {
  const h = harness(runSource());
  await settle(h);
  const drone = h.drones().getById(DRONE);
  // 2.5 s of run time past 16:00:55 at 10x.
  assert.equal(
    h.layer.setDisplayClock(
      runningFrom(ms('16:00:55'), performance.now() - 250, 10),
    ),
    true,
  );
  const at = degrees(drone.position.getValue(now));
  const [a, b] = [rowAt('16:00:55'), rowAt('16:01:00')];
  assert.ok(
    at.lat > a.lat_deg && at.lat < b.lat_deg,
    'between the two stored epochs',
  );
  assert.equal(
    drone.label.text.getValue(now),
    'UAS-1 · MISSION\n120 M AGL · LINK LOST 15 S / 30 S',
    'the label is the 16:00:55 row, not a blend',
  );
  // Nose along the outbound leg (~34 degrees): raw glTF -X maps to north-east.
  const q = drone.orientation.getValue(now);
  const expected = droneOrientation(
    drone.position.getValue(now),
    headingOf(a, b),
    180,
  );
  assert.ok(Cesium.Quaternion.equalsEpsilon(q, expected, 1e-6));
  assert.equal(
    h.layer.setDisplayClock({ atMs: 'soon' }),
    false,
    'a malformed clock is refused',
  );
});

function headingOf(a, b) {
  const φ1 = Cesium.Math.toRadians(a.lat_deg);
  const φ2 = Cesium.Math.toRadians(b.lat_deg);
  const Δλ = Cesium.Math.toRadians(b.lon_deg - a.lon_deg);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Cesium.Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
}

test('the model’s nose, glTF -X, points along the heading', () => {
  // fromGltfAsync's default axis correction maps raw glTF (x, y, z) to model (z, x, y).
  const position = Cesium.Cartesian3.fromDegrees(-104.82, 38.84, 1940);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const toEnu = Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4());
  for (const heading of [0, 34, 90, 214, 270]) {
    const rotation = Cesium.Matrix3.fromQuaternion(
      droneOrientation(position, heading, 180),
    );
    const nose = Cesium.Matrix3.multiplyByVector(
      rotation,
      new Cesium.Cartesian3(0, -1, 0),
      new Cesium.Cartesian3(),
    );
    const local = Cesium.Matrix4.multiplyByPointAsVector(
      toEnu,
      nose,
      new Cesium.Cartesian3(),
    );
    const bearing =
      (Cesium.Math.toDegrees(Math.atan2(local.x, local.y)) + 360) % 360;
    const off = Math.abs(((bearing - heading + 540) % 360) - 180);
    assert.ok(off < 1e-6, `heading ${heading}: nose at ${bearing}`);
  }
  // The follow camera starts behind the nose.
  const back = followOffset(90);
  assert.ok(back.x < 0 && Math.abs(back.y) < 1e-9 && back.z > 0);
});

test('clicking the model opens the stored epoch’s card, which rides with the model', async () => {
  const h = harness(runSource());
  await settle(h);
  h.click(h.drones().getById(DRONE));
  const [, entries, options] = h.cards.at(-1);
  assert.equal(
    entries[0].title,
    'UAS-1 (simulated) · platform:foundation:uas-1',
  );
  assert.match(entries[0].details.join('\n'), /link lost 15 s \/ 30 s/);
  assert.equal(typeof entries[0].position, 'function');
  assert.equal(options.moving, true);
  const anchored = degrees(entries[0].position());
  assert.ok(Math.abs(anchored.lat - rowAt('16:00:55').lat_deg) < 1e-9);
});

test('a flight model with no drone model draws none, keeps the dot and says why', async () => {
  const product = SELECTION.products[0];
  const selection = {
    ...SELECTION,
    products: [
      {
        ...product,
        semantic_metadata: {
          ...product.semantic_metadata,
          models: {
            ...product.semantic_metadata.models,
            flight: 'dataforge.ornithopter/1',
          },
        },
      },
    ],
  };
  const h = harness(runSource({ selection }));
  await settle(h);
  assert.equal(h.layer.hasDrone(), false);
  assert.equal(h.drones().values.length, 0);
  assert.notEqual(h.points().getById(DRONE).point.show?.getValue(now), false);
  const lines = h.layer
    .getStats()
    .facts.find((g) => g.label === UAS_TRACK_BINDING).lines;
  assert.ok(
    lines.some((l) => /no model drawn: .*dataforge\.ornithopter\/1/.test(l)),
  );
  assert.equal(h.layer.followDrone(true), false, 'nothing to follow');
});

test('follow tracks the drone with the tracking camera; another layer taking the camera ends it', async () => {
  const h = harness(runSource());
  await settle(h);
  const drone = h.drones().getById(DRONE);
  assert.equal(h.layer.followDrone(true), true);
  assert.equal(h.viewer.trackedEntity, drone);
  assert.equal(h.layer.following(), true);
  assert.equal(drone.trackingReferenceFrame, Cesium.TrackingReferenceFrame.ENU);
  assert.equal(h.layer.followDrone(false), false);
  assert.equal(h.viewer.trackedEntity, undefined);
  assert.equal(h.layer.following(), false);
  h.layer.followDrone(true);
  h.viewer.trackedEntity = { id: 'some aircraft' };
  h.viewer.trackedEntityChanged.raiseEvent();
  assert.equal(h.layer.following(), false);
  // Leaving the row stops it too.
  h.viewer.trackedEntity = undefined;
  h.layer.followDrone(true);
  h.layer.disable(h.viewer);
  assert.equal(h.layer.following(), false);
  assert.equal(h.viewer.trackedEntity, undefined);
});

/** A GLB's JSON chunk and every POSITION accessor's bounds. */
function glbFacts(url) {
  const bytes = readFileSync(new URL(`../../../public${url}`, import.meta.url));
  const length = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of gltf.meshes ?? [])
    for (const primitive of mesh.primitives) {
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      accessor.min.forEach((v, i) => (min[i] = Math.min(min[i], v)));
      accessor.max.forEach((v, i) => (max[i] = Math.max(max[i], v)));
    }
  return { gltf, min, max, bytes: bytes.length };
}

test('every drone model follows public/models: baked, metres, +Y up, origin-centred, credited', async () => {
  const { FLIGHT_MODEL_AIRFRAMES } = await import('./uasTrack.js');
  const readme = readFileSync(
    new URL('../../../public/models/README.md', import.meta.url),
    'utf8',
  );
  for (const { url } of Object.values(FLIGHT_MODEL_AIRFRAMES)) {
    const { gltf, min, max, bytes } = glbFacts(url);
    for (const node of gltf.nodes ?? []) {
      for (const key of ['matrix', 'translation', 'rotation', 'scale'])
        assert.equal(
          node[key],
          undefined,
          `${url}: ${node.name} has an unapplied ${key}`,
        );
    }
    const extents = max.map((v, i) => v - min[i]);
    assert.ok(
      extents[1] < extents[0] && extents[1] < extents[2],
      `${url}: +Y must be the short vertical axis`,
    );
    // A small multirotor in metres, not centimetres or a 24x calibration.
    assert.ok(
      Math.max(...extents) > 0.2 && Math.max(...extents) < 3,
      `${url}: ${extents} is not a drone in metres`,
    );
    const centre = max.map((v, i) => (v + min[i]) / 2);
    assert.ok(
      centre.every((v) => Math.abs(v) <= 0.001),
      `${url}: centre ${centre}`,
    );
    assert.ok(bytes < 400_000, `${url}: ${bytes} bytes`);
    assert.ok(
      readme.includes(`\`${url.split('/').at(-1)}\``),
      `${url} needs a README attribution row`,
    );
  }
});

test('a receiver gives way to its drone whichever row draws it, and comes back when the drone goes', () => {
  const source = {};
  const viewer = {
    dataSources: { add() {}, remove() {} },
    isDestroyed: () => false,
  };
  const tracks = uasTracksFromSelection(SELECTION);
  const identity = tracks[0].identity;
  const row = createDroneView({
    id: 'world-product:simulation.uas.track',
    source,
    displayMs: () => null,
  });
  row.init(viewer);
  row.show(true);
  assert.equal(droneDrawn(source, REVISION, identity), false);
  row.draw(tracks, { revisionId: REVISION });
  assert.equal(droneDrawn(source, REVISION, identity), true);
  assert.equal(droneDrawn(source, 'another-revision', identity), false);
  assert.equal(
    droneDrawn({}, REVISION, identity),
    false,
    'another world draws nothing',
  );
  // A second layer drawing the same drone keeps it drawn when the first hides.
  const generic = createDroneView({
    id: 'world-model',
    source,
    displayMs: () => null,
  });
  generic.init(viewer);
  generic.show(true);
  generic.draw(tracks, { revisionId: REVISION });
  row.show(false);
  assert.equal(droneDrawn(source, REVISION, identity), true);
  generic.destroy();
  assert.equal(droneDrawn(source, REVISION, identity), false);
  row.show(true);
  assert.equal(droneDrawn(source, REVISION, identity), true);
  row.clear();
  assert.equal(droneDrawn(source, REVISION, identity), false);
});

test('the follow camera starts close behind a drone, with a drone-sized minimum range', () => {
  const offset = followOffset(0);
  const range = Math.hypot(offset.x, offset.y, offset.z);
  assert.ok(
    offset.y < 0 && offset.z > 0,
    'south of and above a drone flying north',
  );
  assert.ok(range > FOLLOW_VIEW.minimumRangeM && range < 150, `range ${range}`);
});
