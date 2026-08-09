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
// Playwright's thirty-second default assumes a browser that is keeping up.
// This one is not: SwiftShader needs roughly a hundred milliseconds to
// composite each frame of a full-screen canvas, and the raid now runs for the
// whole suite rather than ending when the player dies, so that cost never
// stops. Clicks, evaluates and screenshots all queue behind it, and which one
// happens to lose is luck - the failures moved from screenshot to click to
// evaluate as I chased them, always at a different step, which is the tell
// that the step was never the problem.
//
// The game's own budget was measured before touching this: 1-2 ms simulation
// and 1.2-1.9 ms drawing under sustained fire with all twenty-six hostiles
// engaged, about three of a sixteen millisecond frame. Nothing here is slow
// except the software rasteriser, so the honest fix is headroom, not a
// narrower test.
context.setDefaultTimeout(60_000);
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
        await page.screenshot({ path, timeout: 25_000 });
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

/**
 * Wait for a screen to actually be up, then assert it is.
 *
 * The pattern this replaces was `press key; waitForTimeout(700); assert
 * visible`, repeated five times. Every one of those is a guess about how long
 * the browser will take, and every guess is wrong on a machine under load -
 * which is how "the map should open" came to fail on a map that opens fine.
 * Polling for the thing itself turns a race into a wait, and the assertion
 * that follows still fails properly if the screen genuinely never arrives.
 */
const expectScreen = async (title, message) => {
  try {
    await page.waitForFunction(
      (want) =>
        Array.from(document.querySelectorAll('.screen:not(.hidden) .screen-title'))
          .some((t) => t.textContent === want),
      title,
      { timeout: 20_000 },
    );
  } catch {
    assert(false, `${message} (visible: ${JSON.stringify(await visibleScreens())})`);
  }
};

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
  // Wait for the raid to exist rather than for a duration. Deploy generates a
  // map, builds the world mesh and uploads it, and how long that takes depends
  // entirely on the machine - a fixed 2.5 s was enough until the browser got
  // busy, and then this failed as "expected a night raid, got ''", which is
  // what an absent session looks like from the outside.
  await page.waitForFunction(() => !!window.game.session, null, { timeout: 60_000 });
  await page.waitForTimeout(600);
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

  // --- aim assist actually assists -----------------------------------------
  //
  // `aimAssistActive` was read by the look pipeline and set by nothing, so the
  // slider in the controls screen moved a number that could never reach the
  // arithmetic. Two halves to check, because either alone would still pass
  // with the bug: the world has to notice a target under the crosshair, and
  // noticing has to slow the turn down.
  await keepAlive();
  const assist = await page.evaluate(async () => {
    const g = window.game;
    if (!g.session) return null;
    const s = g.session;

    const enemy = s.ai.enemies.find((e) => e.alive);
    if (!enemy) return null;
    s.player.pitch = 0;

    // Both halves of the check have to survive a live raid, and the raid has
    // twenty-six hostiles in it. Two things follow.
    //
    // The negative can't be "turn ninety degrees and expect nothing", because
    // some *other* hostile may be standing there - that failed roughly one run
    // in five and the detector was right every time. So find a bearing that is
    // genuinely empty first, and make all the claims about that one bearing.
    //
    // The positive can't be "drop the target eight tiles east", because a wall
    // in between makes the line-of-sight test correctly answer "no target",
    // which reads as a broken detector rather than a badly chosen spot. So walk
    // outwards along the empty bearing until a range works.
    // Take the negative reading *before* moving anyone onto the bearing, which
    // is the only ordering that works. There is no way to temporarily remove
    // the chosen hostile: `alive` is a getter with no setter, so assigning to
    // it silently does nothing, and teleporting the body off-map leaves the
    // director pathfinding out of bounds every frame. But nothing needs
    // removing - a bearing that reads empty while the hostile is still parked
    // elsewhere is genuinely empty, and that reading stands.
    let lane = null;
    for (let i = 0; i < 32 && !lane; i++) {
      const angle = (i / 32) * Math.PI * 2;
      s.player.angle = angle;
      if (s.crosshairOnTarget) continue; // something is already there

      // Empty. Now walk outwards for a range with line of sight, because a
      // wall in between makes the detector correctly answer "no target" and
      // that would read as a fault rather than a badly chosen spot.
      for (const dist of [8, 6, 4, 2.5]) {
        enemy.x = s.player.x + Math.cos(angle) * dist;
        enemy.y = s.player.y + Math.sin(angle) * dist;
        if (s.crosshairOnTarget) { lane = { angle, dist, wasEmpty: true }; break; }
      }
    }
    if (!lane) return { noLane: true };

    const detectedAway = !lane.wasEmpty;
    const detected = s.crosshairOnTarget;

    const swing = async (active) => {
      g.input.releaseAll();
      g.input.aimAssistActive = active;
      s.player.pitch = 0;
      const canvas = document.querySelector('.game-canvas');
      const x = window.innerWidth * 0.75;
      const y = window.innerHeight * 0.5;
      const opts = (cx, cy) => ({ pointerId: 1, clientX: cx, clientY: cy, bubbles: true, isPrimary: true });
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts(x, y)));
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(x, y + 90)));
      canvas.dispatchEvent(new PointerEvent('pointerup', opts(x, y + 90)));
      await new Promise((r) => setTimeout(r, 120));
      const pitch = s.player.pitch;
      g.input.aimAssistActive = false;
      return Math.abs(pitch);
    };

    const free = await swing(false);
    const slowed = await swing(true);
    s.player.pitch = 0;
    return { detected, detectedAway, free, slowed, lane, strength: g.input.config.aimAssist };
  });
  assert(assist, 'aim assist check needs a live raid with a hostile in it');
  assert(!assist.noLane, 'no clear firing lane anywhere around the player - cannot test the assist');
  assert(assist.detected, 'a hostile dead ahead in the open must register under the crosshair');
  assert(!assist.detectedAway, 'an empty bearing must not register a target');
  assert(assist.strength > 0, `the default profile should ship some assist, got ${assist.strength}`);
  assert(
    assist.slowed < assist.free * 0.995,
    `assist must slow the turn (free ${assist.free.toFixed(4)} rad, ` +
      `assisted ${assist.slowed.toFixed(4)} rad)`,
  );
  // It slows, it does not stop. An assist that eats the whole input is a
  // different and much worse bug than one that does nothing.
  assert(
    assist.slowed > assist.free * 0.5,
    `assist must stay subtle (free ${assist.free.toFixed(4)} rad, ` +
      `assisted ${assist.slowed.toFixed(4)} rad)`,
  );
  // And the join between the two halves, which is the part that was actually
  // missing. The checks above drive `aimAssistActive` by hand, so both would
  // still pass with nothing in the frame loop setting it - which is precisely
  // the state this arrived in. This asserts the game closes that loop itself.
  const wired = await page.evaluate(async (lane) => {
    const g = window.game;
    const s = g.session;
    const enemy = s?.ai.enemies.find((e) => e.alive);
    if (!enemy) return null;
    s.player.pitch = 0;
    // Re-place each pass: the hostiles are live and walking, and a target that
    // strolls out of a 2-degree window mid-check would read as a wiring fault.
    for (let i = 0; i < 12; i++) {
      s.player.angle = lane.angle;
      enemy.x = s.player.x + Math.cos(lane.angle) * lane.dist;
      enemy.y = s.player.y + Math.sin(lane.angle) * lane.dist;
      await new Promise((r) => setTimeout(r, 60));
      if (g.input.aimAssistActive) return true;
    }
    return false;
  }, assist.lane);
  assert(
    wired,
    'the frame loop must set aimAssistActive when a hostile is under the crosshair - ' +
      'the assist slider is inert otherwise',
  );
  console.log(
    `aim assist: on-target ${assist.detected}, off-target ${assist.detectedAway}, ` +
      `turn ${assist.free.toFixed(3)} -> ${assist.slowed.toFixed(3)} rad ` +
      `(${(assist.strength * 100).toFixed(0)}%), wired ${wired}`,
  );

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

  // --- the screen the camera is allowed to use ------------------------------
  //
  // The stick zone used to be a full-height column down the left 42 % of the
  // screen, and every touch that started inside it was a stick touch. Measured
  // consequence: a camera swipe beginning anywhere in that column produced
  // exactly zero camera movement, including one starting over the vitals panel,
  // while the same swipe on the right moved 0.35 rad. Two fifths of the screen
  // did nothing when you tried to look with it, which is most of "I swipe and
  // nothing happens".
  //
  // Two rules fix it and both are checked here: the zone is a corner rather
  // than a column, and a second finger is never a second stick.
  await keepAlive();
  const lookZones = await page.evaluate(async () => {
    const g = window.game;
    if (!g.session) return null;
    const input = g.input;
    const surface = document.querySelector('.game-canvas').parentElement;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const ev = (type, id, x, y) =>
      new PointerEvent(type, {
        pointerId: id, clientX: x, clientY: y, bubbles: true,
        pointerType: 'touch', isPrimary: id === 1,
      });
    // The look accumulator is drained by the loop, so pitch only moves once a
    // frame has run. Two of them, because the first may already be in flight.
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const reset = () => { input.releaseAll(); g.session.player.pitch = 0; };

    const swipe = async (id, x, y, dy) => {
      const el = document.elementFromPoint(x, y) ?? surface;
      el.dispatchEvent(ev('pointerdown', id, x, y));
      el.dispatchEvent(ev('pointermove', id, x, y + dy));
      el.dispatchEvent(ev('pointerup', id, x, y + dy));
      await frame();
      return g.session.player.pitch;
    };

    const out = {};

    // Upper left: outside the stick corner, so it looks.
    reset();
    out.upperLeft = await swipe(11, W * 0.2, H * 0.18, 80);

    // Lower left with the stick already held by another finger: also looks.
    reset();
    surface.dispatchEvent(ev('pointerdown', 12, W * 0.12, H * 0.72));
    out.secondFinger = await swipe(13, W * 0.3, H * 0.5, 80);

    // Lower left, first finger: that is the stick, and must stay the stick.
    reset();
    surface.dispatchEvent(ev('pointerdown', 14, W * 0.15, H * 0.8));
    surface.dispatchEvent(ev('pointermove', 14, W * 0.15, H * 0.8 - 50));
    await frame();
    out.stickForward = input.state.moveY;
    surface.dispatchEvent(ev('pointerup', 14, W * 0.15, H * 0.8 - 50));

    // A finger that lands just outside a button's visible edge still presses
    // it. A touch target the size of its own graphic is a target you miss,
    // and the misses read as the game ignoring you.
    const fire = document.querySelector('[data-control="fire"]');
    const r = fire.getBoundingClientRect();
    const controlAt = (px, py) =>
      document.elementFromPoint(px, py)?.closest('[data-control]')?.dataset.control ?? null;
    out.onButton = controlAt(r.left + r.width / 2, r.top + r.height / 2);
    out.justOutside = controlAt(r.left - 6, r.top + r.height / 2);
    out.wellOutside = controlAt(r.left - 40, r.top + r.height / 2);

    reset();
    return out;
  });

  assert(lookZones, 'the raid should still be running for the look-zone check');
  assert(
    lookZones.upperLeft < -0.01,
    `a swipe in the upper left must turn the camera (pitch ${lookZones.upperLeft.toFixed(4)} rad)`,
  );
  assert(
    lookZones.secondFinger < -0.01,
    `a second finger in the left column must look, not be discarded ` +
      `(pitch ${lookZones.secondFinger.toFixed(4)} rad)`,
  );
  assert(
    lookZones.stickForward > 0.3,
    `the first finger low on the left is still the stick (moveY ${lookZones.stickForward.toFixed(2)})`,
  );
  assert(lookZones.onButton === 'fire', 'the fire button must be hittable at its centre');
  assert(
    lookZones.justOutside === 'fire',
    `6 px outside the fire button must still press it, hit ${lookZones.justOutside}`,
  );
  assert(
    lookZones.wellOutside !== 'fire',
    'the enlarged hit ring must not swallow the whole corner of the screen',
  );
  console.log(
    `look zones: upper-left ${lookZones.upperLeft.toFixed(3)} rad, ` +
      `second finger ${lookZones.secondFinger.toFixed(3)} rad, ` +
      `stick ${lookZones.stickForward.toFixed(2)}, button edge +6 px hits`,
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
  await expectScreen('Sektorkarte', 'the map should open');
  await shot('map');
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(400);

  await keepAlive();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(700);
  await expectScreen('Inventar', 'the inventory should open');
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
  await expectScreen('Einsatzbericht', 'the debrief should show');
  await shot('results');

  await page.getByRole('button', { name: 'Zurück ins Versteck' }).click();
  await page.waitForTimeout(700);
  await expectScreen('Versteck', 'should return to the hideout');
  await shot('back-in-hideout');

  // --- persistence -----------------------------------------------------------
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Fortsetzen' }).click();
  await page.waitForTimeout(700);
  await expectScreen('Versteck', 'a saved profile should load');
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
