/** The embedded application's chrome: generated markup plus host asset paths. */
import { APPLICATION_MARKUP } from './markup.js';

export { APPLICATION_MARKUP };

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
