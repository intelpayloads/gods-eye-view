/**
 * The element application-owned floating DOM is attached to.
 *
 * The standalone shell owns the page, so the default is `document.body`. An
 * embedding host passes its root element so canvases, panels and overlays the
 * application creates at runtime live (and are removed) inside the host's
 * subtree and pick up its scoped stylesheet.
 */
let hostElementOverride = null;

/**
 * Attach runtime-created application DOM under `element`. Returns a function
 * restoring the previous host (only if nothing replaced it since).
 * @param {HTMLElement|null} element
 */
export function configureHostElement(element) {
  const previous = hostElementOverride;
  hostElementOverride = element || null;
  const configured = hostElementOverride;
  return () => {
    if (hostElementOverride === configured) hostElementOverride = previous;
  };
}

/** The current host element for application-created floating DOM. */
export function hostElement() {
  return hostElementOverride || document.body;
}
