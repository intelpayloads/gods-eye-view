import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvSource, createCctvLayer } from './index.js';

/** Resolve logical provider paths unchanged, as the standalone composition does. */
const api = (path) => path;

const camera = {
  id: 'pack/camera ?x',
  name: 'Camera & road',
  city: 'Austin',
  lat: 30.267,
  lon: -97.744,
  headingDeg: 45,
  fovDeg: 60,
  pitchDeg: -12,
};

test('camera catalog and health use fixed source routes and caller cancellation', async () => {
  const calls = [];
  const source = createCctvSource({
    api,
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response(
        JSON.stringify(
          path.endsWith('/sources') ? { sources: [] } : { cameras: [] },
        ),
      );
    },
  });
  const controller = new AbortController();
  await source.getCatalog({ signal: controller.signal });
  await source.getHealth({ signal: controller.signal });
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/cctv/sources', '/api/cctv/health'],
  );
  for (const { options } of calls) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, 'no-store');
  }
});

test('camera sources reject malformed snapshots and failures', async () => {
  for (const method of ['getCatalog', 'getHealth']) {
    const malformed = createCctvSource({
      api,
      fetchImpl: async () => new Response('{}'),
    });
    await assert.rejects(malformed[method](), /Malformed camera/);
    const denied = createCctvSource({
      api,
      fetchImpl: async () => new Response('', { status: 403 }),
    });
    await assert.rejects(denied[method](), /HTTP 403/);
  }
});

test('cancellation while reading a camera response body prevents publication', async () => {
  const controller = new AbortController();
  const source = createCctvSource({
    api,
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { sources: [] };
      },
    }),
  });
  await assert.rejects(source.getCatalog({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('frame and media URLs preserve registered camera identity and encoded metadata', () => {
  const source = createCctvSource({ api });
  const frame = new URL(source.getFrameUrl(camera), 'https://example.test');
  const media = new URL(source.getMediaUrl(camera), 'https://example.test');
  assert.equal(
    frame.pathname,
    '/api/cctv/frame/' + encodeURIComponent(camera.id),
  );
  assert.equal(
    media.pathname,
    '/api/cctv/media/' + encodeURIComponent(camera.id),
  );
  assert.equal(frame.searchParams.get('label'), camera.name);
  assert.equal(frame.searchParams.get('city'), camera.city);
  assert.equal(frame.searchParams.get('lat'), '30.267000');
  assert.equal(frame.searchParams.get('lon'), '-97.744000');
  assert.equal(frame.searchParams.get('heading'), '45');
  assert.equal(frame.searchParams.get('pitch'), '-12');
  assert.deepEqual([...media.searchParams.keys()], ['ts']);
});

test('camera construction is inert and destruction cancels a pending catalog and its visibility listener', async (t) => {
  const original = globalThis.document;
  const listeners = new Set();
  globalThis.document = {
    addEventListener(type, handler) {
      if (type === 'visibilitychange') listeners.add(handler);
    },
    removeEventListener(type, handler) {
      if (type === 'visibilitychange') listeners.delete(handler);
    },
  };
  t.after(() => {
    globalThis.document = original;
  });
  const noop = () => {};
  const services = {
    overlays: {
      clearOverlaySource: noop,
      hitTestWorldOverlay: noop,
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
    },
    sprites: { registerSpriteCollection: noop },
    activation: {},
    locations: {},
    picking: { unregisterPickOwner: noop },
    terrain: {},
    ground: {},
    mesh: {},
    focus: {},
    render: { releaseContinuousRender: noop },
  };
  let resolveCatalog;
  let signal;
  const source = {
    ...createCctvSource({ api }),
    getCatalog(options) {
      signal = options.signal;
      return new Promise((resolve) => {
        resolveCatalog = resolve;
      });
    },
  };
  const a = createCctvLayer({ services, source });
  const b = createCctvLayer({ services, source });
  assert.equal(listeners.size, 0);
  const viewer = {
    scene: { primitives: { add: (value) => value, remove: () => true } },
  };
  const initializing = a.init(viewer);
  assert.equal(listeners.size, 1);
  assert.equal(signal.aborted, false);
  a.destroy(viewer);
  assert.equal(listeners.size, 0);
  assert.equal(signal.aborted, true);
  resolveCatalog({ sources: [] });
  await assert.rejects(initializing, { name: 'AbortError' });
  assert.equal(a.getStats().count, 0);
  assert.equal(b.getStats().count, 0);
});

test('camera routes and URL families resolve through the supplied api, which is required', async () => {
  assert.throws(() => createCctvSource(), /requires an api/);
  const calls = [];
  const source = createCctvSource({
    api: (path) => `https://compat.test${path}`,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('{"sources":[]}');
    },
  });
  await source.getCatalog();
  assert.deepEqual(calls, ['https://compat.test/api/cctv/sources']);
  assert.ok(
    source
      .getFrameUrl(camera)
      .startsWith('https://compat.test/api/cctv/frame/'),
  );
  assert.ok(
    source
      .getMediaUrl(camera)
      .startsWith('https://compat.test/api/cctv/media/'),
  );
});
