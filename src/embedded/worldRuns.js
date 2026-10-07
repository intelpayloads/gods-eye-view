/**
 * Opening one simulation run for the host (DWM-196).
 *
 * A run is a `sim/` head the world model forked for it. Its simulated
 * products are already rows of the panel (DWM-189), each opened on the newest
 * run that holds it. A host that links to a particular run -- Dataforge's
 * "Visualize in World Model" from a published scenario run -- asks for THAT
 * run: every row the run has a product for is pointed at the run's head and
 * time and switched on. Nothing else changes, and no hidden layer is involved.
 *
 * A simulated product with no row is reported, not dropped: today's RF
 * mission-effect series have no position to draw, and the host says so rather
 * than showing an empty globe as if the run had nothing in it.
 */
import { SIM_HEAD_PREFIX } from '../layers/worldModel/simulationRuns.js';
import { DRAWABLE_REPRESENTATIONS, productLayerId } from './worldProducts.js';

/**
 * @param {object} options
 * @param {object} options.manager The DataLayerManager (`getComponents().data.dataManager`).
 * @param {object} options.source The host's ProjectionSource.
 * @param {string} options.head A `sim/` head.
 * @param {string|null} [options.validAt] Where to open the run; null = each product's first epoch.
 * @returns {Promise<{head: string, opened: Array<{binding: string, layerId: string, validAt: string|null}>,
 *   undrawable: Array<{binding: string, reason: string}>}>}
 */
export async function openRun({
  manager,
  source,
  head,
  validAt = null,
  signal,
}) {
  if (typeof head !== 'string' || !head.startsWith(SIM_HEAD_PREFIX))
    throw new TypeError(
      `openRun takes a ${SIM_HEAD_PREFIX} head, got ${JSON.stringify(head)}`,
    );
  if (!manager?.layers)
    throw new Error('openRun: the application is not running');
  const status = await source.getStatus({ head, signal });
  const opened = [];
  const undrawable = [];
  for (const entry of status?.bindings ?? []) {
    if (entry?.modality !== 'simulated' || typeof entry.binding !== 'string')
      continue;
    const layerId = productLayerId(entry.binding);
    if (!manager.layers.has(layerId)) {
      const drawable = (entry.representations ?? []).some((r) =>
        DRAWABLE_REPRESENTATIONS.includes(r?.kind),
      );
      undrawable.push({
        binding: entry.binding,
        reason: drawable
          ? 'no panel row (not discovered at start-up)'
          : 'no position to draw',
      });
      continue;
    }
    const at = validAt ?? entry.valid?.earliest ?? null;
    if (!manager.setLayerParams(layerId, { head, validAt: at }))
      throw new Error(`openRun: ${layerId} refused head ${head}`);
    await manager.setEnabled(layerId, true);
    opened.push({ binding: entry.binding, layerId, validAt: at });
  }
  return { head, opened, undrawable };
}
