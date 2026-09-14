import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorldViewController } from './controller.js';

/** Manual clock: setTimeout/clearTimeout and now() all driven by advance(). */
function fakeClock(start = Date.UTC(2026, 8, 10, 22, 57, 25)) {
  let t = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await flush();
      }
      t = target;
      await flush();
    },
    pending: () => timers.size,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const projection = (revisionId, points = 1) => ({
  revision_id: revisionId,
  points: Array.from({ length: points }, (_, i) => ({ id: `p${i}` })),
  lines: [],
  polygons: [],
  field_samples: [],
  annotations: [],
  assumptions: [],
  omissions: [],
});

/** A source whose projection calls are promises the test resolves by hand. */
function fakeSource({ chain = ['rev-1'], status = null } = {}) {
  const calls = { revisions: [], projections: [], status: 0 };
  const source = {
    chain: chain.map((id, i) => ({
      id,
      parent_id: chain[i + 1] || null,
      created_at: '2026-09-10T22:00:00Z',
    })),
    chainError: null,
    async getRevisions({ head, limit, signal }) {
      calls.revisions.push({ head, limit });
      signal?.throwIfAborted();
      if (source.chainError) throw source.chainError;
      return { head, revisions: source.chain };
    },
    getProjection(request) {
      const call = { request, signal: request.signal };
      call.promise = new Promise((resolve, reject) => {
        call.resolve = (value) =>
          resolve(value ?? projection(request.revisionId));
        call.reject = reject;
        request.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
      calls.projections.push(call);
      return call.promise;
    },
  };
  if (status) {
    source.getStatus = async () => {
      calls.status++;
      return status;
    };
  }
  return { source, calls };
}

function controllerWith(source, clock, overrides = {}) {
  return createWorldViewController({
    source,
    initial: { bbox: [-123, 37, -121, 39], ...overrides },
    debounceMs: 300,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
}

test('a tick reads the chain and, live, projects by the newest revision id with the wall clock', async () => {
  const clock = fakeClock();
  const { source, calls } = fakeSource({ chain: ['rev-2', 'rev-1'] });
  const c = controllerWith(source, clock);
  const applied = [];
  c.onProjection((p) => applied.push(p.revision_id));
  const tick = c.tick();
  await flush();
  assert.equal(calls.revisions.length, 1);
  assert.equal(calls.projections.length, 1);
  assert.equal(calls.projections[0].request.revisionId, 'rev-2');
  assert.equal(
    calls.projections[0].request.query.valid_at,
    '2026-09-10T22:57:25.000Z',
  );
  assert.equal(c.getState().loading, true);
  calls.projections[0].resolve();
  assert.equal(await tick, true);
  assert.deepEqual(applied, ['rev-2']);
  const s = c.getState();
  assert.equal(s.displayedRevisionId, 'rev-2');
  assert.equal(s.headRevisionId, 'rev-2');
  assert.equal(s.load, 'ready');
  assert.equal(s.headAdvanced, false);
  assert.equal(s.headAgeSeconds, 3445);
  // a later live tick re-projects even though the revision did not move: the clock did
  await clock.advance(10_000);
  const tick2 = c.tick();
  await flush();
  assert.equal(calls.projections.length, 2);
  assert.equal(
    calls.projections[1].request.query.valid_at,
    '2026-09-10T22:57:35.000Z',
  );
  calls.projections[1].resolve();
  await tick2;
  assert.equal(c.getState().counters.applied, 2);
  c.stop();
});

test('demand changes coalesce through the debounce into one request', async () => {
  const clock = fakeClock();
  const { source, calls } = fakeSource();
  const c = controllerWith(source, clock);
  const t = c.tick();
  await flush();
  calls.projections[0].resolve();
  await t;
  c.setViewport([-123, 37, -121, 39]); // unchanged: no-op
  c.setViewport([-122, 37, -121, 38]);
  await clock.advance(100);
  c.setViewport([-122.5, 37, -121, 38]);
  await clock.advance(100);
  c.setLayers(['world.weather']);
  assert.equal(calls.projections.length, 1);
  assert.equal(c.getState().pending, true);
  await clock.advance(300);
  assert.equal(calls.projections.length, 2);
  const request = calls.projections[1].request;
  assert.deepEqual(request.query.spatial_scope.bbox, [-122.5, 37, -121, 38]);
  assert.deepEqual(request.query.requested_layers, ['world.weather']);
  assert.equal(c.getState().pending, false);
  c.stop();
});

test('an older response resolving after a newer one is discarded and its request aborted', async () => {
  const clock = fakeClock();
  const { source, calls } = fakeSource();
  const c = controllerWith(source, clock);
  const applied = [];
  c.onProjection((p, { request }) =>
    applied.push(request.query.spatial_scope.bbox[0]),
  );
  const t = c.tick();
  await flush();
  calls.projections[0].resolve();
  await t;
  c.setViewport([-122, 37, -121, 38]);
  await clock.advance(300);
  c.setViewport([-121, 37, -120, 38]);
  await clock.advance(300);
  assert.equal(calls.projections.length, 3);
  assert.equal(
    calls.projections[1].signal.aborted,
    true,
    'superseded request is aborted',
  );
  // the transport ignores the abort and answers late: it must not land
  calls.projections[1].resolve(projection('rev-1', 5));
  await flush();
  calls.projections[2].resolve(projection('rev-1', 2));
  await flush();
  assert.deepEqual(applied, [-123, -121]);
  assert.equal(c.getState().projection.points.length, 2);
  assert.equal(c.getState().counters.discarded, 1);
  c.stop();
});

test('a pin survives a head advance and reports headAdvanced; go-live follows the new head', async () => {
  const clock = fakeClock();
  const { source, calls } = fakeSource({ chain: ['rev-1'] });
  const c = controllerWith(source, clock);
  const t = c.tick();
  await flush();
  calls.projections[0].resolve();
  await t;
  assert.equal(c.pin(), true);
  const d = c.getDemand();
  assert.equal(d.follow, 'pinned');
  assert.equal(d.pinnedRevisionId, 'rev-1');
  assert.equal(
    d.validAt,
    '2026-09-10T22:57:25.000Z',
    'the pinned time is the time the view was issued with',
  );
  await clock.advance(300);
  assert.equal(
    calls.projections.length,
    2,
    'pinning re-issues the frozen demand',
  );
  calls.projections[1].resolve();
  await flush();
  // the world advances; pinned ticks never re-project, only re-read facts
  source.chain = [
    { id: 'rev-2', parent_id: 'rev-1', created_at: '2026-09-10T23:00:00Z' },
    ...source.chain,
  ];
  await clock.advance(30_000);
  await c.tick();
  assert.equal(calls.projections.length, 2);
  const s = c.getState();
  assert.equal(s.headAdvanced, true);
  assert.equal(s.headRevisionId, 'rev-2');
  assert.equal(s.displayedRevisionId, 'rev-1');
  assert.equal(s.request.query.valid_at, '2026-09-10T22:57:25.000Z');
  c.followLive();
  assert.equal(c.getDemand().validAt, null, 'live returns to the wall clock');
  await clock.advance(300);
  assert.equal(calls.projections.length, 3);
  assert.equal(calls.projections[2].request.revisionId, 'rev-2');
  calls.projections[2].resolve();
  await flush();
  assert.equal(c.getState().headAdvanced, false);
  assert.equal(c.getState().displayedRevisionId, 'rev-2');
  c.stop();
});

test('changing head or mode aborts the request in flight; stop silences everything', async () => {
  const clock = fakeClock();
  const { source, calls } = fakeSource();
  const c = controllerWith(source, clock);
  const applied = [];
  c.onProjection((p) => applied.push(p.revision_id));
  const t = c.tick();
  await flush();
  assert.equal(calls.projections.length, 1);
  c.pin('rev-1');
  assert.equal(calls.projections[0].signal.aborted, true);
  await t;
  assert.deepEqual(applied, []);
  await clock.advance(300);
  assert.equal(calls.projections.length, 2);
  c.setWorld('world/other');
  assert.equal(calls.projections[1].signal.aborted, true);
  assert.equal(c.getState().projection, null);
  assert.equal(c.getDemand().follow, 'live');
  const t2 = c.tick();
  await flush();
  assert.equal(calls.revisions.at(-1).head, 'world/other');
  assert.equal(calls.projections.length, 3);
  c.stop();
  assert.equal(calls.projections[2].signal.aborted, true);
  calls.projections[2].resolve(projection('rev-1'));
  assert.equal(await t2, false);
  await flush();
  assert.deepEqual(applied, []);
  assert.equal(c.getState().stopped, true);
  c.setViewport([0, 0, 1, 1]);
  await clock.advance(1000);
  assert.equal(calls.projections.length, 3, 'nothing is issued after stop');
});

test('failures keep the previous projection and surface as facts; status is read when offered', async () => {
  const clock = fakeClock();
  const status = {
    head: { name: 'world/main', revision_id: 'rev-1' },
    bindings: [],
  };
  const { source, calls } = fakeSource({ status });
  const c = controllerWith(source, clock);
  const t = c.tick();
  await flush();
  calls.projections[0].resolve();
  await t;
  assert.equal(calls.status, 1);
  assert.deepEqual(c.getState().status, status);
  source.chainError = Object.assign(
    new Error('World model unreachable at /x'),
    { code: 'unreachable' },
  );
  await c.tick();
  const s = c.getState();
  assert.equal(s.chainError, 'World model unreachable at /x');
  assert.equal(s.stale, true);
  assert.equal(s.projection.revision_id, 'rev-1', 'geometry stays');
  assert.equal(
    calls.projections.length,
    1,
    'no projection is issued against an unread chain',
  );
  source.chainError = null;
  const t3 = c.tick();
  await flush();
  calls.projections[1].reject(
    Object.assign(new Error('boom'), { code: 'http' }),
  );
  await t3;
  assert.equal(c.getState().error, 'boom');
  assert.equal(c.getState().errorCode, 'http');
  assert.equal(c.getState().projection.revision_id, 'rev-1');
  // before any projection, an unreachable world is 'unavailable', not stale
  const down = fakeSource();
  down.source.chainError = Object.assign(new Error('down'), {
    code: 'unreachable',
  });
  const e = controllerWith(down.source, clock);
  await e.tick();
  assert.equal(e.getState().load, 'unavailable');
  assert.equal(e.getState().stale, false);
  assert.equal(down.calls.projections.length, 0);
  e.stop();
  c.stop();
});

test('policy changes travel with the request and are echoed back as demand', async () => {
  const clock = fakeClock();
  const { source, calls } = fakeSource();
  const c = controllerWith(source, clock);
  const t = c.tick();
  await flush();
  calls.projections[0].resolve();
  await t;
  c.setPolicy('withhold', 30);
  await clock.advance(300);
  assert.deepEqual(
    calls.projections[1].request.projectionSpec.projection_policy,
    {
      temporal_age: { mode: 'withhold', threshold_seconds: 30 },
    },
  );
  c.setPolicy('off');
  await clock.advance(300);
  assert.equal(
    'projection_policy' in calls.projections[2].request.projectionSpec,
    false,
  );
  c.setPolicy('off'); // unchanged: no request
  await clock.advance(300);
  assert.equal(calls.projections.length, 3);
  c.stop();
});
