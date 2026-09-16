import * as Cesium from 'cesium';
import {
  countByBinding,
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
import { createSelection, WORLD_MODEL_OVERLAY_SOURCE_ID } from './selection.js';
import { assertProjectionSource, sourceFeatures } from './source.js';
import {
  DEFAULT_DISPLAY_ASSUMPTIONS,
  DEFAULT_PREDICATES,
  DEFAULT_VIEW,
  HEAD,
  viewRectangleDegrees,
} from './view.js';
export * from './adapter.js';
export * from './controller.js';
export * from './demand.js';
export * from './selection.js';
export * from './source.js';
export * from './view.js';

export const WORLD_MODEL_LAYER_ID = 'world-model';

const OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.7);

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
  };
  const controller = createWorldViewController({
    source,
    initial: {
      head,
      displayAssumptions: { ...displayAssumptions },
      predicates: predicates ? { ...predicates } : null,
      modalities: modalities ? [...modalities] : null,
    },
    debounceMs,
    now,
  });
  const selection = createSelection({
    state,
    services,
    overlayHost,
    screenSpaceEventHandlerFactory,
    source,
    config: { id, name, sourceLabel },
  });

  function notifyRowControls() {
    try {
      state.rowControlsListener?.();
    } catch (error) {
      console.warn('[Data:WorldModel] row-controls listener failed:', error);
    }
  }

  function resetRendered() {
    state.byId = new Map();
    state.revisionId = null;
    state.summary = null;
    state.perBinding = [];
    state.skipped = [];
    state.count = 0;
    state.lastUpdate = null;
    state.rendered = false;
    state.selectedId = null;
  }

  function buildEntity(render, revisionId) {
    const cartesian = Cesium.Cartesian3.fromDegrees(
      render.longitude,
      render.latitude,
      render.height,
    );
    const isSample = render.kind === 'field-sample';
    const point = isSample
      ? {
          pixelSize: render.display.pixelSize,
          color: new Cesium.Color(...render.colorRgb, 0.95),
          outlineColor: OUTLINE_COLOR,
          outlineWidth: 1,
          // Display-only (DISPLAY_CHOICES['field-sample']): the sample is a
          // pressure-level map annotation at height 0, so keep it on the
          // ground and visible through terrain. Its numbers are untouched.
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }
      : {
          pixelSize: render.display.pixelSize,
          color: new Cesium.Color(...render.colorRgb, render.display.alpha),
          outlineColor: OUTLINE_COLOR,
          outlineWidth: 1,
        };
    const entity = new Cesium.Entity({
      id: render.id,
      name: render.id,
      position: cartesian,
      point,
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

  /** Only the controller's apply callback reaches here: ordering is decided there. */
  function applyProjection(projection) {
    if (!state.enabled || !state.dataSource) return;
    const points = pointRecordsFromProjection(projection);
    const samples = fieldSampleRecordsFromProjection(projection);
    const byId = new Map();
    for (const render of [...points.records, ...samples.records]) {
      byId.set(render.id, buildEntity(render, projection.revision_id));
    }
    const entities = state.dataSource.entities;
    entities.suspendEvents();
    entities.removeAll();
    for (const entry of byId.values()) entities.add(entry.entity);
    entities.resumeEvents();

    state.byId = byId;
    state.revisionId = projection.revision_id;
    state.summary = summarizeProjection(projection);
    state.perBinding = countByBinding([...points.records, ...samples.records]);
    state.skipped = [...points.skipped, ...samples.skipped];
    state.count = byId.size;
    state.lastUpdate = now();
    state.rendered = true;
    selection.refreshContextRegistrations();
    selection.reselect();
    console.log(
      `[Data:WorldModel] Rendered revision ${projection.revision_id.slice(0, 8)}: ` +
        (state.perBinding
          .map(
            (b) =>
              `${b.binding} ${b.points ? `${b.points} points` : ''}${b.points && b.samples ? ' + ' : ''}${b.samples ? `${b.samples} samples` : ''}`,
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

  const layer = {
    id,
    name,
    icon,
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
      resetRendered();
      state.enabled = false;
      overlayHost.setVisible(WORLD_MODEL_OVERLAY_SOURCE_ID, false);
      console.log('[Data:WorldModel] Initialized');
    },

    enable(viewer = state.viewer) {
      state.enabled = true;
      if (state.dataSource) state.dataSource.show = true;
      selection.installClickHandler();
      services.picking.registerPickOwner(id, (pickedId) =>
        state.byId.has(pickedId),
      );
      overlayHost.setVisible(WORLD_MODEL_OVERLAY_SOURCE_ID, true);
      subscribeCamera(viewer);
      onCameraChanged();
    },

    disable(viewer = state.viewer) {
      controller.cancel();
      state.enabled = false;
      unsubscribeCamera(viewer);
      if (state.dataSource) state.dataSource.show = false;
      selection.clearSelection();
      selection.removeClickHandler();
      services.picking.unregisterPickOwner(id);
      overlayHost.clearSource(WORLD_MODEL_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(WORLD_MODEL_OVERLAY_SOURCE_ID, false);
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
      overlayHost.clearSource(WORLD_MODEL_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(WORLD_MODEL_OVERLAY_SOURCE_ID, false);
      try {
        services.context.removeEntityContextsForLayer(id);
      } catch {
        // context store unavailable
      }
      if (state.dataSource && viewer) {
        viewer.dataSources.remove(state.dataSource, true);
      }
      state.dataSource = null;
      state.viewer = null;
      resetRendered();
    },

    /**
     * Runtime params (DataLayerManager.setLayerParams path). Plain data in,
     * a boolean out; every value is validated before anything changes.
     * @param {{follow?: 'live'|'pinned', revisionId?: string|null, layers?: string[]|null,
     *   validAt?: string|null, knownAsOf?: string|null, policy?: 'off'|'mark'|'withhold',
     *   policyThresholdSeconds?: number, bbox?: number[]|null}} [params]
     */
    setParams(params = {}) {
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
      if (params.layers !== undefined) controller.setLayers(params.layers);
      if (params.validAt !== undefined || params.knownAsOf !== undefined) {
        const demand = controller.getDemand();
        controller.setQueryTime(
          params.validAt !== undefined ? params.validAt : demand.validAt,
          params.knownAsOf !== undefined ? params.knownAsOf : demand.knownAsOf,
        );
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
        facts: features.status ? statusFacts(view.status) : null,
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
