import assert from 'node:assert/strict';
import test from 'node:test';
import {
  borrowInto,
  createWorldConfigRefresh,
  mountWorldConfig,
  sceneRow,
} from './worldConfig.js';

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

test('the Scene row: a chip per scene, the unavailable one says why, Modelled lists its regions (GEN-403)', () => {
  const available = { photoreal: null, modelled: null };
  const photoreal = sceneRow({ scene: 'photoreal', available, regions: [] });
  assert.deepEqual(
    photoreal.chips.map((chip) => [
      chip.label,
      chip.pressed,
      chip.disabledReason,
    ]),
    [
      ['PHOTOREAL', true, null],
      ['MODELLED', false, null],
    ],
  );
  assert.deepEqual(photoreal.lines, []);
  const keyless = sceneRow({
    scene: 'modelled',
    available: {
      photoreal: 'Google 3D tiles did not load here',
      modelled: null,
    },
    reading: true,
    regions: [],
  });
  assert.equal(
    keyless.chips[0].disabledReason,
    'Google 3D tiles did not load here',
  );
  assert.deepEqual(
    keyless.lines.map((line) => line.text),
    ['reading regions…'],
  );
  const drawn = sceneRow({
    scene: 'modelled',
    available,
    regions: [
      {
        name: 'cs-downtown',
        line: 'cs-downtown · terrain, imagery, buildings, trees',
        title: 'terrain: NAD83(2011)…',
      },
      { name: 'b', line: 'b not drawn: no terrain tileset yet', title: '' },
    ],
  });
  assert.deepEqual(
    drawn.lines.map((line) => line.text),
    [
      'cs-downtown · terrain, imagery, buildings, trees',
      'b not drawn: no terrain tileset yet',
    ],
  );
  assert.equal(drawn.lines[0].title, 'terrain: NAD83(2011)…');
  assert.equal(drawn.lines[1].title, 'b not drawn: no terrain tileset yet');
  assert.match(
    sceneRow({ scene: 'modelled', available, regions: [] }).lines[0].text,
    /no regions in this world/,
  );
  assert.deepEqual(
    sceneRow({
      scene: 'modelled',
      available,
      error: 'regions not read: 502',
      regions: [],
    }).lines.map((l) => l.text),
    ['regions not read: 502'],
  );
});

/** Just enough DOM for the block: elements that hold, move and drop children. */
class FakeElement {
  constructor(tagName, ownerDocument) {
    Object.assign(this, { tagName, ownerDocument, parentNode: null });
    Object.assign(this, { children: [], dataset: {}, hidden: false });
  }
  get nextSibling() {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  insertBefore(node, ref) {
    node.remove();
    node.parentNode = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }
  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  remove() {
    const siblings = this.parentNode?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute() {}
  addEventListener() {}
}

function fakeDocument() {
  const document = { createElement: (tag) => new FakeElement(tag, document) };
  return document;
}

test('a host section shows under the status lines and goes back where it was on remove (GEN-419)', () => {
  const document = fakeDocument();
  const panel = document.createElement('div');
  const list = document.createElement('div'); // #data-toggles
  panel.append(list);
  const page = document.createElement('div');
  const section = document.createElement('section');
  const after = document.createElement('span');
  page.append(section, after);

  const block = mountWorldConfig({
    before: list,
    source: slowSource(),
    section,
  });
  const card = panel.children[0];
  assert.equal(card.className, 'world-config');
  assert.deepEqual(
    card.children.map((child) => child.className ?? ''),
    ['world-config-title', '', 'world-config-host', 'world-config-scene'],
  );
  const host = card.children[2];
  assert.equal(host.hidden, false);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0], section);
  assert.deepEqual(page.children, [after]);

  block.remove();
  assert.equal(
    page.children[0],
    section,
    'back in its place, before its sibling',
  );
  assert.equal(page.children[1], after);
  assert.deepEqual(panel.children, [list]);
});

test('with no host section the slot is hidden and empty', () => {
  const document = fakeDocument();
  const panel = document.createElement('div');
  const list = document.createElement('div');
  panel.append(list);
  const block = mountWorldConfig({ before: list, source: slowSource() });
  const host = panel.children[0].children[2];
  assert.equal(host.className, 'world-config-host');
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
  block.remove();
});

test('a borrowed element the host has moved since is left where the host put it', () => {
  const document = fakeDocument();
  const [home, into, elsewhere] = ['a', 'b', 'c'].map(() =>
    document.createElement('div'),
  );
  const element = document.createElement('p');
  home.append(element);
  const giveBack = borrowInto(element, into);
  elsewhere.append(element);
  giveBack();
  assert.equal(element.parentNode, elsewhere);

  const loose = document.createElement('p');
  const undo = borrowInto(loose, into);
  undo();
  assert.equal(
    loose.parentNode,
    null,
    'an element with no home is only taken out',
  );
});
