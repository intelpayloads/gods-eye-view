/** The published package carries every file its exports reach (GEN-367 `files` allow-list). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const SPECIFIERS = [
  /\bfrom\s*['"]([^'"]+)['"]/g, // import ... from / export ... from
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import of a literal
  /\bimport\s+['"]([^'"]+)['"]/g, // side-effect import
  /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g, // runtime asset
  /@import\s+(?:url\()?['"]([^'"]+)['"]/g, // CSS @import
];

/** Package-relative files reachable from `entries` through relative specifiers. */
function reachable(entries) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const absolute = path.join(root, file);
    if (!/\.(m?js|css)$/.test(file) || !existsSync(absolute)) return;
    const source = readFileSync(absolute, 'utf8');
    for (const pattern of SPECIFIERS)
      for (const [, specifier] of source.matchAll(pattern)) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
        visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.split('?')[0])));
      }
  };
  entries.forEach(visit);
  return seen;
}

test('every file reachable from package.json exports is in the packed tarball', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const targets = Object.values(pkg.exports).map((t) => (typeof t === 'string' ? t : Object.values(t)[0]));
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }),
  );
  const inTarball = new Set(packed.files.map((f) => f.path));
  const files = reachable(targets.map((t) => path.posix.normalize(t)));
  const missing = [...files].filter((file) => !inTarball.has(file)).sort();
  assert.deepEqual(missing, [], `reachable from exports but not packed: ${missing.join(', ')}`);
  assert.ok(files.size > targets.length, 'the walk followed imports');
});
