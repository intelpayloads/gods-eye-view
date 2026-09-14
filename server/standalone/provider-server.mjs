import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import connect from 'connect';
import { apiNotFoundPlugin } from './api-not-found.js';
import { compatProviderPlugins } from './compat-providers.js';

/**
 * gods-eye-compat provider server (DWM-34): the Gods Eye provider plugins
 * hosted without Vite, for the transitional Kubernetes service. The plugins
 * are unchanged Vite plugins; this host gives them the two things they use,
 * `server.middlewares` (connect, as in Vite) and `server.httpServer`.
 */

const DEFAULT_PORT = 8200;
const DAY_MS = 86_400_000;

/** Copy `.env` values into process.env without overriding the environment. */
export function loadDotenvIfPresent(file, env = process.env) {
  if (!fs.existsSync(file)) return false;
  const values = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

/**
 * Delete TomTom flow tiles older than `maxAgeDays`. The tile cache has no
 * eviction of its own; budget.json (the daily upstream counter) is always kept.
 */
export async function pruneTomTomTiles(cacheRoot, maxAgeDays, now = Date.now()) {
  const dir = path.join(cacheRoot, 'tomtom');
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of entries) {
    if (!/^flow-.*\.pbf$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fsp.stat(file);
      if (now - stat.mtimeMs > maxAgeDays * DAY_MS) {
        await fsp.unlink(file);
        removed.push(name);
      }
    } catch {
      // Raced with the provider rewriting the tile; nothing to prune.
    }
  }
  return removed;
}

/**
 * Mount each plugin through exactly one Vite server hook. Most provider
 * plugins define both hooks with the same installer, so calling both would
 * register their routes twice. Post hooks run after every pre hook, as in Vite.
 */
export async function mountPlugins(plugins, server) {
  const postHooks = [];
  for (const plugin of plugins) {
    const hook = plugin.configurePreviewServer ?? plugin.configureServer;
    const fn = typeof hook === 'function' ? hook : hook?.handler;
    const post = fn ? await fn.call(plugin, server) : undefined;
    if (typeof post === 'function') postHooks.push(post);
  }
  for (const post of postHooks) await post();
}

/** Build (but do not start) the compat host. */
export async function createProviderServer({
  plugins = compatProviderPlugins(),
  log = console,
} = {}) {
  const app = connect();
  const httpServer = http.createServer(app);
  const providers = plugins.map((plugin) => plugin.name);

  app.use('/healthz', (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ status: 'ok', providers }));
  });

  await mountPlugins([...plugins, apiNotFoundPlugin()], {
    middlewares: app,
    httpServer,
  });

  let closing = null;
  /** Tear down plugin resources first (the AIS socket), then HTTP. */
  const close = ({ forceAfterMs = 5_000 } = {}) => {
    closing ??= (async () => {
      for (const plugin of plugins) {
        try {
          await plugin.closeBundle?.();
        } catch (error) {
          log.error(`[compat] ${plugin.name} teardown failed:`, error);
        }
      }
      log.info('[compat] provider resources closed; closing HTTP server');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          log.warn(`[compat] connections still open after ${forceAfterMs}ms; dropping them`);
          httpServer.closeAllConnections();
          resolve();
        }, forceAfterMs);
        timer.unref();
        httpServer.close(() => {
          clearTimeout(timer);
          resolve();
        });
        httpServer.closeIdleConnections();
      });
    })();
    return closing;
  };

  return { app, httpServer, providers, close };
}

async function main() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  process.chdir(root); // providers resolve .gev-cache / .gev-logs from cwd
  loadDotenvIfPresent(path.join(root, '.env'));

  const host = process.env.HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.PORT || '', 10) || DEFAULT_PORT;
  const pruneDays = Number(process.env.GEV_COMPAT_CACHE_PRUNE_DAYS ?? 7);
  if (Number.isFinite(pruneDays) && pruneDays >= 0) {
    const removed = await pruneTomTomTiles(path.join(root, '.gev-cache'), pruneDays);
    if (removed.length) console.info(`[compat] pruned ${removed.length} TomTom tiles older than ${pruneDays}d`);
  }

  const server = await createProviderServer();
  const shutdown = async (signal) => {
    console.info(`[compat] ${signal}: shutting down`);
    await server.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  server.httpServer.listen(port, host, () => {
    console.info(`[compat] gods-eye-compat listening on http://${host}:${port} (${server.providers.length} providers)`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[compat] failed to start:', error);
    process.exit(1);
  });
}
