/**
 * The embedded application's one look (DWM-189): the globe, the layer panel
 * (the World Model, its connectors and its products), place search and the
 * globe actions. Nothing a host has to tune.
 *
 * What it leaves out is listed here, not deleted from the shared markup: the
 * standalone shell keeps its visual presets, display controls, scenes and HUD,
 * and every module that looks these elements up still finds them.
 */

/** Chrome the embed does not show, by element id in the application markup. */
export const EMBEDDED_HIDDEN_CHROME = Object.freeze([
  'title-bar', // the host page carries its own title
  'style-indicator', // one style, so nothing to indicate
  'control-panel', // visual presets (noir, thermal, retro, ...)
  'pp-toggles', // display: HUD layout, scope, bloom, sharpen, density
  'scene-panel', // scripted scenes
  'cctv-panel', // CCTV has no world-model source
  'global-context-panel', // regional brief and radio
  'traffic-sync-chip',
  'cctv-sync-chip',
  'intel-hud', // the mock-classified tactical HUD
  'share-btn', // the embed never owns the page address
]);

/** The stylesheet that hides `EMBEDDED_HIDDEN_CHROME` under `rootClass`. */
export function presentationCss(rootClass) {
  return EMBEDDED_HIDDEN_CHROME.map(
    (id) => `.${rootClass} #${id} { display: none !important; }`,
  ).join('\n');
}

/** Append the presentation stylesheet inside `root`; returns its remover. */
export function applyPresentation(root, rootClass) {
  const style = root.ownerDocument.createElement('style');
  style.dataset.godsEyePresentation = '';
  style.textContent = presentationCss(rootClass);
  root.appendChild(style);
  return () => style.remove();
}
