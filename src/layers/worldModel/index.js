import * as Cesium from 'cesium';
import {
  aircraftRecordsFromProjection,
  summarizeProjection,
  weatherRecordsFromProjection,
} from './adapter.js';
import { createSelection, WORLD_MODEL_OVERLAY_SOURCE_ID } from './selection.js';
import { assertProjectionSource } from './source.js';
import { DEFAULT_VIEW, viewRectangleDegrees } from './view.js';
export * from './adapter.js';
export * from './selection.js';
export * from './source.js';
export * from './view.js';

export const WORLD_MODEL_LAYER_ID = 'world-model';

const AIRCRAFT_COLOR = Cesium.Color.CYAN;
const OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.7);

/**
 * The world-model layer: ONE completed renderer-neutral projection drawn as
 * Cesium graphics, with Gods Eye's lifecycle, picking and health presentation.
 *
 * Responsibility ends at Projection JSON -> geometry. The layer does not
 * fetch providers, interpret OpenSky/GRIB, own the camera, or know how the
 * projection was transported (see `source.js`: any ProjectionSource works).
 * Numbers stay authoritative: positions come straight from `position`, the
 * only additions are display choices listed in `DISPLAY_CHOICES`.
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
  view = DEFAULT_VIEW,
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

  const state = {
    viewer: null,
    dataSource: null,
    enabled: false,
    request: null,
    revisionId: null,
    summary: null,
    skipped: [],
    byId: new Map(), // projection item id -> { entity, render, cartesian }
    count: 0,
    lastUpdate: null,
    error: null,
    errorCode: null,
    stale: false,
    loading: false,
    rendered: false,
    selectedId: null,
    clickHandler: null,
    keyHandler: null,
  };
  const selection = createSelection({
    state,
    services,
    overlayHost,
    screenSpaceEventHandlerFactory,
    config: { id, name, sourceLabel },
  });

  function abortInFlight() {
    state.request?.abort();
    state.request = null;
  }

  function resetRendered() {
    state.byId = new Map();
    state.revisionId = null;
    state.summary = null;
    state.skipped = [];
    state.count = 0;
    state.lastUpdate = null;
    state.error = null;
    state.errorCode = null;
    state.stale = false;
    state.loading = false;
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
          color: AIRCRAFT_COLOR,
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
        revision_id: revisionId,
        display: render.display,
        record: render.record,
      },
    });
    return { entity, render, cartesian };
  }

  function applyProjection(projection) {
    const aircraft = aircraftRecordsFromProjection(projection);
    const weather = weatherRecordsFromProjection(projection);
    const byId = new Map();
    for (const render of [...aircraft.records, ...weather.records]) {
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
    state.skipped = [...aircraft.skipped, ...weather.skipped];
    state.count = byId.size;
    state.lastUpdate = Date.now();
    state.error = null;
    state.errorCode = null;
    state.stale = false;
    state.rendered = true;
    selection.refreshContextRegistrations();
    selection.reselect();
    console.log(
      `[Data:WorldModel] Rendered revision ${projection.revision_id.slice(0, 8)}: ` +
        `${aircraft.records.length} aircraft, ${weather.records.length} field samples` +
        (state.skipped.length ? `, ${state.skipped.length} skipped` : ''),
    );
  }

  const layer = {
    id,
    name,
    icon,
    source: sourceLabel,
    updateInterval,

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

    enable() {
      state.enabled = true;
      if (state.dataSource) state.dataSource.show = true;
      selection.installClickHandler();
      services.picking.registerPickOwner(id, (pickedId) =>
        state.byId.has(pickedId),
      );
      overlayHost.setVisible(WORLD_MODEL_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      abortInFlight();
      state.enabled = false;
      state.loading = false;
      if (state.dataSource) state.dataSource.show = false;
      selection.clearSelection();
      selection.removeClickHandler();
      services.picking.unregisterPickOwner(id);
      overlayHost.clearSource(WORLD_MODEL_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(WORLD_MODEL_OVERLAY_SOURCE_ID, false);
    },

    /**
     * Poll the head; re-project only when the revision changed. Errors keep
     * the previous geometry and surface through getStats() (UNAVAILABLE with
     * no prior data, STALE with it); returning false would reject the
     * lifecycle instead of presenting the failure.
     */
    async update(viewer, { signal } = {}) {
      if (!state.enabled || !state.dataSource) return false;
      abortInFlight();
      const controller = new AbortController();
      state.request = controller;
      if (signal) {
        if (signal.aborted) controller.abort();
        else
          signal.addEventListener('abort', () => controller.abort(), {
            once: true,
          });
      }
      const current = () =>
        !controller.signal.aborted &&
        state.request === controller &&
        state.enabled;
      state.loading = !state.rendered;
      try {
        const revisionId = await source.getHeadRevision({
          signal: controller.signal,
        });
        if (!current()) return false;
        if (state.rendered && revisionId === state.revisionId) {
          state.lastUpdate = Date.now();
          state.error = null;
          state.errorCode = null;
          state.stale = false;
          return true;
        }
        const projection = await source.getProjection({
          revisionId,
          signal: controller.signal,
        });
        if (!current()) return false;
        applyProjection(projection);
        return true;
      } catch (error) {
        if (!current()) return false;
        state.error = error?.message || 'World model unavailable';
        state.errorCode = error?.code || null;
        state.stale = state.rendered;
        console.warn('[Data:WorldModel] Refresh error:', error);
        return true;
      } finally {
        state.loading = false;
        if (state.request === controller) state.request = null;
      }
    },

    destroy(viewer = state.viewer) {
      abortInFlight();
      state.enabled = false;
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

    getStats() {
      return {
        count: state.count,
        lastUpdate: state.lastUpdate,
        error: state.error,
        errorCode: state.errorCode,
        stale: state.stale,
        loading: state.loading,
        source: state.revisionId
          ? `${sourceLabel} · rev ${state.revisionId.slice(0, 8)}`
          : sourceLabel,
        revisionId: state.revisionId,
        counts: state.summary?.counts ?? null,
        omissions: state.summary?.omissions.length ?? 0,
        annotations: state.summary?.annotations ?? [],
        skipped: state.skipped.length,
      };
    },

    /** Degrees rectangle of the requested view; the caller owns the camera. */
    getViewRectangle() {
      return viewRectangleDegrees(view);
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
          lat: render.latitude,
          lon: render.longitude,
          height_m: render.height,
          revision_id: state.revisionId,
          semantic_identity: item.semantic_ref?.semantic_identity ?? null,
          value: render.kind === 'field-sample' ? render.value : null,
          units: render.kind === 'field-sample' ? render.units : null,
          valid_at: item.time?.valid_at ?? null,
        });
      }
      return result;
    },
  };
  return layer;
}
