import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  apiUrl,
  assetUrl,
  configureEndpoints,
  EndpointUnavailableError,
  isApiAvailable,
  resetEndpoints,
} from '../sources/endpoints.js';
import { configureHostElement, hostElement } from '../app/host.js';
import { acquirePageOwnership, pageOwner } from '../standalone/ownership.js';
import {
  CSS_PATH,
  MARKUP_PATH,
  generateEmbeddedAssets,
  scopeSelector,
} from '../../scripts/generate-embedded-assets.mjs';

const repo = new URL('../../', import.meta.url);

test('provider API paths are unchanged by default and prefixed or refused when configured', () => {
  resetEndpoints();
  assert.equal(apiUrl('/api/opensky?lat=1'), '/api/opensky?lat=1');
  assert.equal(isApiAvailable(), true);

  const restore = configureEndpoints({ apiBaseUrl: 'http://localhost:8200/' });
  assert.equal(apiUrl('/api/launches'), 'http://localhost:8200/api/launches');
  restore();
  assert.equal(apiUrl('/api/launches'), '/api/launches');

  const restoreAbsent = configureEndpoints({ apiBaseUrl: null });
  assert.equal(isApiAvailable(), false);
  assert.throws(() => apiUrl('/api/firms'), EndpointUnavailableError);
  restoreAbsent();
  assert.equal(isApiAvailable(), true);
});

test('a stale restore does not undo a newer endpoint configuration', () => {
  resetEndpoints();
  const restoreFirst = configureEndpoints({ apiBaseUrl: '/a' });
  configureEndpoints({ apiBaseUrl: '/b' });
  restoreFirst();
  assert.equal(apiUrl('/api/x'), '/b/api/x');
  resetEndpoints();
});

test('static assets resolve under the configured asset base', () => {
  resetEndpoints();
  assert.equal(assetUrl('/models/airplane.glb'), '/models/airplane.glb');
  const restore = configureEndpoints({ assetBaseUrl: 'assets/gods-eye/' });
  assert.equal(
    assetUrl('/models/airplane.glb'),
    'assets/gods-eye/models/airplane.glb',
  );
  restore();
});

test('runtime-created floating DOM goes to the host element while one is configured', () => {
  const body = { id: 'body' };
  const root = { id: 'root' };
  const previousDocument = globalThis.document;
  globalThis.document = { body };
  try {
    assert.equal(hostElement(), body);
    const restore = configureHostElement(root);
    assert.equal(hostElement(), root);
    restore();
    assert.equal(hostElement(), body);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('one application owns the page at a time and ownership is released for the next', () => {
  const release = acquirePageOwnership('first');
  assert.equal(pageOwner(), 'first');
  assert.throws(() => acquirePageOwnership('second'), /"first" already owns/);
  release();
  release(); // idempotent
  assert.equal(pageOwner(), null);
  const releaseSecond = acquirePageOwnership('second');
  assert.equal(pageOwner(), 'second');
  releaseSecond();
});

test('embedded markup and scoped stylesheet are generated from index.html and style.css', async () => {
  const outputs = await generateEmbeddedAssets();
  for (const file of [MARKUP_PATH, CSS_PATH]) {
    const committed = await readFile(new URL(file, repo), 'utf8');
    assert.equal(
      committed === outputs[file],
      true,
      `${file} is stale: run node scripts/generate-embedded-assets.mjs`,
    );
  }
  const { APPLICATION_MARKUP } = await import('./markup.js');
  assert.match(APPLICATION_MARKUP, /id="cesiumContainer"/);
  assert.match(APPLICATION_MARKUP, /id="loading-screen"/);
  assert.doesNotMatch(APPLICATION_MARKUP, /<script/i);
});

test('stylesheet scoping keeps application state classes on body and targets under the root', () => {
  assert.equal(scopeSelector(':root'), '.gods-eye-root');
  assert.equal(scopeSelector('html'), '.gods-eye-root');
  assert.equal(scopeSelector('body'), '.gods-eye-root');
  assert.equal(scopeSelector('*'), '.gods-eye-root *');
  assert.equal(scopeSelector('#title-bar h1'), '.gods-eye-root #title-bar h1');
  assert.equal(
    scopeSelector('body.ui-clean-view #title-bar'),
    'body.ui-clean-view .gods-eye-root #title-bar',
  );
  assert.equal(
    scopeSelector('body.cockpit-mode:has(#left-panel-stack .x) #a > b'),
    'body.cockpit-mode:has(#left-panel-stack .x) .gods-eye-root #a > b',
  );
  assert.equal(scopeSelector('body > #x'), '.gods-eye-root > #x');
  assert.equal(scopeSelector('.bodyish'), '.gods-eye-root .bodyish');
});

test('the embedded application boundary owns browser modules only', async () => {
  const groups = JSON.parse(
    await readFile(new URL('scripts/package-boundaries.json', repo), 'utf8'),
  );
  const pkg = JSON.parse(await readFile(new URL('package.json', repo), 'utf8'));
  const group = groups['embedded-application'];
  assert.deepEqual(group.exports, ['./application/embedded']);
  assert.equal(
    pkg.exports['./application/embedded'],
    './src/embedded/application.js',
  );
  assert.equal(group.runtime, undefined, 'a browser group');
  assert.ok(group.modules.includes('src/embedded/application.js'));
  const forbidden = group.modules.filter(
    (module) =>
      !module.startsWith('src/') ||
      /(^|\/)(server|build|providers?)\//.test(module) ||
      /keySetupServer|vite/i.test(module),
  );
  assert.deepEqual(forbidden, []);
  assert.ok(!group.external.includes('vite'));
  assert.ok(!group.external.includes('ws'));
  assert.ok(!group.external.includes('connect'));
});

test('chrome asset references resolve under the host asset base', async () => {
  const { renderApplicationMarkup, APPLICATION_MARKUP } =
    await import('./chrome.js');
  assert.equal(renderApplicationMarkup(), APPLICATION_MARKUP);
  const rendered = renderApplicationMarkup('assets/gods-eye/');
  assert.match(rendered, /data-logo-src="assets\/gods-eye\/logo\.svg"/);
  assert.match(rendered, /src="assets\/gods-eye\/pin\.svg"/);
  assert.doesNotMatch(rendered, /(src|data-logo-src)="\/(?!\/)/);
});

// Start/destroy/restart of the real application is a browser concern:
// scripts/qa-embedded.mjs drives it (READY, RENDER, TEARDOWN, RE-ENTRY).
