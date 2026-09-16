#!/usr/bin/env node
/**
 * qa-world-model — DWM-9 interaction semantics, in the browser, against the
 * fixture stub backplane (`scripts/world-model-stub.mjs`).
 *
 * Gates:
 *   1. ORDERING — an older projection that resolves AFTER a newer one cannot
 *      overwrite it (the stub holds one request with ?delay= via a fetch shim).
 *   2. REPLAY   — pin the revision on screen; move the head (stub /__control
 *      advance); the pinned view keeps its revision and reports headAdvanced;
 *      a layer filter (weather only) is served from the pinned revision; go
 *      live follows the new head with both bindings.
 *   3. INSPECT  — click a point: the card carries the admitted descriptor
 *      (semantic type, access kind, representation capabilities) and lineage.
 *   4. STATUS   — three separate status lines per binding, no verdict.
 *   5. EXTENSION — a synthetic third binding injected by the stub-side fetch
 *      shim renders as points with no layer change.
 *
 * Usage: node scripts/qa-world-model.mjs [--url http://localhost:4173] [--stub-port 8099]
 * Starts the stub itself; expects a dev/preview server whose /api/world proxy
 * points at WORLD_API_URL=http://127.0.0.1:<stub-port> (see package.json:
 * `WORLD_API_URL=http://127.0.0.1:8099 npm run preview`).
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const argv = process.argv;
const url = argv.includes('--url')
  ? argv[argv.indexOf('--url') + 1]
  : 'http://localhost:4173';
const stubPort = Number(
  argv.includes('--stub-port') ? argv[argv.indexOf('--stub-port') + 1] : 8099,
);
const LAYER_ID = 'world-model';
const STUB = `http://127.0.0.1:${stubPort}`;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(
    `  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`,
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stub = spawn(
  process.execPath,
  [
    new URL('./world-model-stub.mjs', import.meta.url).pathname,
    '--port',
    String(stubPort),
  ],
  { stdio: 'inherit' },
);
await sleep(800);
const control = async (body) =>
  (
    await fetch(
      `${STUB}/__control`,
      body ? { method: 'POST', body: JSON.stringify(body) } : {},
    )
  ).json();
await control({ reset: true });

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1440,900',
    '--disable-background-timer-throttling',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  page.on('console', (m) => {
    if (/WorldModel/.test(m.text())) console.log('    browser:', m.text());
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, {
    timeout: 90_000,
  });
  await sleep(10_000); // boot flyTo + deferred init

  // Park over the Bay Area (the fixture's extent) and disable every other layer.
  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    v.camera.cancelFlight();
    v.camera.setView({
      destination:
        window.Cesium?.Cartesian3?.fromDegrees?.(-122, 38, 400_000) ??
        v.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: (-122 * Math.PI) / 180,
          latitude: (38 * Math.PI) / 180,
          height: 400_000,
        }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled) {
        try {
          await gev.dataManager.setEnabled(id, false, { origin: 'user' });
        } catch {
          /* counted later */
        }
      }
    }
  });
  await sleep(2_000);

  // Fetch shim inside the page: adds ?delay= to the FIRST /project call and
  // injects a synthetic third binding into every projection (extension gate).
  await page.evaluate(() => {
    const native = window.fetch.bind(window);
    window.__wmShim = { delayed: 0, projections: 0 };
    window.fetch = async (input, init) => {
      let target = typeof input === 'string' ? input : input.url;
      if (target.includes('/api/world/project') && init?.method === 'POST') {
        window.__wmShim.projections++;
        if (window.__wmShim.delayNext) {
          window.__wmShim.delayNext = false;
          window.__wmShim.delayed++;
          target += (target.includes('?') ? '&' : '?') + 'delay=2500';
        }
        const response = await native(target, init);
        const body = await response.json();
        const vessels = Array.from({ length: 3 }, (_, i) => ({
          id: `world.vessels/track:ais:mmsi:${i}`,
          binding: 'world.vessels',
          position: { lon: -122.3 + i * 0.05, lat: 37.6, height_m: 12 + i },
          frame: 'WGS84',
          height: {
            value_m: 12 + i,
            source_field: 'antenna_height_m',
            assumption: 'vessel_height:antenna-above-msl-as-ellipsoid',
            interpretation: 'explicit-grant',
          },
          time: {
            valid_at: body.query?.valid_at,
            sampled_at: body.query?.valid_at,
          },
          semantic_ref: {
            product_ref: {
              type_id: 'test.vessels.v1',
              content_id: 'sha256:' + 'a'.repeat(64),
            },
            descriptor_id: 'd-m',
            type_id: 'test.vessels.v1',
            semantic_identity: `track:ais:mmsi:${i}`,
          },
          source_ref: {
            source: { type_id: 'source.ais.nmea.v1', content_id: 'sha256:a' },
            row_index: i,
          },
          properties: { mmsi: String(i), fix_quality: 'gnss' },
        }));
        const layers = body.query?.requested_layers;
        if (!layers || layers.includes('world.vessels'))
          body.points = [...body.points, ...vessels];
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      return native(input, init);
    };
  });

  const stats = () =>
    page.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.layers.get(id)?.module?.getStats?.() ||
        null,
      LAYER_ID,
    );
  const waitFor = async (predicate, timeout = 30_000) => {
    const t0 = Date.now();
    for (;;) {
      const s = await stats();
      if (s && predicate(s)) return s;
      if (Date.now() - t0 > timeout) return s;
      await sleep(200);
    }
  };

  await page.evaluate(async (id) => {
    await window.__godsEyeView.dataManager.setEnabled(id, true, {
      origin: 'user',
    });
  }, LAYER_ID);
  let s = await waitFor((x) => x.count > 0);
  check(
    'layer renders from the stub with a viewport scope',
    s?.count > 0 && s.spatialScope === 'viewport',
    { count: s?.count, scope: s?.spatialScope, bbox: s?.bbox },
  );
  check(
    'synthetic third binding renders as points (extension)',
    (s?.perBinding || []).some(
      (b) => b.binding === 'world.vessels' && b.points === 3,
    ),
    s?.perBinding,
  );
  check(
    'mode is LIVE with wall-clock valid_at',
    s?.mode === 'LIVE' && /Z$/.test(s?.validAt || ''),
    { mode: s?.mode, validAt: s?.validAt },
  );

  // ── 1. ORDERING: delay the next projection, then move the camera again ──
  await page.evaluate(() => {
    window.__wmShim.delayNext = true;
  });
  const ordering = await page.evaluate(async (id) => {
    const gev = window.__godsEyeView;
    const module = gev.dataManager.layers.get(id).module;
    module.setParams({ bbox: [-123, 37, -121, 39] }); // request A (delayed 2.5 s by the shim)
    await new Promise((r) => setTimeout(r, 400)); // let the debounce issue it
    module.setParams({ bbox: [-122.6, 37.6, -122, 38] }); // request B (fast)
    await new Promise((r) => setTimeout(r, 1200));
    const afterB = {
      bbox: module.getStats().bbox,
      count: module.getStats().count,
    };
    await new Promise((r) => setTimeout(r, 3000)); // A would land now if it could
    const afterA = {
      bbox: module.getStats().bbox,
      count: module.getStats().count,
      requests: module.getStats().requests,
    };
    return { afterB, afterA, shim: window.__wmShim };
  }, LAYER_ID);
  check(
    'older delayed response cannot overwrite the newer viewport',
    ordering.afterA.bbox?.[0] === -122.6 &&
      ordering.afterB.bbox?.[0] === -122.6 &&
      ordering.afterA.count === ordering.afterB.count,
    ordering,
  );
  check(
    'superseded request was discarded, not applied',
    (ordering.afterA.requests?.discarded || 0) >= 1,
    ordering.afterA.requests,
  );

  // ── 2. REPLAY: pin, advance head, weather-only from the pin, go live ──
  await page.evaluate((id) => {
    window.__godsEyeView.dataManager.layers
      .get(id)
      .module.setParams({ bbox: [-123, 37, -121, 39] });
  }, LAYER_ID);
  await sleep(1500);
  const pinnedRev = (await stats()).revisionId;
  await page.evaluate(
    (id, rev) =>
      window.__godsEyeView.dataManager.setLayerParams(
        id,
        { follow: 'pinned', revisionId: rev },
        { origin: 'user' },
      ),
    LAYER_ID,
    pinnedRev,
  );
  await sleep(800);
  const advanced = await control({ advance: true });
  await page.evaluate(async (id) => {
    await window.__godsEyeView.dataManager.layers
      .get(id)
      .module.update(window.__godsEyeView.viewer, {});
  }, LAYER_ID);
  s = await stats();
  check(
    'pin keeps its revision while the head advances; headAdvanced is reported',
    s.mode === 'PINNED' &&
      s.revisionId === pinnedRev &&
      s.headRevisionId === advanced.advanced &&
      s.headAdvanced === true,
    {
      mode: s.mode,
      revisionId: s.revisionId,
      head: s.headRevisionId,
      headAdvanced: s.headAdvanced,
    },
  );
  const chips = await page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.layers
        .get(id)
        .module.getRowControls()
        .chips.map((c) => c.id),
    LAYER_ID,
  );
  check(
    'go-live chip appears only once the head moved past the pin',
    chips.includes('go-live'),
    chips,
  );
  await page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.setLayerParams(
        id,
        { layers: ['world.weather'] },
        { origin: 'user' },
      ),
    LAYER_ID,
  );
  s = await waitFor(
    (x) =>
      x.revisionId === pinnedRev &&
      (x.perBinding || []).every((b) => b.binding === 'world.weather'),
  );
  check(
    'a layer filter is served from the PINNED revision (no refetch of the head)',
    s.revisionId === pinnedRev &&
      s.perBinding.length === 1 &&
      s.perBinding[0].binding === 'world.weather',
    { revisionId: s.revisionId, perBinding: s.perBinding },
  );
  await page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.setLayerParams(
        id,
        { follow: 'live', layers: null },
        { origin: 'user' },
      ),
    LAYER_ID,
  );
  s = await waitFor(
    (x) =>
      x.revisionId === advanced.advanced && (x.perBinding || []).length >= 2,
  );
  check(
    'go live follows the advanced head with every binding',
    s.mode === 'LIVE' &&
      s.revisionId === advanced.advanced &&
      s.perBinding.length >= 2 &&
      !s.headAdvanced,
    { mode: s.mode, revisionId: s.revisionId, perBinding: s.perBinding },
  );

  // ── policy: withhold at +60 s hides every fixture point, weather untouched ──
  await page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.setLayerParams(
        id,
        { policy: 'withhold', validAt: '2026-09-10T22:58:25Z' },
        { origin: 'user' },
      ),
    LAYER_ID,
  );
  s = await waitFor((x) => x.policy === 'withhold' && x.withheld > 0);
  check(
    'withhold policy: withheld count comes from omissions, weather keeps its samples',
    s.withheld > 0 &&
      (s.perBinding.find((b) => b.binding === 'world.weather')?.samples ||
        0) === 81 &&
      s.policies.some(
        (p) =>
          p.kind === 'policy-not-applicable' && p.binding === 'world.weather',
      ),
    {
      withheld: s.withheld,
      policies: s.policies.length,
      perBinding: s.perBinding,
    },
  );
  await page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.setLayerParams(
        id,
        { policy: 'off', validAt: null },
        { origin: 'user' },
      ),
    LAYER_ID,
  );
  s = await waitFor((x) => x.policy === 'off' && x.withheld === 0);

  // ── 3. INSPECT: descriptor block on the card ──
  const card = await page.evaluate(async (id) => {
    const module = window.__godsEyeView.dataManager.layers.get(id).module;
    const target = module
      .getRenderedIds()
      .find((x) => x.startsWith('world.aircraft/'));
    module.selectById(target);
    await new Promise((r) => setTimeout(r, 1500));
    // Paint is decided per frame: ask for one and read the host afterwards.
    window.__godsEyeView.viewer.scene.requestRender?.();
    await new Promise((r) => setTimeout(r, 500));
    const diag = window.__gevWorldOverlay?.getDiagnostics?.() || {};
    return {
      target,
      selected: module.getSelectedId(),
      hostEntries: diag.entriesBySource?.[id] || 0,
      painted: diag.paintedBySource?.[id] || 0,
    };
  }, LAYER_ID);
  // The overlay host holds the card; read its details through the layer's own card builder.
  const details = await page.evaluate(async (id) => {
    const module = window.__godsEyeView.dataManager.layers.get(id).module;
    const record = module.getRenderedRecord(module.getSelectedId());
    const ref = `${record.record.semantic_ref.product_ref.type_id}@${record.record.semantic_ref.product_ref.content_id}`;
    const report = await (
      await fetch(
        `/api/world/provenance/${encodeURIComponent(ref)}?follow=source&depth=8`,
      )
    ).json();
    return {
      descriptorFound: report.descriptors.some(
        (d) => d.id === record.record.semantic_ref.descriptor_id,
      ),
      sources: report.sources.length,
      run: report.transform_run?.transformation,
    };
  }, LAYER_ID);
  check(
    'click selects a point (one protected card is published by the layer)',
    card.selected === card.target && card.hostEntries === 1,
    card,
  );
  // The card must reach the paint stage: a card whose lines are wider than
  // the gap between the HUD corners is held by the host but never drawn (DWM-60).
  check('the selected card paints', card.painted === 1, card);
  check(
    'the admitted descriptor for the served item is resolvable with lineage',
    details.descriptorFound &&
      details.sources >= 1 &&
      /materialize/.test(details.run || ''),
    details,
  );

  // ── 4. STATUS: three separate lines per binding ──
  s = await stats();
  const factsOk =
    Array.isArray(s.facts) &&
    s.facts.length >= 2 &&
    s.facts.every(
      (group) =>
        group.lines.length === 3 &&
        group.lines[0].startsWith('source:') &&
        group.lines[1].startsWith('processing:') &&
        group.lines[2].startsWith('product time:') &&
        !/verdict|healthy|fresh/i.test(group.lines.join(' ')),
    );
  check(
    'status is three separate fact lines per binding, no verdict',
    factsOk,
    s.facts,
  );
  // The Data Layers row prints those facts verbatim under its meta line (DWM-60).
  const rowFacts = await page.evaluate((id) => {
    const block = document.querySelector(
      `[data-layer-id="${id}"] .data-toggle-facts`,
    );
    const texts = (selector) =>
      [...(block?.querySelectorAll(selector) || [])].map((n) => n.textContent);
    return {
      hidden: block?.hidden ?? null,
      labels: texts('.data-toggle-fact-label'),
      lines: texts('.data-toggle-fact'),
    };
  }, LAYER_ID);
  check(
    'the layer row shows the status facts under the meta line',
    rowFacts.hidden === false &&
      rowFacts.labels.includes('world.aircraft') &&
      ['source:', 'processing:', 'product time:'].every((prefix) =>
        rowFacts.lines.some((l) => l.startsWith(prefix)),
      ),
    rowFacts,
  );

  // OFF must clear, ON must restore.
  const cycle = await page.evaluate(async (id) => {
    const gev = window.__godsEyeView;
    await gev.dataManager.setEnabled(id, false, { origin: 'user' });
    await new Promise((r) => setTimeout(r, 800));
    const off = gev.dataManager.layers.get(id).module.getStats().count;
    await gev.dataManager.setEnabled(id, true, { origin: 'user' });
    const t0 = performance.now();
    let on = 0;
    while (performance.now() - t0 < 20_000) {
      on = gev.dataManager.layers.get(id).module.getStats().count;
      if (on > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { off, on };
  }, LAYER_ID);
  check('re-enable restores the projection', cycle.on > 0, cycle);
} finally {
  await browser.close();
  stub.kill();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-world-model: ${passed}/${results.length} passed`);
console.log(
  `RESULT: ${passed} passed, ${results.length - passed} failed, 0 skipped`,
);
process.exit(passed === results.length ? 0 : 1);
