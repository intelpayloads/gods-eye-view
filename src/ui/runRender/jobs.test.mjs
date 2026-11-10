/** A run's renders (GEN-369): submit, follow, fetch, keep across reloads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GONE_REASON,
  RENDERS_STORAGE_KEY,
  createRenderJobs,
  submitReason,
} from './jobs.js';
import { boxName, colourLabels, dronesLine, frameOf, mediaTypeOf, pickOutputs } from './outputs.js';

const RUN = 'sim/sha256:043d75f9';
const JOB = 'ae1b0f2c-0000-4000-8000-000000000001';
const NAMES = [
  'outputs/manifest.csv',
  `outputs/${JOB}.ObserverCamera.FinalImage.0000.jpeg`,
  `outputs/${JOB}.ObserverCamera.FinalImagestencil_class.0000.jpeg`,
  `outputs/${JOB}.ObserverCamera.FinalImage.0000_neural.png`,
  `outputs/${JOB}.main_camera.seg.0000.png`,
  `outputs/${JOB}.main_camera.multilayer.0000.exr`,
  'outputs/output.json',
];
const RECORD = {
  frame_records: [
    {
      camera_intrinsics: {
        fx: 1662,
        fy: 1662,
        cx: 960,
        cy: 540,
        width: 1920,
        height: 1080,
      },
      annotations: {
        objects: [
          {
            kind: 'bounding_box_2d',
            class_label: 'drone',
            object_id: 'drone_0',
            visible_px: 212,
            box_2d: { x_min: 940, y_min: 520, x_max: 972, y_max: 538 },
          },
          {
            kind: 'bounding_box_2d',
            class_label: 'building',
            box_2d: { x_min: 0, y_min: 0, x_max: 1, y_max: 1 },
          },
        ],
      },
    },
  ],
};

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

/** A source whose job walks through `states`; every call is recorded. */
function fakeSource(states, { failSubmit = null } = {}) {
  const calls = [];
  let i = 0;
  let inFlight = 0;
  let overlapped = false;
  return {
    calls,
    get overlapped() {
      return overlapped;
    },
    async submit(request) {
      calls.push(['submit', request.capture_id]);
      if (failSubmit) throw failSubmit;
      return { id: JOB };
    },
    async status(id) {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await Promise.resolve();
      inFlight--;
      calls.push(['status', id]);
      return states[Math.min(i++, states.length - 1)];
    },
    async outputs(id) {
      calls.push(['outputs', id]);
      return NAMES.map((name, index) => ({ id: `o${index}`, name }));
    },
    async download(id, outputId) {
      calls.push(['download', outputId]);
      const name = NAMES[Number(outputId.slice(1))];
      return new Blob(
        [name.endsWith('.json') ? JSON.stringify(RECORD) : 'pixels'],
        {
          type: 'application/octet-stream',
        },
      );
    },
  };
}

const fakeUrls = () => {
  const live = new Set();
  let n = 0;
  return {
    live,
    create: (blob) => {
      const url = `blob:${++n}:${blob.type}`;
      live.add(url);
      return url;
    },
    revoke: (url) => live.delete(url),
  };
};

const instant = (ms, signal) =>
  signal?.aborted
    ? Promise.reject(signal.reason)
    : new Promise((resolve) => setImmediate(resolve));

async function settle(jobs, runKey, predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate(jobs.list(runKey))) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('never settled');
}

const REQUEST = { capture_id: 'run-043d75f90515-20261105T160055Z-view' };
const SUBMISSION = {
  runKey: RUN,
  validAt: '2026-11-05T16:00:55Z',
  camera: 'This view',
  look: 'fast',
  fovDeg: 60,
  request: REQUEST,
};

test('a render goes queued, rendering, completed, then shows its frame with the drone boxed', async () => {
  const source = fakeSource([
    { state: 'queued' },
    { state: 'rendering' },
    { state: 'transferring' },
    { state: 'completed' },
  ]);
  const seen = [];
  const urls = fakeUrls();
  const jobs = createRenderJobs({
    renderSource: source,
    storage: memoryStorage(),
    sleep: instant,
    objectUrls: urls,
    onChange: () => seen.push(jobs.list(RUN)[0]?.state),
  });
  const entry = await jobs.submit(SUBMISSION);
  assert.equal(entry.id, JOB);
  await settle(jobs, RUN, ([e]) => e.state === 'completed');
  assert.deepEqual(
    [...new Set(seen)],
    ['submitting', 'queued', 'rendering', 'transferring', 'completed'],
  );
  assert.equal(source.overlapped, false, 'one status request at a time');
  await jobs.ensureImages(entry);
  assert.match(entry.images.photo, /image\/png$/);
  assert.match(entry.images.unreal, /image\/jpeg$/);
  assert.match(entry.images.labels, /image\/png$/);
  assert.deepEqual(entry.frame.boxes, [
    {
      objectId: 'drone_0',
      label: null,
      xMin: 940,
      yMin: 520,
      xMax: 972,
      yMax: 538,
      visiblePx: 212,
    },
  ]);
  const downloads = source.calls
    .filter(([kind]) => kind === 'download')
    .map(([, id]) => id)
    .sort();
  assert.deepEqual(
    downloads,
    ['o1', 'o3', 'o4', 'o6'],
    'the four files shown, never the EXR or the passes',
  );
  jobs.dispose();
  assert.equal(urls.live.size, 0, 'every image let go on dispose');
});

test('a failed render keeps the reason the server gave', async () => {
  const source = fakeSource([
    { state: 'rendering' },
    { state: 'failed', reason: 'night at the observer' },
  ]);
  const jobs = createRenderJobs({
    renderSource: source,
    storage: memoryStorage(),
    sleep: instant,
    objectUrls: fakeUrls(),
  });
  await jobs.submit(SUBMISSION);
  await settle(jobs, RUN, ([e]) => e.state === 'failed');
  assert.equal(jobs.list(RUN)[0].reason, 'night at the observer');
  jobs.dispose();
});

test('a refused submit says why, and is not kept', async () => {
  const noAgent = Object.assign(new Error('Precondition Failed'), {
    status: 412,
  });
  const storage = memoryStorage();
  const jobs = createRenderJobs({
    renderSource: fakeSource([], { failSubmit: noAgent }),
    storage,
    sleep: instant,
  });
  const entry = await jobs.submit(SUBMISSION);
  assert.equal(entry.state, 'failed');
  assert.match(entry.reason, /No render node is running/);
  assert.deepEqual(
    JSON.parse(storage.getItem(RENDERS_STORAGE_KEY) ?? '{}')[RUN] ?? [],
    [],
  );
  assert.match(submitReason({ status: 401 }), /Not signed in/);
  jobs.dispose();
});

test('the run keeps its renders across a reload, and picks up one still rendering', async () => {
  const storage = memoryStorage();
  const first = createRenderJobs({
    renderSource: fakeSource([{ state: 'rendering' }]),
    storage,
    sleep: instant,
  });
  await first.submit(SUBMISSION);
  await settle(first, RUN, ([e]) => e.state === 'rendering');
  first.dispose();

  const source = fakeSource([{ state: 'completed' }]);
  const again = createRenderJobs({
    renderSource: source,
    storage,
    sleep: instant,
    objectUrls: fakeUrls(),
  });
  const [entry] = again.list(RUN);
  assert.equal(entry.id, JOB);
  assert.equal(entry.captureId, REQUEST.capture_id);
  assert.equal(entry.validAt, '2026-11-05T16:00:55Z');
  await settle(again, RUN, ([e]) => e.state === 'completed');
  assert.equal(
    source.calls.filter(([kind]) => kind === 'submit').length,
    0,
    'followed, never sent again',
  );
  assert.deepEqual(again.list('sim/sha256:other'), []);
  again.dispose();
});

const gone = () => Object.assign(new Error('no such render'), { status: 404 });

test('a render the server no longer keeps fails at once, and says so', async () => {
  const source = fakeSource([{ state: 'rendering' }]);
  source.status = async (id) => {
    source.calls.push(['status', id]);
    throw gone();
  };
  const storage = memoryStorage();
  const jobs = createRenderJobs({
    renderSource: source,
    storage,
    sleep: instant,
  });
  await jobs.submit(SUBMISSION);
  await settle(jobs, RUN, ([e]) => e.state === 'failed');
  assert.equal(jobs.list(RUN)[0].reason, GONE_REASON);
  assert.equal(
    source.calls.filter(([kind]) => kind === 'status').length,
    1,
    'a 404 is an answer, not a miss to retry',
  );
  assert.equal(
    JSON.parse(storage.getItem(RENDERS_STORAGE_KEY))[RUN][0].gone,
    true,
  );
  jobs.dispose();
});

test('a status that only errs is retried, where a gone one is not', async () => {
  const source = fakeSource([]);
  source.status = async (id) => {
    source.calls.push(['status', id]);
    throw Object.assign(new Error('Bad Gateway'), { status: 502 });
  };
  const jobs = createRenderJobs({
    renderSource: source,
    storage: memoryStorage(),
    sleep: instant,
  });
  await jobs.submit(SUBMISSION);
  await settle(jobs, RUN, ([e]) => e.state === 'failed');
  assert.match(jobs.list(RUN)[0].reason, /Status unreadable: Bad Gateway/);
  assert.equal(source.calls.filter(([kind]) => kind === 'status').length, 5);
  jobs.dispose();
});

test('a finished render whose files are gone says so, and a reload does not ask again', async () => {
  const storage = memoryStorage();
  const source = fakeSource([{ state: 'completed' }]);
  source.outputs = async (id) => {
    source.calls.push(['outputs', id]);
    throw gone();
  };
  const first = createRenderJobs({
    renderSource: source,
    storage,
    sleep: instant,
    objectUrls: fakeUrls(),
  });
  await first.submit(SUBMISSION);
  await settle(first, RUN, ([e]) => e.state === 'completed');
  const entry = await first.ensureImages(first.list(RUN)[0]);
  assert.equal(entry.imageError, GONE_REASON);
  assert.equal(entry.images, null);
  first.dispose();

  const later = fakeSource([{ state: 'completed' }]);
  const again = createRenderJobs({
    renderSource: later,
    storage,
    sleep: instant,
    objectUrls: fakeUrls(),
  });
  const kept = await again.ensureImages(again.list(RUN)[0]);
  assert.equal(kept.imageError, GONE_REASON);
  assert.deepEqual(
    later.calls,
    [],
    'the server was asked for files it had said were gone',
  );
  again.dispose();
});

test('a queued render is cancelled through the host, and stays cancelled', async () => {
  const source = fakeSource([{ state: 'queued' }]);
  source.cancel = async (id) => {
    source.calls.push(['cancel', id]);
  };
  const jobs = createRenderJobs({
    renderSource: source,
    storage: memoryStorage(),
    sleep: instant,
  });
  const entry = await jobs.submit(SUBMISSION);
  await settle(jobs, RUN, ([e]) => e.state === 'queued');
  assert.equal(jobs.canCancel(entry), true);
  assert.deepEqual(await jobs.cancel(entry), { cancelled: true });
  assert.deepEqual([entry.state, entry.reason], ['failed', 'Cancelled']);
  assert.equal(jobs.canCancel(entry), false);
  // The poll that was in flight answers "queued": the cancel stands.
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([entry.state, entry.reason], ['failed', 'Cancelled']);
  jobs.dispose();
});

test('a cancel the server refuses leaves the render running, and a host with no cancel offers none', async () => {
  const source = fakeSource([{ state: 'queued' }, { state: 'rendering' }]);
  source.cancel = async () => {
    throw Object.assign(new Error('a running render finishes'), {
      status: 409,
    });
  };
  const jobs = createRenderJobs({
    renderSource: source,
    storage: memoryStorage(),
    sleep: instant,
  });
  const entry = await jobs.submit(SUBMISSION);
  const answer = await jobs.cancel(entry);
  assert.deepEqual(answer, {
    cancelled: false,
    reason: 'a running render finishes',
  });
  await settle(jobs, RUN, ([e]) => e.state === 'rendering');
  assert.equal(jobs.canCancel(entry), false, 'only a queued render');
  jobs.dispose();

  const plain = createRenderJobs({
    renderSource: fakeSource([{ state: 'queued' }]),
    storage: memoryStorage(),
    sleep: instant,
  });
  const queued = await plain.submit(SUBMISSION);
  assert.equal(plain.canCancel(queued), false);
  assert.equal((await plain.cancel(queued)).cancelled, false);
  plain.dispose();
});

test('dispose stops following: no status is asked after it', async () => {
  const source = fakeSource([{ state: 'queued' }]);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
      gate.then(resolve);
    });
  const jobs = createRenderJobs({
    renderSource: source,
    storage: memoryStorage(),
    sleep,
  });
  await jobs.submit(SUBMISSION);
  await settle(jobs, RUN, ([e]) => e.state === 'queued');
  const asked = source.calls.length;
  jobs.dispose();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.calls.length, asked);
});

test('outputs are picked by the renderer names, typed, and the labels coloured by class', () => {
  const picked = pickOutputs(NAMES.map((name, i) => ({ id: `o${i}`, name })));
  assert.deepEqual(
    Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, v.id])),
    { unreal: 'o1', photo: 'o3', labels: 'o4', record: 'o6' },
  );
  assert.equal(
    pickOutputs(NAMES.slice(0, 3).map((name, i) => ({ id: `o${i}`, name })))
      .photo,
    undefined,
    'fast: no Cosmos frame',
  );
  assert.equal(mediaTypeOf('a.jpeg'), 'image/jpeg');
  assert.equal(mediaTypeOf('a.png'), 'image/png');
  const pixels = new Uint8ClampedArray([
    7, 7, 7, 255, 5, 5, 5, 255, 0, 0, 0, 255,
  ]);
  assert.deepEqual(
    [...colourLabels(pixels)],
    [255, 60, 60, 255, 96, 160, 220, 255, 255, 0, 255, 255],
  );
  assert.deepEqual(
    frameOf({ frame_records: [{ annotations: { objects: [] } }] }).boxes,
    [],
    'a hidden drone has no box',
  );
});

test('a box is shown under its callsign, and the result says who was sent and who is hidden', () => {
  const box = (object_id, label) => ({
    kind: 'bounding_box_2d',
    class_label: 'drone',
    object_id,
    ...(label ? { label } : {}),
    box_2d: { x_min: 1, y_min: 2, x_max: 3, y_max: 4 },
  });
  const frame = (...objects) => frameOf({ frame_records: [{ annotations: { objects } }] });
  const named = frame(box('laydown:x:uas-1', 'RAVEN-1'), box('drone_1'));
  assert.deepEqual(named.boxes.map(boxName), ['RAVEN-1', 'drone_1']);
  const sent = [
    { id: 'laydown:x:uas-1', label: 'RAVEN-1' },
    { id: 'laydown:x:uas-2', label: 'RAVEN-2' },
    { id: 'laydown:x:uas-3', label: null },
  ];
  assert.equal(
    dronesLine(sent, frame(box('laydown:x:uas-1', 'RAVEN-1')).boxes),
    '3 drones sent, 1 visible · hidden: RAVEN-2, laydown:x:uas-3',
  );
  assert.equal(dronesLine(sent.slice(0, 1), frame(box('laydown:x:uas-1', 'RAVEN-1')).boxes), '1 drone sent, 1 visible');
  // A renderer older than GEN-466 names its boxes drone_{i}: only the counts are known.
  assert.equal(dronesLine(sent, frame(box('drone_0'), box('drone_2')).boxes), '3 drones sent, 2 visible');
  assert.equal(dronesLine(undefined, []), null, 'an entry kept from before GEN-468');
});
