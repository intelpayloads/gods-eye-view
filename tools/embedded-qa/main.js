/**
 * QA host for the embeddable application (scripts/qa-embedded.mjs).
 * A host-owned header plus one root element, an in-memory ProjectionSource
 * over the retained Experiment 002 fixtures, and no provider API.
 *
 * `?live` (or `?live=<base url>`, default `/world`) reads a running backplane
 * over HTTP instead, and starts on load: the UI against a real world.
 */
import '../../src/embedded/embedded.css';
import { createEmbeddedApplication } from '../../src/embedded/application.js';
import { createHttpProjectionSource } from '../../src/layers/worldModel/source.js';
import projection from '../../src/layers/worldModel/fixtures/experiment-002.projection.json';
import revisions from '../../src/layers/worldModel/fixtures/experiment-002.revisions.json';
import status from '../../src/layers/worldModel/fixtures/experiment-002.status.json';
import effectsPair from '../../src/layers/worldModel/fixtures/run-effects.pair.json';
import issTrack from '../../src/layers/worldModel/fixtures/receiver-track-thresholds.select.json';
import issEmitters from '../../src/layers/worldModel/fixtures/run-emitters.select.json';

// GEN-299: both cases of Foundation's ground-rf-mission run, mission effects only
// (the runs World Model holds before DWM-218), served beside Experiment 002.
const runs = new Map(
  ['contested', 'nominal'].map((label) => [
    effectsPair[label].head,
    effectsPair[label],
  ]),
);
const byRevision = new Map(
  [...runs.values()].map((run) => [run.revision_id, run]),
);

// GEN-311/312: the ISS East-Med run (GEN-303) as God's Eye projects it at one
// instant: the receiver and the jammer site from the retained selections, and
// the link between them. The retained fixtures hold no link rows, so the QA
// link is derived for display only: silent jammer -> `inactive`, power at the
// receiver -> `free_space` with that power, else `below_horizon_mask`.
const ISS_RUN = Object.freeze({
  head: 'sim/qa-iss-jammer',
  revisionId: issTrack.revision_id,
});
const legends =
  effectsPair.contested.revision.descriptors['simulation.rf.communications']
    .semantic.metadata;
const issRevision = {
  id: ISS_RUN.revisionId,
  parent_id: null,
  created_at: '2026-10-08T18:28:30Z',
  bindings: [
    'simulation.rf.receiver_track',
    'simulation.rf.emitters',
    'simulation.rf.links',
  ],
  descriptors: {
    'simulation.rf.receiver_track': {
      semantic: {
        metadata: {
          state_codes: legends.state_codes,
          reason_codes: legends.reason_codes,
        },
      },
    },
  },
};
const sameInstant = (a, b) => Date.parse(a) === Date.parse(b);

function issProjection(validAt, layers = null) {
  const track = issTrack.products[0].values.find((r) =>
    sameInstant(r.valid_time, validAt),
  );
  const sited = issEmitters.find((e) => sameInstant(e.valid_at, validAt))
    ?.selection.products[0].values[0];
  const points = [];
  const lines = [];
  const grant = 'geodetic_height:declared-wgs84-ellipsoidal';
  if (track) {
    const { lat_deg, lon_deg, height_m, ...properties } = track.value;
    points.push({
      id: `simulation.rf.receiver_track/${track.semantic_identity}`,
      binding: 'simulation.rf.receiver_track',
      position: { lon: lon_deg, lat: lat_deg, height_m },
      height: {
        value_m: height_m,
        source_field: 'height_m',
        assumption: grant,
      },
      time: { valid_at: track.valid_time },
      semantic_ref: { semantic_identity: track.semantic_identity },
      properties,
    });
  }
  if (sited) {
    points.push({
      id: `simulation.rf.emitters/${sited.semantic_identity}`,
      binding: 'simulation.rf.emitters',
      position: { lon: sited.lon, lat: sited.lat, height_m: 0 },
      height: {
        value_m: 0,
        source_field: 'geometric_height_m',
        assumption: grant,
      },
      time: { valid_at: sited.valid_time },
      semantic_ref: { semantic_identity: sited.semantic_identity },
      properties: sited.value,
    });
  }
  if (track && sited) {
    const power = track.value.interference_power_w;
    const reason = !sited.value.active
      ? 'inactive'
      : power > 0
        ? 'free_space'
        : 'below_horizon_mask';
    lines.push({
      id: 'simulation.rf.links/link:foundation:synthetic-ground-emitter:iss-receiver',
      binding: 'simulation.rf.links',
      positions: [
        { lon: sited.lon, lat: sited.lat, height_m: 0 },
        {
          lon: track.value.lon_deg,
          lat: track.value.lat_deg,
          height_m: track.value.height_m,
        },
      ],
      time: { valid_at: track.valid_time },
      semantic_ref: {
        semantic_identity:
          'link:foundation:synthetic-ground-emitter:iss-receiver',
      },
      properties: {
        reason,
        active: sited.value.active,
        received_power_w: reason === 'free_space' ? power : 0,
      },
    });
  }
  // Like World Model: only the layers asked for.
  const asked = (item) => !layers || layers.includes(item.binding);
  return {
    revision_id: ISS_RUN.revisionId,
    points: points.filter(asked),
    lines: lines.filter(asked),
    field_samples: [],
    omissions: [],
  };
}

function issStatus() {
  const times = issTrack.products[0].values.map((r) => r.valid_time).sort();
  const valid = { earliest: times[0], latest: times.at(-1) };
  return {
    ...structuredClone(status),
    head: { name: ISS_RUN.head },
    bindings: [
      'simulation.rf.receiver_track',
      'simulation.rf.emitters',
      'simulation.rf.links',
    ].map((binding) => ({
      binding,
      modality: 'simulated',
      representations: [{ kind: 'positioned_entities/v1' }],
      valid,
    })),
  };
}

function issSelect(query) {
  const binding = query?.requested_layers?.[0];
  if (binding === 'simulation.rf.receiver_track')
    return structuredClone(issTrack);
  if (binding === 'simulation.rf.emitters')
    return structuredClone(
      issEmitters.find((e) => sameInstant(e.valid_at, query.valid_at))
        ?.selection ?? { products: [] },
    );
  return { products: [] };
}

function runStatus(run) {
  const bindings = Object.entries(run.selections).map(
    ([binding, selection]) => {
      const times = selection.products[0].values
        .map((row) => row.valid_time)
        .sort();
      return {
        binding,
        modality: 'simulated',
        representations: [{ kind: 'sample_series/v1' }],
        valid: { earliest: times[0], latest: times.at(-1) },
      };
    },
  );
  return { ...structuredClone(status), head: { name: run.head }, bindings };
}

const fixtureSource = {
  async getHeads() {
    return {
      'world/main': revisions.revisions[0].id,
      [ISS_RUN.head]: ISS_RUN.revisionId,
      ...Object.fromEntries(
        [...runs.values()].map((run) => [run.head, run.revision_id]),
      ),
    };
  },
  async getRevisions({ head, limit = 10 }) {
    if (head === ISS_RUN.head)
      return { head, revisions: [structuredClone(issRevision)] };
    const run = runs.get(head);
    if (run) return { head, revisions: [structuredClone(run.revision)] };
    return { head, revisions: revisions.revisions.slice(0, limit) };
  },
  async getRevision({ revisionId }) {
    if (revisionId === ISS_RUN.revisionId) return structuredClone(issRevision);
    return structuredClone(byRevision.get(revisionId).revision);
  },
  async getProjection({ revisionId, head, query } = {}) {
    if (revisionId === ISS_RUN.revisionId || head === ISS_RUN.head)
      return issProjection(query?.valid_at, query?.requested_layers ?? null);
    return structuredClone(projection);
  },
  async getStatus({ head } = {}) {
    if (head === ISS_RUN.head) return issStatus();
    const run = runs.get(head);
    return run ? runStatus(run) : structuredClone(status);
  },
  async select({ revisionId, head, query }) {
    if (revisionId === ISS_RUN.revisionId || head === ISS_RUN.head)
      return issSelect(query);
    const run = byRevision.get(revisionId) ?? runs.get(head);
    const binding = query?.requested_layers?.[0];
    return structuredClone(run?.selections[binding] ?? { products: [] });
  },
};

let app = null;
const params = new URLSearchParams(location.search);
const live = params.has('live');
const source = live
  ? createHttpProjectionSource({ baseUrl: params.get('live') || '/world' })
  : fixtureSource;
window.__renderErrors = [];
window.__embeddedQa = {
  async create() {
    app = createEmbeddedApplication({
      root: document.getElementById('host-root'),
      worldModelSource: source,
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
  /** GEN-299: open the contested run of the effects pair, compared with its nominal case. */
  async openEffectsPair() {
    const { contested, nominal } = effectsPair;
    return app.openRun(contested.head, {
      revisionId: contested.revision_id,
      compare: { head: nominal.head, revisionId: nominal.revision_id },
    });
  },
  /** GEN-311/312: open the ISS jammer run at an instant (default 14:05Z, jammer on). */
  async openJammerRun(validAt = '2026-10-07T14:05:00Z') {
    return app.openRun(ISS_RUN.head, {
      revisionId: ISS_RUN.revisionId,
      validAt,
    });
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

if (live)
  window.__embeddedQa
    .create()
    .catch((error) => console.error('[embedded-qa] start failed:', error));
