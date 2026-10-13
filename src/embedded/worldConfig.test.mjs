import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorldConfigRefresh } from './worldConfig.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A backplane whose `/status` answers only when the test says so. */
function slowSource(heads = { 'world/main': 'rev-1aaaaaaa' }) {
  const source = {
    heads,
    statusCalls: [],
    async getHeads() {
      return source.heads;
    },
    getStatus({ head }) {
      return new Promise((resolve) =>
        source.statusCalls.push({ head, resolve }),
      );
    },
  };
  return source;
}

const status = (revisionId, ageSeconds = 10) => ({
  head: {
    name: 'world/main',
    revision_id: revisionId,
    age_seconds: ageSeconds,
  },
  bindings: [{ binding: 'a' }, { binding: 'b' }],
});

test('the block shows the head at once and asks /status once while it is slow (DWM-221)', async () => {
  const source = slowSource();
  const shown = [];
  let t = 0;
  const refresh = createWorldConfigRefresh({
    source,
    render: (view) => shown.push(view),
    now: () => t,
  });
  void refresh();
  await flush();
  assert.equal(shown.at(-1).state, 'pending');
  assert.equal(shown.at(-1).lines[0], 'world/main · rev rev-1aaa');
  void refresh();
  void refresh();
  await flush();
  assert.equal(
    source.statusCalls.length,
    1,
    'no second /status while one is out',
  );

  source.statusCalls[0].resolve(status('rev-1aaaaaaa', 10));
  await flush();
  assert.equal(shown.at(-1).state, 'ok');
  assert.match(shown.at(-1).lines[0], /10 s ago/);
  assert.match(shown.at(-1).lines[1], /^2 products/);

  t = 50_000;
  await refresh();
  assert.equal(
    source.statusCalls.length,
    1,
    'the head has not moved: no new /status',
  );
  assert.match(shown.at(-1).lines[0], /min ago/, 'the age is carried forward');

  source.heads = { 'world/main': 'rev-2bbbbbbb' };
  void refresh();
  await flush();
  assert.equal(
    source.statusCalls.length,
    2,
    'the head moved: status is read again',
  );
  assert.equal(shown.at(-1).state, 'ok', 'the last answer stays up meanwhile');
});

test('an unreachable backplane says so; a source without heads still reads one at a time', async () => {
  const shown = [];
  const failing = {
    getHeads: async () => {
      throw new Error('unreachable');
    },
    getStatus: async () => status('x'),
  };
  await createWorldConfigRefresh({
    source: failing,
    render: (v) => shown.push(v),
  })();
  assert.equal(shown.at(-1).state, 'down');

  let calls = 0;
  let answer;
  const headless = {
    getStatus: () => {
      calls++;
      return new Promise((resolve) => (answer = resolve));
    },
  };
  const refresh = createWorldConfigRefresh({
    source: headless,
    render: (v) => shown.push(v),
  });
  void refresh();
  void refresh();
  assert.equal(calls, 1);
  answer(status('rev-1'));
  await flush();
  assert.equal(shown.at(-1).state, 'ok');
});
