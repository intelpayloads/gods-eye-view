/**
 * The world's products as layers (DWM-189).
 *
 * Every connector layer reads the world model through its own adapter. What
 * no adapter claims -- a planned laydown, a weather field, a Foundation run --
 * used to be one generic "World Model" row a user had to find and switch on.
 * Here each such product is its own row, discovered from what the backplane
 * already serves (`GET /status` per head, `GET /heads` for the `sim/` runs),
 * so a new descriptor appears as a new row with no change to this package.
 *
 * Only products with a drawable representation become rows: a sample series
 * with no declared position, or a pinned document, has nothing to put on a
 * globe. A product an adapter claims (`WORLD_LAYER_CLAIMS`) is never a second
 * row: that is how nothing is drawn twice.
 */
import { worldLayerClaiming } from '../sources/layerSources.js';
import { SIM_HEAD_PREFIX } from '../layers/worldModel/simulationRuns.js';
import { HEAD } from '../layers/worldModel/view.js';

/** Representations the generic world-model layer draws. */
export const DRAWABLE_REPRESENTATIONS = Object.freeze([
  'positioned_entities/v1',
  'field_samples/v1',
]);

export const PRODUCT_LAYER_PREFIX = 'world-product:';

/** Panel section per modality (see `PANEL_SECTIONS`). */
export const MODALITY_SECTIONS = Object.freeze({
  observed: 'Observed',
  planned: 'Planned',
  simulated: 'Simulated',
});

const MODALITY_ICONS = Object.freeze({
  observed: '◉',
  planned: '◇',
  simulated: '◈',
});

/** How long start-up waits for the backplane before showing no products. */
export const DISCOVERY_TIMEOUT_MS = 15_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A row name from a binding: the namespace and any day dropped, words
 * spaced, first letter up (`world.scenario_laydown` -> `Scenario laydown`,
 * `simulation.satellites.trajectory` -> `Satellites trajectory`).
 */
export function productLabel(binding) {
  const parts = String(binding).split('.');
  const words = (parts.length > 1 ? parts.slice(1) : parts)
    .filter((part) => !DAY.test(part))
    .join(' ')
    .replace(/_/g, ' ')
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(binding);
}

export function productLayerId(binding) {
  return `${PRODUCT_LAYER_PREFIX}${binding}`;
}

function drawable(entry) {
  return (entry?.representations ?? []).some((r) =>
    DRAWABLE_REPRESENTATIONS.includes(r?.kind),
  );
}

/**
 * The products one head's status contributes. A `sim/` head also carries its
 * base revision's observed bindings; only its own simulated ones are the run.
 */
export function productsOf(status, head, claims) {
  const simulatedHead = head.startsWith(SIM_HEAD_PREFIX);
  return (status?.bindings ?? [])
    .filter((entry) => typeof entry?.binding === 'string' && drawable(entry))
    .filter((entry) => !simulatedHead || entry.modality === 'simulated')
    .filter((entry) => !worldLayerClaiming(entry, claims))
    .map((entry) => ({
      binding: entry.binding,
      modality: entry.modality || 'observed',
      typeId: entry.type_id ?? null,
      head,
      earliest: entry.valid?.earliest ?? null,
    }));
}

/**
 * Every unclaimed drawable product, one per binding. A simulated product is
 * found on every run that holds it; it opens on the newest (by first epoch).
 */
export async function discoverWorldProducts(
  source,
  { head = HEAD, claims, signal } = {},
) {
  const found = new Map();
  const add = (product) => {
    const known = found.get(product.binding);
    const newer =
      known &&
      product.modality === 'simulated' &&
      Date.parse(product.earliest ?? '') > Date.parse(known.earliest ?? '');
    if (!known || newer) found.set(product.binding, product);
  };
  // Every head at once: one after another, a world with a few runs took
  // longer than start-up waits and its product rows never appeared (DWM-194).
  const mainStatus = source.getStatus({ head, signal });
  mainStatus.catch(() => {}); // awaited below; a run's failure must not leave it unhandled
  const heads =
    typeof source.getHeads === 'function'
      ? await source.getHeads({ signal })
      : {};
  const runs = Object.keys(heads ?? {}).filter((name) =>
    name.startsWith(SIM_HEAD_PREFIX),
  );
  const [main, ...statuses] = await Promise.all([
    mainStatus,
    ...runs.map((simHead) => source.getStatus({ head: simHead, signal })),
  ]);
  for (const product of productsOf(main, head, claims)) add(product);
  runs.forEach((simHead, index) => {
    for (const product of productsOf(statuses[index], simHead, claims))
      add(product);
  });
  return [...found.values()];
}

/** `createStandaloneWorldModelLayer` options for one product. */
export function productLayerOptions(product) {
  const simulated = product.modality === 'simulated';
  return {
    id: productLayerId(product.binding),
    name: productLabel(product.binding),
    icon: MODALITY_ICONS[product.modality] ?? MODALITY_ICONS.observed,
    sourceLabel: `World Model · ${product.binding}`,
    layers: [product.binding],
    modalities: [product.modality],
    panelSection:
      MODALITY_SECTIONS[product.modality] ?? MODALITY_SECTIONS.observed,
    ...(simulated
      ? {
          head: product.head,
          validAt: product.earliest,
          simulatedBinding: product.binding,
        }
      : {}),
  };
}

/**
 * Discover with a deadline: a backplane that is down or slow must not hold
 * the application on its loading screen. `{ products, error }`: on failure no
 * products, and the reason, which the World Model block shows -- "0 drawn as
 * layers" would read as a world with nothing to draw.
 */
export async function discoverWithin(
  source,
  options = {},
  timeoutMs = DISCOVERY_TIMEOUT_MS,
) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return {
      products: await discoverWorldProducts(source, {
        ...options,
        signal: timeout,
      }),
      error: null,
    };
  } catch (error) {
    console.warn('[World Model] products not discovered:', error);
    return {
      products: [],
      error: timeout.aborted
        ? `no answer in ${Math.round(timeoutMs / 1000)} s`
        : error?.message || String(error),
    };
  }
}
