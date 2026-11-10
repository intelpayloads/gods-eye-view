/**
 * Render this moment (GEN-369): the run player's RENDER button, its panel,
 * each render's status, and a picture-in-picture that shows a render while
 * the player sits on its moment.
 *
 * Present only when the host injects a `renderSource` (see `jobs.js`) and the
 * run on screen has a drone. The moment is always the player's: opening the
 * panel pauses it, and the request is built from the stored epoch it shows.
 * Cameras are the run's sites with a lens (`simulation.uas.sites`, once a run
 * publishes them, GEN-379) and This view: what God's Eye shows inside a 16:9
 * viewfinder. Renders are listed per run in the viewer's storage until the
 * World Model keeps them (DWM-277).
 */
import { droneName, sharedUasTracks, storedRowAt } from '../../layers/worldModel/uasTrack.js';
import { uasWords } from '../../layers/worldModel/uasCard.js';
import { DEFAULT_DISPLAY_ASSUMPTIONS } from '../../layers/worldModel/view.js';
import {
  VIEW_FRAME,
  autoFovDeg,
  bindsSites,
  buildRenderRequest,
  cameraSites,
  groundDistanceM,
  regionLayers,
  renderBlockers,
  siteFrame,
  sitesQuery,
  slantDistanceM,
  viewfinderBox,
} from './request.js';
import { sunAltitudeDeg } from './sun.js';
import { createRenderJobs } from './jobs.js';
import { colourLabels } from './outputs.js';
import {
  FULL_CLASS,
  OPEN_CLASS,
  PANEL_CLASS,
  PIP_CLASS,
  STYLE,
  VIEWFINDER_CLASS,
  clockText,
  el,
  elapsedText,
} from './markup.js';

const LOOKS = Object.freeze({
  fast: { label: 'Fast', estimate: '~30 s', hint: 'Unreal only' },
  photoreal: { label: 'Photoreal', estimate: '~2 min', hint: 'Unreal, then Cosmos' },
});
const STATE_WORDS = Object.freeze({
  submitting: 'sending',
  queued: 'queued',
  rendering: 'rendering',
  transferring: 'fetching',
  completed: 'done',
  failed: 'failed',
});
const SITE_WORDS = Object.freeze({ gcs: 'GCS', cuas_site: 'C-UAS' });
const TERMINAL = new Set(['completed', 'failed']);
/** A finished render's chip stays this long after it lands. */
const DONE_CHIP_MS = 60_000;
const D2R = Math.PI / 180;

function siteLabel(site) {
  return `${SITE_WORDS[site.kind] ?? site.kind} ${String(site.identity).split(':').at(-1)}`;
}

/** Read the run's drone, region tiles and camera sites, once per run revision. */
async function readRunContext({ source, revisionId, head }) {
  const tracks = await sharedUasTracks(source).read({ revisionId });
  if (!tracks.length) return { tracks: [], region: null, layers: [], sites: [] };
  const region = tracks[0].header?.terrain?.region ?? null;
  let revision = null;
  if (typeof source.getRevision === 'function') revision = await source.getRevision({ revisionId });
  let sites = [];
  if (bindsSites(revision)) {
    const projection = await source.getProjection({
      revisionId,
      head,
      query: { ...sitesQuery(), valid_at: tracks[0].rows[0]?.validTime },
      projectionSpec: { display_assumptions: DEFAULT_DISPLAY_ASSUMPTIONS },
    });
    sites = cameraSites(projection);
  }
  return { tracks, region, layers: regionLayers(revision, region), sites };
}

/**
 * @param {{renderSource: object, viewer: object, playerRoot: HTMLElement,
 *   controls: HTMLElement, seek: (validAt: string) => void, pause: () => void,
 *   storage?: Storage|null}} options
 */
export function mountRunRender({ renderSource, viewer, playerRoot, controls, seek, pause, storage }) {
  const container = viewer?.container;
  if (!renderSource || !container || !playerRoot || !controls) return null;
  const style = el('style', {}, STYLE);
  document.head.appendChild(style);

  const ui = {
    panelOpen: false,
    listOpen: false,
    cameraId: 'view',
    look: 'fast',
    zoom: 'auto',
    droneIndex: 0,
    pipView: 'photo',
    pickedId: null,
    fullOpen: false,
    // The picture-in-picture's ×: closed until a render is opened from the
    // chips or the list, or a new one is sent.
    pipClosed: false,
  };
  let moment = null;
  let context = { key: null, status: 'idle', tracks: [], region: null, layers: [], sites: [] };
  let dirty = true;
  const jobs = createRenderJobs({ renderSource, storage, onChange: () => (dirty = true) });

  const button = el('button', {
    type: 'button',
    class: 'rp-render',
    hidden: true,
    title: 'Render this moment on the render node',
    'aria-expanded': 'false',
    onclick: () => togglePanel(),
  }, 'RENDER');
  const follow = controls.querySelector('.rp-follow');
  if (follow) follow.after(button);
  else controls.append(button);
  const line = el('div', { class: 'rp-render-line', hidden: true });
  controls.after(line);
  const list = el('div', { class: 'rr-list', hidden: true, role: 'dialog', 'aria-label': 'Renders of this run' });
  const panel = el('div', { class: PANEL_CLASS, hidden: true, role: 'dialog', 'aria-label': 'Render this moment' });
  // GEN-423: the form and the list open inside the player, in the chart's place, never as cards over the scene
  // (FOLLOW keeps the drone at the view's centre, just above the player).
  controls.before(panel, list);
  const showOpen = () => playerRoot.classList.toggle(OPEN_CLASS, ui.panelOpen || ui.listOpen);
  const viewfinder = el('div', { class: VIEWFINDER_CLASS, hidden: true, 'aria-hidden': 'true' });
  const pip = el('section', { class: PIP_CLASS, hidden: true, 'aria-label': 'Render of this moment' });
  const full = el('div', { class: FULL_CLASS, hidden: true, role: 'dialog', 'aria-label': 'Render, full size' });
  container.append(viewfinder, pip, full);

  // ---- the run --------------------------------------------------------

  function runKeyOf(run) {
    return run?.head && run.revisionId ? `${run.head}|${run.revisionId}` : null;
  }

  function loadContext(run) {
    const key = runKeyOf(run);
    if (key === context.key) return;
    context = { key, status: key ? 'loading' : 'idle', tracks: [], region: null, layers: [], sites: [] };
    ui.panelOpen = false;
    ui.listOpen = false;
    ui.pickedId = null;
    ui.droneIndex = 0;
    ui.cameraId = 'view';
    dirty = true;
    if (!key) return;
    readRunContext(run).then(
      (read) => {
        if (context.key !== key) return;
        context = { key, status: 'ready', ...read };
        dirty = true;
      },
      (error) => {
        if (context.key !== key) return;
        console.warn('[RunRender] the run could not be read for rendering:', error);
        context = { ...context, status: 'failed' };
        dirty = true;
      },
    );
  }

  function droneAt() {
    const track = context.tracks[ui.droneIndex] ?? context.tracks[0];
    if (!track || !moment) return { track: null, row: null };
    return { track, row: storedRowAt(track.rows, moment.ms) };
  }

  // ---- the camera -----------------------------------------------------

  /** God's Eye's camera as This view: its position, aim and the viewfinder's fov. */
  function viewCamera() {
    const camera = viewer.camera;
    const canvas = viewer.scene?.canvas;
    const fovy = camera?.frustum?.fovy;
    if (!camera || !canvas || !Number.isFinite(fovy)) return { camera: null, box: null };
    const box = viewfinderBox({ width: canvas.clientWidth, height: canvas.clientHeight, fovyRad: fovy });
    const where = camera.positionCartographic;
    return {
      box,
      camera: {
        kind: 'view',
        lon: where.longitude / D2R,
        lat: where.latitude / D2R,
        height: where.height,
        headingDeg: camera.heading / D2R,
        pitchDeg: camera.pitch / D2R,
        fovDeg: box.hfovDeg,
      },
    };
  }

  function siteCamera(site, row) {
    const distance = row?.position ? slantDistanceM({ ...site }, row.position) : null;
    const fovDeg =
      ui.zoom === 'auto'
        ? autoFovDeg(distance, siteFrame(site).width, site.hfovDeg)
        : Math.min(site.hfovDeg, Number(ui.zoom));
    return { kind: 'site', site, fovDeg };
  }

  function chosenCamera(row) {
    if (ui.cameraId === 'view') return viewCamera();
    const site = context.sites.find((s) => s.identity === ui.cameraId);
    return site ? { camera: siteCamera(site, row), box: null } : { camera: null, box: null };
  }

  // ---- the panel ------------------------------------------------------

  function togglePanel(open = !ui.panelOpen) {
    ui.panelOpen = open;
    if (open) {
      ui.listOpen = false;
      pause();
    }
    buildPanel();
    dirty = true;
  }

  function radio(name, value, checked, label, onChange) {
    return el(
      'label',
      {},
      el('input', { type: 'radio', name, value, checked, onchange: () => onChange(value) }),
      label,
    );
  }

  const live = {}; // the panel's lines that change while it is open

  function buildPanel() {
    panel.replaceChildren();
    panel.hidden = !ui.panelOpen;
    showOpen();
    if (!ui.panelOpen) return;
    const name = `rr-${Math.random().toString(36).slice(2, 8)}`;
    const cameras = [
      ...context.sites.map((site) => ({ id: site.identity, label: siteLabel(site) })),
      { id: 'view', label: 'This view' },
    ];
    if (!cameras.some((c) => c.id === ui.cameraId)) ui.cameraId = 'view';
    live.title = el('span', {});
    live.zoom = el('span', { class: 'rr-hint' });
    live.drone = el('span', {});
    live.blockers = el('div', { class: 'rr-blockers', role: 'status' });
    live.go = el('button', { type: 'button', onclick: () => submit() }, 'Render');
    const zoomSelect =
      ui.cameraId === 'view'
        ? null
        : el(
            'select',
            { 'aria-label': 'Zoom', onchange: (event) => ((ui.zoom = event.target.value), (dirty = true)) },
            ['auto', '2', '5', '10', '20', '40'].map((value) =>
              el('option', { value, selected: ui.zoom === value }, value === 'auto' ? 'Auto' : `${value}°`),
            ),
          );
    const droneSelect =
      context.tracks.length > 1
        ? el(
            'select',
            { 'aria-label': 'Drone', onchange: (event) => ((ui.droneIndex = Number(event.target.value)), (dirty = true)) },
            context.tracks.map((track, i) =>
              el('option', { value: i, selected: i === ui.droneIndex }, droneName(track.identity, track.callsign)),
            ),
          )
        : null;
    panel.append(
      el('div', { class: 'rr-head' }, live.title,
        el('button', { type: 'button', 'aria-label': 'Close', onclick: () => togglePanel(false) }, '×')),
      el('div', { class: 'rr-row' }, el('span', { class: 'rr-label' }, 'Camera'),
        el('span', { class: 'rr-options' }, cameras.map((c) =>
          radio(`${name}-camera`, c.id, c.id === ui.cameraId, c.label, (value) => {
            ui.cameraId = value;
            buildPanel();
            dirty = true;
          })),
          context.sites.length ? null : el('span', { class: 'rr-hint' }, '(this run publishes no site cameras)'))),
      el('div', { class: 'rr-row' }, el('span', { class: 'rr-label' }, 'Zoom'),
        el('span', { class: 'rr-options' }, zoomSelect, live.zoom)),
      el('div', { class: 'rr-row' }, el('span', { class: 'rr-label' }, 'Look'),
        el('span', { class: 'rr-options' }, Object.entries(LOOKS).map(([value, look]) =>
          radio(`${name}-look`, value, value === ui.look, `${look.label} ${look.estimate}`, (v) => {
            ui.look = v;
            dirty = true;
          })))),
      el('div', { class: 'rr-row' }, el('span', { class: 'rr-label' }, 'Drone'),
        el('span', { class: 'rr-options' }, droneSelect, live.drone)),
      live.blockers,
      el('div', { class: 'rr-actions' },
        el('button', { type: 'button', onclick: () => togglePanel(false) }, 'Cancel'), live.go),
    );
  }

  /** What the panel would send now, and why not. */
  function currentShot() {
    const { track, row } = droneAt();
    const { camera, box } = chosenCamera(row);
    const where = camera ? (camera.kind === 'site' ? camera.site : camera) : null;
    const sun = where && moment ? sunAltitudeDeg(where, moment.validAt) : null;
    const blockers = renderBlockers({ layers: context.layers, camera, drone: row, sunAltitudeDeg: sun });
    if (ui.cameraId === 'view' && !camera) blockers.unshift('This view needs the 3D perspective camera');
    return { track, row, camera, box, where, blockers };
  }

  function renderPanel(shot) {
    if (!ui.panelOpen) return;
    live.title.textContent = `RENDER ${clockText(moment.ms)}`;
    const frame = shot.camera?.kind === 'site' ? siteFrame(shot.camera.site) : VIEW_FRAME;
    live.zoom.textContent = shot.camera
      ? `${shot.camera.fovDeg.toFixed(1)}°${shot.camera.kind === 'site' ? ` (lens ${shot.camera.site.hfovDeg}°)` : ' as framed'} · ${frame.width}×${frame.height}`
      : '';
    const words = shot.row ? uasWords(shot.row, shot.track.header) : null;
    live.drone.textContent = shot.row
      ? [
          droneName(shot.track.identity, shot.track.callsign),
          shot.where ? `${(groundDistanceM(shot.where, shot.row.position) / 1000).toFixed(2)} km away` : null,
          Number.isFinite(shot.row.aglM) ? `${Math.round(shot.row.aglM)} m AGL` : null,
          words?.mode,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'no stored row at this time';
    live.blockers.replaceChildren(...shot.blockers.map((reason) => el('div', {}, reason)));
    live.go.disabled = shot.blockers.length > 0 || !moment?.run?.revisionId;
  }

  function renderViewfinder(shot) {
    const show = ui.panelOpen && ui.cameraId === 'view' && shot.box;
    viewfinder.hidden = !show;
    if (!show) return;
    const canvas = viewer.scene.canvas.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    const left = Math.round(canvas.left - box.left + shot.box.left);
    const top = Math.round(canvas.top - box.top + shot.box.top);
    const css = `left:${left}px;top:${top}px;width:${shot.box.width}px;height:${shot.box.height}px`;
    if (viewfinder.style.cssText !== css) viewfinder.style.cssText = css;
  }

  async function submit() {
    const shot = currentShot();
    if (shot.blockers.length || !shot.camera || !shot.row) return;
    const request = buildRenderRequest({
      run: moment.run,
      region: context.region,
      layers: context.layers,
      camera: shot.camera,
      drone: shot.row,
      validAt: moment.validAt,
      look: ui.look,
    });
    togglePanel(false);
    ui.pipClosed = false;
    await jobs.submit({
      runKey: moment.run.head,
      validAt: moment.validAt,
      camera: shot.camera.kind === 'site' ? siteLabel(shot.camera.site) : 'This view',
      look: ui.look,
      fovDeg: Number(shot.camera.fovDeg.toFixed(1)),
      request,
    });
  }

  // ---- status chips and the list --------------------------------------

  function entries() {
    return moment?.run ? jobs.list(moment.run.head) : [];
  }

  function chipFor(entry) {
    const word = STATE_WORDS[entry.state] ?? entry.state;
    const at = clockText(Date.parse(entry.validAt));
    const busy = !TERMINAL.has(entry.state);
    const text = busy
      ? `${entry.state === 'queued' || entry.state === 'submitting' ? '◷' : '⟳'} ${at} ${entry.camera} · ${word} ${elapsedText(Date.now() - Date.parse(entry.submittedAt))}`
      : entry.state === 'completed'
        ? `✓ ${at} ${entry.camera}`
        : `⚠ ${at} failed: ${entry.reason ?? 'unknown'}`;
    return el('button', {
      type: 'button',
      class: `rr-chip${entry.state === 'failed' ? ' rr-failed' : entry.state === 'completed' ? ' rr-done' : ''}`,
      title: entry.reason ?? `${entry.look} · ${entry.fovDeg}° · ${entry.captureId}`,
      onclick: () => show(entry),
    }, text);
  }

  function show(entry) {
    ui.pickedId = entry.id;
    ui.listOpen = false;
    ui.pipClosed = false;
    seek(entry.validAt);
    dirty = true;
  }

  let lineKey = null;
  let listKey = null;

  function renderLine() {
    const all = entries();
    const now = Date.now();
    const chips = all
      .filter((e) => !TERMINAL.has(e.state) || (e.finishedAt && now - e.finishedAt < DONE_CHIP_MS))
      .slice(0, 3);
    const visible = Boolean(moment?.run) && context.tracks.length > 0;
    line.hidden = !visible || !all.length;
    const key = [
      ui.listOpen,
      all.length,
      ...chips.map((e) => [e.id, e.state, e.reason, TERMINAL.has(e.state) ? '' : Math.floor((now - Date.parse(e.submittedAt)) / 1000)].join(':')),
    ].join('|');
    if (key !== lineKey) {
      lineKey = key;
      renderChips(all, chips);
    }
    list.hidden = !ui.listOpen;
    showOpen();
    const listed = ui.listOpen ? all.map((e) => [e.id, e.state, e.reason].join(':')).join('|') : null;
    if (ui.listOpen && listed !== listKey)
      list.replaceChildren(
        ...all.map((entry) =>
          el('button', { type: 'button', onclick: () => show(entry), title: entry.captureId },
            `${clockText(Date.parse(entry.validAt))} · ${entry.camera} · ${LOOKS[entry.look]?.label ?? entry.look} · ${STATE_WORDS[entry.state] ?? entry.state}`,
            entry.state === 'failed' && entry.reason ? el('div', { class: 'rr-reason' }, entry.reason) : null),
        ),
      );
    listKey = listed;
  }

  function renderChips(all, chips) {
    const toggle = all.length
      ? el('button', {
          type: 'button',
          class: 'rr-chip',
          'aria-expanded': String(ui.listOpen),
          onclick: () => {
            ui.listOpen = !ui.listOpen;
            if (ui.listOpen) togglePanel(false);
            dirty = true;
          },
        }, `Renders (${all.length}) ${ui.listOpen ? '▴' : '▾'}`)
      : null;
    line.replaceChildren(...chips.map(chipFor), toggle);
  }

  // ---- the picture-in-picture -----------------------------------------

  let pipKey = null;
  let labelCanvas = { id: null, canvas: null };

  /** The render this moment shows: the one picked, else the newest finished at this epoch. */
  function renderHere() {
    if (!moment) return null;
    const here = entries().filter((e) => Date.parse(e.validAt) === moment.ms);
    return (
      here.find((e) => e.id === ui.pickedId) ??
      here.find((e) => e.state === 'completed') ??
      here[0] ??
      null
    );
  }

  function labelsCanvasFor(entry) {
    if (labelCanvas.id === entry.id && labelCanvas.canvas) return labelCanvas.canvas;
    const canvas = el('canvas', { 'aria-label': 'Labels: building, ground, sky, tree, drone' });
    labelCanvas = { id: entry.id, canvas };
    const image = new Image();
    image.onload = () => {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      colourLabels(pixels.data);
      ctx.putImageData(pixels, 0, 0);
    };
    image.src = entry.images.labels;
    return canvas;
  }

  function frameNode(entry, view, boxClass = 'rr-box') {
    const frame = el('div', { class: 'rr-frame' });
    const images = entry.images ?? {};
    if (view === 'labels' && images.labels) frame.append(labelsCanvasFor(entry));
    else {
      const src = view === 'photo' ? images.photo : images.unreal;
      if (src) frame.append(el('img', { src, alt: `${view} frame at ${entry.validAt}` }));
    }
    const { width, height, boxes = [] } = entry.frame ?? {};
    if (width && height)
      for (const box of boxes)
        frame.append(
          el('div', {
            class: boxClass,
            title: `${box.objectId}${box.visiblePx ? ` · ${box.visiblePx} px visible` : ''}`,
            style: `left:${(((box.xMin + box.xMax) / 2) / width) * 100}%;top:${(((box.yMin + box.yMax) / 2) / height) * 100}%;width:${((box.xMax - box.xMin) / width) * 100}%;height:${((box.yMax - box.yMin) / height) * 100}%`,
          }),
        );
    return frame;
  }

  function viewOf(entry) {
    const images = entry.images ?? {};
    if (ui.pipView === 'photo' && !images.photo) return 'unreal';
    return ui.pipView;
  }

  function renderPip() {
    const entry = renderHere();
    if (entry?.state === 'completed' && !entry.images && !entry.imageError) void jobs.ensureImages(entry);
    const key = entry
      ? [entry.id, entry.state, Boolean(entry.images), entry.imageError, ui.pipView, ui.fullOpen, ui.pipClosed].join('|')
      : null;
    if (key === pipKey) return;
    pipKey = key;
    pip.hidden = !entry || ui.pipClosed;
    full.hidden = !(entry && ui.fullOpen && entry.images && !ui.pipClosed);
    if (!entry || ui.pipClosed) return;
    const view = viewOf(entry);
    const images = entry.images ?? {};
    const frame =
      entry.state === 'completed' && entry.images
        ? frameNode(entry, view)
        : el('div', { class: 'rr-frame' },
            el('div', { class: 'rr-status' },
              entry.state === 'failed'
                ? `Render failed: ${entry.reason ?? 'unknown'}`
                : entry.imageError
                  ? `Images unreadable: ${entry.imageError}`
                  : entry.state === 'completed'
                    ? 'Fetching the frame…'
                    : `${STATE_WORDS[entry.state] ?? entry.state} on the render node…`));
    const viewButton = (value, label, enabled) =>
      el('button', {
        type: 'button',
        'aria-pressed': String(view === value),
        disabled: !enabled,
        onclick: () => {
          ui.pipView = value;
          dirty = true;
        },
      }, label);
    pip.replaceChildren(
      frame,
      el('div', { class: 'rr-caption' },
        el('span', {}, `${entry.camera} · ${entry.fovDeg}° · ${LOOKS[entry.look]?.label ?? entry.look}`),
        el('span', {}, clockText(Date.parse(entry.validAt)))),
      el('div', { class: 'rr-views' },
        viewButton('photo', 'photo', Boolean(images.photo)),
        viewButton('unreal', 'unreal', Boolean(images.unreal)),
        viewButton('labels', 'labels', Boolean(images.labels)),
        el('span', { style: 'flex:1' }),
        el('button', {
          type: 'button',
          title: 'Full size, with a download',
          disabled: !entry.images,
          onclick: () => {
            ui.fullOpen = true;
            dirty = true;
          },
        }, '⤢'),
        el('button', {
          type: 'button',
          'aria-label': 'Close',
          title: 'Close; open it again from Renders',
          onclick: () => {
            ui.pipClosed = true;
            ui.fullOpen = false;
            dirty = true;
          },
        }, '×')),
    );
    if (ui.fullOpen && entry.images) {
      const src = view === 'photo' ? images.photo : view === 'unreal' ? images.unreal : images.labels;
      full.replaceChildren(
        el('button', { type: 'button', class: 'rr-close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: closeFull }, '×'),
        frameNode(entry, view),
        el('div', {}, `${entry.camera} · ${entry.fovDeg}° · ${clockText(Date.parse(entry.validAt))} · ${entry.captureId}`),
        el('div', { class: 'rr-actions' },
          src ? el('a', { href: src, download: `${entry.captureId}-${view}.${view === 'unreal' ? 'jpg' : 'png'}` }, 'Download') : null,
          el('button', { type: 'button', onclick: closeFull }, 'Close')),
      );
    }
  }

  function closeFull() {
    ui.fullOpen = false;
    dirty = true;
  }

  /** Escape leaves full size, as a lightbox does. */
  function onKey(event) {
    if (event.key === 'Escape' && ui.fullOpen) {
      event.preventDefault();
      closeFull();
    }
  }
  document.addEventListener('keydown', onKey);

  // ---- the player's tick ----------------------------------------------

  let lastSecond = 0;
  let lastMs = null;

  function update(next) {
    moment = next?.run && Number.isFinite(next.ms) ? next : null;
    loadContext(moment?.run ?? null);
    const usable = Boolean(moment) && context.status === 'ready' && context.tracks.length > 0;
    button.hidden = !usable;
    button.setAttribute('aria-expanded', String(ui.panelOpen));
    if (!usable && ui.panelOpen) togglePanel(false);
    const shot = usable && ui.panelOpen ? currentShot() : null;
    if (shot) renderPanel(shot);
    renderViewfinder(shot ?? {});
    const second = Math.floor(Date.now() / 1000);
    if (dirty || second !== lastSecond || moment?.ms !== lastMs) {
      dirty = false;
      lastSecond = second;
      lastMs = moment?.ms;
      renderLine();
      renderPip();
    }
  }

  return {
    update,
    dispose() {
      jobs.dispose();
      document.removeEventListener('keydown', onKey);
      for (const node of [button, line, list, panel, viewfinder, pip, full, style]) node.remove();
      playerRoot.classList.remove(OPEN_CLASS);
    },
  };
}
