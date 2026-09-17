import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BINDING_PALETTE,
  DISPLAY_CHOICES,
  TEMPERATURE_RAMP_K,
  bindingColor,
  contextRecordFor,
  countByBinding,
  descriptorCardLines,
  fieldSampleRecordsFromProjection,
  inspectionLines,
  lineageCardLines,
  MAX_CARD_LINE_CHARS,
  packCardLines,
  pointRecordsFromProjection,
  selectionCardLines,
  shortRef,
  summarizeProjection,
  temperatureColor,
} from './adapter.js';

const read = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );
const fixture = read('experiment-002.projection.json');
const aircraftProvenance = read('experiment-002.provenance.aircraft.json');
const weatherProvenance = read('experiment-002.provenance.weather.json');
const DLH = 'world.aircraft/track:opensky:icao24:3c4b33';
const NODE = 'world.weather/air_temperature/850hPa/39.000/237.000';

test('the fixture is the retained Experiment 002 view', () => {
  assert.equal(fixture.counts.points, 97);
  assert.equal(fixture.counts.field_samples, 81);
  assert.equal(fixture.query.predicates.pressure_hpa, 850);
  assert.equal(
    fixture.projection_spec.display_assumptions.aircraft_height,
    'adsb-geometric-as-wgs84-ellipsoid',
  );
});

test('point records keep ids, positions and the projected item verbatim; colour is by binding', () => {
  const { records, skipped } = pointRecordsFromProjection(fixture);
  assert.equal(records.length, fixture.points.length);
  assert.equal(skipped.length, 0);
  const dlh = records.find((record) => record.id === DLH);
  const source = fixture.points.find((point) => point.id === DLH);
  assert.equal(dlh.kind, 'point');
  assert.equal(dlh.binding, 'world.aircraft');
  assert.equal(dlh.longitude, -121.9978);
  assert.equal(dlh.latitude, 38.503);
  assert.equal(dlh.height, 5913.12);
  assert.deepEqual(dlh.record, source);
  assert.equal(dlh.record.height.barometric_height_m, 5615.94);
  assert.equal(dlh.display, DISPLAY_CHOICES.point);
  assert.equal(dlh.stale, false);
  assert.deepEqual(dlh.colorRgb, bindingColor('world.aircraft'));
  assert.ok(BINDING_PALETTE.includes(bindingColor('world.vessels')));
  assert.deepEqual(
    bindingColor('world.vessels'),
    bindingColor('world.vessels'),
  );
  // a point the backplane marked stale gets the dimmed display choice, nothing else changes
  const marked = pointRecordsFromProjection({
    points: [
      {
        ...source,
        time: { ...source.time, age_at_query_seconds: 61, stale: true },
      },
    ],
  }).records[0];
  assert.equal(marked.stale, true);
  assert.equal(marked.display, DISPLAY_CHOICES['point-stale']);
  assert.equal(marked.display.keyedBy, 'time.stale');
  assert.equal(marked.height, 5913.12);
});

test('field-sample records stay at display height 0 with value and units untouched', () => {
  const { records, skipped } = fieldSampleRecordsFromProjection(fixture);
  assert.equal(records.length, fixture.field_samples.length);
  assert.equal(skipped.length, 0);
  const node = records.find((record) => record.id === NODE);
  const source = fixture.field_samples.find((sample) => sample.id === NODE);
  assert.equal(node.kind, 'field-sample');
  assert.equal(node.binding, 'world.weather');
  assert.equal(node.height, 0);
  assert.equal(node.longitude, -123);
  assert.equal(node.latitude, 39);
  assert.equal(node.value, 297.25);
  assert.equal(node.units, 'K');
  assert.equal(node.record.native.lon, 237);
  assert.deepEqual(node.record, source);
  assert.equal(JSON.stringify(node.record).includes('colorRgb'), false);
  assert.equal(node.display.clampToGround, true);
  assert.deepEqual(
    countByBinding([
      ...pointRecordsFromProjection(fixture).records,
      ...records,
    ]),
    [
      { binding: 'world.aircraft', points: 97, samples: 0 },
      { binding: 'world.weather', points: 0, samples: 81 },
    ],
  );
});

test('non-finite positions or values are skipped with a reason, never guessed', () => {
  const broken = {
    points: [
      { id: 'a', position: { lon: null, lat: 1, height_m: 2 } },
      { position: { lon: 1, lat: 1, height_m: 2 } },
    ],
    field_samples: [
      { id: 'w', position: { lon: 1, lat: 1, height_m: 0 }, value: 'n/a' },
    ],
  };
  assert.deepEqual(pointRecordsFromProjection(broken), {
    records: [],
    skipped: [
      { id: 'a', reason: 'non-finite-position' },
      { id: '', reason: 'missing-id' },
    ],
  });
  assert.deepEqual(fieldSampleRecordsFromProjection(broken).skipped, [
    { id: 'w', reason: 'non-finite-value' },
  ]);
});

test('a 2-D point (no height declared, DWM-75) is drawn on the surface at 0, never skipped; a null height under a declared height block still is', () => {
  const surface = {
    id: 'world.fires.viirs_noaa20/detection:firms:N20:2026-09-17T1006Z:30.2:-97.7',
    binding: 'world.fires.viirs_noaa20',
    position: { lon: -97.7, lat: 30.2, height_m: null },
    height: null,
    time: {
      valid_at: '2026-09-17T10:06:00+00:00',
      known_as_of: '2026-09-17T12:00:00+00:00',
    },
    semantic_ref: {
      semantic_identity: 'detection:firms:N20:2026-09-17T1006Z:30.2:-97.7',
    },
    source_ref: {
      source: {
        type_id: 'source.firms.viirs_noaa20_nrt.v1',
        content_id: 'sha256:313f6326c7f8',
      },
      row_index: 3,
    },
    properties: { satellite: 'N20', confidence: 'n', frp_mw: 12.5 },
  };
  const declared = {
    ...surface,
    id: 'world.aircraft/x',
    height: { value_m: null, source_field: 'geometric_height_m' },
  };
  const { records, skipped } = pointRecordsFromProjection({
    points: [surface, declared],
  });
  assert.deepEqual(skipped, [
    { id: 'world.aircraft/x', reason: 'non-finite-position' },
  ]);
  assert.equal(records.length, 1);
  const [fire] = records;
  assert.equal(fire.height, 0);
  assert.equal(fire.surface, true);
  assert.equal(fire.longitude, -97.7);
  assert.deepEqual(fire.record, surface, 'the projected item is kept verbatim');
  const aircraft = pointRecordsFromProjection(fixture).records[0];
  assert.equal(aircraft.surface, false);
  const lines = selectionCardLines(fire);
  assert.equal(lines[0], 'detection:firms:N20:2026-09-17T1006Z:30.2:-97.7');
  assert.match(
    lines.join('\n'),
    /world\.fires\.viirs_noaa20 · surface entity, no height declared/,
  );
  assert.match(lines.join('\n'), /^grant none needed$/m);
  assert.match(lines.join('\n'), /satellite N20 · confidence n/);
  assert.match(
    lines.join('\n'),
    /source\.firms\.viirs_noaa20_nrt\.v1@313f6326 row 3/,
  );
  for (const line of lines) assert.ok(line.length <= MAX_CARD_LINE_CHARS, line);
});

test('temperature colour clamps to the ramp and never throws', () => {
  assert.deepEqual(
    temperatureColor(200),
    temperatureColor(TEMPERATURE_RAMP_K.min),
  );
  assert.deepEqual(
    temperatureColor(400),
    temperatureColor(TEMPERATURE_RAMP_K.max),
  );
  assert.notDeepEqual(temperatureColor(280), temperatureColor(300));
  assert.deepEqual(temperatureColor(Number.NaN), [0.6, 0.6, 0.6]);
});

test('selection cards quote the grants, distinguish product-time age from query age, and read properties generically', () => {
  const point = pointRecordsFromProjection(fixture).records.find(
    (r) => r.id === DLH,
  );
  const lines = selectionCardLines(point);
  assert.match(lines[0], /DLH455 · track:opensky:icao24:3c4b33/);
  assert.match(
    lines.join('\n'),
    /world\.aircraft · height 5913 m from geometric_height_m · baro 5616 m/,
  );
  assert.match(
    lines.join('\n'),
    /^grant aircraft_height:adsb-geometric-as-wgs84-ellipsoid$/m,
  );
  // Every line fits the card the overlay host can place (DWM-60).
  for (const line of lines) assert.ok(line.length <= MAX_CARD_LINE_CHARS, line);
  assert.match(lines.join('\n'), /held-report · age at product time 1 s/);
  assert.equal(
    lines.some((l) => l.startsWith('age at query')),
    false,
  );
  assert.match(lines.join('\n'), /aircraft\.track_state_set\.v1@7b84ecd0/);
  assert.match(
    lines.join('\n'),
    /source\.opensky\.state_vectors\.v1@452fc448 row 11/,
  );

  const marked = pointRecordsFromProjection({
    points: [
      {
        ...point.record,
        time: { ...point.record.time, age_at_query_seconds: 61, stale: true },
      },
    ],
  }).records[0];
  assert.match(
    selectionCardLines(marked).join('\n'),
    /age at query 61 s · STALE \(view policy\)/,
  );

  // a synthetic product with no callsign: identity is the title, properties are listed as they come
  const vessel = pointRecordsFromProjection({
    points: [
      {
        id: 'world.vessels/track:ais:mmsi:1',
        binding: 'world.vessels',
        position: { lon: -122, lat: 37.5, height_m: 13 },
        height: {
          value_m: 13,
          source_field: 'antenna_height_m',
          assumption: 'vessel_height:x',
        },
        time: { valid_at: 't', temporal_status: null, age_seconds: null },
        semantic_ref: { semantic_identity: 'track:ais:mmsi:1' },
        properties: { mmsi: '1', fix_quality: 'gnss', speed_kn: 9.5 },
      },
    ],
  }).records[0];
  const vlines = selectionCardLines(vessel);
  assert.equal(vlines[0], 'track:ais:mmsi:1');
  assert.match(vlines.join('\n'), /mmsi 1 · fix_quality gnss/);
  assert.equal(vlines.join('\n').includes('speed_kn'), false);

  const weather = fieldSampleRecordsFromProjection(fixture).records.find(
    (r) => r.id === NODE,
  );
  const wlines = selectionCardLines(weather);
  assert.equal(wlines[0], '297.25 K air_temperature @ 850 hPa');
  assert.match(wlines[1], /pressure level, not altitude · drawn at 0 m/);
  assert.match(wlines[2], /native lon 237\.000 \(0\.\.360\)/);
  assert.match(wlines.join('\n'), /lag 3445 s/);
});

test('card fragments pack into lines the host can place, continuation lines indented', () => {
  assert.deepEqual(packCardLines(['a', 'b', null, '', 'c']), ['a · b · c']);
  const packed = packCardLines(['x'.repeat(40), 'y'.repeat(40), 'z'], 72);
  assert.deepEqual(packed, ['x'.repeat(40), `  ${'y'.repeat(40)} · z`]);
  // an oversize fragment stands alone; the host ellipsizes it
  assert.deepEqual(packCardLines(['short', 'w'.repeat(80)], 72), [
    'short',
    `  ${'w'.repeat(80)}`,
  ]);
  assert.deepEqual(packCardLines([]), []);
});

test("the inspection block shows the item's admitted descriptor then its lineage", () => {
  const point = fixture.points.find((p) => p.id === DLH);
  const lines = inspectionLines(point, aircraftProvenance);
  const text = lines.join('\n');
  assert.match(
    lines[0],
    new RegExp(
      `descriptor ${point.semantic_ref.descriptor_id.slice(0, 8)} · admitted · aircraft\\.track_state_set\\.v1`,
    ),
  );
  assert.match(
    text,
    /valid instant 2026-09-10T22:57:25\+00:00\n {2}known instant/,
  );
  assert.match(text, /spatial WGS84 bbox/);
  assert.match(
    text,
    /access entity_set\/v1 @ world-entity-index\n {2}dimensions space,valid_time,identity/,
  );
  assert.match(
    text,
    /representation positioned_entities\/v1\n {2}capabilities point,height,temporal_age\n {2}requires /,
  );
  assert.match(text, /time\{valid,sampled,age_basis\}/);
  assert.match(text, /position\{[^}]*lon[^}]*\}/);
  assert.match(text, /admission \d+ checks passed/);
  assert.match(
    text,
    /produced by aircraft\.materialize-track-state@1 · succeeded · 2 inputs/,
  );
  assert.match(text, /bound in world\.aircraft@/);
  // the source type is not repeated when it is the ref's own type
  assert.match(
    text,
    /source source\.opensky\.state_vectors\.v1@452fc448\n {2}connector opensky-replay · publication/,
  );
  for (const line of lines) assert.ok(line.length <= MAX_CARD_LINE_CHARS, line);
  // the weather product: 4 retained sources reached through the block ("via")
  const sample = fixture.field_samples.find((s) => s.id === NODE);
  const wtext = inspectionLines(sample, weatherProvenance).join('\n');
  assert.match(
    wtext,
    /representation field_samples\/v1 · capabilities sample,annotation/,
  );
  assert.match(wtext, /via weather\.field_block\.v1@/);
  assert.equal((wtext.match(/^source /gm) || []).length, 4);
  // an item whose descriptor is not in the report says so instead of guessing another
  assert.match(
    inspectionLines(
      { semantic_ref: { descriptor_id: 'nope' } },
      aircraftProvenance,
    )[0],
    /descriptor nope not in the provenance report/,
  );
  assert.deepEqual(descriptorCardLines(null), []);
  assert.deepEqual(lineageCardLines(null), []);
});

test('context records carry semantic and source refs verbatim', () => {
  const point = pointRecordsFromProjection(fixture).records.find(
    (r) => r.id === DLH,
  );
  const record = contextRecordFor(point, {
    layerId: 'world-model',
    layerName: 'World Model',
    source: 'Dataforge World Model',
    revisionId: fixture.revision_id,
  });
  assert.equal(record.id, DLH);
  assert.equal(record.layerId, 'world-model');
  assert.equal(record.label, selectionCardLines(point)[0]);
  assert.equal(record.latitude, 38.503);
  assert.deepEqual(record.properties.semantic_ref, point.record.semantic_ref);
  assert.deepEqual(record.properties.source_ref, point.record.source_ref);
  assert.equal(record.properties.revision_id, fixture.revision_id);
  assert.equal(record.properties.kind, 'point');
  assert.equal(record.properties.height.value_m, 5913.12);

  const weather = fieldSampleRecordsFromProjection(fixture).records.find(
    (r) => r.id === NODE,
  );
  const sample = contextRecordFor(weather, { layerId: 'world-model' });
  assert.equal(sample.properties.value, 297.25);
  assert.equal(sample.properties.pressure_hpa, 850);
  assert.equal(sample.properties.vertical, 'pressure-hPa-not-altitude');
  assert.deepEqual(sample.properties.native, weather.record.native);
});

test('summary carries counts, policy echoes, withheld and marked; short refs', () => {
  const summary = summarizeProjection(fixture);
  assert.equal(summary.revisionId, fixture.revision_id);
  assert.deepEqual(summary.counts, {
    points: 97,
    field_samples: 81,
    annotations: 1,
    assumptions: 6,
    omissions: 1,
  });
  assert.match(
    summary.annotations[0],
    /850 hPa is a pressure level, not an altitude/,
  );
  assert.equal(summary.omissions[0].reason, 'no-geometric_height_m');
  assert.deepEqual(summary.policies, []);
  assert.equal(summary.withheld, 0);
  assert.equal(summary.marked, 0);
  const withPolicy = summarizeProjection({
    ...fixture,
    points: fixture.points.map((p, i) => ({
      ...p,
      time: { ...p.time, stale: i < 3 },
    })),
    assumptions: [
      ...fixture.assumptions,
      {
        kind: 'projection-policy',
        policy: 'temporal_age',
        binding: 'world.aircraft',
        mode: 'withhold',
        withheld: 5,
      },
      {
        kind: 'policy-not-applicable',
        policy: 'temporal_age',
        binding: 'world.weather',
        reason: 'policy-not-declared',
      },
    ],
    omissions: [
      ...fixture.omissions,
      { reason: 'temporal-age-withheld', binding: 'world.aircraft', count: 5 },
    ],
  });
  assert.equal(withPolicy.policies.length, 2);
  assert.equal(withPolicy.withheld, 5);
  assert.equal(withPolicy.marked, 3);
  assert.equal(
    shortRef({
      type_id: 'aircraft.track_state_set.v1',
      content_id: 'sha256:7b84ecd0559a',
    }),
    'aircraft.track_state_set.v1@7b84ecd0',
  );
  assert.equal(shortRef(null), '');
});
