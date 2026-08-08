/**
 * build-sw.mjs - write the real asset names into the service worker.
 *
 * The worker cannot know what to precache on its own. Vite hashes the bundle
 * filename (`index-f-E-C48k.js`), which is the property that makes cache-first
 * serving safe - a new build has a new name and cannot collide with an old
 * cached copy - and it is also the reason a hand-written static file cannot
 * list it.
 *
 * Relying on the runtime cache instead does not work, and the offline test is
 * what proved it. On the very first visit the worker is installing while the
 * page is already loading, so the bundle is fetched *before* the fetch handler
 * exists and never passes through it. Install the app, walk into a tunnel, and
 * the cache holds the HTML and the icons and nothing to run. The bug only
 * appears in the one sequence that matters - first launch, then no signal -
 * and it needed a test that actually cut the network to surface.
 *
 * So the precache list is generated from what the build produced, and the
 * cache name is derived from it too: change any asset and the name changes,
 * which is what evicts the previous version on activate.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const SW = join(DIST, 'sw.js');

/** Every file under `dist`, as paths relative to it. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, `${prefix}${entry}/`));
    else out.push(`${prefix}${entry}`);
  }
  return out;
}

const files = walk(DIST)
  // Source maps are for debugging and would roughly quadruple what a phone
  // stores; the worker itself must not cache itself.
  .filter((f) => !f.endsWith('.map') && f !== 'sw.js')
  .sort();

const precache = ['./', ...files.map((f) => `./${f}`)];

// Cache name from the content of the list, so any change to the build produces
// a new cache and the old one is dropped on activate.
const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);

let source = readFileSync(SW, 'utf8');

const replacements = [
  [/const CACHE = '[^']*';/, `const CACHE = 'grayzone-${version}';`],
  [/const SHELL = \[[\s\S]*?\];/, `const SHELL = ${JSON.stringify(precache, null, 2)};`],
];

for (const [pattern, replacement] of replacements) {
  if (!pattern.test(source)) {
    console.error(`build-sw: could not find ${pattern} in ${SW} - refusing to write a half-patched worker`);
    process.exit(1);
  }
  source = source.replace(pattern, replacement);
}

writeFileSync(SW, source);

const bundle = files.find((f) => f.endsWith('.js'));
console.log(
  `Wrote ${SW}: ${precache.length} precached entries, cache grayzone-${version}` +
    (bundle ? ` (bundle ${bundle})` : ''),
);
if (!bundle) {
  console.error('build-sw: no script bundle in the precache list - the app could not run offline');
  process.exit(1);
}
