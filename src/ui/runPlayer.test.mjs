/** The run player (GEN-310): which run is on screen, and which layers its clock moves. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runOnScreen } from './runPlayer.js';

const RUN = 'sim/sha256:d6eca085';
const source = { select() {} };
const layer = (id, params, enabled = true) => ({
  id,
  entry: { enabled },
  module: { getProjectionSource: () => source },
  params: { layers: null, validAt: null, ...params },
});

test('the run is the head of an enabled layer on a sim/ head; every layer on it follows', () => {
  const run = runOnScreen([
    layer('world-model', { head: 'world/main' }),
    layer('emitters', {
      head: RUN,
      layers: ['simulation.rf.emitters'],
      validAt: '2026-10-07T13:55:00Z',
    }),
    layer('track', {
      head: RUN,
      layers: ['simulation.rf.receiver_track'],
      validAt: '2026-10-07T14:06:00Z',
    }),
    layer('links', { head: RUN, layers: ['simulation.rf.links'] }, false),
  ]);
  assert.equal(run.head, RUN);
  // The receiver track's layer leads: its time is the player's.
  assert.equal(run.validAt, '2026-10-07T14:06:00Z');
  assert.deepEqual(run.layerIds, ['emitters', 'track', 'links']);
  assert.equal(run.source, source);
});

test('no enabled layer on a run: no player', () => {
  assert.equal(
    runOnScreen([layer('world-model', { head: 'world/main' })]),
    null,
  );
  assert.equal(runOnScreen([layer('track', { head: RUN }, false)]), null);
  assert.equal(runOnScreen([]), null);
});

test('a pinned layer gives its revision, and the host\'s focus adds the comparison (GEN-299)', () => {
  const focus = { head: RUN, revisionId: 'rev-1', headAdvanced: true, source, compare: { head: 'sim/n', revisionId: 'rev-n' } };
  const run = runOnScreen(
    [layer('track', { head: RUN, layers: ['simulation.rf.receiver_track'], follow: 'pinned', revisionId: 'rev-1' })],
    focus,
  );
  assert.equal(run.revisionId, 'rev-1');
  assert.deepEqual(run.compare, focus.compare);
  assert.equal(run.headAdvanced, true);
});

test('the opened run stays the run when a row left on an older run is switched on (GEN-341)', () => {
  const opened = 'sim/sha256:opened';
  const focus = { head: opened, revisionId: 'rev-1', headAdvanced: false, source, compare: { head: 'sim/n', revisionId: 'rev-n' } };
  const run = runOnScreen(
    [
      layer('stale-track', { head: RUN, layers: ['simulation.rf.receiver_track'] }),
      layer('effects', { head: opened }, false),
    ],
    focus,
  );
  assert.equal(run.head, opened);
  assert.equal(run.revisionId, 'rev-1');
  assert.deepEqual(run.compare, focus.compare);
  assert.deepEqual(run.layerIds, ['effects'], 'only the opened run\'s layers follow its clock');
  // Without a focus the same rows give the older run, as before.
  assert.equal(runOnScreen([layer('stale-track', { head: RUN })]).head, RUN);
});

test('a focused run with no layer on screen (mission effects only) is still the run', () => {
  const focus = { head: RUN, revisionId: 'rev-1', headAdvanced: false, source, compare: null };
  const run = runOnScreen([layer('world-model', { head: 'world/main' })], focus);
  assert.equal(run.head, RUN);
  assert.equal(run.revisionId, 'rev-1');
  assert.deepEqual(run.layerIds, []);
  assert.equal(run.source, source);
  assert.equal(runOnScreen([], null), null);
});
