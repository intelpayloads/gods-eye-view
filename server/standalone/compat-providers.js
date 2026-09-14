import { openSkyProxy } from '../providers/aircraft/opensky.js';
import { celestrakProxy, rocketLaunchesProxy } from '../providers/space.js';
import { tomtomProxy } from '../providers/traffic.js';
import { firmsProxy } from '../providers/firms.js';
import { terrainHeightsProxy } from '../providers/terrain.js';
import { adsbdbProxy } from '../providers/aircraft/enrichment.js';
import { overpassProxy } from '../providers/overpass.js';
import { militaryInstallationsProxy } from '../providers/military-installations.js';
import { regionalBriefProxy } from '../providers/regional/briefing.js';
import { weatherEffectsProxy } from '../providers/regional/weather-effects.js';
import { cctvProxy } from '../providers/cctv.js';
import { defaultSourceRoot } from '../providers/common/source-root.js';
import { radioBrowserProxy } from '../providers/radio.js';
import { gbfsProxy } from '../providers/gbfs.js';
import { adsbLolProxy } from '../providers/aircraft/adsb-lol.js';
import { aisLiveProxy } from '../providers/vessels/ais-live.js';
import { trackBackfillProxies } from '../providers/aircraft/tracks.js';
import { openAiRealtimeProxy } from '../providers/openai.js';
import { googlePlacesContextProxy } from '../providers/places.js';

/**
 * gods-eye-compat removal ledger (DWM-34).
 *
 * The compat provider server mounts exactly the plugins listed here. It is a
 * transitional service: each DWM-27 connector ticket deletes its row from
 * COMPAT_PROVIDERS once its Gods Eye layer reads the world model, and DWM-48 /
 * DWM-46 delete the COMPAT_UTILITY_ROUTES rows. When both lists are empty the
 * service, its Dockerfile and deploy/compat/ in Dataforge-World-Model go.
 * The same tables live on the Confluence harness page (DWM 71041025).
 *
 * `plugin` is the Vite plugin name; `routes` are the paths it registers (the
 * coverage test asserts both against localProviderPlugins()). A row names every
 * ticket that must land before it can be deleted.
 */
export const COMPAT_PROVIDERS = Object.freeze([
  {
    id: 'opensky',
    plugin: 'opensky-proxy',
    create: () => openSkyProxy(),
    routes: ['/api/opensky'],
    removedBy: ['DWM-4', 'DWM-46'],
  },
  {
    id: 'track-backfill',
    plugin: 'track-backfill-proxies',
    create: () => trackBackfillProxies(),
    // /api/opensky-track leaves with DWM-46, /api/adsblol/trace with DWM-31.
    routes: ['/api/opensky-track', '/api/adsblol/trace'],
    removedBy: ['DWM-46', 'DWM-31'],
  },
  {
    id: 'adsb-lol',
    plugin: 'adsblol-proxy',
    create: () => adsbLolProxy(),
    routes: ['/api/adsblol/mil'],
    removedBy: ['DWM-31'],
  },
  {
    id: 'adsbdb',
    plugin: 'adsbdb-proxy',
    create: () => adsbdbProxy(),
    routes: ['/api/adsbdb'],
    removedBy: ['DWM-31'],
  },
  {
    id: 'ais-live',
    plugin: 'ais-live-proxy',
    create: () => aisLiveProxy(),
    routes: ['/api/ais-live'],
    removedBy: ['DWM-29'],
  },
  {
    id: 'celestrak',
    plugin: 'celestrak-proxy',
    create: () => celestrakProxy(),
    routes: ['/api/celestrak'],
    removedBy: ['DWM-33'],
  },
  {
    id: 'launches',
    plugin: 'rocket-launches-proxy',
    create: () => rocketLaunchesProxy(),
    routes: ['/api/launches'],
    removedBy: ['DWM-36'],
  },
  {
    id: 'firms',
    plugin: 'firms-proxy',
    create: () => firmsProxy(),
    routes: ['/api/firms'],
    removedBy: ['DWM-30'],
  },
  {
    id: 'gbfs',
    plugin: 'gbfs-proxy',
    create: () => gbfsProxy(),
    routes: ['/api/gbfs'],
    removedBy: ['DWM-35'],
  },
  {
    id: 'radio',
    plugin: 'radio-browser-proxy',
    create: () => radioBrowserProxy(),
    routes: ['/api/radio'],
    removedBy: ['DWM-38'],
  },
  {
    id: 'military-installations',
    plugin: 'military-installations-proxy',
    create: () => militaryInstallationsProxy(),
    routes: ['/api/military-installations'],
    removedBy: ['DWM-40'],
  },
  {
    id: 'tomtom',
    plugin: 'tomtom-proxy',
    create: () => tomtomProxy(),
    routes: ['/api/tomtom'],
    removedBy: ['DWM-43'],
  },
  {
    id: 'cctv',
    plugin: 'cctv-proxy',
    create: () => cctvProxy({ sourceRoot: defaultSourceRoot }),
    routes: ['/api/cctv'],
    removedBy: ['DWM-45'],
  },
  {
    id: 'weather-effects',
    plugin: 'weather-effects-proxy',
    create: () => weatherEffectsProxy(),
    routes: ['/api/weather-effects'],
    removedBy: ['DWM-37'],
  },
]);

/**
 * Routes that are not world-model data feeds. Each has an exit owner: the
 * ticket that moves (or deliberately drops) the functionality before compat is
 * deleted. A row without an owner blocks the end condition.
 */
export const COMPAT_UTILITY_ROUTES = Object.freeze([
  {
    id: 'terrain',
    plugin: 'terrain-heights-proxy',
    create: () => terrainHeightsProxy(),
    routes: ['/api/terrain/heights'],
    usedBy: 'terrain height sampling for ground-clamped entities',
    exitOwner: 'DWM-46',
    prerequisites: [],
  },
  {
    id: 'overpass',
    plugin: 'overpass-proxy',
    create: () => overpassProxy(),
    // The generic Overpass proxy is not the installations feed: it also serves
    // roads/boundaries context, and this plugin mounts /api/route as well.
    routes: ['/api/overpass', '/api/route'],
    usedBy: 'military installations layer (until DWM-40), roads/boundaries context, route planning',
    exitOwner: 'DWM-48',
    prerequisites: ['DWM-40', 'DWM-43'],
  },
  {
    id: 'regional-brief',
    plugin: 'regional-brief-proxy',
    create: () => regionalBriefProxy(),
    routes: ['/api/regional-brief'],
    usedBy: 'regional briefing panel',
    exitOwner: 'DWM-48',
    prerequisites: [],
  },
  {
    id: 'openai',
    plugin: 'openai-realtime-proxy',
    create: () => openAiRealtimeProxy(),
    routes: [
      '/api/openai/hud-summary',
      '/api/realtime/debug-log',
      '/api/realtime/token',
    ],
    usedBy: 'voice control and HUD summary',
    exitOwner: 'DWM-48',
    prerequisites: [],
  },
  {
    id: 'google-places',
    plugin: 'google-places-context-proxy',
    create: () => googlePlacesContextProxy(),
    routes: ['/api/google/nearby-places', '/api/google/text-search'],
    usedBy: 'place search and nearby context',
    exitOwner: 'DWM-48',
    prerequisites: [],
  },
]);

/** Local dev plugins the compat server deliberately never mounts. */
export const COMPAT_EXCLUDED = Object.freeze([
  {
    plugin: 'gev-key-setup',
    reason: 'dev-only Provider Settings; writes .env. Compat keys come from a Kubernetes Secret.',
  },
  {
    plugin: 'gev-world-model-dev-proxy',
    reason: 'standalone dev adapter for /api/world; consumers reach the backplane at /world, never through compat.',
  },
]);

/** Instantiate every plugin still on either ledger, providers first. */
export function compatProviderPlugins() {
  return [...COMPAT_PROVIDERS, ...COMPAT_UTILITY_ROUTES].map((row) => row.create());
}
