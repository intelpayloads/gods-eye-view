import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { APPLICATION_MARKUP } from './markup.js';
import { EMBEDDED_HIDDEN_CHROME, presentationCss } from './presentation.js';
import { EMBEDDED_PANEL_LABELS, EMBEDDED_HIDDEN_LAYER_IDS } from './options.js';
import { REGISTERED_LAYER_IDS } from '../data/layerState.js';
import { DetachedShareLink } from '../sharelink.js';
import { STANDALONE_FEATURES } from '../standalone/features.js';
import { PANEL_SECTIONS, panelOrder } from '../ui/layerPanel.js';

const embeddedFeatures = () =>
  readFileSync(new URL('./application.js', import.meta.url), 'utf8');

test('every chrome element the embed hides exists in the markup it ships', () => {
  assert.ok(EMBEDDED_HIDDEN_CHROME.length > 0);
  for (const id of EMBEDDED_HIDDEN_CHROME)
    assert.ok(
      APPLICATION_MARKUP.includes(`id="${id}"`) ||
        APPLICATION_MARKUP.includes(`id=\\"${id}\\"`),
      `#${id} is not in the application markup`,
    );
  const css = presentationCss('gods-eye-root');
  for (const id of EMBEDDED_HIDDEN_CHROME)
    assert.match(css, new RegExp(`\\.gods-eye-root #${id} \\{ display: none`));
});

test('the layer panel and place search stay: the embed keeps connectors and configuration', () => {
  for (const id of ['data-panel', 'data-toggles', 'location-bar'])
    assert.ok(!EMBEDDED_HIDDEN_CHROME.includes(id), `#${id} must stay`);
});

test('the embed turns off the scope vignette and the share link the standalone keeps', () => {
  assert.equal(STANDALONE_FEATURES.scopeMask, true);
  assert.equal(STANDALONE_FEATURES.shareLink, true);
  const source = embeddedFeatures();
  assert.match(source, /shareLink: false/);
  assert.match(source, /scopeMask: false/);
});

test('the detached share link answers every call the shell makes on a share link', () => {
  const called = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js'))
        for (const [, method] of readFileSync(path, 'utf8').matchAll(
          /shareLinkManager\??\.([a-zA-Z_]+)\s*\(/g,
        ))
          called.add(method);
    }
  };
  walk(new URL('../', import.meta.url));
  assert.ok(called.size > 5, 'the scan found the shell calls');
  const detached = new DetachedShareLink();
  for (const method of called)
    assert.equal(
      typeof detached[method],
      'function',
      `DetachedShareLink lacks ${method}`,
    );
  assert.equal(detached.parseInitialHash(), null);
});

test('every shown embedded layer has a panel section; the generic world-model row is not shown', () => {
  assert.ok(EMBEDDED_HIDDEN_LAYER_IDS.includes('world-model'));
  const shown = REGISTERED_LAYER_IDS.filter(
    (id) => !EMBEDDED_HIDDEN_LAYER_IDS.includes(id),
  );
  assert.ok(shown.length > 0);
  for (const id of shown)
    assert.ok(
      PANEL_SECTIONS.includes(EMBEDDED_PANEL_LABELS[id]?.section),
      `${id} has no panel section`,
    );
});

test('the panel orders rows by section and stays flat when no row names one', () => {
  const row = (id, panelSection = null) => ({
    id,
    panelSection,
    showInTogglePanel: true,
  });
  const ordered = panelOrder(
    [
      row('dams', 'Reference'),
      row('weather', 'Observed'),
      row('flights', 'Connectors'),
      row('run', 'Simulated'),
      row('hidden', 'Connectors'),
    ].map((r) => (r.id === 'hidden' ? { ...r, showInTogglePanel: false } : r)),
  );
  assert.equal(ordered.sectioned, true);
  assert.deepEqual(
    ordered.layers.map((r) => r.id),
    ['flights', 'weather', 'run', 'dams'],
  );
  const flat = panelOrder([row('b'), row('a')]);
  assert.equal(flat.sectioned, false);
  assert.deepEqual(
    flat.layers.map((r) => r.id),
    ['b', 'a'],
  );
});
