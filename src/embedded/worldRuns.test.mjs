import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openRun } from './worldRuns.js';
import { DRAWABLE_REPRESENTATIONS, productLayerId } from './worldProducts.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../layers/worldModel/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
const runStatus = fixture('simulated-run.status.json');
const [runHead] = Object.keys(fixture('simulated-run.heads.json')).filter((h) =>
  h.startsWith('sim/'),
);

/** A manager holding a row for every drawable simulated product, as discovery registers. */
function managerFor(status, { refuse = false } = {}) {
  const layers = new Map();
  for (const b of status.bindings)
    if (
      b.modality === 'simulated' &&
      b.representations.some((r) => DRAWABLE_REPRESENTATIONS.includes(r.kind))
    )
      layers.set(productLayerId(b.binding), { params: {}, enabled: false });
  return {
    layers,
    setLayerParams(id, params) {
      if (refuse) return false;
      Object.assign(layers.get(id).params, params);
      return true;
    },
    async setEnabled(id, on) {
      layers.get(id).enabled = on;
    },
  };
}

const source = (status) => ({ getStatus: async () => status });

test('opening a run points every row the run has a product for at the run, and only those', async () => {
  const manager = managerFor(runStatus);
  const result = await openRun({
    manager,
    source: source(runStatus),
    head: runHead,
  });
  const simulated = runStatus.bindings.filter(
    (b) => b.modality === 'simulated',
  );
  assert.ok(simulated.length > 0 && result.opened.length > 0);
  assert.equal(
    result.opened.length + result.undrawable.length,
    simulated.length,
  );
  for (const { binding, layerId, validAt } of result.opened) {
    const row = manager.layers.get(layerId);
    assert.equal(row.enabled, true);
    assert.equal(row.params.head, runHead);
    const entry = simulated.find((b) => b.binding === binding);
    assert.equal(
      validAt,
      entry.valid.earliest,
      'opens at the product first epoch',
    );
  }
  // The run's base (observed) products are not the run: no row of theirs moves.
  assert.ok(runStatus.bindings.some((b) => b.modality === 'observed'));
  assert.ok(
    result.opened.every(({ binding }) =>
      simulated.some((b) => b.binding === binding),
    ),
  );
});

test('a requested time wins, and a product with nothing to draw is named rather than dropped', async () => {
  const rf = {
    binding: 'simulation.rf.navigation',
    modality: 'simulated',
    representations: [{ kind: 'numeric_samples/v1' }],
    valid: { earliest: '2026-08-12T01:59:00Z' },
  };
  const status = { ...runStatus, bindings: [...runStatus.bindings, rf] };
  const manager = managerFor(status);
  const at = '2026-08-12T02:00:00Z';
  const result = await openRun({
    manager,
    source: source(status),
    head: runHead,
    validAt: at,
  });
  assert.ok(result.opened.every((o) => o.validAt === at));
  assert.deepEqual(result.undrawable, [
    { binding: 'simulation.rf.navigation', reason: 'no position to draw' },
  ]);
});

test('only a run head is opened, and a row that refuses the head fails loudly', async () => {
  await assert.rejects(
    openRun({
      manager: managerFor(runStatus),
      source: source(runStatus),
      head: 'world/main',
    }),
    /sim\//,
  );
  await assert.rejects(
    openRun({
      manager: managerFor(runStatus, { refuse: true }),
      source: source(runStatus),
      head: runHead,
    }),
    /refused head/,
  );
});
