/**
 * QA host for the embeddable application (scripts/qa-embedded.mjs).
 * A host-owned header plus one root element, an in-memory ProjectionSource
 * over the retained Experiment 002 fixtures, and no provider API.
 */
import '../../src/embedded/embedded.css';
import { createEmbeddedApplication } from '../../src/embedded/application.js';
import projection from '../../src/layers/worldModel/fixtures/experiment-002.projection.json';
import revisions from '../../src/layers/worldModel/fixtures/experiment-002.revisions.json';
import status from '../../src/layers/worldModel/fixtures/experiment-002.status.json';

const source = {
  async getRevisions({ head, limit = 10 }) {
    return { head, revisions: revisions.revisions.slice(0, limit) };
  },
  async getProjection() {
    return structuredClone(projection);
  },
  async getStatus() {
    return structuredClone(status);
  },
};

let app = null;
const params = new URLSearchParams(location.search);
window.__renderErrors = [];
window.__embeddedQa = {
  async create() {
    app = createEmbeddedApplication({
      root: document.getElementById('host-root'),
      worldModelSource: source,
      apiBaseUrl: null,
      cesiumToken: params.get('cesiumToken') || null,
      initialCamera: {
        lon: -122.25,
        lat: 37.62,
        rangeM: 95000,
        headingDeg: 0,
        pitchDeg: -35,
      },
      worldModel: { updateInterval: 5000 },
    });
    await app.start();
    app
      .getComponents()
      .scene.viewer.scene.renderError.addEventListener((_, error) =>
        window.__renderErrors.push(
          String(error?.stack || error?.message || error),
        ),
      );
    return app.getState().status;
  },
  async enableWorldModel() {
    const { dataManager } = app.getComponents().data;
    await dataManager.setEnabled('world-model', true, { origin: 'user' });
    return dataManager.isEnabled('world-model');
  },
  /** Enable every registered layer; each reports its own outcome. */
  async enableAllLayers() {
    const { dataManager } = app.getComponents().data;
    const outcomes = {};
    for (const id of [...dataManager.layers.keys()]) {
      try {
        await dataManager.setEnabled(id, true, { origin: 'user' });
        outcomes[id] = dataManager.getLayerLifecycleState(id);
      } catch (error) {
        outcomes[id] = { threw: String(error?.message || error) };
      }
    }
    return outcomes;
  },
  renderedIds() {
    const layer = app
      ?.getComponents()
      .data?.dataManager?.layers.get('world-model')?.module;
    return layer ? layer.getRenderedIds() : [];
  },
  async destroy() {
    const flatten = (error) =>
      error?.errors
        ? error.errors.flatMap(flatten)
        : [
            `${error?.name}: ${error?.message}\n${String(error?.stack || '')
              .split('\n')
              .slice(1, 4)
              .join('\n')}`,
          ];
    try {
      await app.destroy();
    } catch (error) {
      return { status: app.getState().status, errors: flatten(error) };
    } finally {
      window.__lastApp = app;
    }
    const status = app.getState().status;
    app = null;
    return status;
  },
};
