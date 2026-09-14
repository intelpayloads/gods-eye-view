import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createWorldModelLayer } from './index.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/experiment-002.projection.json', import.meta.url),
    'utf8',
  ),
);
const DLH = 'world.aircraft/track:opensky:icao24:3c4b33';
const TOTAL = fixture.points.length + fixture.field_samples.length;

/** Everything the layer touches, faked and recorded. No HTTP anywhere. */
function harness(source) {
  const sources = [];
  const overlay = [];
  const owners = new Map();
  const store = new Map();
  let selected = null;
  let handler = null;
  let pickResult;
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
    scene: {
      pick() {
        return pickResult;
      },
    },
  };
  const services = {
    context: {
      registerEntityContext(entity, metadata) {
        entity.__gevContextId = metadata.id;
        store.set(metadata.id, metadata);
      },
      selectEntityContext(entity) {
        selected = entity.__gevContextId;
      },
      clearSelectedEntityContextForLayer() {
        selected = null;
      },
      removeEntityContextsForLayer(layerId) {
        for (const [key, record] of store)
          if (record.layerId === layerId) store.delete(key);
      },
    },
    picking: {
      registerPickOwner(id, predicate) {
        owners.set(id, predicate);
      },
      unregisterPickOwner(id) {
        owners.delete(id);
      },
      resolvePickId(picked) {
        const id = picked?.id;
        if (id && typeof id === 'object') return String(id.id);
        return id ? String(id) : null;
      },
      isOwnedByOtherLayer: () => false,
    },
  };
  const layer = createWorldModelLayer({
    source,
    services,
    overlayHost: {
      setEntries(...args) {
        overlay.push(['set', ...args]);
      },
      setVisible(...args) {
        overlay.push(['visible', ...args]);
      },
      clearSource(...args) {
        overlay.push(['clear', ...args]);
      },
    },
    screenSpaceEventHandlerFactory: () => {
      handler = {
        destroyed: false,
        setInputAction(fn) {
          this.fn = fn;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      return handler;
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return {
    layer,
    viewer,
    sources,
    overlay,
    owners,
    store,
    handler: () => handler,
    selected: () => selected,
    pick(value) {
      pickResult = value;
    },
  };
}

function fixtureSource({ revision = 'rev-1', fail = null } = {}) {
  const calls = { heads: 0, projections: 0 };
  const source = {
    revision,
    fail,
    calls,
    async getHeadRevision() {
      calls.heads++;
      if (source.fail) throw source.fail;
      return source.revision;
    },
    async getProjection({ revisionId }) {
      calls.projections++;
      return { ...fixture, revision_id: revisionId };
    },
  };
  return source;
}

test('renders one entity per projected item from the injected source', async () => {
  const source = fixtureSource();
  const h = harness(source);
  assert.equal(await h.layer.update(h.viewer), true);
  const stats = h.layer.getStats();
  assert.equal(stats.count, TOTAL);
  assert.equal(stats.revisionId, 'rev-1');
  assert.equal(stats.source, 'Dataforge World Model · rev rev-1');
  assert.equal(stats.error, null);
  assert.equal(stats.stale, false);
  assert.deepEqual(stats.counts, {
    points: 97,
    field_samples: 81,
    annotations: 1,
    assumptions: 6,
    omissions: 1,
  });
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, TOTAL);
  const dlh = h.sources[0].entities.getById(DLH);
  const now = Cesium.JulianDate.now();
  const carto = Cesium.Cartographic.fromCartesian(dlh.position.getValue(now));
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.longitude) + 121.9978) < 1e-9);
  assert.ok(Math.abs(carto.height - 5913.12) < 1e-6);
  const props = dlh.properties.getValue(now);
  assert.equal(
    props.record.semantic_ref.semantic_identity,
    'track:opensky:icao24:3c4b33',
  );
  assert.equal(props.record.height.barometric_height_m, 5615.94);
  const node = h.sources[0].entities.getById(
    'world.weather/air_temperature/850hPa/39.000/237.000',
  );
  assert.equal(
    node.point.heightReference.getValue(now),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.equal(
    Cesium.Cartographic.fromCartesian(node.position.getValue(now)).height <
      1e-6,
    true,
  );
  // every rendered item is registered for inspection, refs intact
  assert.equal(h.store.size, TOTAL);
  assert.deepEqual(
    h.store.get(DLH).properties.source_ref,
    fixture.points[0].source_ref,
  );
  assert.equal(h.layer.describeSource().transport, 'custom');
  h.layer.destroy(h.viewer);
});

test('an unchanged head does not re-project; a new head does', async () => {
  const source = fixtureSource();
  const h = harness(source);
  await h.layer.update(h.viewer);
  await h.layer.update(h.viewer);
  assert.equal(source.calls.heads, 2);
  assert.equal(source.calls.projections, 1);
  source.revision = 'rev-2';
  await h.layer.update(h.viewer);
  assert.equal(source.calls.projections, 2);
  assert.equal(h.layer.getStats().revisionId, 'rev-2');
  h.layer.destroy(h.viewer);
});

test('a failed refresh keeps the geometry, reports stale, and does not reject the lifecycle', async () => {
  const source = fixtureSource();
  const h = harness(source);
  await h.layer.update(h.viewer);
  source.fail = Object.assign(new Error('World model unreachable at /x'), {
    code: 'unreachable',
  });
  assert.equal(await h.layer.update(h.viewer), true);
  const stats = h.layer.getStats();
  assert.equal(stats.count, TOTAL);
  assert.equal(stats.stale, true);
  assert.equal(stats.error, 'World model unreachable at /x');
  assert.equal(stats.errorCode, 'unreachable');
  assert.equal(h.sources[0].entities.values.length, TOTAL);
  h.layer.destroy(h.viewer);

  const empty = harness(
    fixtureSource({ fail: new Error('head world/main is not set') }),
  );
  assert.equal(await empty.layer.update(empty.viewer), true);
  assert.equal(empty.layer.getStats().count, 0);
  assert.equal(empty.layer.getStats().stale, false);
  assert.match(empty.layer.getStats().error, /not set/);
  empty.layer.destroy(empty.viewer);
});

test('late refresh cannot publish after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve;
    let signal;
    const h = harness({
      getHeadRevision(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
      async getProjection({ revisionId }) {
        return { ...fixture, revision_id: revisionId };
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve('rev-late');
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.overlay.filter(([kind]) => kind === 'set').length, 0);
    h.layer.destroy(h.viewer);
  }
});

test('disable releases the click handler, pick owner and overlay; destroy releases the data source and contexts', async () => {
  const h = harness(fixtureSource());
  await h.layer.update(h.viewer);
  assert.equal(typeof h.owners.get('world-model'), 'function');
  assert.equal(h.owners.get('world-model')(DLH), true);
  assert.equal(h.owners.get('world-model')('someone-else'), false);
  assert.equal(h.handler().destroyed, false);
  h.layer.disable(h.viewer);
  assert.equal(h.handler().destroyed, true);
  assert.equal(h.owners.has('world-model'), false);
  assert.equal(h.sources[0].show, false);
  assert.deepEqual(h.overlay.at(-2), ['clear', 'world-model']);
  assert.deepEqual(h.overlay.at(-1), ['visible', 'world-model', false]);
  assert.equal(h.store.size, TOTAL, 'records survive a disable for re-enable');
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);
  assert.equal(h.store.size, 0);
  assert.equal(h.layer.getStats().count, 0);
});

test('selection publishes one protected card with refs; clicks select and clear', async () => {
  const h = harness(fixtureSource());
  await h.layer.update(h.viewer);
  assert.equal(h.layer.selectById(DLH), true);
  const [kind, sourceId, entries, options] = h.overlay.findLast(
    ([k]) => k === 'set',
  );
  assert.equal(kind, 'set');
  assert.equal(sourceId, 'world-model');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, DLH);
  assert.equal(entries[0].protected, true);
  assert.equal(entries[0].paintLane, 'selected');
  assert.match(entries[0].title, /DLH455/);
  assert.match(
    entries[0].details.join('\n'),
    /adsb-geometric-as-wgs84-ellipsoid/,
  );
  assert.ok(Number.isFinite(entries[0].position.x));
  assert.equal(options.cohortLimit, 1);
  assert.equal(h.selected(), DLH);
  assert.equal(h.layer.getSelectedId(), DLH);

  // empty-space click clears
  h.pick(undefined);
  h.handler().fn({ position: { x: 1, y: 1 } });
  assert.equal(h.layer.getSelectedId(), null);
  assert.equal(h.selected(), null);
  assert.deepEqual(h.overlay.at(-1), ['clear', 'world-model']);

  // clicking one of our entities selects it
  const node = 'world.weather/air_temperature/850hPa/39.000/237.000';
  h.pick({ id: h.sources[0].entities.getById(node) });
  h.handler().fn({ position: { x: 2, y: 2 } });
  assert.equal(h.layer.getSelectedId(), node);
  assert.equal(
    h.overlay.at(-1)[2][0].title,
    '297.25 K air_temperature @ 850 hPa',
  );

  // a refresh keeps the selection while the item survives, drops it otherwise
  const source = fixtureSource({ revision: 'rev-2' });
  const h2 = harness(source);
  await h2.layer.update(h2.viewer);
  h2.layer.selectById(DLH);
  source.revision = 'rev-3';
  await h2.layer.update(h2.viewer);
  assert.equal(h2.layer.getSelectedId(), DLH);
  source.revision = 'rev-4';
  source.getProjection = async ({ revisionId }) => ({
    ...fixture,
    revision_id: revisionId,
    points: [],
  });
  await h2.layer.update(h2.viewer);
  assert.equal(h2.layer.getSelectedId(), null);
  h2.layer.destroy(h2.viewer);
  h.layer.destroy(h.viewer);
});

test('analyst records are JSON-safe and only exist while shown', async () => {
  const h = harness(fixtureSource());
  await h.layer.update(h.viewer);
  const records = h.layer.getAnalystRecords(2);
  assert.equal(records.length, 2);
  assert.equal(records[0].semantic_identity, 'track:opensky:icao24:3c4b33');
  assert.equal(typeof JSON.stringify(records), 'string');
  h.layer.disable(h.viewer);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  h.layer.destroy(h.viewer);
});
