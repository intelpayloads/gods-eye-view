/** The embedded application's chrome: generated markup plus host asset paths. */
import { APPLICATION_MARKUP, APPLICATION_STYLESHEETS } from './markup.js';

export { APPLICATION_MARKUP, APPLICATION_STYLESHEETS };

/** Class the embedded stylesheet scopes every rule under. */
export const ROOT_CLASS = 'gods-eye-root';

/** Root-relative asset references in the chrome markup (`src="/logo.svg"`). */
const MARKUP_ASSET_ATTRIBUTE = /\b(src|data-logo-src)="\/(?!\/)([^"]*)"/g;

/**
 * The chrome markup with static asset references under `assetBaseUrl`.
 * @param {string} [assetBaseUrl] Prefix for `public/` assets, e.g. `assets/gods-eye`.
 */
export function renderApplicationMarkup(assetBaseUrl) {
  if (assetBaseUrl === undefined) return APPLICATION_MARKUP;
  const base = String(assetBaseUrl).replace(/\/+$/, '');
  return APPLICATION_MARKUP.replace(
    MARKUP_ASSET_ATTRIBUTE,
    (_, attribute, file) => `${attribute}="${base}/${file}"`,
  );
}

/**
 * Add the chrome's external stylesheets (web and icon fonts) to `document`'s
 * <head> unless the host already loads them. Returns a function removing the
 * links this call added.
 */
export function attachApplicationStylesheets(document) {
  const added = [];
  for (const href of APPLICATION_STYLESHEETS) {
    const present = [
      ...document.head.querySelectorAll('link[rel="stylesheet"]'),
    ].some((link) => link.getAttribute('href') === href);
    if (present) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.godsEyeStylesheet = '';
    document.head.appendChild(link);
    added.push(link);
  }
  return () => {
    for (const link of added.splice(0)) link.remove();
  };
}
