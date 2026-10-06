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
    async getStatus({ head }) {
      calls.push(head);
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

test('runs are read from sim/ heads only, and a head is re-read only when it moves', async () => {
  const calls = [];
  const runs = createSimulationRuns(serving(calls));
  const [run] = await runs.read();
  assert.equal(run.head, RUN_HEAD);
  await runs.read();
  assert.deepEqual(calls, ['heads', RUN_HEAD, 'heads']);
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
