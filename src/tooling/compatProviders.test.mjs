import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localProviderPlugins } from '../../server/providers/local.js';
import {
  COMPAT_EXCLUDED,
  COMPAT_PROVIDERS,
  COMPAT_UTILITY_ROUTES,
} from '../../server/standalone/compat-providers.js';
import {
  createProviderServer,
  loadDotenvIfPresent,
  mountPlugins,
  pruneTomTomTiles,
} from '../../server/standalone/provider-server.mjs';

/** Routes a plugin registers when mounted through one hook. */
async function registeredRoutes(plugin) {
  const routes = [];
  await mountPlugins([plugin], {
    middlewares: { use: (route) => routes.push(route) },
    httpServer: null,
  });
  return routes;
}

test('the compat ledger accounts for every local provider plugin exactly once', () => {
  const ledger = [
    ...COMPAT_PROVIDERS.map((row) => row.plugin),
    ...COMPAT_UTILITY_ROUTES.map((row) => row.plugin),
    ...COMPAT_EXCLUDED.map((row) => row.plugin),
  ];
  assert.equal(new Set(ledger).size, ledger.length, 'no plugin is listed twice');
  const local = localProviderPlugins().map((plugin) => plugin.name);
  assert.deepEqual([...ledger].sort(), [...local].sort());
});

test('every ledger row names its routes and the tickets that remove it', async () => {
  for (const row of [...COMPAT_PROVIDERS, ...COMPAT_UTILITY_ROUTES]) {
    const plugin = row.create();
    assert.equal(plugin.name, row.plugin, `${row.id} builds its plugin`);
    assert.deepEqual(
      (await registeredRoutes(plugin)).sort(),
      [...row.routes].sort(),
      `${row.id} routes`,
    );
    const owners = row.removedBy ?? [row.exitOwner];
    assert.ok(owners.length && owners.every((key) => /^DWM-\d+$/.test(key)), `${row.id} has an owner`);
  }
  for (const row of COMPAT_EXCLUDED) assert.ok(row.reason, `${row.plugin} records why`);
});

test('a plugin defining both Vite hooks is mounted once, post hooks after all pre hooks', async () => {
  const calls = [];
  const both = {
    name: 'both',
    configureServer: (server) => server.middlewares.use('/api/both'),
    configurePreviewServer: (server) => {
      server.middlewares.use('/api/both');
      return () => calls.push('post:both');
    },
  };
  const objectHook = {
    name: 'object',
    configureServer: { handler: (server) => server.middlewares.use('/api/object') },
  };
  await mountPlugins([both, objectHook], {
    middlewares: { use: (route) => calls.push(route) },
  });
  assert.deepEqual(calls, ['/api/both', '/api/object', 'post:both']);
});

test('the host serves healthz, 404s unknown API routes and tears plugins down before HTTP', async (t) => {
  const order = [];
  const plugin = {
    name: 'fixture-proxy',
    configureServer: (server) => {
      server.middlewares.use('/api/fixture', (_req, res) => res.end('fixture'));
      server.httpServer.on('close', () => order.push('http-close'));
    },
    closeBundle: () => order.push('closeBundle'),
  };
  const log = { info() {}, warn() {}, error() {} };
  const server = await createProviderServer({ plugins: [plugin], log });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close({ forceAfterMs: 100 }));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;

  const health = await fetch(`${base}/healthz`).then((res) => res.json());
  assert.deepEqual(health, { status: 'ok', providers: ['fixture-proxy'] });
  assert.equal(await fetch(`${base}/api/fixture`).then((res) => res.text()), 'fixture');
  const missing = await fetch(`${base}/api/world/x`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Unknown API route' });

  await server.close({ forceAfterMs: 100 });
  assert.deepEqual(order, ['closeBundle', 'http-close']);
});

test('startup prune drops old TomTom tiles and keeps the budget', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'tomtom');
  fs.mkdirSync(dir);
  const now = Date.now();
  const old = new Date(now - 10 * 86_400_000);
  for (const name of ['flow-1-2-3.pbf', 'budget.json']) {
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.utimesSync(path.join(dir, name), old, old);
  }
  fs.writeFileSync(path.join(dir, 'flow-4-5-6.pbf'), 'fresh');

  assert.deepEqual(await pruneTomTomTiles(root, 7, now), ['flow-1-2-3.pbf']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['budget.json', 'flow-4-5-6.pbf']);
  assert.deepEqual(await pruneTomTomTiles(path.join(root, 'absent'), 7, now), []);
});

test('.env fills only unset variables', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-compat-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.env');
  fs.writeFileSync(file, 'A=from-file\nB=from-file\n');
  const env = { A: 'from-env' };
  assert.equal(loadDotenvIfPresent(file, env), true);
  assert.deepEqual(env, { A: 'from-env', B: 'from-file' });
  assert.equal(loadDotenvIfPresent(path.join(root, 'missing'), env), false);
});
