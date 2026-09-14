#!/usr/bin/env node
/**
 * world-model-stub — a tiny world-model backplane over the retained
 * Experiment 002 fixtures, for QA without Postgres.
 *
 * Serves GET /heads, /revisions, /status, /provenance/{ref} and POST /project
 * from `src/layers/worldModel/fixtures/`. Knobs (query string or JSON body):
 *   ?delay=<ms>          on /project: hold the response (so an OLDER request can resolve
 *                        AFTER a newer one — the ordering gate)
 *   POST /__control {"advance": true}   append a child revision to the chain (head moves)
 *   POST /__control {"reset": true}     back to the fixture chain
 *   GET  /__control                     request log (what the layer asked for)
 *
 * /project honours the demand it is given: `requested_layers` filters bindings,
 * `spatial_scope.bbox` filters positions, a `temporal_age` policy marks or
 * withholds points by `valid_at` − `time.sampled_at` (the same rule the real
 * backplane applies to representations declaring the capability), and a
 * revision id that is not in the chain is a 404. Nothing else is interpreted.
 *
 * Usage: node scripts/world-model-stub.mjs [--port 8099]
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const argv = process.argv;
const port = Number(
  argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : 8099,
);
const read = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../src/layers/worldModel/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
const projection = read('experiment-002.projection.json');
const revisions = read('experiment-002.revisions.json');
const status = read('experiment-002.status.json');
const provenance = {
  aircraft: read('experiment-002.provenance.aircraft.json'),
  weather: read('experiment-002.provenance.weather.json'),
};
const HEAD = 'world/main';

let chain = [...revisions.revisions];
const log = [];

function advance() {
  const head = chain[0];
  const id = `advanced${String(chain.length).padStart(28, '0')}`;
  chain = [
    {
      ...head,
      id,
      parent_id: head.id,
      created_at: new Date().toISOString(),
    },
    ...chain,
  ];
  return id;
}

function json(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function inside(bbox, position) {
  if (!bbox) return true;
  const [w, s, e, n] = bbox;
  return (
    position.lon >= w &&
    position.lon <= e &&
    position.lat >= s &&
    position.lat <= n
  );
}

function project(body) {
  const revisionId = body.revision_id || chain[0].id;
  if (!chain.some((r) => r.id === revisionId)) return null;
  const query = body.query || {};
  const spec = body.projection_spec || {};
  const layers = query.requested_layers || null;
  const bbox = query.spatial_scope?.bbox || null;
  const validAt = query.valid_at ? Date.parse(query.valid_at) : NaN;
  const policy = spec.projection_policy?.temporal_age || null;
  const keep = (item) =>
    (!layers || layers.includes(item.binding)) && inside(bbox, item.position);
  const assumptions = projection.assumptions.filter(
    (a) => a.kind !== 'revision',
  );
  assumptions.unshift({
    kind: 'revision',
    revision_id: revisionId,
    head: body.revision_id ? null : HEAD,
    resolved_at: new Date().toISOString(),
  });
  const omissions = [...projection.omissions];
  let points = projection.points.filter(keep);
  if (policy && Number.isFinite(validAt)) {
    let marked = 0;
    const withheld = [];
    points = points.flatMap((p) => {
      const basis = Date.parse(p.time.sampled_at);
      const age = (validAt - basis) / 1000;
      const stale = age > policy.threshold_seconds;
      if (policy.mode === 'withhold' && stale) {
        withheld.push(p.id);
        return [];
      }
      const time = { ...p.time, age_at_query_seconds: age };
      if (policy.mode === 'mark') {
        time.stale = stale;
        marked += stale ? 1 : 0;
      }
      return [{ ...p, time }];
    });
    assumptions.push({
      kind: 'projection-policy',
      policy: 'temporal_age',
      mode: policy.mode,
      threshold_seconds: policy.threshold_seconds,
      age_basis: 'sample_at',
      binding: 'world.aircraft',
      marked,
      withheld: withheld.length,
    });
    if (withheld.length)
      omissions.push({
        binding: 'world.aircraft',
        reason: 'temporal-age-withheld',
        count: withheld.length,
        item_ids: withheld,
        threshold_seconds: policy.threshold_seconds,
        age_basis: 'sample_at',
      });
    assumptions.push({
      kind: 'policy-not-applicable',
      policy: 'temporal_age',
      binding: 'world.weather',
      reason: 'policy-not-declared',
      declared_capabilities: ['sample', 'annotation'],
    });
  }
  const samples = projection.field_samples.filter(keep);
  const annotations =
    layers && !layers.includes('world.weather') ? [] : projection.annotations;
  return {
    ...projection,
    revision_id: revisionId,
    query: { ...projection.query, ...query },
    projection_spec: { ...projection.projection_spec, ...spec },
    counts: {
      ...projection.counts,
      points: points.length,
      field_samples: samples.length,
      annotations: annotations.length,
      assumptions: assumptions.length,
      omissions: omissions.length,
    },
    points,
    field_samples: samples,
    annotations,
    assumptions,
    omissions,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;
  let body = null;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return json(res, 400, { error: 'invalid-json' });
    }
  }
  log.push({
    at: Date.now(),
    method: req.method,
    path,
    search: url.search,
    body,
  });
  if (path === '/__control') {
    if (req.method === 'GET') return json(res, 200, { chain, log });
    if (body?.advance) return json(res, 200, { advanced: advance(), chain });
    if (body?.reset) {
      chain = [...revisions.revisions];
      log.length = 0;
      return json(res, 200, { chain });
    }
    return json(res, 400, { error: 'unknown control' });
  }
  if (path === '/healthz') return json(res, 200, { ok: true });
  if (path === '/heads') return json(res, 200, { [HEAD]: chain[0].id });
  if (path === '/revisions') {
    const limit = Number(url.searchParams.get('limit') || 10);
    const head = url.searchParams.get('head') || HEAD;
    if (head !== HEAD)
      return json(res, 404, {
        error: 'not-found',
        message: `head ${head} not set`,
      });
    return json(res, 200, { head, revisions: chain.slice(0, limit) });
  }
  if (path === '/status') {
    return json(res, 200, {
      ...status,
      now: new Date().toISOString(),
      head: {
        ...status.head,
        revision_id: chain[0].id,
        parent_id: chain[0].parent_id,
      },
    });
  }
  if (path.startsWith('/provenance/')) {
    const ref = decodeURIComponent(path.slice('/provenance/'.length));
    const report = ref.startsWith('aircraft.')
      ? provenance.aircraft
      : ref.startsWith('weather.')
        ? provenance.weather
        : null;
    if (!report)
      return json(res, 404, {
        error: 'not-found',
        message: `no product registered as ${ref}`,
      });
    return json(res, 200, report);
  }
  if (path === '/project' && req.method === 'POST') {
    const delay = Number(url.searchParams.get('delay') || body?.__delay || 0);
    const result = project(body || {});
    if (!result)
      return json(res, 404, {
        error: 'not-found',
        message: `revision ${body?.revision_id} not found`,
      });
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return json(res, 200, result);
  }
  json(res, 404, { error: 'not-found', message: `no route ${path}` });
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    `world-model-stub listening on http://127.0.0.1:${port} (head ${HEAD} -> ${chain[0].id.slice(0, 8)})`,
  );
});
