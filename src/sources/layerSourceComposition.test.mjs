import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createdLayerSourceKeys, LAYER_SOURCE_KEYS } from './layerSources.js';

/** Factories that build a layer's provider source. */
const PROVIDER_SOURCE_FACTORY =
  /(?<![.\w])(create(?:OpenSky|AdsbLol|AisStream|Satellite|UsgsEarthquake|Firms|Launch|Traffic|FlowTile|Cctv|Installation|Bikeshare|Radio|WeatherEffects)Source)\(/g;

const src = fileURLToPath(new URL('../', import.meta.url));

/** Application modules outside the source definitions (`src/layers`, `src/sources`). */
async function compositionModules() {
  const files = [];
  for (const entry of await readdir(src, {
    recursive: true,
    withFileTypes: true,
  })) {
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(src, file).split(path.sep).join('/');
    if (
      entry.isFile() &&
      entry.name.endsWith('.js') &&
      !relative.startsWith('layers/') &&
      !relative.startsWith('sources/')
    )
      files.push(relative);
  }
  return files.sort();
}

test('every provider source an application module builds is created in its layer source slot', async () => {
  const composers = [];
  for (const file of await compositionModules()) {
    const text = await readFile(path.join(src, file), 'utf8');
    for (const match of text.matchAll(PROVIDER_SOURCE_FACTORY)) {
      composers.push(file);
      const before = text.slice(0, match.index).replace(/\s+/g, ' ');
      const slot = before.match(/createLayerSource\( ?'([^']+)', ?$/);
      assert.ok(
        slot,
        `src/${file}: ${match[1]}() must be wrapped in createLayerSource(key, ...)`,
      );
      assert.ok(
        LAYER_SOURCE_KEYS.includes(slot[1]),
        `src/${file}: unknown layer source key ${slot[1]}`,
      );
    }
  }
  assert.ok(
    composers.includes('data/flights.js'),
    'the scan found the compositions',
  );
});

test('the standalone layer singletons cover every layer source key', async () => {
  for (const file of [
    'data/flights.js',
    'data/militaryFlights.js',
    'data/militaryRegistry.js',
    'data/aisLiveVessels.js',
    'data/satellites.js',
    'data/earthquakes.js',
    'data/rocketLaunches.js',
    'data/traffic.js',
    'data/flowTiles.js',
    'data/cctv.js',
    'data/bikeshare.js',
    'data/militaryInstallations.js',
    'data/localLayers.js',
    'data/radio.js',
    'cockpitCloudEffects.js',
  ])
    await import(new URL(file, new URL('../', import.meta.url)));
  assert.deepEqual(
    createdLayerSourceKeys().sort(),
    [...LAYER_SOURCE_KEYS].sort(),
  );
});
