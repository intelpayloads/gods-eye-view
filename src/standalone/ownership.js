/**
 * One live application per page.
 *
 * The controls and the production layer catalog share page-scoped state
 * (module-singleton layers, the context store, the render governor, element
 * ids), so two applications cannot run at the same time. They can run one
 * after another: an application acquires ownership while it starts and
 * releases it after its cleanup, and the next one may then start.
 */
let owner = null;

/**
 * Acquire page ownership for `label`. Returns an idempotent release function.
 * @param {string} label Human-readable owner, reported to a conflicting caller.
 */
export function acquirePageOwnership(label) {
  if (owner)
    throw new Error(
      `Gods Eye application "${owner.label}" already owns this page; destroy it first`,
    );
  const token = { label };
  owner = token;
  return () => {
    if (owner === token) owner = null;
  };
}

/** The label of the application that currently owns the page, if any. */
export function pageOwner() {
  return owner?.label ?? null;
}
