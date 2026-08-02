/**
 * renderers.mjs - run the same raid through both renderers and compare.
 *
 * Two backends drawing the same world is only worth having if they agree about
 * what the world *is*. A shader that quietly puts the horizon in a different
 * place, or a mesh that mirrors the map, would look perfectly plausible in
 * isolation - you would only notice when the software fallback kicked in on
 * someone's phone and the game turned into a different game.
 *
 * So this pins the parts that must match and measures the parts that are
 * allowed to differ:
 *
 *   - **Must match.** The seed, the map, the conditions and the camera. Both
 *     paths are driven to the identical position and heading, and the frame is
 *     split into a grid whose per-cell brightness ordering has to correspond.
 *     Absolute values will not match - the GPU path tone maps in shader and has
 *     smooth lighting - but if one renderer thinks the left of the frame is
 *     dark and the other thinks it is bright, something is mirrored or the
 *     camera basis has drifted.
 *   - **Free to differ.** Frame rate and sharpness. Those get reported, not
 *     asserted, because the numbers here come from SwiftShader and say nothing
 *     about a real phone.
 *
 * Run: node tests/renderers.mjs [--url ...] [--out ...]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL = argOf('--url', 'http://127.0.0.1:4173/');
const OUT = argOf('--out', './dist/renderers');
const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;

/** Grid the frame is sampled on. Coarse on purpose: this compares layout. */
const COLS = 8;
const ROWS = 4;

mkdirSync(OUT, { recursive: true });

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

try {
  const gpu = await runOnce('gpu', 1);
  const software = await runOnce('software', 0);

  console.log(`\ngpu:      ${gpu.renderer}`);
  console.log(`software: ${software.renderer}`);
  assert(gpu.usingGL, 'the GPU pass should have used WebGL - check the context creation');
  assert(!software.usingGL, 'forcing the software renderer should have taken the raycaster path');

  // Same raid, both times. If this drifts, nothing below compares anything.
  assert(
    gpu.seed === software.seed && gpu.map === software.map,
    `both runs must be the same raid (gpu ${gpu.map}/${gpu.seed}, software ${software.map}/${software.seed})`,
  );
  assert(
    Math.abs(gpu.camera.x - software.camera.x) < 0.01 &&
      Math.abs(gpu.camera.y - software.camera.y) < 0.01 &&
      Math.abs(gpu.camera.angle - software.camera.angle) < 0.01,
    'both runs must be looking from the same place in the same direction',
  );

  // --- the frames have to describe the same scene --------------------------
  //
  // Spearman rank correlation over the grid cells. Rank rather than value
  // because the two paths apply different tone curves, so the brightnesses are
  // related monotonically but not linearly - comparing the *ordering* is the
  // question that actually has a right answer.
  const rho = spearman(gpu.cells, software.cells);
  console.log(`\ncell brightness rank correlation: ${rho.toFixed(3)} over ${COLS}x${ROWS} cells`);

  assert(
    rho > 0.5,
    `the two renderers should agree about where the frame is light and dark (rho ${rho.toFixed(3)}). ` +
      `A low or negative value means the image is mirrored, the camera basis differs, or the ` +
      `horizon is in the wrong place.`,
  );

  // A mirrored world is the specific failure this file exists to catch, and
  // the correlation above is nearly blind to it: any first-person frame is
  // sky over ground, that vertical split dominates the ranking, and it
  // survives a left-right flip untouched.
  //
  // So the horizontal structure gets tested on its own. Subtracting each row's
  // mean removes the sky-over-ground signal and leaves only where each row is
  // lighter or darker than its own average - which is exactly what mirroring
  // reverses.
  const gpuH = withoutRowMeans(gpu.cells);
  const swH = withoutRowMeans(software.cells);
  const upright = spearman(gpuH, swH);
  const mirrored = spearman(gpuH, flipHorizontally(swH));
  console.log(`horizontal structure: upright ${upright.toFixed(3)}, mirrored ${mirrored.toFixed(3)}`);
  assert(
    upright > mirrored,
    `the frames agree better when one is mirrored (${upright.toFixed(3)} vs ${mirrored.toFixed(3)}), ` +
      `which means one renderer is drawing the world back to front`,
  );

  console.log(`\nperformance, SwiftShader - indicative only, not a device measurement:`);
  console.log(`  gpu       ${gpu.fps.toFixed(1)} fps  draw ${gpu.draw.toFixed(2)} ms  at ${gpu.internal}`);
  console.log(`  software  ${software.fps.toFixed(1)} fps  draw ${software.draw.toFixed(2)} ms  at ${software.internal}`);

  console.log(`\nBoth renderers agree. Frames in ${OUT}`);
} finally {
  await browser.close();
}

/**
 * Play the opening of one raid with the renderer forced, and report what the
 * frame looked like.
 *
 * The seed is pinned through the same hook the smoke test uses, so both runs
 * get an identical map rather than merely a similar one.
 */
async function runOnce(label, mode) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 414 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  await page.getByRole('button', { name: 'Neues Profil' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Überspringen' }).click();
  await page.waitForTimeout(300);

  // Force the renderer before deploying, so the raid is drawn by the backend
  // under test from its very first frame.
  await page.evaluate((m) => {
    window.game.settings.renderer = m;
    window.game.applySettings(window.game.settings);
  }, mode);
  await page.waitForTimeout(200);

  await page.getByRole('button', { name: 'Einsatz starten' }).click();
  await page.waitForTimeout(400);

  // Pin the raid seed. It is drawn from `Math.random` at deploy, so both runs
  // would otherwise get a differently arranged map and there would be nothing
  // to compare. Stubbed only across the click and put back immediately: the
  // AI and the effects want real randomness once the raid is running.
  await page.evaluate(() => {
    window.__realRandom = Math.random;
    Math.random = () => 0.4242;
  });
  await page.getByRole('button', { name: 'Absetzen' }).click();
  await page.evaluate(() => {
    Math.random = window.__realRandom;
  });
  await page.waitForTimeout(2500);

  // Freeze the camera at a fixed pose. Left to itself the player drifts with
  // recoil and the two runs would be comparing different views.
  await page.evaluate(() => {
    const s = window.game.session;
    if (!s) return;
    s.player.x = Math.floor(s.player.x) + 0.5;
    s.player.y = Math.floor(s.player.y) + 0.5;
    s.player.angle = 0;
    s.player.pitch = 0;
  });
  await page.waitForTimeout(700);

  const state = await page.evaluate(() => {
    const g = window.game;
    const s = g.session;
    return {
      usingGL: g.renderer.usingGL,
      renderer: g.renderer.rendererName,
      seed: s?.generated.seed ?? -1,
      map: s?.generated.blueprintId ?? '',
      camera: { x: s?.player.x ?? 0, y: s?.player.y ?? 0, angle: s?.player.angle ?? 0 },
      fps: g.loop.stats.fps,
      draw: g.loop.stats.renderMs,
      internal: `${g.renderer.internalWidth}x${g.renderer.internalHeight}`,
    };
  });

  const cells = await page.evaluate(
    ({ cols, rows }) => {
      // Ask the renderer which canvas holds the world - a forced-software run
      // still has a hidden GL canvas in the DOM holding a stale frame, and a
      // selector would happily read that instead.
      const canvas = window.game.renderer.worldCanvas;
      const scratch = document.createElement('canvas');
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      scratch.getContext('2d').drawImage(canvas, 0, 0);
      const ctx = scratch.getContext('2d');

      const out = [];
      const cw = Math.floor(canvas.width / cols);
      const ch = Math.floor(canvas.height / rows);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const data = ctx.getImageData(c * cw, r * ch, cw, ch).data;
          let sum = 0;
          // Every 16th pixel: this is a coarse layout comparison and reading
          // all of them under a software rasteriser is needlessly slow.
          for (let i = 0; i < data.length; i += 64) {
            sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          }
          out.push(sum / (data.length / 64));
        }
      }
      return out;
    },
    { cols: COLS, rows: ROWS },
  );

  await page.screenshot({ path: `${OUT}/${label}.png` });
  await context.close();

  if (errors.length) throw new Error(`${label}: page errors\n  ${errors.join('\n  ')}`);
  return { ...state, cells };
}

/** Spearman rank correlation of two equal-length series. */
function spearman(a, b) {
  const ra = ranks(a);
  const rb = ranks(b);
  const n = ra.length;
  const mean = (n - 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = ra[i] - mean;
    const y = rb[i] - mean;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

/** Ranks with ties averaged, so a flat sky does not bias the correlation. */
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const out = new Array(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const shared = (i + j) / 2;
    for (let k = i; k <= j; k++) out[order[k][1]] = shared;
    i = j + 1;
  }
  return out;
}

/**
 * Subtract each row's mean, leaving only horizontal structure.
 *
 * Without this every comparison is dominated by the fact that sky is brighter
 * than ground, which is true of both renderers no matter which way round the
 * world is drawn.
 */
function withoutRowMeans(cells) {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    const row = cells.slice(r * COLS, (r + 1) * COLS);
    const mean = row.reduce((a, b) => a + b, 0) / COLS;
    for (const v of row) out.push(v - mean);
  }
  return out;
}

/** Mirror the cell grid left to right. */
function flipHorizontally(cells) {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) out.push(cells[r * COLS + (COLS - 1 - c)]);
  }
  return out;
}
