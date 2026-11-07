/**
 * A region drawn from the World Model's own tilesets (GEN-403), without Cesium.
 *
 * The embed shows one of two scenes. Photoreal is Google's mesh (GEN-402).
 * Modelled draws each region the world has from its own terrain, imagery,
 * buildings and trees: the world the RF model computes against. The two never
 * stack, because Google's mesh carries its own ground and buildings.
 *
 * A region is drawn when its terrain tileset is listed. The backplane lists a
 * tileset only once its run has finished, and imagery, buildings and trees sit
 * on that terrain. Files are read by content id (`/tilesets/{content_id}/`),
 * whose bytes and URL never change, so the browser's immutable cache holds
 * across revisions; the listing's own URLs are pinned to a revision.
 *
 * A region's terrain covers the whole globe: beyond its ring the tiles hold
 * the ring's edge heights (`layer.json` `beyond.rule: hold-edge`), so the
 * level-0 tiles put both hemispheres 1.7 km up. It is therefore the globe's
 * terrain only while the camera is over that region's ring; elsewhere the base
 * globe stays as it is. Its heights are NAD83(2011) ellipsoidal, drawn on
 * Cesium's WGS84 ellipsoid, about a metre apart there: a display assumption.
 */
export const SCENES = Object.freeze({
  photoreal: 'photoreal',
  modelled: 'modelled',
});

export const SCENE_STORAGE_KEY = 'gev:scene:v1';

/** A region's tilesets, in the order they are drawn (and the renderer takes them, GEN-369). */
export const REGION_LAYERS = Object.freeze([
  'terrain',
  'imagery',
  'buildings',
  'trees',
]);

export const REGION_DISPLAY = Object.freeze({
  kind: 'region-scene',
  terrain: 'region-terrain-while-the-camera-is-over-its-ring',
  height: 'nad83-2011-ellipsoidal-drawn-on-wgs84',
  // A region is left only this much past its ring and ceiling, so its terrain never flaps at the edge.
  exitMargin: 0.1,
  // The fly-to looks at the region's box from the south.
  view: Object.freeze({ headingDeg: 0, pitchDeg: -35 }),
});

export const REGION_DISPLAY_FACT =
  'display: a region’s terrain is the globe’s only while the camera is over its ring; ' +
  'its NAD83(2011) ellipsoid heights are drawn on WGS84 (about 1 m apart there)';

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQUATOR = 111_320;

/** `[W, S, E, N]` in degrees, or null when it is not a box. */
export function boxOf(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const [west, south, east, north] = bounds.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (!(west < east && south < north)) return null;
  return Object.freeze({ west, south, east, north });
}

function grown(box, degrees) {
  return Object.freeze({
    west: box.west - degrees,
    south: box.south - degrees,
    east: box.east + degrees,
    north: box.north + degrees,
  });
}

/** The box scaled about its centre (`scale` 1.1 = 10% wider and taller). */
function scaled(box, scale) {
  const halfW = ((box.east - box.west) / 2) * scale;
  const halfH = ((box.north - box.south) / 2) * scale;
  const lon = (box.west + box.east) / 2;
  const lat = (box.south + box.north) / 2;
  return {
    west: lon - halfW,
    south: lat - halfH,
    east: lon + halfW,
    north: lat + halfH,
  };
}

function sidesM(box) {
  const lat = ((box.south + box.north) / 2) * (Math.PI / 180);
  return {
    widthM: (box.east - box.west) * M_PER_DEG_LON_EQUATOR * Math.cos(lat),
    heightM: (box.north - box.south) * M_PER_DEG_LAT,
  };
}

/** How high over a region its terrain stays the globe's: its ring's longer side, so the view is mostly the ring. */
export function ceilingM(region) {
  const { widthM, heightM } = sidesM(region.ring);
  return Math.max(widthM, heightM);
}

/**
 * One region as the Modelled scene draws it: its box and ring from the
 * declaration, its listed tilesets at their content-id URLs, and whether it is
 * drawn (its terrain is listed) or why not.
 * @param {{name: string, region: object|null, listing: object|null,
 *   resolveUrl: (path: string) => string}} options `region` is `GET /regions/{name}`,
 *   `listing` is `GET /regions/{name}/tilesets` (null when it 404s).
 */
export function regionSceneOf({ name, region, listing, resolveUrl }) {
  const declaration = region?.declaration ?? null;
  const box = boxOf(declaration?.bounds);
  if (!box)
    return Object.freeze({
      name,
      box: null,
      ring: null,
      layers: Object.freeze({}),
      missing: REGION_LAYERS,
      drawn: false,
      reason: 'it declares no bounds',
    });
  const margin = Number(declaration.ring);
  const ring = Number.isFinite(margin) && margin > 0 ? grown(box, margin) : box;
  const layers = {};
  for (const entry of listing?.tilesets ?? []) {
    const layer = entry?.layer;
    if (!REGION_LAYERS.includes(layer) || layers[layer]) continue;
    if (typeof entry.content_id !== 'string' || !entry.content_id) continue;
    if (typeof entry.root !== 'string' || !entry.root) continue;
    const url = resolveUrl(`/tilesets/${entry.content_id}/`);
    layers[layer] = Object.freeze({
      layer,
      contentId: entry.content_id,
      type: entry.type ?? null,
      root: entry.root,
      files: Number.isFinite(entry.files) ? entry.files : null,
      url,
      rootUrl: `${url}${entry.root}`,
    });
  }
  const missing = REGION_LAYERS.filter((layer) => !layers[layer]);
  const drawn = Boolean(layers.terrain);
  return Object.freeze({
    name,
    box,
    ring,
    layers: Object.freeze(layers),
    missing: Object.freeze(missing),
    drawn,
    reason: drawn
      ? null
      : missing.length === REGION_LAYERS.length
        ? 'no tilesets yet'
        : 'no terrain tileset yet',
  });
}

/** The region names `GET /regions` holds (one row per source), in order of first appearance. */
export function regionNamesOf(regions) {
  const names = [];
  for (const row of regions?.regions ?? []) {
    const name = row?.region;
    if (typeof name === 'string' && name && !names.includes(name))
      names.push(name);
  }
  return names;
}

function inside(box, { lon, lat }) {
  return (
    lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north
  );
}

function over(region, camera, scale) {
  const ring = scale === 1 ? region.ring : scaled(region.ring, scale);
  return inside(ring, camera) && camera.height <= ceilingM(region) * scale;
}

/**
 * The drawn region whose terrain the globe takes for a camera at
 * `{lon, lat, height}` (ellipsoid metres), or null. A region is entered inside
 * its ring and below its ceiling, and left only past both by
 * `REGION_DISPLAY.exitMargin`; of overlapping rings the smallest wins.
 * @param {object[]} regions From `regionSceneOf`.
 * @param {string|null} [previous] The region the globe holds now.
 */
export function activeRegionAt(regions, camera, previous = null) {
  if (![camera?.lon, camera?.lat, camera?.height].every(Number.isFinite))
    return null;
  const drawn = (regions ?? []).filter(
    (region) => region?.drawn && region.ring,
  );
  const held = drawn.find((region) => region.name === previous);
  if (held && over(held, camera, 1 + REGION_DISPLAY.exitMargin)) return held;
  const area = (region) => {
    const { widthM, heightM } = sidesM(region.ring);
    return widthM * heightM;
  };
  return (
    drawn
      .filter((region) => over(region, camera, 1))
      .sort((a, b) => area(a) - area(b))[0] ?? null
  );
}

/** The scene to open in: a stored choice that is still on offer, else Photoreal when Google loaded, else Modelled. */
export function initialScene({
  stored = null,
  photorealAvailable = false,
} = {}) {
  if (stored === SCENES.modelled) return SCENES.modelled;
  if (stored === SCENES.photoreal && photorealAvailable)
    return SCENES.photoreal;
  return photorealAvailable ? SCENES.photoreal : SCENES.modelled;
}

/** The region a run's products name (`semantic_metadata[binding].terrain.region`), or null. */
export function runRegionOf(headers) {
  for (const binding of Object.keys(headers ?? {}).sort()) {
    const region = headers[binding]?.terrain?.region;
    if (typeof region === 'string' && region) return region;
  }
  return null;
}

/** Where the fly-to looks: the box centre at `groundM`, from the south, as far off as the box's diagonal. */
export function regionCamera(region, groundM = 0) {
  const { widthM, heightM } = sidesM(region.box);
  return Object.freeze({
    lon: (region.box.west + region.box.east) / 2,
    lat: (region.box.south + region.box.north) / 2,
    height: Number.isFinite(groundM) ? groundM : 0,
    headingDeg: REGION_DISPLAY.view.headingDeg,
    pitchDeg: REGION_DISPLAY.view.pitchDeg,
    rangeM: Math.hypot(widthM, heightM),
  });
}

/**
 * The imagery layer a `tilejson.json` describes, or why it cannot be drawn.
 * Only XYZ web-mercator is read (rows from the top: Cesium's `{y}`); anything
 * else is refused, never re-mapped.
 */
export function imageryOf(tilejson, url) {
  const template = tilejson?.tiles?.[0];
  if (tilejson?.scheme !== 'xyz' || tilejson?.projection !== 'EPSG:3857')
    return {
      imagery: null,
      reason: `imagery is ${tilejson?.scheme ?? '?'} ${tilejson?.projection ?? '?'}, not xyz EPSG:3857`,
    };
  if (typeof template !== 'string' || !template.includes('{z}'))
    return { imagery: null, reason: 'imagery has no tile template' };
  const box = boxOf(tilejson.bounds);
  if (!box) return { imagery: null, reason: 'imagery has no bounds' };
  const maxzoom = Number(tilejson.maxzoom);
  const tileSize = Number(tilejson.tile_size);
  return {
    imagery: Object.freeze({
      url: `${url}${template}`,
      box,
      maximumLevel: Number.isInteger(maxzoom) ? maxzoom : undefined,
      tileSize: Number.isInteger(tileSize) && tileSize > 0 ? tileSize : 256,
      attribution:
        typeof tilejson.attribution === 'string' ? tilejson.attribution : null,
    }),
    reason: null,
  };
}

/** The region's line in the World Model block: what is drawn, or why it is not. */
export function regionLine(region) {
  if (!region.drawn) return `${region.name} not drawn: ${region.reason}`;
  const drawn = REGION_LAYERS.filter((layer) => region.layers[layer]);
  return `${region.name} · ${drawn.join(', ')}`;
}
