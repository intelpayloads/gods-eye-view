import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectionCardLines, selectionProvenanceLines } from './adapter.js';
import { dbwText, receiverCard, revisionHeaders } from './rfCard.js';

// The ISS run's receiver track, as World Model serves it (GEN-303).
const track = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/receiver-track-thresholds.select.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
// The receiver track's header carries the same legends as the mission products.
const pair = JSON.parse(
  readFileSync(
    new URL('./fixtures/run-effects.pair.json', import.meta.url),
    'utf8',
  ),
);
const metadata =
  pair.contested.revision.descriptors['simulation.rf.communications'].semantic
    .metadata;
const header = {
  state_codes: metadata.state_codes,
  reason_codes: metadata.reason_codes,
};

/** A receiver-track row as the projection would place it: one point. */
function itemAt(iso) {
  const row = track.products[0].values.find((v) =>
    v.valid_time.startsWith(iso),
  );
  return {
    binding: 'simulation.rf.receiver_track',
    semantic_ref: { semantic_identity: row.semantic_identity },
    properties: { ...row.value },
    time: { valid_at: row.valid_time },
    height: {},
  };
}
const card = (item, options) =>
  selectionCardLines(
    { kind: 'point', record: item, binding: item.binding },
    options,
  );

test('at 14:05Z on the ISS run the card leads with Unavailable and why, in words', () => {
  const [title, lead, measures] = card(itemAt('2026-10-07T14:05:00'), {
    header,
  });
  assert.equal(title, 'satellite:norad:25544 (simulated)');
  assert.equal(lead, 'Unavailable — below unavailable threshold');
  assert.equal(measures, 'SINR -2.7 dB · interference -177.3 dBW');
});

test("with the run's name for the receiver the title leads with it", () => {
  const [title] = card(itemAt('2026-10-07T14:05:00'), {
    header,
    name: 'ISS (simulated)',
  });
  assert.equal(title, 'ISS (simulated) · satellite:norad:25544');
});

test('before the jammer the receiver is nominal with no interference', () => {
  const lines = card(itemAt('2026-10-07T13:56:00'), { header });
  assert.equal(lines[1], 'Nominal — nominal threshold met');
  assert.equal(lines[2], 'SINR 20.0 dB · no interference');
});

test('the worded values leave the value list; the thresholds stay', () => {
  const text = card(itemAt('2026-10-07T14:05:00'), { header }).join('\n');
  assert.doesNotMatch(
    text,
    /state_code|reason_code|interference_power_w|\bsinr_db/,
  );
  assert.match(text, /nominal_min_sinr_db 15/);
});

test('the raw codes and watts are kept under provenance', () => {
  const item = itemAt('2026-10-07T14:05:00');
  const text = selectionProvenanceLines({ kind: 'point', record: item }).join(
    '\n',
  );
  assert.match(text, /state_code 2/);
  assert.match(text, /reason_code 1/);
  assert.match(text, /interference_power_w 1\.87\d*e-18/);
});

test('no legend read: the card says so and never guesses a meaning', () => {
  const lines = card(itemAt('2026-10-07T14:05:00'));
  assert.equal(
    lines[1],
    'state 2 · reason 1 (no legend in the product header)',
  );
  assert.doesNotMatch(lines.join('\n'), /Unavailable|nominal threshold/);
});

test("the legend is the product's: a different header names states differently", () => {
  const custom = {
    state_codes: { 2: 'jammed' },
    reason_codes: { 1: 'swamped' },
  };
  assert.equal(
    receiverCard(itemAt('2026-10-07T14:05:00'), custom).lead,
    'Jammed — swamped',
  );
});

test('items without a state code keep the generic card', () => {
  assert.equal(receiverCard({ properties: { callsign: 'X' } }, header), null);
  const lines = card({
    properties: { callsign: 'DLH4', alt: 1 },
    semantic_ref: { semantic_identity: 'a' },
  });
  assert.equal(lines[0], 'DLH4 · a');
});

test('interference power reads in dBW; zero and missing are said, not computed', () => {
  assert.equal(dbwText(1e-15), 'interference -150.0 dBW');
  assert.equal(dbwText(0), 'no interference');
  assert.equal(dbwText(null), 'interference unknown');
});

test('revision headers are read by binding, and {} when the source cannot say', async () => {
  const source = { getRevision: async () => pair.contested.revision };
  const headers = await revisionHeaders(source, pair.contested.revision_id);
  assert.deepEqual(
    headers['simulation.rf.communications'].state_codes,
    metadata.state_codes,
  );
  assert.deepEqual(await revisionHeaders({}, 'x'), {});
  assert.deepEqual(await revisionHeaders(source, null), {});
});
