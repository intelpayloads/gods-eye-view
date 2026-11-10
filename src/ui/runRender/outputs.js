/**
 * What a finished render hands back (GEN-369), read from the job's output
 * files by the renderer's own names (droneimages `RENDER.md`):
 * `{job}.<camera>.<pass>.0000.<ext>`, plus `output.json`, whose frame record
 * carries each visible drone's 2D box. The label image is one byte per pixel,
 * a class id (sky, building, ground, tree, drone), so it is coloured here
 * before anyone looks at it. Pure.
 */
export const OUTPUT_PATTERNS = Object.freeze({
  photo: /\.ObserverCamera\.FinalImage\.0000_neural\.png$/,
  unreal: /\.ObserverCamera\.FinalImage\.0000\.jpe?g$/,
  labels: /\.main_camera\.seg\.0000\.png$/,
  record: /(^|\/)output\.json$/,
});

/** The renderer's class ids (`render/labels.rs`) and the colour each is shown in. */
export const LABEL_CLASSES = Object.freeze({
  1: Object.freeze({ name: 'building', rgb: [214, 140, 69] }),
  2: Object.freeze({ name: 'ground', rgb: [96, 128, 72] }),
  5: Object.freeze({ name: 'sky', rgb: [96, 160, 220] }),
  6: Object.freeze({ name: 'tree', rgb: [40, 170, 90] }),
  7: Object.freeze({ name: 'drone', rgb: [255, 60, 60] }),
});
const UNLABELED_RGB = [255, 0, 255];

/** `[{id, name}]` -> `{photo, unreal, labels, record}`, each `{id, name}` or absent. */
export function pickOutputs(outputs) {
  const picked = {};
  for (const output of outputs ?? []) {
    const name = String(output?.name ?? '');
    for (const [key, pattern] of Object.entries(OUTPUT_PATTERNS))
      if (!picked[key] && pattern.test(name)) picked[key] = { id: output.id, name };
  }
  return picked;
}

/** The media type of an output by its name: the server sends every file as octet-stream. */
export function mediaTypeOf(name) {
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.json$/i.test(name)) return 'application/json';
  return 'application/octet-stream';
}

/** Colour decoded label pixels (RGBA, the class id in every channel) in place. */
export function colourLabels(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const rgb = LABEL_CLASSES[rgba[i]]?.rgb ?? UNLABELED_RGB;
    rgba[i] = rgb[0];
    rgba[i + 1] = rgb[1];
    rgba[i + 2] = rgb[2];
    rgba[i + 3] = 255;
  }
  return rgba;
}

/**
 * The frame a render made: its size, and each visible drone's box in its
 * pixels. A drone hidden or out of frame has no box (the renderer leaves it
 * out), so an empty list means the drone is not in the picture.
 */
export function frameOf(output) {
  const record = output?.frame_records?.[0] ?? null;
  const intrinsics = record?.camera_intrinsics ?? {};
  const boxes = [];
  for (const object of record?.annotations?.objects ?? []) {
    if (object?.kind !== 'bounding_box_2d' || object.class_label !== 'drone') continue;
    const box = object.box_2d ?? {};
    if (![box.x_min, box.y_min, box.x_max, box.y_max].every(Number.isFinite)) continue;
    boxes.push({
      objectId: String(object.object_id ?? 'drone'),
      // GEN-466: the callsign the request sent; an older renderer writes none.
      label: typeof object.label === 'string' && object.label ? object.label : null,
      xMin: box.x_min,
      yMin: box.y_min,
      xMax: box.x_max,
      yMax: box.y_max,
      visiblePx: Number.isFinite(object.visible_px) ? object.visible_px : null,
    });
  }
  return {
    width: Number.isFinite(intrinsics.width) ? intrinsics.width : null,
    height: Number.isFinite(intrinsics.height) ? intrinsics.height : null,
    boxes,
  };
}

/** What a box is called: its callsign, else the renderer's object id. */
export function boxName(box) {
  return box?.label || box?.objectId || 'drone';
}

/**
 * How many drones a render was sent and how many its frame shows (GEN-468):
 * `3 drones sent, 2 visible · hidden: RAVEN-2`. `sent` is the request's
 * targets as `[{id, label}]`. A drone is visible when a box carries its id; a
 * renderer older than GEN-466 names boxes `drone_{i}`, so then only the
 * counts are said. Null when the entry does not know what it sent.
 */
export function dronesLine(sent, boxes = []) {
  if (!Array.isArray(sent) || !sent.length) return null;
  const count = `${sent.length} drone${sent.length === 1 ? '' : 's'} sent, ${boxes.length} visible`;
  const ids = new Set(boxes.map((box) => box.objectId));
  if (boxes.length && !sent.some((drone) => ids.has(drone.id))) return count;
  const hidden = sent.filter((drone) => !ids.has(drone.id)).map((drone) => drone.label || drone.id);
  return hidden.length ? `${count} · hidden: ${hidden.join(', ')}` : count;
}
