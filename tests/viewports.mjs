/**
 * Viewport matrix.
 *
 * The smoke test proves the game works. This proves it *fits* - on the phones
 * people actually hold, in landscape, including the ones with a notch eating
 * the left edge.
 *
 * It checks two things per screen, and both are things a screenshot review
 * misses reliably:
 *
 *   1. **Overflow.** Any element extending past the viewport, or a scroll
 *      container the page itself can scroll sideways. A cut-off button is
 *      indistinguishable from a missing one.
 *   2. **Touch targets.** Anything tappable under 40 px in either dimension.
 *      Apple asks for 44, Google for 48; 40 is the line below which a thumb
 *      genuinely misses.
 *
 * Safe-area insets are simulated by injecting the env() fallbacks, because
 * headless Chromium has no notch.
 *
 * Usage: node tests/viewports.mjs [--url URL] [--out DIR]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL = argOf('--url', 'http://localhost:4173/');
const OUT = argOf('--out', './dist/viewports');
mkdirSync(OUT, { recursive: true });

/**
 * Landscape logical sizes. The small end is what actually decides the layout:
 * anything that fits an iPhone SE fits everything above it.
 */
const DEVICES = [
  { name: 'iphone-se', width: 667, height: 375, dpr: 2, notch: 0 },
  { name: 'iphone-14', width: 844, height: 390, dpr: 3, notch: 47 },
  { name: 'iphone-15-pro-max', width: 932, height: 430, dpr: 3, notch: 59 },
  { name: 'pixel-8', width: 892, height: 412, dpr: 2.6, notch: 24 },
  { name: 'galaxy-a54', width: 780, height: 360, dpr: 2.4, notch: 0 },
];

const problems = [];

for (const device of DEVICES) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();

  page.on('pageerror', (e) => problems.push(`${device.name}: [pageerror] ${e.message}`));

  await page.goto(URL, { waitUntil: 'networkidle' });

  // Simulate the notch and gesture bar. env() cannot be set directly, so the
  // variables the stylesheet reads are overridden instead.
  if (device.notch > 0) {
    await page.addStyleTag({
      content: `:root{--safe-l:${device.notch}px;--safe-r:${device.notch}px;--safe-b:21px;}`,
    });
  }
  await page.waitForTimeout(400);

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/${device.name}-${name}.png` });
  };

  const audit = async (label) => {
    const found = await page.evaluate(() => {
      const out = { overflow: [], small: [], overlap: [], pageScrollsX: false };
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      out.pageScrollsX = document.documentElement.scrollWidth > vw + 1;

      const describe = (el) => {
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
        const text = (el.textContent || '').trim().slice(0, 24);
        return `${el.tagName.toLowerCase()}${id}${cls} "${text}"`;
      };

      const visible = (el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return !el.closest('.hidden');
      };

      for (const el of document.querySelectorAll('.screen:not(.hidden) *, .hud:not(.hidden) *')) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;

        // Overflow past the viewport, with a pixel of tolerance for rounding.
        if (r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1 || r.top < -1) {
          // Ignore anything inside a scroll container - it is meant to extend
          // past its box, that is what scrolling is for.
          const scroller = el.closest('.panel-body, .nav-rail, .primer-card, .screen-body');
          if (!scroller) out.overflow.push(describe(el));
        }

        // Touch targets.
        //
        // Inventory cells are exempt and stay smaller on purpose. They are a
        // positional grid where every neighbour is the same kind of thing, so
        // a near miss selects an adjacent item rather than firing an action -
        // recoverable in a way that missing "Verkaufen" and hitting "Alles
        // verkaufen" is not. Sizing them to 44 would also cut the visible
        // stash roughly in half on a phone.
        const tappable = el.matches('button, .btn, .tab, .nav-item, .touch-btn, .list-row.clickable, .time-chip');
        if (tappable && (r.width < 40 || r.height < 40)) {
          out.small.push(`${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      // --- overlapping touch controls ---------------------------------------
      //
      // The floating raid buttons are absolutely positioned from a layout the
      // player can edit, so nothing in the cascade stops two of them landing on
      // top of each other. Overflow does not catch it - both can sit happily
      // inside the viewport while covering one another - and the failure is
      // vicious in play: the finger presses whichever the stacking order put on
      // top, and the other control is simply gone with no visible cause.
      const buttons = [...document.querySelectorAll('.touch-btn')].filter(visible);
      for (let i = 0; i < buttons.length; i++) {
        for (let j = i + 1; j < buttons.length; j++) {
          const a = buttons[i].getBoundingClientRect();
          const b = buttons[j].getBoundingClientRect();
          // A few pixels of contact is fine - these are circles inside square
          // boxes, so the corners can touch while the controls do not.
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX > 6 && overlapY > 6) {
            out.overlap.push(
              `${buttons[i].textContent?.trim()} / ${buttons[j].textContent?.trim()} ` +
                `by ${Math.round(overlapX)}x${Math.round(overlapY)}px`,
            );
          }
        }
      }

      // De-duplicate: one broken rule produces dozens of identical rows.
      out.overflow = [...new Set(out.overflow)].slice(0, 6);
      out.small = [...new Set(out.small)].slice(0, 6);
      out.overlap = [...new Set(out.overlap)].slice(0, 8);
      return out;
    });

    if (found.pageScrollsX) problems.push(`${device.name}/${label}: page scrolls horizontally`);
    for (const o of found.overflow) problems.push(`${device.name}/${label}: overflows viewport - ${o}`);
    for (const s of found.small) problems.push(`${device.name}/${label}: touch target too small - ${s}`);
    for (const o of found.overlap) problems.push(`${device.name}/${label}: touch buttons overlap - ${o}`);
  };

  // --- walk the screens ----------------------------------------------------
  await shot('menu');
  await audit('menu');

  await page.getByRole('button', { name: 'Neues Profil' }).click();
  await page.waitForTimeout(500);
  await shot('primer');
  await audit('primer');

  await page.getByRole('button', { name: 'Überspringen' }).click();
  await page.waitForTimeout(400);

  for (const [label, file] of [
    ['Übersicht', 'hub-overview'],
    ['Ausrüstung', 'hub-gear'],
    ['Versteck', 'hub-base'],
    ['Händler', 'hub-traders'],
    ['Aufträge', 'hub-quests'],
    ['Versicherung', 'hub-insurance'],
  ]) {
    await page.locator('.screen:not(.hidden) .nav-item', { hasText: label }).first().click();
    await page.waitForTimeout(280);
    await shot(file);
    await audit(file);
  }

  // This suite is about layout - safe areas, notches, whether anything
  // overlaps at 3x - and layout is the same whichever backend draws the world
  // behind it. It is also the one suite that has to run at real device pixel
  // ratios, which is exactly where WebGL on SwiftShader falls over: a 932x430
  // viewport at 3x is nearly four megapixels through a CPU rasteriser, and the
  // raid screenshots time out.
  //
  // So the raid is drawn by the software path here. The GPU path is covered by
  // smoke.mjs and renderers.mjs; nothing this file asserts can tell them apart.
  await page.evaluate(() => {
    window.game.settings.renderer = 0;
    window.game.applySettings(window.game.settings);
  });

  await page.getByRole('button', { name: 'Einsatz starten' }).click();
  await page.waitForTimeout(400);
  await shot('deploy');
  await audit('deploy');

  await page.getByRole('button', { name: 'Absetzen' }).click();
  await page.waitForTimeout(2200);
  await shot('raid');
  await audit('raid');

  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);
  await shot('inventory');
  await audit('inventory');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await shot('pause');
  await audit('pause');

  await browser.close();
  console.log(`${device.name.padEnd(20)} ${device.width}x${device.height} @${device.dpr}  checked`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} layout problems:\n` + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

console.log(`\nNo layout problems. Screenshots in ${OUT}`);
