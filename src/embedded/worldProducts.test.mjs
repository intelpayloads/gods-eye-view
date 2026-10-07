import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WORLD_LAYER_CLAIMS,
  WORLD_LAYER_SOURCES,
  worldLayerClaiming,
} from '../sources/layerSources.js';
import {
  DRAWABLE_REPRESENTATIONS,
  discoverWithin,
  discoverWorldProducts,
  productLabel,
  productLayerOptions,
  productsOf,
} from './worldProducts.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../layers/worldModel/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
const simHeads = fixture('simulated-run.heads.json');
const simStatus = fixture('simulated-run.status.json');
const [runHead] = Object.keys(simHeads).filter((h) => h.startsWith('sim/'));

const entry = (binding, kind, extra = {}) => ({
  binding,
  modality: 'observed',
  type_id: `${binding}.type.v1`,
  representations: [{ kind }],
  valid: {},
  ...extra,
});

/** A world/main status with one product of each kind the rules sort. */
const mainStatus = {
  head: { name: 'world/main', revision_id: 'r1', age_seconds: 4 },
  bindings: [
    entry('world.aircraft', 'positioned_entities/v1'), // claimed: flights
    entry('world.weather', 'field_samples/v1'),
    entry('world.launches', 'positioned_entities/v1', { modality: 'planned' }),
    entry('world.igs.orbit_final.2026-08-12', 'numeric_samples/v1'), // not drawable
    entry('model.receiver_profiles.reference', 'canonical_document/v1'), // not drawable
  ],
};

function source({ heads = simHeads, fail = null } = {}) {
  return {
    async getStatus({ head = 'world/main' } = {}) {
      if (fail) throw fail;
      return head === runHead ? simStatus : mainStatus;
    },
    async getHeads() {
      return heads;
    },
  };
}

test('every world adapter declares what it draws, so its products are never a second row', () => {
  assert.deepEqual(
    Object.keys(WORLD_LAYER_CLAIMS).sort(),
    Object.keys(WORLD_LAYER_SOURCES).sort(),
  );
  for (const [key, claim] of Object.entries(WORLD_LAYER_CLAIMS))
    assert.ok(
      (claim.bindings?.length ?? 0) + (claim.types?.length ?? 0) > 0,
      `${key} claims nothing`,
    );
  assert.equal(worldLayerClaiming({ binding: 'world.aircraft' }), 'flights');
  assert.equal(worldLayerClaiming({ binding: 'world.weather' }), null);
});

test('a product is a row only when it is drawable and no adapter claims it', () => {
  const rows = productsOf(mainStatus, 'world/main', WORLD_LAYER_CLAIMS);
  for (const row of rows) {
    const status = mainStatus.bindings.find((b) => b.binding === row.binding);
    assert.ok(
      status.representations.some((r) =>
        DRAWABLE_REPRESENTATIONS.includes(r.kind),
      ),
    );
    assert.equal(worldLayerClaiming(status), null);
  }
  // Not vacuous: the drawable claimed one and the undrawable ones were there.
  assert.deepEqual(rows.map((r) => r.binding).sort(), [
    'world.launches',
    'world.weather',
  ]);
});

test("a run head contributes only its own simulated products, not its base's observed ones", () => {
  const rows = productsOf(simStatus, runHead, WORLD_LAYER_CLAIMS);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.modality === 'simulated'));
  assert.ok(simStatus.bindings.some((b) => b.modality === 'observed'));
});

test('discovery finds main products and each simulated product on the newest run holding it', async () => {
  const run = simStatus.bindings.find((b) => b.modality === 'simulated');
  const products = await discoverWorldProducts(source(), {
    claims: WORLD_LAYER_CLAIMS,
  });
  const byBinding = Object.fromEntries(products.map((p) => [p.binding, p]));
  assert.deepEqual(Object.keys(byBinding).sort(), [
    run.binding,
    'world.launches',
    'world.weather',
  ]);
  const options = productLayerOptions(byBinding[run.binding]);
  assert.equal(options.head, runHead);
  assert.equal(options.validAt, run.valid.earliest);
  assert.equal(options.simulatedBinding, run.binding);
  assert.equal(options.panelSection, 'Simulated');
  assert.equal(
    productLayerOptions(byBinding['world.launches']).panelSection,
    'Planned',
  );
  assert.deepEqual(productLayerOptions(byBinding['world.weather']).layers, [
    'world.weather',
  ]);
});

test('a backplane that cannot be read yields no product rows instead of holding start-up', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(
      await discoverWithin(source({ fail: new Error('down') })),
      [],
    );
  } finally {
    console.warn = warn;
  }
});

test('a row is named from its binding: namespace and day dropped, words spaced', () => {
  assert.equal(productLabel('world.scenario_laydown'), 'Scenario laydown');
  assert.equal(
    productLabel('simulation.satellites.trajectory'),
    'Satellites trajectory',
  );
  assert.equal(
    productLabel('world.igs.orbit_final.2026-08-12'),
    'Igs orbit final',
  );
  assert.equal(productLabel('weather'), 'Weather');
});
