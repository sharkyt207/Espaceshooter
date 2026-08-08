/**
 * offline.mjs - does the installed app actually start without a network?
 *
 * The game has always been offline in the sense that matters least: no
 * servers, no accounts, every texture and sound generated at runtime. None of
 * that helps if the *first* request needs a connection, which it did until the
 * service worker existed. Tapping a home-screen icon on a train produced a
 * browser error page.
 *
 * "It works offline" is exactly the kind of claim that is false in practice and
 * unfalsifiable by reading the code, so this drives it: load once with a
 * network, take the network away, reload, and require a running game.
 *
 * Run: npm run build && npm run preview & node tests/offline.mjs
 */

import { chromium } from 'playwright';
import { findChromium } from './browser.mjs';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL = argOf('--url', 'http://localhost:4173/');

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

let failure = null;
try {
  const context = await browser.newContext({
    viewport: { width: 900, height: 414 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // --- first visit, with a network -----------------------------------------
  await page.goto(URL, { waitUntil: 'networkidle' });

  const registered = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    // Registration is deferred to `load`, so wait rather than sampling
    // immediately and concluding it never happened.
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (!reg) return 'failed';

    // And then wait to be *controlled*, which is a different thing and the one
    // that matters. `ready` resolves as soon as a worker is active; the page
    // that triggered the install was loaded before that worker existed, so it
    // runs uncontrolled until `clients.claim()` takes effect. Going offline in
    // that window is what made this test fail intermittently - the cache was
    // full and correct, and the bundle request still went to the network.
    if (navigator.serviceWorker.controller) return 'controlled';
    return await new Promise((resolve) => {
      const done = () => resolve('controlled');
      navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
      setTimeout(() => resolve(navigator.serviceWorker.controller ? 'controlled' : 'uncontrolled'), 5000);
    });
  });
  assert(
    registered === 'controlled',
    `the service worker should be controlling the page after the first visit, got "${registered}"`,
  );
  console.log('service worker: registered and controlling');

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    let total = 0;
    const kinds = [];
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      total += keys.length;
      for (const request of keys) {
        const path = new URL(request.url).pathname;
        if (path.endsWith('.js')) kinds.push('js');
        else if (path.endsWith('.css')) kinds.push('css');
        else if (path.endsWith('/') || path.endsWith('.html')) kinds.push('html');
      }
    }
    return { names, total, kinds };
  });
  assert(cached.total > 0, 'the cache should not be empty after a full load');
  // The bundle is the asset pack for this game - without it there is nothing
  // to run offline, however many icons were stored.
  assert(
    cached.kinds.includes('js'),
    `the script bundle has to be cached, only found ${JSON.stringify(cached.kinds)}`,
  );
  assert(
    cached.kinds.includes('html'),
    `the entry document has to be cached, only found ${JSON.stringify(cached.kinds)}`,
  );
  console.log(`cache: ${cached.total} entries in ${cached.names.join(', ')}`);

  // --- now take the network away -------------------------------------------
  await context.setOffline(true);

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const state = await page.evaluate(() => ({
    hasGame: !!window.game,
    hasCanvas: !!document.querySelector('canvas'),
    title: document.querySelector('.menu-hero .title')?.textContent ?? null,
    running: !!window.game?.loop?.stats,
    fps: window.game?.loop?.stats?.fps ?? 0,
  }));

  if (!state.hasGame) {
    const diag = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls = [];
      for (const n of names) {
        const c = await caches.open(n);
        for (const r of await c.keys()) urls.push(r.url);
      }
      return { controller: !!navigator.serviceWorker.controller, urls };
    });
    console.error('offline state:', JSON.stringify(state));
    console.error('controlled by worker:', diag.controller);
    console.error('cached urls:\n  ' + diag.urls.join('\n  '));
    console.error('errors:\n' + errors.join('\n'));
  }
  assert(state.hasGame, 'the game should boot from cache with no network');
  assert(state.hasCanvas, 'the renderer should come up offline');
  assert(state.title, 'the menu should render offline');
  assert(state.running, 'the loop should be running offline');
  assert(errors.length === 0, `page errors while offline:\n${errors.join('\n')}`);

  console.log(`offline reload: "${state.title}" up, loop at ${state.fps.toFixed(0)} fps`);

  // --- and a raid has to be playable, not just the menu ---------------------
  await page.getByRole('button', { name: 'Neues Profil' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Überspringen' }).click().catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Einsatz starten' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Absetzen' }).click();
  await page.waitForFunction(() => !!window.game.session, null, { timeout: 60_000 });
  await page.waitForTimeout(800);

  const raid = await page.evaluate(() => ({
    state: window.game.state,
    ai: window.game.session?.ai.aliveCount ?? 0,
    map: window.game.session?.generated.displayName ?? null,
  }));
  assert(raid.state === 'raid', `a raid should start offline, state was ${raid.state}`);
  assert(raid.ai > 0, 'the raid should be populated offline');
  console.log(`offline raid: ${raid.map}, ${raid.ai} hostiles`);

  assert(errors.length === 0, `page errors during the offline raid:\n${errors.join('\n')}`);
} catch (err) {
  failure = err;
} finally {
  await browser.close();
}

if (failure) {
  console.error(`\nOffline test failed: ${failure.message}`);
  process.exit(1);
}
console.log('\nOffline test passed. The installed app starts with no network.');
