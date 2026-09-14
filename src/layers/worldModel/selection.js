import * as Cesium from 'cesium';
import {
  contextRecordFor,
  inspectionLines,
  selectionCardLines,
} from './adapter.js';
import { refString, sourceFeatures } from './source.js';

export const WORLD_MODEL_OVERLAY_SOURCE_ID = 'world-model';

/** One protected card at a time; it never competes with ambient labels. */
export const WORLD_MODEL_SELECTED_OVERLAY_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/** Provenance reports kept per content-addressed ref (immutable, so cacheable). */
export const PROVENANCE_CACHE_LIMIT = 32;

const FALLBACK_ACCENT = '#00ffff';

function cssColor(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return FALLBACK_ACCENT;
  const channel = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${channel(rgb[0])}, ${channel(rgb[1])}, ${channel(rgb[2])})`;
}

/**
 * Selection for the world-model layer: click -> selected card + shared
 * context record. The card quotes the projection's numbers and grants; then,
 * when the source offers `getProvenance`, the item's ADMITTED descriptor and
 * its lineage are fetched by the item's own product ref and appended. The
 * context record carries semantic/source refs verbatim for inspection.
 */
export function createSelection({
  state,
  services,
  overlayHost,
  screenSpaceEventHandlerFactory,
  source,
  config: { id, name, sourceLabel },
}) {
  const { resolvePickId, isOwnedByOtherLayer } = services.picking;
  const {
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
  } = services.context;
  const features = sourceFeatures(source);
  const provenance = new Map(); // ref -> report | Promise<report>
  let inspection = null; // { itemId, controller }

  function contextFor(entry) {
    return contextRecordFor(entry.render, {
      layerId: id,
      layerName: name,
      source: sourceLabel,
      revisionId: state.revisionId,
      dataSource: state.dataSource,
    });
  }

  function cardEntry(entry, extraDetails = []) {
    const [title, ...details] = selectionCardLines(entry.render);
    return {
      id: entry.render.id,
      position: entry.cartesian,
      variant: 'selected',
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-card',
      priority: Number.MAX_SAFE_INTEGER,
      title,
      details: [...details, ...extraDetails],
      accent: cssColor(entry.render.colorRgb),
      interactive: false,
      anchorRadiusPx: 8,
      minAnchorGapPx: 10,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    };
  }

  function publishCard(entry, extraDetails = []) {
    overlayHost.setEntries(
      WORLD_MODEL_OVERLAY_SOURCE_ID,
      [cardEntry(entry, extraDetails)],
      WORLD_MODEL_SELECTED_OVERLAY_OPTIONS,
    );
  }

  function pickedOwnId(picked) {
    const pickedId = resolvePickId(picked);
    return pickedId && state.byId.has(pickedId) ? pickedId : null;
  }

  function onKeyDown(event) {
    if (event?.key === 'Escape') clearSelection();
  }

  function installClickHandler() {
    if (state.clickHandler || !state.viewer) return;
    const handler = screenSpaceEventHandlerFactory(state.viewer);
    handler.setInputAction((click) => {
      const picked = state.viewer?.scene?.pick(click.position);
      const own = pickedOwnId(picked);
      if (own) {
        selectById(own);
        return;
      }
      // A pick that belongs to a sibling layer is not "empty space".
      if (picked) {
        const pickedId = resolvePickId(picked);
        if (pickedId && isOwnedByOtherLayer(id, pickedId)) return;
      }
      clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    state.clickHandler = handler;
    if (typeof window !== 'undefined') {
      state.keyHandler = onKeyDown;
      window.addEventListener('keydown', state.keyHandler);
    }
  }

  function removeClickHandler() {
    if (state.clickHandler) {
      state.clickHandler.destroy();
      state.clickHandler = null;
    }
    if (state.keyHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', state.keyHandler);
    }
    state.keyHandler = null;
  }

  function cancelInspection() {
    inspection?.controller.abort();
    inspection = null;
  }

  function remember(ref, value) {
    provenance.delete(ref);
    provenance.set(ref, value);
    while (provenance.size > PROVENANCE_CACHE_LIMIT) {
      provenance.delete(provenance.keys().next().value);
    }
  }

  /** Fetch (or reuse) the provenance report behind an item's product ref. */
  function loadProvenance(ref, signal) {
    const cached = provenance.get(ref);
    if (cached) return Promise.resolve(cached);
    const pending = source
      .getProvenance({ ref, follow: 'source', signal })
      .then((report) => {
        remember(ref, report);
        return report;
      })
      .catch((error) => {
        if (provenance.get(ref) === pending) provenance.delete(ref);
        throw error;
      });
    remember(ref, pending);
    return pending;
  }

  /**
   * Append the admitted descriptor + lineage to the card once the report
   * arrives, unless the selection moved on. A failed fetch leaves the card
   * as it was and says so in one line; it never hides the served item.
   */
  function inspect(entry) {
    cancelInspection();
    if (!features.provenance) return;
    const ref = refString(entry.render.record?.semantic_ref?.product_ref);
    if (!ref) return;
    const controller = new AbortController();
    const itemId = entry.render.id;
    inspection = { itemId, controller };
    loadProvenance(ref, controller.signal).then(
      (report) => {
        if (controller.signal.aborted || state.selectedId !== itemId) return;
        const current = state.byId.get(itemId);
        if (!current) return;
        publishCard(current, inspectionLines(current.render.record, report));
        if (inspection?.controller === controller) inspection = null;
      },
      (error) => {
        if (controller.signal.aborted || state.selectedId !== itemId) return;
        const current = state.byId.get(itemId);
        if (!current) return;
        publishCard(current, [
          `provenance unavailable: ${error?.message || error}`,
        ]);
        if (inspection?.controller === controller) inspection = null;
      },
    );
  }

  /** Select one rendered item by its projection id. */
  function selectById(itemId) {
    const entry = state.byId.get(itemId);
    if (!entry) return false;
    state.selectedId = itemId;
    publishCard(entry);
    try {
      registerEntityContext(entry.entity, contextFor(entry));
      selectEntityContext(entry.entity);
    } catch {
      // context store unavailable — the card still shows
    }
    inspect(entry);
    return true;
  }

  function clearSelection() {
    cancelInspection();
    if (!state.selectedId) return;
    state.selectedId = null;
    overlayHost.clearSource(WORLD_MODEL_OVERLAY_SOURCE_ID);
    try {
      clearSelectedEntityContextForLayer(id);
    } catch {
      // nothing to clear
    }
  }

  /** Replace this layer's context records with the current render set. */
  function refreshContextRegistrations() {
    try {
      removeEntityContextsForLayer(id);
      for (const entry of state.byId.values()) {
        registerEntityContext(entry.entity, contextFor(entry));
      }
    } catch {
      // context store unavailable (unit tests without a window)
    }
  }

  /** After a refresh: keep the selection if the item survived, else drop it. */
  function reselect() {
    if (!state.selectedId) return;
    if (state.byId.has(state.selectedId)) {
      selectById(state.selectedId);
    } else {
      cancelInspection();
      state.selectedId = null;
      overlayHost.clearSource(WORLD_MODEL_OVERLAY_SOURCE_ID);
    }
  }

  return {
    installClickHandler,
    removeClickHandler,
    selectById,
    clearSelection,
    refreshContextRegistrations,
    reselect,
    cardEntry,
    /** Test/QA seam: whether the report for a ref is cached. */
    hasProvenance: (ref) => provenance.has(ref),
  };
}
