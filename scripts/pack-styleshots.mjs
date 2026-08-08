/**
 * pack-styleshots.mjs - re-encode the style captures for embedding.
 *
 * The published page has to be self-contained, so every frame is inlined as a
 * data URI. Straight base64 of the PNGs is about 4.3 MB, which is a slow page
 * on a phone for no gain: these are photographs of a rendered scene, not line
 * art, and JPEG is the right container for them.
 *
 * Resizing happens on a canvas in the browser rather than through an image
 * library, because this project has no runtime or build dependencies and
 * Chromium is already here for the tests.
 *
 * Quality is set per kind of frame. The raid captures carry film grain and, in
 * one style, scanlines - both are exactly the high-frequency detail JPEG
 * spends its bits on last, so they get more. The menus are flat colour and
 * type, which survives a lower setting untouched.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = process.argv[2] ?? './dist/styles';
const OUT = process.argv[3] ?? './dist/styleshots.json';

/** Target width and JPEG quality by frame kind. */
const PROFILE = {
  hud: { width: 1000, quality: 0.9 },
  hub: { width: 1200, quality: 0.86 },
  npc: { width: 1200, quality: 0.86 },
  weapon: { width: 700, quality: 0.92 },
  'npc-portrait': { width: 420, quality: 0.92 },
};

const files = readdirSync(SRC).filter((f) => f.endsWith('.png'));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

const out = {};
let totalIn = 0;
let totalOut = 0;

for (const file of files.sort()) {
  const raw = readFileSync(join(SRC, file));
  totalIn += raw.length;

  // `feldbericht-npc-portrait.png` -> style `feldbericht`, kind `npc-portrait`.
  const stem = file.replace(/\.png$/, '');
  const dash = stem.indexOf('-');
  const style = stem.slice(0, dash);
  const kind = stem.slice(dash + 1);
  const profile = PROFILE[kind];
  if (!profile) {
    console.warn(`skipping ${file}: no profile for kind "${kind}"`);
    continue;
  }

  const dataUri = await page.evaluate(
    async ({ b64, width, quality }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const scale = Math.min(1, width / img.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    },
    { b64: raw.toString('base64'), width: profile.width, quality: profile.quality },
  );

  out[`${style}/${kind}`] = dataUri;
  totalOut += dataUri.length;
  console.log(`${file.padEnd(34)} ${(raw.length / 1024).toFixed(0).padStart(5)} kB -> ${(dataUri.length / 1024).toFixed(0).padStart(5)} kB`);
}

await browser.close();
writeFileSync(OUT, JSON.stringify(out));
console.log(`\n${Object.keys(out).length} frames, ${(totalIn / 1024 / 1024).toFixed(2)} MB -> ${(totalOut / 1024 / 1024).toFixed(2)} MB of data URI`);
console.log(`Wrote ${OUT}`);
