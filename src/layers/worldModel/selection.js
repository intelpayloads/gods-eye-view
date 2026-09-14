import * as Cesium from 'cesium';
import { contextRecordFor, selectionCardLines } from './adapter.js';

export const WORLD_MODEL_OVERLAY_SOURCE_ID = 'world-model';

/** One protected card at a time; it never competes with ambient labels. */
export const WORLD_MODEL_SELECTED_OVERLAY_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

const AIRCRAFT_ACCENT = '#00ffff';

function cssColor(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return AIRCRAFT_ACCENT;
  const channel = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${channel(rgb[0])}, ${channel(rgb[1])}, ${channel(rgb[2])})`;
}

/**
 * Selection for the world-model layer: click -> selected card + shared
 * context record. The card quotes the projection's numbers and grants; the
 * context record carries semantic/source refs verbatim for inspection.
 */
export function createSelection({
  state,
  services,
  overlayHost,
  screenSpaceEventHandlerFactory,
  config: { id, name, sourceLabel },
}) {
  const { resolvePickId, isOwnedByOtherLayer } = services.picking;
  const {
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
  } = services.context;

  function contextFor(entry) {
    return contextRecordFor(entry.render, {
      layerId: id,
      layerName: name,
      source: sourceLabel,
      revisionId: state.revisionId,
      dataSource: state.dataSource,
    });
  }

  function cardEntry(entry) {
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
      details,
      accent:
        entry.render.kind === 'field-sample'
          ? cssColor(entry.render.colorRgb)
          : AIRCRAFT_ACCENT,
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

  /** Select one rendered item by its projection id. */
  function selectById(itemId) {
    const entry = state.byId.get(itemId);
    if (!entry) return false;
    state.selectedId = itemId;
    overlayHost.setEntries(
      WORLD_MODEL_OVERLAY_SOURCE_ID,
      [cardEntry(entry)],
      WORLD_MODEL_SELECTED_OVERLAY_OPTIONS,
    );
    try {
      registerEntityContext(entry.entity, contextFor(entry));
      selectEntityContext(entry.entity);
    } catch {
      // context store unavailable — the card still shows
    }
    return true;
  }

  function clearSelection() {
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
  };
}
