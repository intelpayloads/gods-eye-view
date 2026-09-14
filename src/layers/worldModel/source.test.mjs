import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ProjectionSourceError,
  assertProjectionSource,
  createHttpProjectionSource,
  validateProjection,
} from './source.js';
import { DEFAULT_VIEW } from './view.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/experiment-002.projection.json', import.meta.url),
    'utf8',
  ),
);

/** Route table -> fetchImpl that records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const route = routes[String(url)];
    if (!route)
      return Response.json(
        { error: 'not-found', message: `no route ${url}` },
        { status: 404 },
      );
    if (typeof route === 'function') return route(options);
    return Response.json(route.body, { status: route.status ?? 200 });
  };
  return { calls, fetchImpl };
}

test('reads the head and pins the projection to that revision', async () => {
  const projection = { ...fixture, revision_id: 'rev-1' };
  const { calls, fetchImpl } = fakeFetch({
    '/x/heads': { body: { 'world/main': 'rev-1', 'world/other': 'rev-9' } },
    '/x/project': { body: projection },
  });
  const source = createHttpProjectionSource({
    baseUrl: '/x/',
    fetchImpl,
    headers: async () => ({ authorization: 'Bearer t0k', 'x-caller': 'qa' }),
  });
  assert.equal(await source.getHeadRevision(), 'rev-1');
  const result = await source.getProjection({ revisionId: 'rev-1' });
  assert.deepEqual(result, projection);
  assert.equal(calls[0].url, '/x/heads');
  assert.equal(calls[0].options.headers.authorization, 'Bearer t0k');
  assert.equal(calls[1].url, '/x/project');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['content-type'], 'application/json');
  assert.equal(calls[1].options.headers['x-caller'], 'qa');
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.revision_id, 'rev-1');
  assert.deepEqual(body.query, DEFAULT_VIEW.query);
  assert.deepEqual(body.projection_spec, DEFAULT_VIEW.projection_spec);
  assert.deepEqual(source.describe(), {
    transport: 'http',
    baseUrl: '/x',
    head: 'world/main',
  });
});

test('typed errors: head missing, unauthorized, unreachable, http, malformed', async () => {
  const code = (promise) =>
    promise.then(
      () => assert.fail('expected rejection'),
      (error) => {
        assert.ok(error instanceof ProjectionSourceError, String(error));
        return error.code;
      },
    );
  const source = (routes) =>
    createHttpProjectionSource({
      baseUrl: '/w',
      fetchImpl: fakeFetch(routes).fetchImpl,
    });
  assert.equal(
    await code(source({ '/w/heads': { body: {} } }).getHeadRevision()),
    'head-missing',
  );
  assert.equal(
    await code(
      source({ '/w/heads': { body: { a: 1 }, status: 401 } }).getHeadRevision(),
    ),
    'unauthorized',
  );
  assert.equal(
    await code(
      source({
        '/w/heads': { body: { error: 'down' }, status: 502 },
      }).getHeadRevision(),
    ),
    'unreachable',
  );
  assert.equal(await code(source({}).getHeadRevision()), 'http');
  assert.equal(
    await code(
      source({
        '/w/project': { body: { ...fixture, revision_id: 'other' } },
      }).getProjection({ revisionId: 'rev-1' }),
    ),
    'malformed',
  );
  assert.equal(
    await code(
      source({
        '/w/project': { body: { revision_id: 'rev-1', points: [] } },
      }).getProjection({ revisionId: 'rev-1' }),
    ),
    'malformed',
  );
  const network = createHttpProjectionSource({
    baseUrl: '/w',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(await code(network.getHeadRevision()), 'unreachable');
  const message = await source({ '/w/heads': { body: {} } })
    .getHeadRevision()
    .catch((error) => error.message);
  assert.match(message, /world\/main is not set; run `worldmodel noaa replay`/);
});

test('abort wins even when the transport keeps going', async () => {
  const abort = new AbortController();
  const source = createHttpProjectionSource({
    baseUrl: '/w',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        abort.abort();
        return { 'world/main': 'rev-1' };
      },
    }),
  });
  await assert.rejects(source.getHeadRevision({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('any object with the two methods is a ProjectionSource; HTTP is one implementation', () => {
  const memory = {
    async getHeadRevision() {
      return 'fixture';
    },
    async getProjection({ revisionId }) {
      return { ...fixture, revision_id: revisionId };
    },
  };
  assert.equal(assertProjectionSource(memory), memory);
  assert.throws(
    () => assertProjectionSource({ getHeadRevision() {} }),
    /ProjectionSource/,
  );
  assert.throws(() => createHttpProjectionSource({}), /baseUrl/);
  assert.equal(validateProjection(fixture), fixture);
  assert.throws(() => validateProjection({ revision_id: 'x' }), /points array/);
});
