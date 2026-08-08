/**
 * browser.mjs - find a Chromium to drive.
 *
 * Every browser-based check here (smoke, viewports, renderers, styleshots)
 * needs the same thing, and each used to work it out for itself as
 * `process.env.CHROMIUM_PATH || undefined`. Handing `undefined` to Playwright
 * means "use the build you downloaded", which is wrong in any environment that
 * ships a browser instead - the version in the path Playwright expects is
 * pinned to the npm package, so a browser that is present but a few builds
 * older is invisible to it. The failure is a message telling you to run
 * `npx playwright install`, which is exactly the thing such environments
 * forbid, so it sends you the wrong way.
 *
 * This looks for what is actually on disk and only falls back to Playwright's
 * own resolution when it finds nothing.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Directories that ship a browser, most specific first. */
const ROOTS = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);

/**
 * Relative paths to the binary inside one browser directory.
 *
 * Full Chromium before the headless shell: the shell cannot do WebGL, and the
 * renderer comparison and the style screenshots both need it. A check that
 * silently ran on a software rasteriser would still pass while measuring
 * nothing about the GPU path.
 */
const BINARIES = [
  'chrome-linux/chrome',
  'chrome-linux/headless_shell',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
];

/**
 * Absolute path to a usable Chromium, or `undefined` to let Playwright decide.
 *
 * `CHROMIUM_PATH` still wins, so pointing the checks at a specific build stays
 * a one-variable job.
 */
export function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    // Newest build first, so a directory holding several is unambiguous.
    const dirs = readdirSync(root)
      .filter((name) => name.startsWith('chromium'))
      .sort((a, b) => (buildNumber(b) - buildNumber(a)) || a.localeCompare(b));

    for (const dir of dirs) {
      for (const binary of BINARIES) {
        const candidate = join(root, dir, binary);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/** `chromium-1194` -> 1194, so builds sort numerically rather than as text. */
function buildNumber(name) {
  const match = /(\d+)$/.exec(name);
  return match ? Number(match[1]) : -1;
}
