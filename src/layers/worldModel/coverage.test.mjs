import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPLAY_CHOICES,
  JS_RAMP_DB,
  fieldLegends,
  fieldRamp,
  fieldSampleRecordsFromProjection,
  jsColor,
  selectionCardLines,
  temperatureColor,
} from './adapter.js';
import { DEFAULT_DISPLAY_ASSUMPTIONS } from './view.js';

// GEN-307: one node of the ISS run's J/S coverage plane (chunked_field/v2,
// DWM-199) as World Model's field_samples projector emits it, next to an
// 850 hPa temperature node.
const coverage = (value, lat = 34.0, lon = 29.0) => ({
  id: `simulation.rf.coverage/js_db/424000m/${lat.toFixed(3)}/${lon.toFixed(3)}`,
  binding: 'simulation.rf.coverage',
  position: { lon, lat, height_m: 424000 },
  native: { lon, lat, lon_convention: '-180..180', frame: {} },
  frame: 'WGS84-map-overlay',
  value,
  units: 'dB',
  variable: 'js_db',
  height_m: 424000,
  vertical: 'height_m',
  time: {
    valid_at: '2026-10-07T13:58:00+00:00',
    run_at: null,
    lag_seconds: 480,
  },
});
const weather = {
  id: 'world.weather/air_temperature/850hPa/37.000/237.000',
  binding: 'world.weather',
  position: { lon: -123, lat: 37, height_m: 0 },
  value: 290,
  units: 'K',
  variable: 'air_temperature',
  pressure_hpa: 850,
  vertical: 'pressure-hPa-not-altitude',
  time: {},
};
const records = (...samples) =>
  fieldSampleRecordsFromProjection({ field_samples: samples }).records;

test('the projection request grants the plane height', () => {
  assert.equal(
    DEFAULT_DISPLAY_ASSUMPTIONS.field_plane_height,
    'declared-wgs84-ellipsoidal',
  );
});

test('J/S takes a diverging ramp centred on 0 dB; weather keeps the temperature ramp', () => {
  const [js, temp] = records(coverage(6), weather);
  assert.equal(js.ramp, 'js-db');
  assert.equal(temp.ramp, 'kelvin');
  assert.deepEqual(temp.colorRgb, temperatureColor(290));
  assert.deepEqual(
    jsColor(0),
    [0.94, 0.94, 0.94],
    '0 dB is the neutral midpoint',
  );
  const [r, , b] = jsColor(JS_RAMP_DB.max);
  assert.ok(r > b, 'jammer stronger reads red');
  const [r2, , b2] = jsColor(JS_RAMP_DB.min);
  assert.ok(b2 > r2, 'signal stronger reads blue');
  assert.deepEqual(
    jsColor(40),
    jsColor(JS_RAMP_DB.max),
    'clamped for colour only',
  );
  // The ISS run's range (about -3..+8 dB) spans visibly different colours.
  assert.notDeepEqual(jsColor(-3), jsColor(8));
  assert.equal(fieldRamp({ units: 'dB', variable: 'snr_db' }), 'kelvin');
});

test('the plane is drawn at its own height, not clamped to the ground', () => {
  const [js, temp] = records(coverage(2), weather);
  assert.equal(js.plane, true);
  assert.equal(js.height, 424000);
  assert.equal(js.display, DISPLAY_CHOICES['field-sample-plane']);
  assert.equal(js.display.clampToGround, false);
  assert.equal(temp.plane, false);
  assert.equal(temp.display.clampToGround, true);
});

test('a J/S node card says which side is stronger, at the plane height', () => {
  const [js] = records(coverage(6.42));
  const lines = selectionCardLines(js);
  assert.equal(lines[0], '6.42 dB js_db @ 424000 m');
  assert.equal(lines[1], 'jammer stronger than the signal');
  assert.match(
    lines[2],
    /^plane above the WGS84 ellipsoid · drawn at 424000 m/,
  );
  assert.equal(
    selectionCardLines(records(coverage(-2))[0])[1],
    'signal stronger than the jammer',
  );
  assert.match(
    selectionCardLines(records(weather)[0]).join('\n'),
    /pressure level, not altitude/,
  );
});

test('a masked node is not a sample: nothing is drawn for it, never 0 dB', () => {
  // World Model omits masked nodes (masked-grid-node); a null value that
  // slipped through is skipped, not coloured.
  const out = fieldSampleRecordsFromProjection({
    field_samples: [{ ...coverage(0), value: null }],
  });
  assert.equal(out.records.length, 0);
  assert.deepEqual(
    out.skipped.map((s) => s.reason),
    ['non-finite-value'],
  );
});

test('the legend explains the J/S ramp, and only that ramp', () => {
  const legends = fieldLegends(
    records(coverage(1), coverage(3, 34.5), weather),
  );
  assert.equal(legends.length, 1);
  assert.equal(legends[0].label, 'simulation.rf.coverage');
  assert.match(
    legends[0].lines[0],
    /blue signal stronger · white 0 dB · red jammer stronger/,
  );
  assert.deepEqual(fieldLegends(records(weather)), []);
});
