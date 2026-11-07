/** The standalone dev proxy's region routes (GEN-403): JSON as before, tile files as bytes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { worldModelDevProxy } from '../server/providers/world.js';

function proxy(fetchImpl) {
  let middleware;
  worldModelDevProxy({
    upstream: 'http://backplane:8100',
    fetchImpl,
  }).configureServer({
    middlewares: {
      use(_route, handler) {
        middleware = handler;
      },
    },
  });
  return async (url, { method = 'GET', headers = {} } = {}) => {
    const res = {
      writeHead(status, head) {
        Object.assign(this, { status, headers: head });
      },
      end(body) {
        this.body = body;
        this.done?.();
      },
    };
    const ended = new Promise((resolve) => {
      res.done = resolve;
    });
    middleware({ url, method, headers }, res);
    await ended;
    return res;
  };
}

test('a tile file passes through as bytes with its type, cache policy and ETag', async () => {
  const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0xff, 0x00, 0x80]);
  const seen = [];
  const request = proxy(async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(glb, {
      headers: {
        'content-type': 'model/gltf-binary',
        'cache-control': 'public, max-age=31536000, immutable',
        etag: '"sha256:aa"',
      },
    });
  });
  const res = await request('/tilesets/sha256:4254/15/13677/9310.glb', {
    headers: { 'if-none-match': '"sha256:aa"' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual([...res.body], [...glb]);
  assert.equal(res.headers['Content-Type'], 'model/gltf-binary');
  assert.equal(
    res.headers['cache-control'],
    'public, max-age=31536000, immutable',
  );
  assert.equal(res.headers.etag, '"sha256:aa"');
  assert.equal(
    seen[0].url,
    'http://backplane:8100/tilesets/sha256:4254/15/13677/9310.glb',
  );
  assert.equal(seen[0].init.headers['if-none-match'], '"sha256:aa"');
});

test('the region reads are JSON routes; other paths stay refused', async () => {
  const request = proxy(async () => Response.json({ regions: [] }));
  for (const path of [
    '/regions',
    '/regions/cs-downtown',
    '/regions/cs-downtown/tilesets?head=world%2Fmain',
  ]) {
    const res = await request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(JSON.parse(res.body), { regions: [] });
  }
  assert.equal((await request('/regions', { method: 'POST' })).status, 405);
  assert.equal((await request('/tilesets/sha256:aa')).status, 404);
  assert.equal((await request('/deliveries/1')).status, 404);
});

test('a dot segment never reaches another backplane route through a tile path', async () => {
  let fetched = 0;
  const request = proxy(async () => {
    fetched++;
    return Response.json({});
  });
  for (const path of [
    '/tilesets/a/../../deliveries',
    '/tilesets/a/%2e%2e/%2E%2E/heads',
    '/tilesets/a/./x',
  ]) {
    assert.equal((await request(path)).status, 404, path);
  }
  assert.equal(fetched, 0);
});
