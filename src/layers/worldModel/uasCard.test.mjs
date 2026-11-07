/** The drone's card and label in words (GEN-395), on the real return-home run in fixtures/uas-track.select.json. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UAS_WORDED, isUasRow, uasCard, uasLabel } from './uasCard.js';
import { uasTracksFromSelection } from './uasTrack.js';
import { selectionCardLines } from './adapter.js';

const SELECTION = JSON.parse(
  readFileSync(new URL('./fixtures/uas-track.select.json', import.meta.url)),
);
const PRODUCT = SELECTION.products[0];
const HEADER = PRODUCT.semantic_metadata;
const [TRACK] = uasTracksFromSelection(SELECTION);

/** The projected item for the stored row at `hms`, as /project serves it. */
function itemAt(hms) {
  const row = PRODUCT.values.find((r) => r.valid_time.slice(11, 19) === hms);
  const { lon_deg, lat_deg, height_m, ...properties } = row.value;
  return {
    id: `simulation.uas.track/${row.semantic_identity}`,
    binding: 'simulation.uas.track',
    semantic_ref: { semantic_identity: row.semantic_identity },
    properties,
    position: { lon: lon_deg, lat: lat_deg, height_m },
    height: { value_m: height_m, source_field: 'height_m' },
    time: { valid_at: row.valid_time },
  };
}

const rowAt = (hms) =>
  TRACK.rows.find((row) => row.validTime.slice(11, 19) === hms);

test('a drone-track row is told apart from a receiver row', () => {
  assert.equal(isUasRow(itemAt('16:00:00').properties), true);
  assert.equal(isUasRow({ state_code: 0, reason_code: 2 }), false);
  assert.equal(isUasRow(null), false);
  assert.equal(uasCard({ properties: { state_code: 0 } }, HEADER), null);
});

test('the card names the mode and C2 state from the product’s legends', () => {
  const card = uasCard(itemAt('16:00:30'), HEADER);
  assert.equal(card.title, 'UAS-1 (simulated) · platform:foundation:uas-1');
  assert.equal(card.lead, 'Mission · C2 nominal — nominal threshold met');
  assert.deepEqual(card.measures.slice(0, 2), ['AGL 120.0 m', 'link up']);
  assert.match(card.measures[2], /^C2 SINR \d+\.\d dB$/);
  assert.equal(
    uasCard(itemAt('16:01:15'), HEADER).lead,
    'Return altitude · C2 unavailable — below unavailable threshold',
  );
});

test('the lost-link timer runs from the first unavailable epoch against its timeout', () => {
  assert.equal(
    uasCard(itemAt('16:00:40'), HEADER).measures[1],
    'link lost 0 s / 30 s',
  );
  assert.equal(
    uasCard(itemAt('16:00:55'), HEADER).measures[1],
    'link lost 15 s / 30 s',
  );
  // Recovering keeps counting until the link is back; nominal is up.
  assert.equal(
    uasCard(itemAt('16:01:20'), HEADER).measures[1],
    'link lost 40 s / 30 s',
  );
  assert.equal(uasCard(itemAt('16:01:25'), HEADER).measures[1], 'link up');
});

test('without a legend the card says so and shows the codes', () => {
  const card = uasCard(itemAt('16:01:15'), null);
  assert.equal(
    card.lead,
    'mode 1 · C2 state 2 (no legend in the product header)',
  );
  assert.match(
    uasLabel(rowAt('16:01:15'), null, TRACK.identity),
    /^UAS-1 · MODE 1/,
  );
});

test('the map label reads the mode, AGL and the timer of one stored row', () => {
  const label = (hms) => uasLabel(rowAt(hms), HEADER, TRACK.identity);
  assert.equal(label('16:00:30'), 'UAS-1 · MISSION\n120 M AGL');
  assert.equal(
    label('16:00:55'),
    'UAS-1 · MISSION\n120 M AGL · LINK LOST 15 S / 30 S',
  );
  assert.equal(
    label('16:01:10'),
    'UAS-1 · RETURN ALTITUDE\n120 M AGL · LINK LOST 30 S / 30 S',
  );
  assert.equal(label('16:01:50'), 'UAS-1 · RETURN TRANSIT\n59 M AGL');
  assert.equal(label('16:02:30'), 'UAS-1 · LANDED\n0 M AGL');
  assert.equal(uasLabel(null, HEADER, TRACK.identity), '');
});

test('the generic value list leaves out what the card says in words', () => {
  const lines = selectionCardLines(
    { kind: 'point', id: 'x', record: itemAt('16:00:55') },
    { header: HEADER },
  );
  assert.equal(lines[0], 'UAS-1 (simulated) · platform:foundation:uas-1');
  assert.equal(
    lines[1],
    'Mission · C2 unavailable — below unavailable threshold',
  );
  const text = lines.join('\n');
  assert.match(text, /link lost 15 s \/ 30 s/);
  for (const key of UAS_WORDED)
    assert.doesNotMatch(text, new RegExp(`\\b${key}\\b`));
});
