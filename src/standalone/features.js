/**
 * Optional page-owning features. The standalone shell enables all of them; an
 * embedding host opts in explicitly.
 *  - voice: the realtime voice command dock (needs the provider token API)
 *  - keySetup: the provider key setup dialog (needs the provider setup API)
 *  - firstRun: the welcome tour revealed after the loading screen
 *  - shareLink: the URL hash carries and restores the view; off, the page's
 *    address is left alone and nothing is restored from it (DWM-189)
 *  - scopeMask: the circular scope vignette and its feather (DWM-189)
 */
export const STANDALONE_FEATURES = Object.freeze({
  voice: true,
  keySetup: true,
  firstRun: true,
  shareLink: true,
  scopeMask: true,
});

/** `features` over the standalone defaults. */
export function resolveFeatures(features = {}) {
  return { ...STANDALONE_FEATURES, ...features };
}
