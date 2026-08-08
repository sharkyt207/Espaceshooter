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
import { findChromium } from './browser.mjs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL = argOf('--url', 'http://localhost:4173/');
const OUT = argOf('--out', './dist/smoke');
const EXECUTABLE = findChromium();

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

/**
 * Capture one step, with the render loop held still for the duration.
 *
 * Headless Chromium composites in software, and this raid draws a full-screen
 * canvas every frame. The game's own budget is fine - around 1.5 ms of
 * simulation and 1.5 ms of drawing, measured under sustained fire with all
 * twenty-six hostiles engaged - but the compositor behind it needs roughly a
 * hundred milliseconds per frame, and `page.screenshot` has to go through that
 * same compositor. Against a canvas that never stops changing, it can starve
 * indefinitely; it was timing out at thirty seconds.
 *
 * This never showed up before because the player used to die partway through
 * and the raid would end, leaving a static screen for every later capture. Now
 * the player survives the whole walk, the raid never stops, and the contention
 * is continuous. So: stop the loop, take the picture, start it again. The
 * frame on screen is already rendered, so the capture is unchanged, and every
 * performance number is sampled outside this helper and so is untouched.
 *
 * Holding the loop still fixes most of it but not all - roughly one run in
 * four still lost a capture, at whichever step happened to land while the
 * rasteriser was behind. That residue is contention inside the browser rather
 * than anything the game is doing, so it gets a retry instead of a fix: a
 * short settle, then one more attempt. If both fail, the failure is real and
 * says which step it was.
 */
const shot = async (name) => {
  step++;
  const path = `${OUT}/${String(step).padStart(2, '0')}-${name}.png`;
  await page.evaluate(() => window.game?.loop?.stop());
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await page.screenshot({ path, timeout: 15000 });
        return;
      } catch (err) {
        // Name the step. A bare "page.screenshot: Timeout" says nothing about
        // where the suite got to, and the answer to "which screenshot" is the
        // whole diagnosis.
        if (attempt === 2) {
          throw new Error(`screenshot "${name}" (step ${step}) failed twice: ${err.message}`);
        }
        await page.waitForTimeout(1500);
      }
    }
  } finally {
    await page.evaluate(() => window.game?.loop?.start());
  }
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

/**
 * Top the player back up, and confirm it worked.
 *
 * The raid runs live through this whole suite with twenty-six hostiles in it,
 * and they are perfectly capable of killing the player between two steps. When
 * that happened the raid ended early and every subsequent assertion failed on
 * something unrelated to what it was checking - the map "not opening" because
 * there was no longer a raid to open it in.
 *
 * Healing rather than pausing the world: the AI staying live is the point of
 * the performance measurement at the end, and a suite that only passes against
 * a frozen game is not testing the game. What the player's survival is *not*
 * is the thing under test here - this walks the interface and the raid
 * lifecycle, and dying mid-walk is noise.
 *
 * Topping the player up at each step is not enough, and the reason is worth
 * recording. This used to heal at eight checkpoints and hope the player
 * survived the gaps, which held only for as long as the AI was harmless. The
 * moment the AI started genuinely closing ground and shooting from cover, the
 * gaps became lethal and the suite began failing at whichever step happened to
 * be unlucky - the map "not opening" one run, the inventory the next. A
 * wandering failure is the signature of a race, not of the thing it points at,
 * and chasing it step by step would have meant tuning timings forever.
 *
 * So the player is taken out of the fight once, at the first call, by making
 * the incoming-damage path a no-op for them. Everything else stays live: the
 * hostiles still hunt, still shoot, still cost frame time. Nothing here
 * asserts on the player taking damage, so nothing is lost by removing them as
 * a target, and the AI being lethal is now a fact about the game rather than a
 * hazard for the test.
 *
 * The healthy-player check is not optional. The first version of this wrote
 * `part.max` under the wrong name, so every part's hp became undefined - which
 * did not heal the player, it corrupted them, and swapped one flaky step for
 * another. A silent no-op is worse than the flake it replaced.
 */
const keepAlive = async () => {
  const state = await page.evaluate(() => {
    const s = window.game.session;
    if (!s) return null;

    // Install once per raid. `__smokeGuarded` is stamped on the health system
    // itself, so a new raid gets a fresh (unguarded) one and re-arms here.
    const health = s.player.health;
    if (!health.__smokeGuarded) {
      health.__smokeGuarded = true;
      health.applyDamage = () => {}; // returns void in the real thing
      health.kill = () => {};
    }

    for (const part of Object.values(health.parts)) {
      part.hp = part.max;
      part.lightBleeds = 0;
      part.heavyBleeds = 0;
      part.fractured = false;
    }
    s.player.stamina = 100;
    return { hp: health.totalHp, alive: s.player.alive };
  });
  if (state) {
    assert(
      Number.isFinite(state.hp) && state.hp > 0 && state.alive,
      `keepAlive must leave a live player, got ${JSON.stringify(state)}`,
    );
  }
  return state;
};

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
  await keepAlive();
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
  await keepAlive();
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

  // --- four fingers at once -------------------------------------------------
  //
  // The claim the whole input rewrite rests on: a finger walking, a finger
  // looking, a finger on fire and a finger on ADS all work *simultaneously*.
  // The previous implementation kept one movement pointer and one look pointer
  // and silently discarded everything else, which no screenshot and no
  // single-touch test could ever have caught - the game simply stopped
  // responding to a hand that held it the way a claw player holds it.
  await keepAlive();
  const multitouch = await page.evaluate(async () => {
    const g = window.game;
    if (!g.session) return null;
    const input = g.input;
    input.releaseAll();
    g.session.player.pitch = 0;

    const surface = document.querySelector('.game-canvas').parentElement;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const ev = (type, id, x, y) =>
      new PointerEvent(type, {
        pointerId: id, clientX: x, clientY: y, bubbles: true,
        pointerType: 'touch', isPrimary: id === 1,
      });

    // 1: left thumb, walking forward.
    //
    // A walk rather than a full-throw sprint, because sprinting correctly
    // refuses to let the weapon be shouldered - testing ADS against a
    // sprinting player would be testing the wrong rule.
    const stickX = W * 0.18;
    const stickY = H * 0.7;
    surface.dispatchEvent(ev('pointerdown', 1, stickX, stickY));
    surface.dispatchEvent(ev('pointermove', 1, stickX, stickY - 30));

    // 2: right thumb, dragging the camera down against recoil.
    const lookX = W * 0.75;
    const lookY = H * 0.55;
    surface.dispatchEvent(ev('pointerdown', 2, lookX, lookY));

    // 3 and 4: index fingers on the fire and ADS buttons.
    const fireBtn = document.querySelector('[data-control="fire"]');
    const adsBtn = document.querySelector('[data-control="ads"]');
    if (fireBtn) fireBtn.dispatchEvent(ev('pointerdown', 3, 10, 10));
    if (adsBtn) adsBtn.dispatchEvent(ev('pointerdown', 4, 20, 20));

    // Now move the look finger *while everything else is held down*. This is
    // the exact combination the old router dropped.
    //
    // The effect is measured on the player's pitch rather than on
    // `state.lookY`: the look delta is an accumulator the game loop drains and
    // clears every frame, so reading it after a wait reliably returns zero and
    // would make this assertion pass or fail on timing rather than on
    // behaviour. Pitch is where the input actually lands.
    const pitchBefore = g.session.player.pitch;
    surface.dispatchEvent(ev('pointermove', 2, lookX, lookY + 70));
    await new Promise((r) => setTimeout(r, 120));
    const pitchAfter = g.session?.player.pitch ?? pitchBefore;

    // ADS is observed on the weapon, not on the raw input flag. Under
    // toggle-to-aim - which is the default - the game deliberately consumes
    // `state.ads` and flips a session toggle instead, so the flag is false one
    // tick after the press by design. What the player actually sees is the
    // weapon coming up.
    const sample = {
      pointers: input.activePointers,
      moveY: input.state.moveY,
      pitchDelta: pitchAfter - pitchBefore,
      fire: input.state.fire,
      aiming: (g.session?.playerWeapon.adsProgress ?? 0) > 0.05,
      sprinting: g.session?.player.sprinting ?? false,
      foundButtons: !!fireBtn && !!adsBtn,
    };

    for (const [id, el] of [[1, surface], [2, surface], [3, fireBtn], [4, adsBtn]]) {
      if (el) el.dispatchEvent(ev('pointerup', id, 0, 0));
    }
    input.releaseAll();
    return sample;
  });

  assert(multitouch, 'the raid should still be running for the multitouch check');
  assert(
    multitouch.foundButtons,
    'the fire and ADS buttons must be findable, or this test proves nothing',
  );
  assert(
    multitouch.moveY > 0.3,
    `the stick must still read forward with three other fingers down (was ${multitouch.moveY.toFixed(2)})`,
  );
  assert(
    multitouch.pitchDelta < -0.01,
    `the camera must still turn with three other fingers down ` +
      `(pitch moved ${multitouch.pitchDelta.toFixed(4)} rad)`,
  );
  assert(multitouch.fire, 'fire must stay held while walking and looking');
  assert(!multitouch.sprinting, 'the stick should be at a walk for this check, not a sprint');
  assert(multitouch.aiming, 'the weapon must come up while walking, looking and firing');
  console.log(
    `multitouch: ${multitouch.pointers} pointers routed, ` +
      `move ${multitouch.moveY.toFixed(2)}, pitch ${multitouch.pitchDelta.toFixed(3)} rad, ` +
      `fire ${multitouch.fire}, aiming ${multitouch.aiming}`,
  );

  // --- play -----------------------------------------------------------------
  await keepAlive();
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

  await keepAlive();
  await page.mouse.move(450, 207);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const underFire = await page.evaluate(() => ({
    fps: window.game.loop.stats.fps,
    sim: window.game.loop.stats.simMs,
    draw: window.game.loop.stats.renderMs,
    ai: window.game.session ? window.game.session.ai.aliveCount : 0,
  }));
  console.log(
    `under fire: ${underFire.fps.toFixed(1)} fps  sim ${underFire.sim.toFixed(2)} ms  ` +
      `draw ${underFire.draw.toFixed(2)} ms  (${underFire.ai} AI alive)`,
  );
  await shot('raid-fired');

  await page.keyboard.press('KeyR');
  await page.waitForTimeout(1200);
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(400);
  await shot('raid-crouched');

  // --- overlays --------------------------------------------------------------
  await keepAlive();
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(700);
  assert((await visibleScreens()).includes('Sektorkarte'), 'the map should open');
  await shot('map');
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(400);

  await keepAlive();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(700);
  assert((await visibleScreens()).includes('Inventar'), 'the inventory should open');
  await shot('inventory');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);

  // --- end the raid and debrief ---------------------------------------------
  //
  // The raid is live throughout this suite and the AI are perfectly capable of
  // killing the player between two steps. That made the abandon flow fail at
  // random - and a test that fails randomly is a test people learn to re-run
  // rather than read.
  //
  // Healing here rather than guarding the assertion, because the point is to
  // exercise the abandon path: skipping it when the player happens to have
  // died would quietly stop testing it on exactly the runs where the game was
  // most active.
  await keepAlive();

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
