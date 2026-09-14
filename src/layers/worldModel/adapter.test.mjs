import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DISPLAY_CHOICES,
  TEMPERATURE_RAMP_K,
  aircraftRecordsFromProjection,
  contextRecordFor,
  selectionCardLines,
  shortRef,
  summarizeProjection,
  temperatureColor,
  weatherRecordsFromProjection,
} from './adapter.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/experiment-002.projection.json', import.meta.url),
    'utf8',
  ),
);
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

test('aircraft records keep ids, positions and the projected item verbatim', () => {
  const { records, skipped } = aircraftRecordsFromProjection(fixture);
  assert.equal(records.length, fixture.points.length);
  assert.equal(skipped.length, 0);
  const dlh = records.find((record) => record.id === DLH);
  const source = fixture.points.find((point) => point.id === DLH);
  assert.equal(dlh.kind, 'aircraft');
  assert.equal(dlh.longitude, -121.9978);
  assert.equal(dlh.latitude, 38.503);
  assert.equal(dlh.height, 5913.12);
  assert.deepEqual(dlh.record, source);
  assert.equal(dlh.record.height.barometric_height_m, 5615.94);
  assert.equal(
    dlh.record.height.assumption,
    'aircraft_height:adsb-geometric-as-wgs84-ellipsoid',
  );
  assert.equal(dlh.display, DISPLAY_CHOICES.aircraft);
  assert.equal(dlh.display.positionSmoothing, 'none');
});

test('weather records stay at display height 0 with value and units untouched', () => {
  const { records, skipped } = weatherRecordsFromProjection(fixture);
  assert.equal(records.length, fixture.field_samples.length);
  assert.equal(skipped.length, 0);
  const node = records.find((record) => record.id === NODE);
  const source = fixture.field_samples.find((sample) => sample.id === NODE);
  assert.equal(node.kind, 'field-sample');
  assert.equal(node.height, 0);
  assert.equal(node.longitude, -123);
  assert.equal(node.latitude, 39);
  assert.equal(node.value, 297.25);
  assert.equal(node.units, 'K');
  assert.equal(node.record.native.lon, 237);
  assert.deepEqual(node.record, source);
  assert.equal(node.colorRgb.length, 3);
  assert.ok(node.colorRgb.every((c) => c >= 0 && c <= 1));
  // Colour is a display choice; it must not be written into the item.
  assert.equal(JSON.stringify(node.record).includes('colorRgb'), false);
  assert.equal(node.display.clampToGround, true);
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
  assert.deepEqual(aircraftRecordsFromProjection(broken), {
    records: [],
    skipped: [
      { id: 'a', reason: 'non-finite-position' },
      { id: '', reason: 'missing-id' },
    ],
  });
  assert.deepEqual(weatherRecordsFromProjection(broken).skipped, [
    { id: 'w', reason: 'non-finite-value' },
  ]);
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

test('selection cards quote the grants and the pressure caveat', () => {
  const aircraft = aircraftRecordsFromProjection(fixture).records.find(
    (r) => r.id === DLH,
  );
  const lines = selectionCardLines(aircraft);
  assert.match(lines[0], /DLH455 · track:opensky:icao24:3c4b33/);
  assert.match(
    lines.join('\n'),
    /5913 m from geometric_height_m \(aircraft_height:adsb-geometric-as-wgs84-ellipsoid\)/,
  );
  assert.match(lines.join('\n'), /baro 5616 m/);
  assert.match(lines.join('\n'), /held-report · age 1 s/);
  assert.match(lines.join('\n'), /aircraft\.track_state_set\.v1@7b84ecd0/);
  assert.match(
    lines.join('\n'),
    /source\.opensky\.state_vectors\.v1@452fc448 row 11/,
  );

  const weather = weatherRecordsFromProjection(fixture).records.find(
    (r) => r.id === NODE,
  );
  const wlines = selectionCardLines(weather);
  assert.equal(wlines[0], '297.25 K air_temperature @ 850 hPa');
  assert.match(wlines[1], /pressure level, not altitude · drawn at 0 m/);
  assert.match(wlines[2], /native lon 237\.000 \(0\.\.360\)/);
  assert.match(wlines[3], /lag 3445 s/);
});

test('context records carry semantic and source refs verbatim', () => {
  const aircraft = aircraftRecordsFromProjection(fixture).records.find(
    (r) => r.id === DLH,
  );
  const record = contextRecordFor(aircraft, {
    layerId: 'world-model',
    layerName: 'World Model',
    source: 'Dataforge World Model',
    revisionId: fixture.revision_id,
  });
  assert.equal(record.id, DLH);
  assert.equal(record.layerId, 'world-model');
  assert.equal(record.label, selectionCardLines(aircraft)[0]);
  assert.equal(record.latitude, 38.503);
  assert.deepEqual(
    record.properties.semantic_ref,
    aircraft.record.semantic_ref,
  );
  assert.deepEqual(record.properties.source_ref, aircraft.record.source_ref);
  assert.equal(record.properties.revision_id, fixture.revision_id);
  assert.equal(record.properties.height.value_m, 5913.12);

  const weather = weatherRecordsFromProjection(fixture).records.find(
    (r) => r.id === NODE,
  );
  const sample = contextRecordFor(weather, { layerId: 'world-model' });
  assert.equal(sample.properties.value, 297.25);
  assert.equal(sample.properties.pressure_hpa, 850);
  assert.equal(sample.properties.vertical, 'pressure-hPa-not-altitude');
  assert.deepEqual(sample.properties.native, weather.record.native);
});

test('summary and short refs', () => {
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
  assert.equal(
    shortRef({
      type_id: 'aircraft.track_state_set.v1',
      content_id: 'sha256:7b84ecd0559a',
    }),
    'aircraft.track_state_set.v1@7b84ecd0',
  );
  assert.equal(shortRef(null), '');
});
