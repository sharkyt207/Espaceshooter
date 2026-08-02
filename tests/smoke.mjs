/**
 * Browser smoke test.
 *
 * The unit tests cover the simulation, but they cannot see the parts that only
 * exist in a browser: the renderer, the screen stack, touch input wiring and
 * the raid lifecycle end to end. This drives a real Chromium through a full
 * session - new profile, every hideout tab, deploy, play, loot, map, abandon,
 * debrief - screenshotting each step and failing on any page error.
 *
 * Usage:
 *   npm run build && npm run preview &
 *   node tests/smoke.mjs [--out DIR] [--url URL]
 *
 * Requires Playwright. In CI this is the gate that catches "it typechecks but
 * the menu does not open".
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL = argOf('--url', 'http://localhost:4173/');
const OUT = argOf('--out', './dist/smoke');
const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;

mkdirSync(OUT, { recursive: true });

const errors = [];
let step = 0;

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

// A representative landscape phone viewport.
//
// Device pixel ratio 1, deliberately. This suite runs against SwiftShader -
// WebGL rasterised on the CPU - and the GPU renderer at DPR 2 means four times
// the fragments through a software rasteriser, which drags a night raid under
// one frame per second and makes every timed step flaky. DPR 1 is not a gap in
// coverage: layout at 2x and 3x is what `viewports.mjs` exists to check, and
// nothing this suite asserts is resolution-dependent.
const context = await browser.newContext({
  viewport: { width: 900, height: 414 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
});
page.on('pageerror', (e) => {
  errors.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 6).join('\n')}`);
});

const shot = async (name) => {
  step++;
  await page.screenshot({ path: `${OUT}/${String(step).padStart(2, '0')}-${name}.png` });
};

const visibleScreens = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.screen:not(.hidden) .screen-title')).map((t) => t.textContent),
  );

/** Which screen is actually on top, by hit-testing the middle of the viewport. */
const topmostScreen = (page) =>
  page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return el?.closest('.screen')?.dataset.screen ?? null;
  });

const tab = (label) =>
  page.locator('.screen:not(.hidden) .nav-item, .screen:not(.hidden) .tab', { hasText: label }).first();

let failure = null;
try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot('menu');

  // --- new profile ---------------------------------------------------------
  await page.getByRole('button', { name: 'Neues Profil' }).click();
  await page.waitForTimeout(600);

  // First run opens the primer over the hideout. It must be on top, not
  // merely present - a pushed screen rendering underneath the one it was
  // pushed over is invisible to every assertion except a screenshot.
  const afterNew = await visibleScreens();
  assert(afterNew.includes('Erste Schritte'), `expected the primer, got ${JSON.stringify(afterNew)}`);
  assert(await topmostScreen(page) === 'primer', 'the primer must render above the hideout');
  await shot('primer');

  // Walk every card, then finish.
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.waitForTimeout(220);
  }
  await shot('primer-last');
  await page.getByRole('button', { name: 'Los geht’s' }).click();
  await page.waitForTimeout(400);

  const afterPrimer = await visibleScreens();
  assert(afterPrimer.includes('Versteck'), `expected the hideout, got ${JSON.stringify(afterPrimer)}`);
  assert(!afterPrimer.includes('Erste Schritte'), 'the primer should be dismissed');
  await shot('hideout-gear');

  // --- every hub section renders --------------------------------------------
  for (const label of ['Ausrüstung', 'Versteck', 'Werkstatt', 'Händler', 'Aufträge', 'Versicherung']) {
    await tab(label).click();
    await page.waitForTimeout(350);
    await shot(`hideout-${label.toLowerCase()}`);
  }
  await tab('Übersicht').click();
  await page.waitForTimeout(300);
  await shot('hideout-overview');

  // --- deploy ---------------------------------------------------------------
  await page.getByRole('button', { name: 'Einsatz starten' }).click();
  await page.waitForTimeout(500);
  await shot('deploy');

  // Deploy at night. This is the harder path through the game and the one that
  // exercises the conditions system, the lightmap rebuild and the weapon light.
  await page.locator('.time-chip', { hasText: 'Nacht' }).first().click();
  await page.waitForTimeout(250);
  await shot('deploy-night');

  await page.getByRole('button', { name: 'Absetzen' }).click();
  await page.waitForTimeout(2500);
  await shot('raid');

  // --- the weapon light lights the world ------------------------------------
  //
  // Measured, not eyeballed: the beam feeds the same lightmap term the world
  // is shaded by, so switching it on must measurably brighten the middle of
  // the frame. A screenshot alone would not catch the beam silently going
  // nowhere.
  const conditions = await page.evaluate(() => window.game.session?.conditions.label ?? '');
  assert(conditions.startsWith('Nacht'), `expected a night raid, got ${conditions}`);
  assert(
    await page.evaluate(() => window.game.session?.hasTorch ?? true),
    'the starting rifle should have a light fitted',
  );

  const darkness = await centreBrightness(page);
  await page.keyboard.press('KeyL');
  await page.waitForTimeout(500);
  await shot('raid-torch');
  const lit = await centreBrightness(page);
  // The raid is live while this runs and the AI are perfectly capable of
  // ending it mid-check, so read through a guard rather than asserting the
  // session still exists.
  assert(
    await page.evaluate(() => window.game.session?.torchOn ?? true),
    'the light should be on after pressing L',
  );
  // Relative, not absolute: the beam covers a fixed slice of the frame, so how
  // many absolute levels it adds depends on what the rest of the scene is
  // doing. Under fog the surroundings are already bright and the same beam
  // moves the mean far less.
  assert(
    lit > darkness * 1.05,
    `the beam should brighten the frame (dark ${darkness.toFixed(1)}, lit ${lit.toFixed(1)})`,
  );
  console.log(`torch: centre luminance ${darkness.toFixed(1)} -> ${lit.toFixed(1)}`);

  const inRaid = await page.evaluate(() => window.game.state);
  assert(inRaid === 'raid', `expected to be in a raid, state was ${inRaid}`);

  // --- aiming is not inverted ----------------------------------------------
  //
  // Down means down. The sign runs through input, the player, ballistics and
  // the horizon, and a flip anywhere along it is invisible in every other test
  // - it just makes the game feel wrong.
  const pitchAfterDrag = async (dy) =>
    page.evaluate(async (dy) => {
      const g = window.game;
      if (!g.session) return 0;
      g.session.player.pitch = 0;
      const canvas = document.querySelector('.game-canvas');
      const x = window.innerWidth * 0.75;
      const y = window.innerHeight * 0.5;
      const opts = (cx, cy) => ({ pointerId: 1, clientX: cx, clientY: cy, bubbles: true, isPrimary: true });
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts(x, y)));
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(x, y + dy)));
      canvas.dispatchEvent(new PointerEvent('pointerup', opts(x, y + dy)));
      await new Promise((r) => setTimeout(r, 120));
      return g.session?.player.pitch ?? 0;
    }, dy);

  const draggedDown = await pitchAfterDrag(90);
  assert(draggedDown < -0.01, `dragging down must look down, pitch was ${draggedDown.toFixed(3)}`);
  const draggedUp = await pitchAfterDrag(-90);
  assert(draggedUp > 0.01, `dragging up must look up, pitch was ${draggedUp.toFixed(3)}`);
  await page.evaluate(() => { if (window.game.session) window.game.session.player.pitch = 0; });
  console.log(`aim: drag down -> ${draggedDown.toFixed(3)} rad, drag up -> ${draggedUp.toFixed(3)} rad`);

  // --- play -----------------------------------------------------------------
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  await shot('raid-moved');

  // Sample performance early, while the player is reliably still alive - the
  // AI are perfectly capable of ending the raid mid-test.
  const perf = await measurePerformance(page);
  console.log(
    `perf: ${perf.fps.toFixed(1)} fps  sim ${perf.sim.toFixed(2)} ms  draw ${perf.draw.toFixed(2)} ms  ` +
      `at ${perf.res}  (${perf.ai} AI alive)`,
  );

  await page.mouse.move(450, 207);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await shot('raid-fired');

  await page.keyboard.press('KeyR');
  await page.waitForTimeout(1200);
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(400);
  await shot('raid-crouched');

  // --- overlays --------------------------------------------------------------
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(700);
  assert((await visibleScreens()).includes('Sektorkarte'), 'the map should open');
  await shot('map');
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(400);

  await page.keyboard.press('Tab');
  await page.waitForTimeout(700);
  assert((await visibleScreens()).includes('Inventar'), 'the inventory should open');
  await shot('inventory');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);

  // --- end the raid and debrief ---------------------------------------------
  if ((await page.evaluate(() => window.game.state)) === 'raid') {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await shot('pause');
    // Two taps: the first arms the control, the second commits.
    const abandon = page.getByRole('button', { name: /Einsatz abbrechen|Einsatz aufgeben/ });
    await abandon.click();
    await page.waitForTimeout(300);
    await abandon.click();
  }
  await page.waitForTimeout(900);
  assert((await visibleScreens()).includes('Einsatzbericht'), 'the debrief should show');
  await shot('results');

  await page.getByRole('button', { name: 'Zurück ins Versteck' }).click();
  await page.waitForTimeout(700);
  assert((await visibleScreens()).includes('Versteck'), 'should return to the hideout');
  await shot('back-in-hideout');

  // --- persistence -----------------------------------------------------------
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Fortsetzen' }).click();
  await page.waitForTimeout(700);
  assert((await visibleScreens()).includes('Versteck'), 'a saved profile should load');
  await shot('loaded-save');
} catch (err) {
  failure = err;
}

await browser.close();

if (errors.length > 0) {
  console.error('\nPage errors:\n' + errors.join('\n---\n'));
}
if (failure) {
  console.error(`\nSmoke test failed: ${failure.message}`);
}
if (failure || errors.length > 0) process.exit(1);

console.log(`\nSmoke test passed. ${step} screenshots in ${OUT}`);

// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Mean luminance of the middle of the rendered frame.
 *
 * Which canvas holds the world depends on the active renderer: the software
 * path draws it straight onto the 2D canvas, while the GPU path renders into
 * its own and puts a transparent overlay in front for the HUD. Measuring the
 * overlay would read a fully transparent image and every luminance assertion
 * would compare zero to zero, so the renderer is asked rather than the DOM
 * queried.
 *
 * A WebGL canvas has no 2D context to read from either, so the pixels come
 * back through `drawImage` into a scratch canvas - which works for both
 * backends and keeps this helper renderer-agnostic.
 */
async function centreBrightness(page) {
  return page.evaluate(() => {
    const canvas = window.game.renderer.worldCanvas;
    const scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const ctx = scratch.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const w = Math.floor(canvas.width * 0.4);
    const h = Math.floor(canvas.height * 0.4);
    const data = ctx.getImageData(
      Math.floor((canvas.width - w) / 2),
      Math.floor((canvas.height - h) / 2),
      w,
      h,
    ).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
    return sum / (data.length / 4);
  });
}

/** Sample the loop's own statistics while the camera is moving. */
async function measurePerformance(page) {
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(400 + i * 30, 200);
    await page.waitForTimeout(500);
  }
  return page.evaluate(() => {
    const g = window.game;
    return {
      fps: g.loop.stats.fps,
      sim: g.loop.stats.simMs,
      draw: g.loop.stats.renderMs,
      res: g.renderer.internalResolution,
      ai: g.session ? g.session.ai.aliveCount : 0,
    };
  });
}
