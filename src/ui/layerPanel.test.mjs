import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerPanel } from './layerPanel.js';

/** The slice of the DOM the panel touches, enough to render and re-render rows. */
class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.dataset = {};
    this.attributes = {};
    this.hidden = false;
    this.disabled = false;
    this._text = '';
    this._listeners = new Map();
    const classes = () =>
      String(this.className).split(/\s+/).filter(Boolean);
    this.classList = {
      toggle: (name, force) => {
        const set = new Set(classes());
        if (force === undefined ? !set.has(name) : force) set.add(name);
        else set.delete(name);
        this.className = [...set].join(' ');
      },
      contains: (name) => classes().includes(name),
    };
  }

  get textContent() {
    return this.children.length
      ? this.children.map((c) => c.textContent).join('')
      : this._text;
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }

  set innerHTML(value) {
    if (value !== '') throw new Error('mock only supports clearing');
    this.children = [];
    this._text = '';
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, listener) {
    this._listeners.set(type, listener);
  }

  removeEventListener(type) {
    this._listeners.delete(type);
  }

  matches(selector) {
    const byClass = selector.match(/^\.([\w-]+)$/);
    if (byClass) return this.classList.contains(byClass[1]);
    const byData = selector.match(/^\[data-layer-id="([^"]+)"\]$/);
    if (byData) return this.dataset.layerId === byData[1];
    throw new Error(`unsupported selector ${selector}`);
  }

  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function installDocument() {
  const prior = { document: globalThis.document };
  globalThis.document = {
    hidden: false,
    createElement: (tag) => new Element(tag),
  };
  return () => {
    globalThis.document = prior.document;
  };
}

function mountPanel(layers) {
  const container = new Element('div');
  const panel = new LayerPanel({
    getLayers: () => layers,
    isEnabled: (id) => layers.find((l) => l.id === id).enabled,
    setEnabled: async () => {},
    setLayerParams: () => {},
    getRowControls: () => null,
    hasRowControls: () => false,
    subscribeRowControls: () => null,
  });
  panel.mount(container);
  return { panel, container };
}

function layerRow({ id = 'world-model', enabled = true, stats = {} } = {}) {
  return {
    id,
    name: 'World Model',
    icon: '◈',
    source: 'Dataforge World Model',
    enabled,
    showInTogglePanel: true,
    lifecycleState: enabled ? 'enabled' : 'disabled',
    stats: { count: 83, lastUpdate: Date.now(), ...stats },
  };
}

const facts = [
  {
    label: 'world.aircraft',
    lines: [
      'source: opensky-live idle · checkpoint 2026-09-16T15:28:22+00:00 · 1 receipts',
      'processing: opensky.aircraft@1 succeeded',
      'product time: valid instant to 2026-09-16T15:28:16+00:00 (41s before now) · known 35s ago · admitted',
    ],
  },
  {
    label: 'world.weather',
    lines: [
      'source: noaa-live idle · checkpoint 2026-09-16T14:42:55+00:00 · 4 receipts',
      'processing: gfs.temperature-field@1 succeeded',
      'product time: valid instants to 2026-09-16T11:00:00+00:00 (4h before now) · known 46m ago · admitted',
    ],
  },
];

test('a layer\'s reported facts are printed verbatim under the meta line, three per binding, no verdict', () => {
  const restore = installDocument();
  try {
    const layers = [layerRow({ stats: { facts } })];
    const { container } = mountPanel(layers);
    const row = container.querySelector('[data-layer-id="world-model"]');
    assert.match(row.querySelector('.data-toggle-meta').textContent, /^Dataforge World Model · /);
    const block = row.querySelector('.data-toggle-facts');
    assert.equal(block.hidden, false);
    assert.deepEqual(
      block.querySelectorAll('.data-toggle-fact-label').map((n) => n.textContent),
      ['world.aircraft', 'world.weather'],
    );
    const lines = block.querySelectorAll('.data-toggle-fact').map((n) => n.textContent);
    assert.deepEqual(lines, [...facts[0].lines, ...facts[1].lines]);
    for (const line of lines) assert.doesNotMatch(line, /fresh|healthy|verdict|ok\b/i);
    // the meta line itself is unchanged: facts never leak into the feed state
    assert.equal(row.querySelector('.data-toggle-btn').textContent, 'ON');
  } finally {
    restore();
  }
});

test('the facts block follows every refresh and hides when the layer is off or reports nothing', () => {
  const restore = installDocument();
  try {
    const layers = [layerRow({ stats: { facts: null } })];
    const { panel, container } = mountPanel(layers);
    const block = container.querySelector('.data-toggle-facts');
    assert.equal(block.hidden, true, 'nothing reported yet');

    layers[0].stats.facts = facts.slice(0, 1);
    panel._refreshTogglePanel();
    assert.equal(block.hidden, false);
    assert.equal(block.querySelectorAll('.data-toggle-fact').length, 3);

    // a later tick changes a fact: the row shows the new text, not the old
    layers[0].stats.facts = [
      { label: 'world.aircraft', lines: ['source: opensky-live idle · 2 receipts', 'processing: opensky.aircraft@1 unchanged', 'product time: valid instant to T (1m before now)'] },
    ];
    panel._refreshTogglePanel();
    assert.match(block.textContent, /2 receipts/);
    assert.doesNotMatch(block.textContent, /1 receipts/);

    // a failed facts fetch is reported as one more line, never as a feed fault
    layers[0].stats.facts = null;
    layers[0].stats.factsError = 'status unavailable';
    panel._refreshTogglePanel();
    assert.equal(block.hidden, false);
    assert.deepEqual(block.querySelectorAll('.data-toggle-fact').map((n) => n.textContent), ['status: status unavailable']);
    assert.equal(container.querySelector('.data-toggle-btn').textContent, 'ON');

    // off: quiet row
    layers[0].enabled = false;
    layers[0].lifecycleState = 'disabled';
    layers[0].stats.facts = facts;
    panel._refreshTogglePanel();
    assert.equal(block.hidden, true);
    panel.destroy();
  } finally {
    restore();
  }
});

test('a layer without facts renders no block content and an array status never reaches the meta line', () => {
  const restore = installDocument();
  try {
    // A layer that (as the world model once did) puts its fact array in `status`
    // gets neither a facts block nor a garbled meta line.
    const layers = [layerRow({ id: 'legacy', stats: { status: facts } })];
    const { container } = mountPanel(layers);
    const block = container.querySelector('.data-toggle-facts');
    assert.equal(block.hidden, true);
    assert.equal(block.children.length, 0);
    assert.doesNotMatch(container.querySelector('.data-toggle-meta').textContent, /object/i);
  } finally {
    restore();
  }
});
