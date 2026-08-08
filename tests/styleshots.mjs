/**
 * styleshots.mjs - photograph each visual style from the running game.
 *
 * Four views per style, chosen because between them they cover every surface a
 * style touches: a quest NPC (the portrait treatment), the weapon in hand (the
 * viewmodel finish), a raid frame (the grade, and the HUD over it), and the hub
 * (the CSS chrome).
 *
 * These are captures, not mockups. Every pixel comes from the same code that
 * runs in the game, so whichever direction is chosen is already built - there
 * is no second step where the picture has to be turned into an implementation.
 *
 * The raid is pinned to one seed and one camera pose across all three styles,
 * so the only thing that differs between the three raid frames is the style
 * itself. Comparing three different-looking scenes would say nothing.
 *
 * Run: node tests/styleshots.mjs [--url ...] [--out ...]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { findChromium } from './browser.mjs';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL = argOf('--url', 'http://127.0.0.1:4173/');
const OUT = argOf('--out', './dist/styles');
const EXECUTABLE = findChromium();

const STYLES = ['comic', 'futuristisch', 'realistisch'];

/** Fixed pose for the raid frame, so the three are directly comparable. */
const POSE = { angle: 0.2, pitch: -0.04 };

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

try {
  for (const style of STYLES) {
    console.log(`\n--- ${style} ---`);
    await shootUi(style);
    await shootRaid(style);
  }
  console.log(`\nDone. ${STYLES.length * 4} frames in ${OUT}`);
} finally {
  await browser.close();
}

/**
 * Open the game with a style already applied.
 *
 * `dpr` differs between the two passes on purpose. The menus are captured at
 * 2x because they are type and hairlines and that is where the difference
 * between the styles lives; the raid is captured at 1x because this runs
 * against SwiftShader, where the GPU renderer at 2x is four times the
 * fragments through a CPU rasteriser and the frame never arrives.
 */
async function open(style, dpr) {
  const context = await browser.newContext({
    viewport: { width: 900, height: 414 },
    deviceScaleFactor: dpr,
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

  // Set the style before anything is drawn, so no cached portrait or tone
  // curve belongs to the previous one.
  await page.evaluate((id) => {
    window.game.settings.style = id;
    window.game.applySettings(window.game.settings);
  }, style);
  await page.waitForTimeout(400);

  return { context, page, errors };
}

/** The hub and a quest NPC, at full device resolution. */
async function shootUi(style) {
  const { context, page, errors } = await open(style, 2);

  // --- the hub -------------------------------------------------------------
  await page.locator('.screen:not(.hidden) .nav-item', { hasText: 'Übersicht' }).first().click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${style}-hub.png` });

  // --- a quest NPC ---------------------------------------------------------
  //
  // The traders screen, which is where the portraits are at their largest.
  await page.locator('.screen:not(.hidden) .nav-item', { hasText: 'Händler' }).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${style}-npc.png` });

  // The portrait on its own, too - the treatment is the point and the
  // surrounding chrome distracts from it at this size.
  const portrait = page.locator('.portrait').first();
  if (await portrait.count()) {
    await portrait.screenshot({ path: `${OUT}/${style}-npc-portrait.png` });
  }

  await context.close();
  if (errors.length) throw new Error(`${style} ui: page errors\n  ${errors.join('\n  ')}`);
}

/** A raid frame and the weapon, at 1x. */
async function shootRaid(style) {
  const { context, page, errors } = await open(style, 1);

  await page.getByRole('button', { name: 'Einsatz starten' }).click();
  await page.waitForTimeout(400);

  // Dusk, clear. Overcast grey is the condition a grade has least to work
  // with - there is barely any colour in the scene for a style to take a
  // position on - so the preview is shot under a low sun, where the three
  // directions are actually distinguishable.
  await page.locator('.time-chip', { hasText: 'Dämmerung' }).first().click().catch(() => {});
  await page.waitForTimeout(250);

  // The same map arrangement and the same weather every time. Both are drawn
  // from Math.random at deploy, so it is pinned across the click and restored
  // immediately after. This particular value rolls clear weather.
  await page.evaluate(() => {
    window.__realRandom = Math.random;
    Math.random = () => 0.01;
  });
  await page.getByRole('button', { name: 'Absetzen' }).click();
  await page.evaluate(() => {
    Math.random = window.__realRandom;
  });
  await page.waitForTimeout(2600);

  // Freeze the camera. Recoil and footsteps would otherwise leave each style
  // looking at something slightly different.
  await page.evaluate((pose) => {
    const s = window.game.session;
    if (!s) return;
    s.player.x = Math.floor(s.player.x) + 0.5;
    s.player.y = Math.floor(s.player.y) + 0.5;
    s.player.angle = pose.angle;
    s.player.pitch = pose.pitch;
  }, POSE);
  await page.waitForTimeout(900);

  await page.screenshot({ path: `${OUT}/${style}-hud.png` });

  // --- the weapon ----------------------------------------------------------
  //
  // Aimed down sights and cropped to the lower right, which is the largest and
  // least obstructed the viewmodel ever gets. The crop is taken from the
  // canvas rather than the page so the HUD buttons stay out of it.
  await page.evaluate(() => {
    const c = window.game.session?.playerWeapon;
    if (c) c.adsProgress = 0;
  });
  await page.waitForTimeout(500);
  const canvas = await page.locator('.game-canvas.overlay, .game-canvas').last().boundingBox();
  if (canvas) {
    await page.screenshot({
      path: `${OUT}/${style}-weapon.png`,
      clip: {
        x: canvas.x + canvas.width * 0.42,
        y: canvas.y + canvas.height * 0.45,
        width: canvas.width * 0.40,
        height: canvas.height * 0.45,
      },
    });
  }

  const state = await page.evaluate(() => ({
    style: document.documentElement.dataset.style,
    renderer: window.game.renderer.rendererName,
    conditions: window.game.session?.conditions.label ?? '',
  }));
  console.log(`  style=${state.style}  ${state.conditions}  via ${state.renderer.slice(0, 40)}`);

  await context.close();
  if (errors.length) throw new Error(`${style}: page errors\n  ${errors.join('\n  ')}`);
}
