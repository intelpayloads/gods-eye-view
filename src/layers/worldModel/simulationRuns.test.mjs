/**
 * Simulated runs. Two real documents from a backplane holding one Foundation
 * satellite run forked from a world with USGS earthquakes:
 *   fixtures/simulated-run.heads.json   `GET /heads`
 *   fixtures/simulated-run.status.json  `GET /status?head=sim/<run>`: the run's
 *     simulated trajectory beside the observed earthquakes it inherited
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createSimulationRuns,
  leaveRunParams,
  runOf,
  sharedSimulationRuns,
  SIM_HEAD_PREFIX,
  stepRunParams,
  viewRunParams,
} from './simulationRuns.js';
import { DEFAULT_DISPLAY_ASSUMPTIONS } from './view.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const HEADS = fixture('simulated-run.heads.json');
const STATUS = fixture('simulated-run.status.json');
const [RUN_HEAD] = Object.keys(HEADS).filter((h) =>
  h.startsWith(SIM_HEAD_PREFIX),
);

function serving(calls = []) {
  return {
    async getHeads() {
      calls.push('heads');
      return HEADS;
    },
    async getStatus({ head, modality }) {
      calls.push(`${head} ${modality}`);
      return STATUS;
    },
  };
}

test('a run is timed by its own simulated bindings, never the observed ones it inherited', () => {
  const run = runOf(RUN_HEAD, HEADS[RUN_HEAD], STATUS);
  const simulated = STATUS.bindings.filter((b) => b.modality === 'simulated');
  const observed = STATUS.bindings.filter((b) => b.modality !== 'simulated');
  assert.ok(
    simulated.length && observed.length,
    'the fixture holds both, so the rule is not vacuous',
  );
  assert.deepEqual(
    run.bindings,
    simulated.map((b) => b.binding),
  );
  assert.equal(run.earliest, simulated[0].valid.earliest);
  assert.equal(run.latest, simulated[0].valid.latest);
  assert.ok(
    observed.every(
      (b) => Date.parse(b.valid.earliest) !== Date.parse(run.earliest),
    ),
  );
});

test('a head with nothing simulated to draw is not a run', () => {
  const observedOnly = {
    bindings: STATUS.bindings.filter((b) => b.modality !== 'simulated'),
  };
  assert.equal(runOf(RUN_HEAD, 'r', observedOnly), null);
});

test('runs are read from sim/ heads only, for their simulated bindings, and a head is re-read only when it moves', async () => {
  const calls = [];
  const runs = createSimulationRuns(serving(calls));
  const [run] = await runs.read();
  assert.equal(run.head, RUN_HEAD);
  await runs.read();
  assert.deepEqual(calls, ['heads', `${RUN_HEAD} simulated`, 'heads']);
});

/** Many run heads, each answering only when released: what is in flight is visible. */
function held(count) {
  const heads = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`sim/sha256:run${i}`, `rev${i}`]),
  );
  const pending = [];
  return {
    pending,
    asked: [],
    async getHeads() {
      return heads;
    },
    getStatus({ head }) {
      this.asked.push(head);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    release() {
      for (const { resolve } of pending.splice(0)) resolve(STATUS);
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('every moved run head is read at once, and two readers share what is in flight', async () => {
  const source = held(30);
  const runs = createSimulationRuns(source);
  const first = runs.read();
  const second = runs.read();
  await settle();
  assert.equal(source.pending.length, 30, 'all 30 asked before any answered');
  source.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.length, 30);
  assert.deepEqual(a, b);
  assert.equal(source.asked.length, 30, 'each head asked once for both reads');
});

test("one reader's abort never fails another's read of the same heads", async () => {
  const source = held(3);
  const runs = createSimulationRuns(source);
  const controller = new AbortController();
  const aborted = runs.read({ signal: controller.signal });
  const kept = runs.read();
  await settle();
  controller.abort();
  source.release();
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal((await kept).length, 3);
  assert.equal(source.asked.length, 3);
});

test('a head whose status failed is read again next time', async () => {
  const source = held(1);
  const runs = createSimulationRuns(source);
  const failing = runs.read();
  await settle();
  source.pending.splice(0)[0].reject(new Error('502'));
  await assert.rejects(failing, /502/);
  const retry = runs.read();
  await settle();
  source.release();
  assert.equal((await retry).length, 1);
  assert.equal(source.asked.length, 2);
});

test('every row on one source shares one reader', () => {
  const source = serving();
  assert.equal(sharedSimulationRuns(source), sharedSimulationRuns(source));
  assert.notEqual(sharedSimulationRuns(source), sharedSimulationRuns(serving()));
});

test('a source without heads or status has no runs', async () => {
  assert.deepEqual(await createSimulationRuns({}).read(), []);
});

test('viewing a run asks for its head, the simulated modality and a stored epoch', () => {
  const run = runOf(RUN_HEAD, HEADS[RUN_HEAD], STATUS);
  assert.deepEqual(viewRunParams(run), {
    head: RUN_HEAD,
    modalities: ['simulated'],
    validAt: new Date(run.earliest).toISOString().replace('.000Z', 'Z'),
  });
  assert.deepEqual(leaveRunParams('world/main'), {
    head: 'world/main',
    modalities: null,
    validAt: null,
  });
  // the layer grants the run's declared geodetic height by default
  assert.equal(
    DEFAULT_DISPLAY_ASSUMPTIONS.geodetic_height,
    'declared-wgs84-ellipsoidal',
  );
});

test('stepping moves the query time and stays inside the run', () => {
  const run = runOf(RUN_HEAD, HEADS[RUN_HEAD], STATUS);
  const second = stepRunParams(run, run.earliest, 60).validAt;
  assert.equal(Date.parse(second) - Date.parse(run.earliest), 60_000);
  assert.equal(
    Date.parse(stepRunParams(run, run.earliest, -60).validAt),
    Date.parse(run.earliest),
  );
  assert.equal(
    Date.parse(stepRunParams(run, run.latest, 60).validAt),
    Date.parse(run.latest),
  );
});
