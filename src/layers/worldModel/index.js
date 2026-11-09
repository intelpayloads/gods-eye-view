import * as Cesium from 'cesium';
import {
  countByBinding,
  fieldLegends,
  lineRecordsFromProjection,
  fieldSampleRecordsFromProjection,
  pointRecordsFromProjection,
  summarizeProjection,
} from './adapter.js';
import { createWorldViewController } from './controller.js';
import {
  FOLLOW_MODES,
  POLICY_MODES,
  demandBbox,
  formatAge,
  policyModeOf,
} from './demand.js';
import { createSelection } from './selection.js';
import { assertProjectionSource, sourceFeatures } from './source.js';
import {
  DEFAULT_DISPLAY_ASSUMPTIONS,
  DEFAULT_PREDICATES,
  DEFAULT_VIEW,
  HEAD,
  viewRectangleDegrees,
} from './view.js';
import {
  SIM_HEAD_PREFIX,
  STEP_SECONDS,
  leaveRunParams,
  sharedSimulationRuns,
  stepRunParams,
  viewRunParams,
} from './simulationRuns.js';
import {
  PASS_DISPLAY,
  RECEIVER_TRACK_BINDING,
  createReceiverPasses,
  positionAt,
  relinked,
  showsReceiverPass,
} from './receiverPass.js';
import { LINK_BINDING, pulseRadiusM } from './rfStyle.js';
import { displayMsAt, isDisplayClock, pausedAt } from './displayClock.js';
import {
  DRONE_DISPLAY_FACT,
  UAS_TRACK_BINDING,
  sharedUasTracks,
  showsUasTrack,
} from './uasTrack.js';
import { createDroneView, droneDrawn } from './droneView.js';
import { followDrone, linkEdgeEntity, pathOwner } from './linkView.js';
import { sharedUasSites } from './uasSites.js';
import { runRegionOf } from './regionScene.js';
export * from './adapter.js';
export * from './controller.js';
export * from './demand.js';
export * from './selection.js';
export * from './receiverPass.js';
export * from './uasTrack.js';
export * from './displayClock.js';
export * from './regionScene.js';
export * from './source.js';
export * from './view.js';

export const WORLD_MODEL_LAYER_ID = 'world-model';

const OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.7);
const LABEL_OFFSET = new Cesium.Cartesian2(12, 0);

/** Run chips a simulated product row shows at most (newest first). */
const MAX_RUN_CHIPS = 4;

/** A paused display clock at a query time; none without one (GEN-395). */
function clockAt(validAt) {
  const ms = Date.parse(validAt ?? '');
  return Number.isFinite(ms) ? pausedAt(ms, performance.now()) : null;
}

/** `sim/sha256:3d9ea495…` -> `3d9ea495`. */
function runLabel(head) {
  return head
    .slice(SIM_HEAD_PREFIX.length)
    .replace(/^sha256:/, '')
    .slice(0, 8);
}

/**
 * The world-model layer: camera demand -> ordered, cancellable projections
 * of ONE revision (live head or a pin) drawn as Cesium graphics, with Gods
 * Eye's lifecycle, picking, params/chips and health presentation.
 *
 * Responsibility ends at demand -> Projection JSON -> geometry. The layer
 * does not fetch providers, interpret OpenSky/GRIB, own the camera, or know
 * how the projection was transported (any ProjectionSource works). The
 * `controller` is an adapter proving the DWM-9 interaction semantics; it is
 * not a library another consumer must import. Numbers stay authoritative:
 * positions come straight from `position`; the only additions are display
 * choices listed in `DISPLAY_CHOICES`.
 */
export function createWorldModelLayer({
  source,
  services,
  overlayHost,
  screenSpaceEventHandlerFactory,
  id = WORLD_MODEL_LAYER_ID,
  name = 'World Model',
  icon = '🌐',
  sourceLabel = 'Dataforge World Model',
  updateInterval = 30_000,
  debounceMs = 300,
  head = HEAD,
  displayAssumptions = DEFAULT_DISPLAY_ASSUMPTIONS,
  predicates = DEFAULT_PREDICATES,
  modalities = null,
  layers = null,
  validAt = null,
  simulatedBinding = null,
  panelSection = null,
  policyThresholdSeconds = 30,
  now = () => Date.now(),
} = {}) {
  assertProjectionSource(source);
  if (!services?.context || !services?.picking) {
    throw new TypeError(
      'World model layer requires context and picking services',
    );
  }
  if (!overlayHost)
    throw new TypeError('World model layer requires an overlay host');
  if (typeof screenSpaceEventHandlerFactory !== 'function') {
    throw new TypeError(
      'World model layer requires a screen-space event handler factory',
    );
  }
  const features = sourceFeatures(source);

  const state = {
    viewer: null,
    dataSource: null,
    enabled: false,
    revisionId: null,
    summary: null,
    perBinding: [],
    skipped: [],
    byId: new Map(), // projection item id -> { entity, render, cartesian }
    count: 0,
    lastUpdate: null,
    rendered: false,
    selectedId: null,
    clickHandler: null,
    keyHandler: null,
    cameraRemovers: [],
    prevPercentageChanged: null,
    rowControlsListener: null,
    policyThresholdSeconds,
    simRuns: [],
    passSource: null,
    passes: [],
    passRevisionId: null,
    legends: [], // colour legends of the rendered fields (GEN-307)
    headers: {}, // binding -> descriptor semantic.metadata, from the projection (GEN-312, DWM-229)
    // GEN-395: where drawn things are between stored epochs; the run player drives it.
    displayClock: clockAt(validAt),
    displayFrame: { frame: null, ms: null },
    droneRevisionId: null,
  };
  // Shared with every other row on this source: a run head is read once per world.
  const simulationRuns = sharedSimulationRuns(source);
  const receiverPasses = createReceiverPasses(source);
  const uasTracks = sharedUasTracks(source);
  const uasSites = sharedUasSites(source);
  const drones = createDroneView({
    id,
    source,
    displayMs,
    onFollowChange: () => notifyRowControls(),
  });
  const controller = createWorldViewController({
    source,
    initial: {
      head,
      displayAssumptions: { ...displayAssumptions },
      predicates: predicates ? { ...predicates } : null,
      modalities: modalities ? [...modalities] : null,
      layers: layers ? [...layers] : null,
      validAt,
    },
    debounceMs,
    now,
  });
  // A click on a drawn path's line or edge marker opens its item's card (GEN-405).
  state.pickAlias = (pickedId) => {
    const owner = drones.itemForPick(pickedId) ?? pathOwner(pickedId);
    return owner && state.byId.has(owner) ? owner : null;
  };
  const selection = createSelection({
    state,
    services,
    overlayHost,
    screenSpaceEventHandlerFactory,
    source,
    config: { id, name, sourceLabel },
  });

  /**
   * A simulated product layer (DWM-189): one chip per run holding the
   * product, the active one lit, and two that step the query time. There is
   * no live world to leave to -- the product only exists inside runs.
   */
  function productRunChips(demand) {
    const runs = state.simRuns.filter((run) =>
      run.bindings.includes(simulatedBinding),
    );
    const chips = runs.slice(0, MAX_RUN_CHIPS).map((run) => ({
      id: `run-${run.head}`,
      label: `RUN ${runLabel(run.head)}`,
      active: run.head === demand.head,
      state: run.head === demand.head ? 'active' : 'idle',
      title: `Simulated run ${run.head}, ${run.earliest} – ${run.latest}: values at stored epochs only; a drawn drone moves between them as display interpolation`,
      params: viewRunParams(run),
    }));
    const run = runs.find((r) => r.head === demand.head);
    if (run) chips.push(...stepChips(run, demand.validAt || run.earliest));
    return chips;
  }

  function stepChips(run, at) {
    return [
      ['sim-back', `−${STEP_SECONDS / 60}m`, -STEP_SECONDS],
      ['sim-forward', `+${STEP_SECONDS / 60}m`, STEP_SECONDS],
    ].map(([chipId, label, seconds]) => ({
      id: chipId,
      label,
      active: false,
      state: 'idle',
      title: `Query time ${seconds > 0 ? 'forward' : 'back'} ${Math.abs(seconds)} s within ${run.earliest} – ${run.latest}`,
      params: stepRunParams(run, at, seconds),
    }));
  }

  /** SIM RUNS n to enter the newest run; inside one, its chip leaves and two step the query time. */
  function simulationRunChips(demand) {
    if (!demand.head.startsWith(SIM_HEAD_PREFIX)) {
      const [newest] = state.simRuns;
      return newest
        ? [
            {
              id: 'sim-view',
              label: `SIM RUNS ${state.simRuns.length}`,
              active: false,
              state: 'idle',
              title: `Simulated runs on ${state.simRuns.map((r) => r.head).join(', ')} — click to view the newest at its first epoch`,
              params: viewRunParams(newest),
            },
          ]
        : [];
    }
    const run = state.simRuns.find((r) => r.head === demand.head);
    const at = demand.validAt || run?.earliest || '';
    const chips = [
      {
        id: 'sim-leave',
        label: `SIM ${demand.head
          .slice(SIM_HEAD_PREFIX.length)
          .replace(/^sha256:/, '')
          .slice(0, 8)} @ ${at.slice(11, 19)}Z`,
        active: true,
        state: 'active',
        title: `Viewing simulated run ${demand.head} at ${at}: values at stored epochs only; a drawn drone moves between them as display interpolation — click to return to ${head}`,
        params: leaveRunParams(head),
      },
    ];
    if (run) chips.push(...stepChips(run, at));
    return chips;
  }

  function notifyRowControls() {
    try {
      state.rowControlsListener?.();
    } catch (error) {
      console.warn('[Data:WorldModel] row-controls listener failed:', error);
    }
  }

  function resetRendered() {
    state.byId = new Map();
    state.legends = [];
    state.revisionId = null;
    state.headers = {};
    state.summary = null;
    state.perBinding = [];
    state.skipped = [];
    state.count = 0;
    state.lastUpdate = null;
    state.rendered = false;
    state.selectedId = null;
  }

  /** GEN-311: a projected line (an RF link) as a straight line-of-sight polyline. */
  function lineGraphics(render) {
    const color = new Cesium.Color(...render.colorRgb, render.display.alpha);
    return {
      positions: render.positions.map((p) =>
        Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
      ),
      width: render.display.widthPx,
      // A radio path is a chord through space, not a great-circle arc.
      arcType: Cesium.ArcType.NONE,
      material: render.display.dashed
        ? new Cesium.PolylineDashMaterialProperty({ color, dashLength: 12 })
        : color,
    };
  }

  /** GEN-311: the jammer site's label and, while active, a pulsing ring. */
  function emitterGraphics(render) {
    const display = render.display;
    const graphics = {
      label: {
        text: render.label,
        font: '12px sans-serif',
        fillColor: new Cesium.Color(...render.colorRgb, display.alpha),
        outlineColor: OUTLINE_COLOR,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    };
    if (display.pulse) {
      // Display-only: the radius is wall-clock animation, not a range. Both
      // axes read ONE value per frame: two clock reads a moment apart made
      // the minor axis exceed the major one, which Cesium refuses.
      let frame = -1;
      let radiusM = display.pulse.minRadiusM;
      const radius = new Cesium.CallbackProperty(() => {
        const current = state.viewer?.scene?.frameState?.frameNumber ?? 0;
        if (current !== frame) {
          frame = current;
          radiusM = pulseRadiusM(display, performance.now() / 1000);
        }
        return radiusM;
      }, false);
      graphics.ellipse = {
        semiMajorAxis: radius,
        semiMinorAxis: radius,
        height: render.height,
        fill: false,
        outline: true,
        outlineColor: new Cesium.Color(...render.colorRgb, 0.8),
        outlineWidth: 2,
      };
    }
    return graphics;
  }

  function buildEntity(render, revisionId) {
    const cartesian = Cesium.Cartesian3.fromDegrees(
      render.longitude,
      render.latitude,
      render.height,
    );
    if (render.kind === 'line') {
      const entity = new Cesium.Entity({
        id: render.id,
        name: `${render.id} · ${render.label}`,
        position: cartesian,
        polyline: lineGraphics(render),
        properties: {
          kind: render.kind,
          binding: render.binding,
          revision_id: revisionId,
          display: render.display,
          record: render.record,
        },
      });
      return { entity, render, cartesian };
    }
    const isSample = render.kind === 'field-sample';
    const point = isSample
      ? {
          pixelSize: render.display.pixelSize,
          color: new Cesium.Color(...render.colorRgb, 0.95),
          outlineWidth: render.display.outline ? 1 : 0,
          scaleByDistance: new Cesium.NearFarScalar(
            ...render.display.scaleByDistance,
          ),
          // Display-only (DISPLAY_CHOICES['field-sample']): the sample is a
          // pressure-level map annotation at height 0, so keep it on the
          // ground and visible through terrain up close -- and behind the
          // Earth from space. Its numbers are untouched.
          // A height plane (GEN-307) stays at its own height.
          ...(render.display.clampToGround
            ? { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }
            : {}),
          disableDepthTestDistance: render.display.depthTestBeyondM,
        }
      : {
          pixelSize: render.display.pixelSize,
          color: new Cesium.Color(...render.colorRgb, render.display.alpha),
          outlineColor: OUTLINE_COLOR,
          outlineWidth: 1,
          // A 2-D point (the representation declares no height) sits on the
          // terrain, not at ellipsoid height 0 under it.
          ...(render.surface
            ? {
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              }
            : {}),
        };
    const entity = new Cesium.Entity({
      id: render.id,
      name: render.id,
      position: cartesian,
      point,
      ...(render.display.kind === 'emitter' ? emitterGraphics(render) : {}),
      properties: {
        kind: render.kind,
        binding: render.binding,
        revision_id: revisionId,
        display: render.display,
        record: render.record,
      },
    });
    return { entity, render, cartesian };
  }

  /**
   * GEN-309: the run's whole receiver pass under the marker, one polyline per
   * stretch of one state, at the track's own heights. Replaced only when the
   * revision changes; stepping the query time moves the marker along it.
   */
  function drawPasses(passes) {
    const entities = state.passSource?.entities;
    if (!entities) return;
    // Removed outside the batch: see applyProjection.
    entities.removeAll();
    entities.suspendEvents();
    for (const pass of passes) {
      pass.segments.forEach((segment, index) => {
        entities.add(
          new Cesium.Entity({
            id: `${pass.id}/${index}`,
            name: `${pass.label} · ${segment.name} ${segment.from} – ${segment.until}`,
            polyline: {
              positions: segment.positions.map((p) =>
                Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
              ),
              width: PASS_DISPLAY.widthPx,
              material: new Cesium.Color(
                ...segment.colorRgb,
                PASS_DISPLAY.alpha,
              ),
              arcType: Cesium.ArcType.NONE,
            },
            properties: { kind: PASS_DISPLAY.kind, display: PASS_DISPLAY },
          }),
        );
      });
    }
    entities.resumeEvents();
    state.passes = passes;
    labelPassMarkers();
  }

  /** The current instant's marker on a pass carries the receiver's name. */
  function labelPassMarkers() {
    for (const { entity, render } of state.byId.values()) {
      if (render.binding !== RECEIVER_TRACK_BINDING) continue;
      const identity = render.record?.semantic_ref?.semantic_identity;
      const pass = state.passes.find((p) => p.identity === identity);
      const revisionId = state.revisionId;
      entity.label = pass
        ? new Cesium.LabelGraphics({
            show: new Cesium.CallbackProperty(
              () => !droneDrawn(source, revisionId, identity),
              false,
            ),
            text: pass.label,
            font: '13px sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: OUTLINE_COLOR,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: LABEL_OFFSET,
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
          })
        : undefined;
    }
  }

  /**
   * The display time (GEN-395), read once per rendered frame so a model, its
   * label, its card and the follow camera agree within a frame, and clamped
   * to `range`. Without a clock it is the query time; null with neither.
   */
  function displayMs(range) {
    const frame = state.viewer?.scene?.frameState?.frameNumber;
    let ms;
    if (frame !== undefined && state.displayFrame.frame === frame) {
      ms = state.displayFrame.ms;
    } else {
      ms = state.displayClock
        ? displayMsAt(state.displayClock, performance.now())
        : Date.parse(controller.getDemand().validAt ?? '');
      if (frame !== undefined) state.displayFrame = { frame, ms };
    }
    if (!Number.isFinite(ms)) return null;
    if (Number.isFinite(range?.end)) ms = Math.min(range.end, ms);
    if (Number.isFinite(range?.start)) ms = Math.max(range.start, ms);
    return ms;
  }

  function useDisplayClock(clock) {
    state.displayClock = clock;
    state.displayFrame = { frame: null, ms: null };
  }

  /**
   * Bind each run receiver's marker, and the receiver end of every link drawn
   * to it, to the display time along its pass: a step moves them at once,
   * before World Model answers, and while the run plays they move between
   * stored epochs with the drone (GEN-395, display interpolation only). The
   * projection replaces the entities, so this runs after each one and when
   * the pass lands. The marker's card, colour and label stay the projection's.
   */
  function placeReceivers() {
    // A pass read for another revision (the previous run) must not move this one's receiver.
    if (!state.passes.length) return;
    if (state.passRevisionId !== state.revisionId) return;
    const bound = [];
    for (const entry of state.byId.values()) {
      if (entry.render.binding !== RECEIVER_TRACK_BINDING) continue;
      const identity = entry.render.record?.semantic_ref?.semantic_identity;
      const pass = state.passes.find((p) => p.identity === identity);
      if (!pass?.track?.length) continue;
      const range = { start: pass.track[0].at, end: pass.track.at(-1).at };
      const from = {
        lon: entry.render.longitude,
        lat: entry.render.latitude,
        height: entry.render.height,
      };
      let lastMs = null;
      let to = from;
      let cartesian = entry.cartesian;
      const at = () => {
        const ms = displayMs(range);
        if (ms !== lastMs) {
          lastMs = ms;
          to = (Number.isFinite(ms) && positionAt(pass.track, ms)) || from;
          cartesian = Cesium.Cartesian3.fromDegrees(to.lon, to.lat, to.height);
        }
        return { to, cartesian };
      };
      entry.entity.position = new Cesium.CallbackProperty(
        () => at().cartesian,
        false,
      );
      entry.anchor = () => at().cartesian;
      // A drawn drone carries this receiver; its marker gives way to the model.
      const revisionId = state.revisionId;
      if (entry.entity.point)
        entry.entity.point.show = new Cesium.CallbackProperty(
          () => !droneDrawn(source, revisionId, identity),
          false,
        );
      bound.push({ from, at });
    }
    if (!bound.length) return;
    for (const entry of state.byId.values()) {
      if (entry.render.binding !== LINK_BINDING || !entry.entity.polyline)
        continue;
      const positions = entry.render.positions;
      const link = bound.find(({ from }) => relinked(positions, from, from));
      if (!link) continue;
      let lastTo = null;
      let drawn = null;
      entry.entity.polyline.positions = new Cesium.CallbackProperty(() => {
        const { to } = link.at();
        if (to !== lastTo) {
          lastTo = to;
          drawn = relinked(positions, link.from, to).map((p) =>
            Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
          );
        }
        return drawn;
      }, false);
    }
  }

  /** The projected dot of a drawn drone gives way to its model; its card follows the model. */
  function yieldDroneDots() {
    const drawn = drones.drawnItemIds();
    for (const [itemId, entry] of state.byId) {
      if (!drawn.has(itemId)) continue;
      if (entry.entity.point) entry.entity.point.show = false;
      entry.anchor = drones.anchorFor(itemId);
    }
  }

  function clearDrones() {
    state.droneRevisionId = null;
    drones.clear();
  }

  /** Read (cached per revision) and draw the run's drone for what was just projected (GEN-395). */
  async function refreshDrones(revisionId) {
    if (!features.select || !showsUasTrack(controller.getDemand())) {
      clearDrones();
      return;
    }
    if (state.droneRevisionId === revisionId) {
      yieldDroneDots();
      return;
    }
    state.droneRevisionId = revisionId;
    try {
      const tracks = await uasTracks.read({ revisionId });
      // The C2 path's GCS end (GEN-405); a run without sites draws no path.
      const first = tracks.find((t) => t.rows.length)?.rows[0]?.validTime;
      const sites = await uasSites
        .read({ revisionId, validAt: first })
        .catch((error) => {
          console.warn('[Data:WorldModel] run sites unreadable:', error);
          return new Map();
        });
      if (state.droneRevisionId !== revisionId || !state.enabled) return;
      drones.draw(tracks, { revisionId, sites });
      yieldDroneDots();
      selection.reselect();
      notifyRowControls();
    } catch (error) {
      if (state.droneRevisionId === revisionId) state.droneRevisionId = null;
      console.warn('[Data:WorldModel] drone track unreadable:', error);
    }
  }

  /**
   * A jammer's path to a drone follows the drawn drone between stored epochs
   * (GEN-405), as the drone does; its colour and card stay the projection's.
   * The track is the run's, read once per revision and shared.
   */
  async function followLinks(revisionId) {
    const links = [...state.byId.values()].filter(
      (e) =>
        e.render.binding === LINK_BINDING &&
        e.entity.polyline &&
        typeof e.render.record?.properties?.receiver === 'string',
    );
    if (!links.length || !features.select) return;
    let tracks;
    try {
      tracks = await uasTracks.read({ revisionId });
    } catch (error) {
      console.warn('[Data:WorldModel] drone track unreadable:', error);
      return;
    }
    if (state.revisionId !== revisionId || !state.enabled) return;
    const byIdentity = new Map(
      tracks.filter((t) => t.rows.length >= 2).map((t) => [t.identity, t]),
    );
    for (const entry of links) {
      if (state.byId.get(entry.render.id) !== entry) continue; // a newer projection
      const track = byIdentity.get(entry.render.record.properties.receiver);
      if (track)
        entry.anchor = followDrone(
          entry.entity,
          entry.render,
          track,
          displayMs,
        );
    }
  }

  function clearPasses() {
    state.passRevisionId = null;
    if (state.passes.length || state.passSource?.entities.values.length)
      drawPasses([]);
  }

  /** Read (cached per revision) and draw the pass for what was just projected. */
  async function refreshPasses(revisionId) {
    if (!features.select || !showsReceiverPass(controller.getDemand())) {
      clearPasses();
      return;
    }
    if (state.passRevisionId === revisionId) {
      labelPassMarkers();
      return;
    }
    state.passRevisionId = revisionId;
    try {
      const passes = await receiverPasses.read({ revisionId });
      // A newer projection (or leaving the run) superseded this read.
      if (state.passRevisionId !== revisionId || !state.enabled) return;
      drawPasses(passes);
      placeReceivers();
      // The pass names the receiver; a card already open takes the name.
      selection.reselect();
    } catch (error) {
      if (state.passRevisionId === revisionId) state.passRevisionId = null;
      console.warn('[Data:WorldModel] receiver pass unreadable:', error);
    }
  }

  /** Only the controller's apply callback reaches here: ordering is decided there. */
  function applyProjection(projection) {
    if (!state.enabled || !state.dataSource) return;
    const points = pointRecordsFromProjection(projection);
    const samples = fieldSampleRecordsFromProjection(projection);
    const lines = lineRecordsFromProjection(projection);
    const rendered = [...points.records, ...samples.records, ...lines.records];
    const byId = new Map();
    for (const render of rendered) {
      byId.set(render.id, buildEntity(render, projection.revision_id));
    }
    const entities = state.dataSource.entities;
    // Remove outside the batch: Cesium folds a remove and an add of the same
    // id inside one suspended batch into no event at all, so the visualizers
    // kept drawing the previous entity and a step never moved the marker.
    entities.removeAll();
    entities.suspendEvents();
    for (const entry of byId.values()) {
      entities.add(entry.entity);
      // An obstructed RF path marks its main edge (GEN-405).
      const edge = linkEdgeEntity(entry.render);
      if (edge) entities.add(edge);
    }
    entities.resumeEvents();

    state.byId = byId;
    state.revisionId = projection.revision_id;
    // GEN-312: a receiver card names its state and reason from its product's
    // legend, which the projection carries per binding (DWM-229).
    state.headers = projection.semantic_metadata ?? {};
    state.summary = summarizeProjection(projection);
    state.perBinding = countByBinding(rendered);
    state.legends = fieldLegends(rendered);
    state.skipped = [...points.skipped, ...samples.skipped, ...lines.skipped];
    state.count = byId.size;
    state.lastUpdate = now();
    state.rendered = true;
    // Steps taken since this projection was issued are already on screen.
    placeReceivers();
    yieldDroneDots();
    void followLinks(projection.revision_id);
    selection.refreshContextRegistrations();
    selection.reselect();
    refreshPasses(projection.revision_id);
    refreshDrones(projection.revision_id);
    console.log(
      `[Data:WorldModel] Rendered revision ${projection.revision_id.slice(0, 8)}: ` +
        (state.perBinding
          .map(
            (b) =>
              `${b.binding} ${[
                b.points ? `${b.points} points` : '',
                b.samples ? `${b.samples} samples` : '',
                b.lines ? `${b.lines} lines` : '',
              ]
                .filter(Boolean)
                .join(' + ')}`,
          )
          .join(', ') || 'nothing') +
        (state.summary.withheld
          ? `, ${state.summary.withheld} withheld by policy`
          : '') +
        (state.skipped.length ? `, ${state.skipped.length} skipped` : ''),
    );
    notifyRowControls();
  }
  controller.onProjection(applyProjection);

  function cameraRectangle() {
    const camera = state.viewer?.camera;
    if (!camera || typeof camera.computeViewRectangle !== 'function')
      return undefined;
    const rect = camera.computeViewRectangle(
      state.viewer.scene?.globe?.ellipsoid,
    );
    if (!rect) return undefined; // horizon in view: no honest rectangle
    return {
      west: Cesium.Math.toDegrees(rect.west),
      south: Cesium.Math.toDegrees(rect.south),
      east: Cesium.Math.toDegrees(rect.east),
      north: Cesium.Math.toDegrees(rect.north),
    };
  }

  function onCameraChanged() {
    if (!state.enabled) return;
    controller.setViewport(demandBbox(cameraRectangle()));
  }

  function subscribeCamera(viewer) {
    const camera = viewer?.camera;
    if (!camera?.changed?.addEventListener) return;
    camera.changed.addEventListener(onCameraChanged);
    state.cameraRemovers.push(() =>
      camera.changed.removeEventListener(onCameraChanged),
    );
    if (camera.moveEnd?.addEventListener) {
      const remove = camera.moveEnd.addEventListener(onCameraChanged);
      state.cameraRemovers.push(
        typeof remove === 'function'
          ? remove
          : () => camera.moveEnd.removeEventListener(onCameraChanged),
      );
    }
    // percentageChanged is a shared global on the camera: save it so disable
    // restores the sensitivity every other camera.changed listener expects.
    state.prevPercentageChanged = camera.percentageChanged;
    camera.percentageChanged = 0.05;
  }

  function unsubscribeCamera(viewer) {
    for (const remove of state.cameraRemovers) {
      try {
        remove();
      } catch {
        // already released
      }
    }
    state.cameraRemovers = [];
    const camera = viewer?.camera;
    if (camera && state.prevPercentageChanged != null) {
      camera.percentageChanged = state.prevPercentageChanged;
    }
    state.prevPercentageChanged = null;
  }

  function statusLines(status) {
    const lines = [];
    for (const binding of status?.bindings || []) {
      // A product layer reports its own binding, not the whole world's.
      if (layers && !layers.includes(binding.binding)) continue;
      const valid = binding.valid || {};
      const known = binding.knowledge || {};
      const sources = (binding.sources || [])
        .map(
          (s) =>
            `${s.connector_instance_id || '?'} ${s.state || 'unknown'}${s.last_checkpoint_at ? ` · checkpoint ${s.last_checkpoint_at}` : ''} · ${s.receipt_count ?? '?'} receipts`,
        )
        .join('; ');
      const run = (binding.processing || [])[0];
      lines.push({
        binding: binding.binding,
        source: `source: ${sources || 'no retained source reached'}`,
        processing: run
          ? `processing: ${run.pipeline || '?'} ${run.status || '?'}${run.error?.message ? ` — ${run.error.message}` : ''}`
          : 'processing: no interpretation run recorded',
        productTime: `product time: valid ${valid.kind || '?'} to ${valid.latest || '?'} (${formatAge(valid.offset_seconds)} before now) · known ${formatAge(known.age_seconds)} ago · ${binding.admission || '?'}`,
      });
    }
    return lines;
  }

  /**
   * The same facts in the panel's generic shape (`stats.facts`): one group
   * per binding, labelled by the binding, three lines. The Data Layers row
   * prints these verbatim without knowing this layer.
   */
  function statusFacts(status) {
    return statusLines(status).map((line) => ({
      label: line.binding,
      lines: [line.source, line.processing, line.productTime],
    }));
  }

  /**
   * The card's facts: the status lines (when the source serves status) and,
   * per binding, what the backplane withheld for a grant this view did not
   * send -- one line per grant, so the card says what it cannot draw and
   * why instead of drawing nothing (DWM-208).
   */
  function cardFacts(view) {
    const groups = features.status ? statusFacts(view.status) : [];
    for (const o of state.summary?.ungranted || []) {
      if (layers && !layers.includes(o.binding)) continue;
      const lines = o.grants.map((g) => `withheld ${o.count}: needs ${g}`);
      const group = groups.find((g) => g.label === o.binding);
      if (group) group.lines.push(...lines);
      else groups.push({ label: o.binding, lines });
    }
    // GEN-395: the drawn drone's motion is a display assumption, said where the row's facts are.
    if (drones.hasDrone() || drones.reasons().length) {
      const lines = [
        ...(drones.hasDrone() ? [DRONE_DISPLAY_FACT] : []),
        ...drones.reasons().map((reason) => `no model drawn: ${reason}`),
      ];
      const group = groups.find((g) => g.label === UAS_TRACK_BINDING);
      if (group) group.lines.push(...lines);
      else groups.push({ label: UAS_TRACK_BINDING, lines });
    }
    for (const legend of state.legends) {
      if (layers && !layers.includes(legend.label)) continue;
      const group = groups.find((g) => g.label === legend.label);
      if (group) group.lines.push(...legend.lines);
      else groups.push({ label: legend.label, lines: [...legend.lines] });
    }
    return features.status || groups.length ? groups : null;
  }

  const layer = {
    id,
    name,
    icon,
    panelSection,
    source: sourceLabel,
    updateInterval,
    controller,

    init(viewer) {
      if (state.viewer)
        throw new Error('World model layer is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource(id);
      state.dataSource.show = false;
      viewer.dataSources.add(state.dataSource);
      state.passSource = new Cesium.CustomDataSource(`${id}-pass`);
      state.passSource.show = false;
      viewer.dataSources.add(state.passSource);
      drones.init(viewer);
      resetRendered();
      state.enabled = false;
      overlayHost.setVisible(id, false);
      console.log('[Data:WorldModel] Initialized');
    },

    enable(viewer = state.viewer) {
      state.enabled = true;
      if (state.dataSource) state.dataSource.show = true;
      if (state.passSource) state.passSource.show = true;
      drones.show(true);
      selection.installClickHandler();
      services.picking.registerPickOwner(id, (pickedId) =>
        state.byId.has(pickedId),
      );
      overlayHost.setVisible(id, true);
      subscribeCamera(viewer);
      onCameraChanged();
    },

    disable(viewer = state.viewer) {
      controller.cancel();
      state.enabled = false;
      unsubscribeCamera(viewer);
      if (state.dataSource) state.dataSource.show = false;
      if (state.passSource) state.passSource.show = false;
      drones.show(false);
      selection.clearSelection();
      selection.removeClickHandler();
      services.picking.unregisterPickOwner(id);
      overlayHost.clearSource(id);
      overlayHost.setVisible(id, false);
    },

    /**
     * The host's clock tick: read the chain (+ status), LIVE re-projects the
     * current demand by the newest revision id, PINNED only refreshes facts.
     * Errors keep the previous geometry and surface through getStats();
     * returning false would reject the lifecycle instead of presenting the
     * failure, so only a disabled layer returns false.
     */
    async update(viewer, { signal } = {}) {
      if (!state.enabled || !state.dataSource) return false;
      const completed = await controller.tick({ signal });
      try {
        state.simRuns = await simulationRuns.read({ signal });
      } catch (error) {
        if (!signal?.aborted)
          console.warn('[Data:WorldModel] simulated runs unreadable:', error);
      }
      const view = controller.getState();
      if (completed && view.error && !view.loading)
        console.warn('[Data:WorldModel] Refresh error:', view.error);
      notifyRowControls();
      return state.enabled && completed;
    },

    destroy(viewer = state.viewer) {
      controller.stop();
      state.enabled = false;
      unsubscribeCamera(viewer);
      selection.clearSelection();
      selection.removeClickHandler();
      services.picking.unregisterPickOwner(id);
      overlayHost.clearSource(id);
      overlayHost.setVisible(id, false);
      try {
        services.context.removeEntityContextsForLayer(id);
      } catch {
        // context store unavailable
      }
      if (state.dataSource && viewer) {
        viewer.dataSources.remove(state.dataSource, true);
      }
      if (state.passSource && viewer) {
        viewer.dataSources.remove(state.passSource, true);
      }
      drones.destroy();
      state.dataSource = null;
      state.passSource = null;
      state.passes = [];
      state.passRevisionId = null;
      state.droneRevisionId = null;
      state.viewer = null;
      resetRendered();
    },

    /**
     * Runtime params (DataLayerManager.setLayerParams path). Plain data in,
     * a boolean out; every value is validated before anything changes.
     * @param {{head?: string, modalities?: string[]|null, follow?: 'live'|'pinned', revisionId?: string|null, layers?: string[]|null,
     *   validAt?: string|null, knownAsOf?: string|null, policy?: 'off'|'mark'|'withhold',
     *   policyThresholdSeconds?: number, bbox?: number[]|null}} [params]
     */
    setParams(params = {}) {
      if (
        params.head !== undefined &&
        (typeof params.head !== 'string' || !params.head.trim())
      )
        return false;
      if (
        params.modalities !== undefined &&
        params.modalities !== null &&
        (!Array.isArray(params.modalities) ||
          params.modalities.some(
            (modality) => typeof modality !== 'string' || !modality.trim(),
          ))
      )
        return false;
      if (params.follow !== undefined && !FOLLOW_MODES.includes(params.follow))
        return false;
      if (params.policy !== undefined && !POLICY_MODES.includes(params.policy))
        return false;
      if (
        params.policyThresholdSeconds !== undefined &&
        !(Number(params.policyThresholdSeconds) >= 0)
      )
        return false;
      if (
        params.layers !== undefined &&
        params.layers !== null &&
        !Array.isArray(params.layers)
      )
        return false;
      if (params.policyThresholdSeconds !== undefined)
        state.policyThresholdSeconds = Number(params.policyThresholdSeconds);
      if (params.head !== undefined) {
        controller.setWorld(params.head.trim());
        // setWorld drops the binding filter, which is right for the generic
        // layer; a product row's binding is its identity, so it survives a
        // move to another run. Lost, every row drew the whole run and one
        // click selected the same item in two of them (DWM-210).
        if (layers && params.layers === undefined) controller.setLayers(layers);
        if (!showsReceiverPass(controller.getDemand())) clearPasses();
        if (!showsUasTrack(controller.getDemand())) clearDrones();
      }
      if (params.modalities !== undefined)
        controller.setModalities(params.modalities);
      if (params.layers !== undefined) controller.setLayers(params.layers);
      if (params.validAt !== undefined || params.knownAsOf !== undefined) {
        const demand = controller.getDemand();
        controller.setQueryTime(
          params.validAt !== undefined ? params.validAt : demand.validAt,
          params.knownAsOf !== undefined ? params.knownAsOf : demand.knownAsOf,
        );
        // A step puts drawn things at the stored epoch; the run player, if
        // playing, sets its running clock right after (GEN-395).
        if (params.validAt !== undefined)
          useDisplayClock(clockAt(params.validAt));
      }
      if (params.bbox !== undefined)
        controller.setViewport(demandBbox(params.bbox));
      if (
        params.policy !== undefined ||
        params.policyThresholdSeconds !== undefined
      ) {
        const mode = params.policy ?? policyModeOf(controller.getDemand());
        controller.setPolicy(mode, state.policyThresholdSeconds);
      }
      if (params.follow === 'pinned') {
        if (!controller.pin(params.revisionId || undefined)) return false;
      } else if (params.follow === 'live') {
        controller.followLive();
      }
      notifyRowControls();
      return true;
    },

    getParams() {
      const demand = controller.getDemand();
      return {
        head: demand.head,
        modalities: demand.modalities ? [...demand.modalities] : null,
        follow: demand.follow,
        revisionId: demand.pinnedRevisionId,
        layers: demand.layers ? [...demand.layers] : null,
        validAt: demand.validAt,
        knownAsOf: demand.knownAsOf,
        policy: policyModeOf(demand),
        policyThresholdSeconds: state.policyThresholdSeconds,
      };
    },

    /**
     * Row chips (DataLayerManager row-controls contract): LIVE/PINNED, go
     * live when the head moved past the pin, the temporal-age policy. Each
     * chip declares the params to apply; the manager owns the write.
     */
    getRowControls() {
      const view = controller.getState();
      // A product layer is one binding at the head: a simulated one picks
      // and steps its runs; an observed or planned one has nothing to choose.
      if (simulatedBinding)
        return { chips: productRunChips(view.demand), legend: [] };
      if (layers) return { chips: [], legend: [] };
      const pinned = view.follow === 'pinned';
      const policy = policyModeOf(view.demand);
      const nextPolicy =
        POLICY_MODES[(POLICY_MODES.indexOf(policy) + 1) % POLICY_MODES.length];
      const chips = [
        {
          id: 'follow',
          label: pinned
            ? `PINNED ${(view.demand.pinnedRevisionId || '').slice(0, 8)}`
            : 'LIVE',
          active: pinned,
          state: pinned ? 'active' : 'idle',
          title: pinned
            ? 'Pinned to one revision, query time and policy — click to follow the head live'
            : 'Following the head live (wall-clock query time) — click to pin the revision on screen',
          params: pinned
            ? { follow: 'live' }
            : {
                follow: 'pinned',
                revisionId: view.displayedRevisionId || view.headRevisionId,
              },
        },
      ];
      if (pinned && view.headAdvanced) {
        chips.push({
          id: 'go-live',
          label: 'HEAD MOVED',
          active: false,
          state: 'idle',
          title: `A newer revision ${(view.headRevisionId || '').slice(0, 8)} exists — click to follow it`,
          params: { follow: 'live' },
        });
      }
      chips.push({
        id: 'policy',
        label:
          policy === 'off'
            ? 'AGE OFF'
            : policy === 'mark'
              ? 'AGE MARK'
              : 'AGE HIDE',
        active: policy !== 'off',
        state: policy !== 'off' ? 'active' : 'idle',
        title: `temporal_age policy (${state.policyThresholdSeconds} s): ${policy} — click for ${nextPolicy}. Applies only where the product declares the capability.`,
        params: { policy: nextPolicy },
      });
      chips.unshift(...simulationRunChips(view.demand));
      return { chips, legend: [] };
    },

    setRowControlsListener(listener) {
      state.rowControlsListener =
        typeof listener === 'function' ? listener : null;
    },

    getStats() {
      const view = controller.getState();
      const request = view.request;
      return {
        count: state.count,
        lastUpdate: state.lastUpdate,
        error: view.error || view.chainError,
        errorCode: view.errorCode || view.chainErrorCode,
        stale: view.stale,
        loading: view.loading || view.pending,
        source: state.revisionId
          ? `${sourceLabel} · rev ${state.revisionId.slice(0, 8)}`
          : sourceLabel,
        mode: view.follow === 'pinned' ? 'PINNED' : 'LIVE',
        revisionId: state.revisionId,
        headRevisionId: view.headRevisionId,
        headAdvanced: view.headAdvanced,
        headAgeSeconds: view.headAgeSeconds,
        spatialScope: request?.query?.spatial_scope ? 'viewport' : 'all',
        bbox: request?.query?.spatial_scope?.bbox ?? null,
        validAt: request?.query?.valid_at ?? null,
        policy: policyModeOf(view.demand),
        counts: state.summary?.counts ?? null,
        perBinding: state.perBinding,
        omissions: state.summary?.omissions.length ?? 0,
        withheld: state.summary?.withheld ?? 0,
        marked: state.summary?.marked ?? 0,
        policies: state.summary?.policies ?? [],
        annotations: state.summary?.annotations ?? [],
        skipped: state.skipped.length,
        // Three separate facts per binding; never combined into a verdict.
        // `facts`, not `status`: the panel reads `status` as its feed-state
        // enum, so an array there was silently dropped (DWM-60).
        facts: cardFacts(view),
        factsError: view.statusError ?? null,
        features,
        requests: view.counters,
      };
    },

    /** Degrees rectangle of the retained Experiment 002 view; the caller owns the camera. */
    getViewRectangle() {
      return viewRectangleDegrees(DEFAULT_VIEW);
    },

    getProjectionSummary() {
      return state.summary;
    },

    /** The receiver passes drawn under the run's markers (GEN-309); [] off a run head. */
    getReceiverPasses() {
      return state.passes;
    },

    /**
     * The run player's display time (GEN-395): drawn geometry follows it
     * between stored epochs; the query time and every value stay on stored
     * epochs. A malformed clock is refused.
     */
    setDisplayClock(clock) {
      if (clock !== null && !isDisplayClock(clock)) return false;
      useDisplayClock(clock);
      return true;
    },

    /** Whether this layer draws a run's drone as a model (GEN-395). */
    hasDrone() {
      return drones.hasDrone();
    },

    /** Follow the drone with the tracking camera, or stop; false when there is none to follow. */
    followDrone(on = true) {
      return drones.follow(!!on);
    },

    following() {
      return drones.following();
    },

    /** The region this layer's products name (`terrain.region`, GEN-403), or null. */
    terrainRegion() {
      return runRegionOf(state.headers);
    },

    getRenderedIds() {
      return [...state.byId.keys()];
    },

    getRenderedRecord(itemId) {
      return state.byId.get(itemId)?.render ?? null;
    },

    getSelectedId() {
      return state.selectedId;
    },

    /** QA/test seam: select by projection id without a canvas click. */
    selectById(itemId) {
      return selection.selectById(itemId);
    },

    clearSelection() {
      selection.clearSelection();
    },

    /** The ProjectionSource this layer reads (the run player selects through it). */
    getProjectionSource() {
      return source;
    },

    describeSource() {
      return typeof source.describe === 'function'
        ? source.describe()
        : { transport: 'custom' };
    },

    /** JSON-safe records for the analyst query engine (on demand only). */
    getAnalystRecords(maxCount = 2000) {
      if (!state.dataSource?.show || !state.byId.size) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const { render } of state.byId.values()) {
        if (result.length >= limit) break;
        const item = render.record;
        result.push({
          id: render.id,
          kind: render.kind,
          binding: render.binding,
          lat: render.latitude,
          lon: render.longitude,
          height_m: render.height,
          revision_id: state.revisionId,
          semantic_identity: item.semantic_ref?.semantic_identity ?? null,
          value: render.kind === 'field-sample' ? render.value : null,
          units: render.kind === 'field-sample' ? render.units : null,
          valid_at: item.time?.valid_at ?? null,
          stale: item.time?.stale ?? null,
        });
      }
      return result;
    },
  };
  return layer;
}
