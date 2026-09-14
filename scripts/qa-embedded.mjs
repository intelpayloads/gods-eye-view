#!/usr/bin/env node
/**
 * qa-embedded — the embeddable application in a host page, in a real browser.
 *
 * Serves `tools/embedded-qa/` (a host header + one root element, fixture
 * ProjectionSource, no provider API) from a Vite dev server and drives
 * create -> ready -> world-model renders -> destroy -> create again.
 *
 * Gates:
 *   1. READY      — the embedded application reaches `ready` inside the host root.
 *   2. RENDER     — the world-model layer renders the fixture aircraft.
 *   3. TEARDOWN   — after destroy: root empty, no canvas, body classes, window
 *                   globals, window/document listeners and live intervals are
 *                   back to the pre-start baseline.
 *   4. RE-ENTRY   — a second application starts, renders, and tears down clean.
 *   5. HOST       — the host header keeps its own styles and position.
 *   6. ALL LAYERS — every registered layer (module singletons included) enabled
 *                   with no provider API, then torn down, then a clean restart.
 *
 * Usage: node scripts/qa-embedded.mjs [--port 5188] [--headful] [--verbose] [--cesium-token <token>]
 * (or CESIUM_ION_TOKEN) to start on Google 3D tiles through Cesium ion.
 */
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';

const argv = process.argv;
const port = Number(
  argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : 5188,
);
const root = fileURLToPath(new URL('../', import.meta.url));
const AIRCRAFT = 'world.aircraft/track:opensky:icao24:3c4b33';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(
    `  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`,
  );
}

const server = await createServer({
  root,
  configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
  server: { port, strictPort: true, host: '127.0.0.1' },
  logLevel: 'warn',
});
await server.listen();
const cesiumToken = argv.includes('--cesium-token')
  ? argv[argv.indexOf('--cesium-token') + 1]
  : process.env.CESIUM_ION_TOKEN || '';
const url = `http://127.0.0.1:${port}/tools/embedded-qa/index.html${cesiumToken ? `?cesiumToken=${encodeURIComponent(cesiumToken)}` : ''}`;

const browser = await puppeteer.launch({
  headless: argv.includes('--headful') ? false : 'new',
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--window-size=1440,900',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
  ],
});

// Track live intervals from before any application module runs.
const TRACK_INTERVALS = () => {
  const live = new Set();
  const set = window.setInterval.bind(window);
  const clear = window.clearInterval.bind(window);
  window.setInterval = (...args) => {
    const id = set(...args);
    live.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    live.delete(id);
    return clear(id);
  };
  window.__qaLiveIntervals = () => live.size;
};

async function listenerCounts(page, cdp) {
  const counts = {};
  for (const name of ['window', 'document', 'document.body']) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: name,
    });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId,
    });
    counts[name] = listeners.length;
  }
  return counts;
}

async function snapshot(page, cdp) {
  const dom = await page.evaluate(() => ({
    rootChildren: document.getElementById('host-root').childElementCount,
    rootClass: document.getElementById('host-root').className,
    bodyChildren: document.body.childElementCount,
    bodyClass: document.body.className,
    canvases: document.querySelectorAll('canvas').length,
    viewers: document.querySelectorAll('.cesium-viewer').length,
    globals: Object.keys(window)
      .filter((key) => /^__(gev|godsEye|GOOGLE_MAPS)/.test(key))
      .sort(),
    intervals: window.__qaLiveIntervals(),
    header: (() => {
      const header = document.getElementById('host-header');
      const style = getComputedStyle(header);
      const box = header.getBoundingClientRect();
      return {
        top: box.top,
        height: box.height,
        background: style.backgroundColor,
        font: style.fontFamily,
      };
    })(),
  }));
  return { ...dom, listeners: await listenerCounts(page, cdp) };
}

async function waitFor(page, fn, what, timeout = 120_000, ...args) {
  try {
    await page.waitForFunction(fn, { timeout, polling: 250 }, ...args);
    return true;
  } catch {
    console.log(`    timed out waiting for ${what}`);
    return false;
  }
}

async function cycle(page, cdp, label, baseline, { allLayers = false } = {}) {
  const status = await page.evaluate(() => window.__embeddedQa.create());
  check(`${label}: READY`, status === 'ready', status);
  const inRoot = await page.evaluate(
    () =>
      !!document.querySelector('#host-root .cesium-viewer') &&
      !!document.querySelector('#host-root #data-toggles'),
  );
  check(`${label}: viewer and chrome live inside the host root`, inRoot);
  const header = await page.evaluate(() => {
    const box = document.getElementById('host-header').getBoundingClientRect();
    const title = document.getElementById('title-bar')?.getBoundingClientRect();
    return {
      headerTop: box.top,
      headerHeight: box.height,
      titleTop: title?.top ?? null,
    };
  });
  check(
    `${label}: HOST header unchanged and chrome laid out below it`,
    header.headerTop === 0 &&
      header.headerHeight === 64 &&
      header.titleTop !== null &&
      header.titleTop >= 64,
    header,
  );
  check(
    `${label}: world-model layer enabled`,
    await page.evaluate(() => window.__embeddedQa.enableWorldModel()),
  );
  const rendered = await waitFor(
    page,
    (id) => window.__embeddedQa.renderedIds().includes(id),
    'fixture aircraft',
    60_000,
    AIRCRAFT,
  );
  check(`${label}: RENDER fixture aircraft`, rendered);
  if (allLayers) {
    const outcomes = await page.evaluate(() =>
      window.__embeddedQa.enableAllLayers(),
    );
    const threw = Object.entries(outcomes).filter(([, o]) => o?.threw);
    check(
      `${label}: every layer enables or reports without throwing`,
      threw.length === 0,
      threw.length ? threw : Object.keys(outcomes).length,
    );
    // Let enabled layers run their first refresh against the absent provider API.
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  const destroyed = await page.evaluate(() => window.__embeddedQa.destroy());
  check(`${label}: destroyed`, destroyed === 'destroyed', destroyed);
  if (destroyed !== 'destroyed') throw new Error(`${label}: destroy failed`);
  // Let deferred work (transitions, microtasks, pending timeouts) settle.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = await snapshot(page, cdp);
  for (const key of [
    'rootChildren',
    'rootClass',
    'bodyChildren',
    'bodyClass',
    'canvases',
    'viewers',
    'globals',
    'intervals',
    'listeners',
    'header',
  ]) {
    const same = JSON.stringify(after[key]) === JSON.stringify(baseline[key]);
    check(
      `${label}: TEARDOWN ${key} back to baseline`,
      same,
      same ? undefined : { baseline: baseline[key], after: after[key] },
    );
  }
}

let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 836 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    if (
      argv.includes('--verbose') &&
      ['warn', 'warning', 'error'].includes(message.type())
    )
      console.log(
        `    browser ${message.type()}: ${message.text().slice(0, 400)}`,
      );
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.evaluateOnNewDocument(TRACK_INTERVALS);
  const cdp = await page.createCDPSession();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__embeddedQa, { timeout: 120_000 });
  const baseline = await snapshot(page, cdp);
  console.log('  baseline', JSON.stringify(baseline));

  await cycle(page, cdp, 'first', baseline);
  await cycle(page, cdp, 'second', baseline);
  await cycle(page, cdp, 'all-layers', baseline, { allLayers: true });
  await cycle(page, cdp, 'after-all-layers', baseline);
  const renderErrors = await page.evaluate(() => window.__renderErrors);
  check(
    'no render errors',
    renderErrors.length === 0,
    renderErrors.slice(0, 3),
  );
  check('no page errors', errors.length === 0, errors.slice(0, 10));
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
process.exitCode = failed.length || exitCode ? 1 : 0;
