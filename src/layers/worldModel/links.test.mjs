/**
 * A run's RF paths to its drone, coloured by obstruction (GEN-405), on a local World Model's
 * answers for Foundation's shadowed example (examples/uas/shadowed.sexpr on its captured
 * cs-downtown pins, Foundation GEN-420 delivered to World Model DWM-284):
 *   fixtures/shadowed.track.select.json             the drone's whole track (`POST /select`)
 *   fixtures/shadowed.sites.select.json             the run's sites as of 16:00:20 (`POST /select`)
 *   fixtures/shadowed.links.<hhmmss>.project.json   the jammer's path at 16:00:20, :38 and :45 (`POST /project`)
 * The tower cuts the GCS path 16:00:15–28. The jammer is silent until 16:00:37, then radiates in
 * the open, and from 16:00:41 from behind the tower. The not-modelled cases are runs without a
 * surface: the GEN-395 prod track and the ISS geometry.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import { lineRecordsFromProjection, selectionCardLines } from './adapter.js';
import { createDroneView, droneItemId } from './droneView.js';
import {
  OBSTRUCTION_STATES,
  edgeAboveGroundM,
  obstructionLines,
  obstructionOf,
} from './linkObstruction.js';
import {
  LINK_VIEW_DISPLAY,
  c2PathIds,
  followDrone,
  linkEdgeEntity,
  linkEdgeId,
  pathOwner,
} from './linkView.js';
import {
  RF_DISPLAY,
  linkPowerColor,
  linkStyle,
  receivedDbw,
} from './rfStyle.js';
import { uasCard } from './uasCard.js';
import { createUasSites, siteName, uasSitesFromSelection } from './uasSites.js';
import {
  displayPoseAt,
  storedRowAt,
  uasTracksFromSelection,
} from './uasTrack.js';

const read = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );
const [TRACK] = uasTracksFromSelection(read('shadowed.track.select.json'));
const SITES_SELECTION = read('shadowed.sites.select.json');
const SITES = uasSitesFromSelection(SITES_SELECTION);
const LINKS = Object.fromEntries(
  ['160020', '160038', '160045'].map((t) => [
    t,
    read(`shadowed.links.${t}.project.json`),
  ]),
);
const at = (hms) => Date.parse(`2026-11-05T${hms}Z`);
const hms = (row) => row.validTime.slice(11, 19);
const NOW = Cesium.JulianDate.now();

test('the GCS path is obstructed behind the tower and clear around it; its edge is a roof over the street', () => {
  assert.equal(
    TRACK.header.models.obstruction,
    'dataforge.p526-knife-edge-deygout/1',
  );
  const cut = TRACK.rows.filter(
    (r) => r.c2.state === OBSTRUCTION_STATES.obstructed,
  );
  assert.deepEqual(
    [hms(cut[0]), hms(cut.at(-1)), cut.length],
    ['16:00:15', '16:00:28', 14],
  );
  for (const row of TRACK.rows) {
    const { state, lossDb, edges, edge } = row.c2;
    if (state === OBSTRUCTION_STATES.obstructed) {
      assert.ok(lossDb > 0 && edges >= 1 && edge, hms(row));
      assert.ok(edge.roofed && edge.groundM < edge.heightM, hms(row));
    } else {
      assert.equal(state, OBSTRUCTION_STATES.clear, hms(row));
      assert.ok(lossDb === 0 && edges === 0 && edge === null, hms(row));
    }
  }
  // The roof stands some 68 m over the street at 16:00:20.
  const behind = storedRowAt(TRACK.rows, at('16:00:20')).c2;
  assert.ok(Math.abs(edgeAboveGroundM(behind.edge) - 67.8) < 1);
  assert.deepEqual(obstructionLines(behind), [
    'obstructed · building or tree',
    `loss ${behind.lossDb.toFixed(1)} dB over ${behind.edges} edges`,
    `edge top 1,880 m · ${Math.round(edgeAboveGroundM(behind.edge))} m above ground`,
  ]);
});

test('a path on a run without a surface says nothing about obstruction', () => {
  const [freeSpace] = uasTracksFromSelection(read('uas-track.select.json'));
  assert.ok(freeSpace.rows.length > 1);
  assert.ok(
    freeSpace.rows.every((r) => r.c2.state === OBSTRUCTION_STATES.notModelled),
  );
  const iss = read('run-geometry.iss.json').links;
  for (const link of iss) {
    const style = linkStyle({ reason: link.reason, ...link.values });
    assert.equal(style.obstruction.state, OBSTRUCTION_STATES.notModelled);
    assert.ok(!style.label.includes('obstructed'), style.label);
  }
  assert.deepEqual(obstructionLines(obstructionOf({})), []);
  assert.deepEqual(
    uasCard({ properties: { mode_code: 0, c2_state_code: 0 } }).extra,
    [],
  );
});

test("a jammer's obstructed path is a dashed beam; in the open it is solid; silent and shielded it stays faint", () => {
  const style = (t) => linkStyle(LINKS[t].lines[0].properties);
  const silent = style('160020');
  const open = style('160038');
  const behind = style('160045');
  assert.equal(silent.display, RF_DISPLAY['link-idle']);
  assert.equal(open.display, RF_DISPLAY['link-clear']);
  assert.equal(behind.display, RF_DISPLAY['link-diffracted']);
  assert.ok(behind.display.dashed && !open.display.dashed);
  // Still coloured by the power that arrives, which already lost the edge.
  const dbw = receivedDbw(LINKS['160045'].lines[0].properties.received_power_w);
  assert.deepEqual(behind.colorRgb, linkPowerColor(dbw));
  assert.match(behind.label, /^obstructed \d+ dB · -\d+\.\d dBW at receiver$/);
  // Obstruction is read from `obstructed`, never `reason`: a silent jammer behind a wall is shielded.
  const shielded = linkStyle({
    ...LINKS['160045'].lines[0].properties,
    reason: 'inactive',
    active: false,
  });
  assert.equal(shielded.display, RF_DISPLAY['link-idle-obstructed']);
  assert.match(shielded.label, /^jammer silent · path obstructed \d+ dB$/);
});

test("a link's card says its loss and how high its edge stands, not the raw columns", () => {
  const [record] = lineRecordsFromProjection(LINKS['160045']).records;
  const lines = selectionCardLines(record);
  assert.ok(lines.includes('obstructed · building or tree'), lines.join('\n'));
  assert.ok(lines.some((l) => /^loss \d+\.\d dB over \d edges?$/.test(l)));
  assert.ok(lines.some((l) => / m above ground$/.test(l)));
  assert.ok(
    !lines.some((l) => /edge_nu|edge_roofed|obstruction_loss_db/.test(l)),
    lines.join('\n'),
  );
  // The drone's card says its C2 path's, under the C2 lines.
  const row = read('shadowed.track.select.json').products[0].values.find((r) =>
    r.valid_time.includes('16:00:20'),
  );
  const card = uasCard(
    {
      properties: row.value,
      semantic_ref: { semantic_identity: TRACK.identity },
    },
    TRACK.header,
  );
  assert.match(card.extra[0], /^C2 path obstructed · building or tree$/);
  assert.equal(card.extra.length, 3);
});

test("the run's sites put the GCS where the scenario declares it, read once per revision", async () => {
  const gcs = SITES.get(TRACK.gcs);
  assert.deepEqual(
    [gcs.kind, gcs.position],
    ['gcs', { lon: -104.8259, lat: 38.8323, height: 1813.85 }],
  );
  assert.equal(SITES.get('home:foundation:uas-1').kind, 'home');
  assert.equal(siteName(TRACK.gcs), 'GCS-1');
  let calls = 0;
  const reader = createUasSites({
    async select() {
      calls++;
      return SITES_SELECTION;
    },
  });
  const first = await reader.read({
    revisionId: 'r1',
    validAt: TRACK.rows[0].validTime,
  });
  await reader.read({ revisionId: 'r1', validAt: TRACK.rows[9].validTime });
  assert.equal(calls, 1);
  assert.equal(first.get(TRACK.gcs).position.height, 1813.85);
  assert.equal(
    (await reader.read({ revisionId: 'r1' })).size,
    0,
    'no instant, no read',
  );
});

function viewer() {
  const sources = [];
  return {
    sources,
    dataSources: { add: (s) => sources.push(s), remove() {} },
    isDestroyed: () => false,
  };
}

test("the drone's C2 path runs from the GCS to the drawn drone, dashed and edged only while the tower cuts it", () => {
  let ms = at('16:00:20');
  const view = createDroneView({ id: 'run', displayMs: () => ms });
  const v = viewer();
  view.init(v);
  view.show(true);
  view.draw([TRACK], { revisionId: 'r1', sites: SITES });
  const itemId = droneItemId(TRACK.identity);
  const ids = c2PathIds(itemId);
  const entities = v.sources[0].entities;
  const line = entities.getById(ids.line);
  const edge = entities.getById(ids.edge);
  assert.ok(line && edge);
  const gcs = SITES.get(TRACK.gcs).position;
  const ends = () => line.polyline.positions.getValue(NOW);
  const near = (cartesian, p) =>
    Cesium.Cartesian3.distance(
      cartesian,
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
    ) < 1e-3;
  // Behind the tower: from the GCS to where the drone is drawn, dashed, its edge on the roof.
  assert.ok(
    near(ends()[0], gcs) && near(ends()[1], displayPoseAt(TRACK.rows, ms)),
  );
  const dash = () => line.polyline.material.dashPattern.getValue(NOW);
  assert.equal(dash(), LINK_VIEW_DISPLAY.dashPatternObstructed);
  const roof = storedRowAt(TRACK.rows, ms).c2.edge;
  assert.ok(edge.point.show.getValue(NOW));
  assert.ok(
    near(edge.position.getValue(NOW), {
      lon: roof.lon,
      lat: roof.lat,
      height: roof.heightM,
    }),
  );
  assert.match(edge.label.text.getValue(NOW), /^C2 EDGE · \d+ m ABOVE GROUND$/);
  // Between stored epochs the line follows the drone; its look stays the stored epoch's.
  ms = at('16:00:20') + 400;
  assert.ok(near(ends()[1], displayPoseAt(TRACK.rows, ms)));
  assert.equal(dash(), LINK_VIEW_DISPLAY.dashPatternObstructed);
  // Clear of the tower: solid, no edge.
  ms = at('16:00:35');
  assert.equal(dash(), LINK_VIEW_DISPLAY.dashPatternClear);
  assert.equal(edge.point.show.getValue(NOW), false);
  // A click on the path or its edge means the drone.
  assert.equal(view.itemForPick(ids.line), itemId);
  assert.equal(view.itemForPick(ids.edge), itemId);
  assert.equal(view.itemForPick(`${itemId}/mode/0`), null);
  // A run without sites draws the drone and no path.
  view.draw([TRACK], { revisionId: 'r1', sites: new Map() });
  assert.ok(entities.getById(itemId) && !entities.getById(ids.line));
});

test("a jammer's path marks its edge while obstructed, follows the drone, and a click on the edge means the link", () => {
  const [behind] = lineRecordsFromProjection(LINKS['160045']).records;
  const [open] = lineRecordsFromProjection(LINKS['160038']).records;
  assert.equal(linkEdgeEntity(open), null);
  const marker = linkEdgeEntity(behind);
  assert.equal(marker.id, linkEdgeId(behind.id));
  assert.equal(pathOwner(marker.id), behind.id);
  assert.equal(pathOwner(behind.id), null);
  const entity = new Cesium.Entity({
    id: behind.id,
    polyline: { positions: [] },
  });
  let ms = at('16:00:45');
  const anchor = followDrone(entity, behind, TRACK, () => ms);
  const ends = () => entity.polyline.positions.getValue(NOW);
  const site = behind.positions[0];
  const pose = () => displayPoseAt(TRACK.rows, ms);
  const near = (c, p) =>
    Cesium.Cartesian3.distance(
      c,
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
    ) < 1e-3;
  assert.ok(near(ends()[0], site) && near(ends()[1], pose()));
  ms += 600;
  assert.ok(near(ends()[1], pose()) && near(anchor(), pose()));
});
