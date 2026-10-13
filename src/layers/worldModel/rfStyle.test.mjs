import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lineRecordsFromProjection,
  pointRecordsFromProjection,
  selectionCardLines,
} from './adapter.js';
import {
  EMITTER_BINDING,
  LINK_BINDING,
  RF_DISPLAY,
  emitterStyle,
  linkPowerColor,
  linkStyle,
  pulseRadiusM,
} from './rfStyle.js';

// The ISS run's geometry at two instants (Foundation GEN-303 contract):
// 13:56Z the jammer is silent, 14:05Z it is on and the path is clear.
const SITE = { lon: 29.0, lat: 34.0, height_m: 0 };
const ISS = { lon: 22.3, lat: 35.43, height_m: 423793.2 };
const emitter = (active) => ({
  id: `${EMITTER_BINDING}/emitter:foundation:synthetic-ground-emitter`,
  binding: EMITTER_BINDING,
  position: SITE,
  height: { value_m: 0, source_field: 'geometric_height_m' },
  semantic_ref: {
    semantic_identity: 'emitter:foundation:synthetic-ground-emitter',
  },
  properties: { active, eirp_w: 0.002, min_elevation_deg: 10 },
});
const link = (reason, received_power_w, positions = [SITE, ISS]) => ({
  id: `${LINK_BINDING}/link:foundation:jammer:iss-receiver`,
  binding: LINK_BINDING,
  positions,
  semantic_ref: { semantic_identity: 'link:foundation:jammer:iss-receiver' },
  properties: { reason, received_power_w, active: reason !== 'inactive' },
});

test('at 14:05Z the jammer is on: red, larger, pulsing, labelled active', () => {
  const [site] = pointRecordsFromProjection({
    points: [emitter(true)],
  }).records;
  assert.equal(site.display, RF_DISPLAY['emitter-active']);
  assert.ok(site.display.pulse);
  assert.equal(
    site.label,
    'emitter:foundation:synthetic-ground-emitter · active',
  );
});

test('at 13:56Z the jammer is dim and does not pulse; unknown activity is never shown as on', () => {
  const [site] = pointRecordsFromProjection({
    points: [emitter(false)],
  }).records;
  assert.equal(site.display, RF_DISPLAY['emitter-silent']);
  assert.equal(site.display.pulse, null);
  assert.ok(site.display.alpha < 0.5);
  const unknown = emitterStyle({ active: null }, 'e');
  assert.equal(unknown.active, false);
  assert.equal(unknown.label, 'e · activity unknown');
});

test('a clear path is a solid beam coloured by the received power', () => {
  const [beam] = lineRecordsFromProjection({
    lines: [link('free_space', 1.87e-18)],
  }).records;
  assert.equal(beam.kind, 'line');
  assert.equal(beam.display.dashed, false);
  assert.equal(beam.label, 'clear path · -177.3 dBW at receiver');
  assert.deepEqual(beam.positions[1], {
    lon: 22.3,
    lat: 35.43,
    height: 423793.2,
  });
  // The card anchors at the receiver end.
  assert.equal(beam.height, 423793.2);
  assert.notDeepEqual(
    linkPowerColor(-185),
    linkPowerColor(-155),
    'stronger reads redder',
  );
});

test('a blocked path is drawn differently from a clear one', () => {
  for (const reason of ['earth_occulted', 'below_horizon_mask']) {
    const style = linkStyle({ reason, received_power_w: 0 });
    assert.equal(style.display, RF_DISPLAY['link-blocked']);
    assert.equal(style.display.dashed, true);
    assert.notEqual(
      style.display,
      linkStyle({ reason: 'free_space', received_power_w: 1e-17 }).display,
    );
  }
  assert.equal(
    linkStyle({ reason: 'earth_occulted' }).label,
    'blocked · earth occulted',
  );
});

test('a silent jammer leaves a faint path; unknown power is amber, not a guess', () => {
  assert.equal(
    linkStyle({ reason: 'inactive', received_power_w: 0 }).display,
    RF_DISPLAY['link-idle'],
  );
  assert.ok(RF_DISPLAY['link-idle'].alpha <= 0.2);
  assert.equal(linkStyle({ reason: 'zero_eirp' }).label, 'no emitted power');
  const unknown = linkStyle({ reason: 'unknown_eirp', received_power_w: null });
  assert.equal(unknown.display, RF_DISPLAY['link-power-unknown']);
  assert.equal(
    linkStyle({ reason: 'free_space', received_power_w: null }).label,
    'clear path · power unknown',
  );
  // An unnamed reason is shown, not hidden.
  assert.equal(linkStyle({ reason: 'ionospheric' }).label, 'path ionospheric');
});

test('a line with a missing vertex is skipped whole, never bent', () => {
  const bad = link('free_space', 1e-17, [
    SITE,
    { lon: 22.3, lat: null, height_m: 4e5 },
  ]);
  const { records, skipped } = lineRecordsFromProjection({ lines: [bad] });
  assert.equal(records.length, 0);
  assert.deepEqual(skipped, [{ id: bad.id, reason: 'non-finite-position' }]);
});

test('the link card says what its path is doing', () => {
  const [beam] = lineRecordsFromProjection({
    lines: [link('earth_occulted', 0)],
  }).records;
  const lines = selectionCardLines(beam);
  assert.equal(lines[0], 'link:foundation:jammer:iss-receiver');
  assert.equal(lines[1], 'blocked · earth occulted');
});

test('the pulse ring grows over one period and starts again', () => {
  const display = RF_DISPLAY['emitter-active'];
  const { periodS, minRadiusM, maxRadiusM } = display.pulse;
  assert.equal(pulseRadiusM(display, 0), minRadiusM);
  assert.ok(pulseRadiusM(display, periodS / 2) > minRadiusM);
  assert.ok(pulseRadiusM(display, periodS * 0.99) < maxRadiusM);
  assert.equal(pulseRadiusM(display, periodS), minRadiusM);
  assert.equal(pulseRadiusM(RF_DISPLAY['emitter-silent'], 1), null);
});
