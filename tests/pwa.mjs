/**
 * pwa.mjs - is this actually installable from the address it will be served at?
 *
 * "Add to Home Screen" either produces an app or a grey bookmark, and which one
 * you get is decided by a handful of details that all fail quietly: a manifest
 * that 404s, an icon that 404s, a `start_url` that points outside the directory
 * the site lives in, a missing `apple-touch-icon`. None of these break the page
 * - it loads and plays perfectly - so the only symptom is a disappointing icon
 * on someone's phone, discovered after they have already tried to install it.
 *
 * The subdirectory case is the one worth guarding. GitHub Pages serves a
 * project site from `/<repo>/`, not from the domain root, and an absolute
 * `start_url: "/"` would launch the wrong page - the user's *other* projects,
 * or a 404. Running this against a subpath is therefore the real test, and it
 * is what the default URL below does.
 *
 * Run:
 *   npm run build
 *   mkdir -p /tmp/pages/Espaceshooter && cp -r dist/* /tmp/pages/Espaceshooter/
 *   (cd /tmp/pages && python3 -m http.server 4200) &
 *   node tests/pwa.mjs
 */

import { chromium } from 'playwright';
import { findChromium } from './browser.mjs';

// Not named `URL`: shadowing the global constructor is a mistake I made while
// writing this, and it only surfaced after every other check had passed.
const target = process.argv[2] ?? 'http://127.0.0.1:4200/Espaceshooter/';

/**
 * Honour an outbound proxy when one is configured.
 *
 * Sandboxed environments route HTTPS through a local proxy, and Chromium does
 * not read `HTTPS_PROXY` the way curl does - so a live URL that curl fetches
 * happily comes back as ERR_CONNECTION_RESET in the browser, which reads as a
 * broken deployment rather than a missing setting.
 */
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(target);
// Never route a local server through it: the proxy would try to relay a
// request that has nowhere to go, and the run simply hangs.
const proxy = isLocal ? null : (process.env.HTTPS_PROXY || process.env.https_proxy);

const browser = await chromium.launch({
  executablePath: findChromium(),
  ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1,::1' } } : {}),
  args: [
    '--no-sandbox',
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    // The proxy terminates TLS with its own CA, which the browser has no
    // reason to trust. Only relaxed when a proxy is actually in use.
    ...(proxy ? ['--ignore-certificate-errors'] : []),
  ],
});

const failures = [];
let head;
let manifest;

try {
  // A phone in portrait, which is how someone arrives before installing.
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
  });
  await page.goto(target, { waitUntil: 'networkidle' });

  head = await page.evaluate(() => {
    const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content ?? null;
    const link = (r) => document.querySelector(`link[rel="${r}"]`)?.href ?? null;
    return {
      title: document.title,
      manifest: link('manifest'),
      appleIcon: link('apple-touch-icon'),
      appleCapable: meta('apple-mobile-web-app-capable'),
      appleTitle: meta('apple-mobile-web-app-title'),
      viewport: meta('viewport'),
    };
  });

  if (!head.manifest) failures.push('no <link rel="manifest">');
  // iOS ignores the manifest for the home-screen icon and reads these instead,
  // which is why they are checked separately rather than assumed.
  if (head.appleCapable !== 'yes') failures.push('apple-mobile-web-app-capable is not "yes"');
  if (!head.appleIcon) failures.push('no apple-touch-icon - iOS would use a screenshot');
  if (!head.appleTitle) failures.push('no apple-mobile-web-app-title - the icon would be labelled from <title>');
  if (!/viewport-fit=cover/.test(head.viewport ?? '')) {
    failures.push('viewport lacks viewport-fit=cover - the notch would letterbox the game');
  }

  if (head.manifest) {
    manifest = await page.evaluate(async (href) => {
      const res = await fetch(href);
      if (!res.ok) return { ok: false, status: res.status };
      const json = await res.json();
      const abs = (u) => new URL(u, href).href;
      return {
        ok: true,
        name: json.name,
        startUrl: abs(json.start_url),
        scope: abs(json.scope),
        display: json.display,
        orientation: json.orientation,
        icons: (json.icons ?? []).map((i) => ({
          src: abs(i.src),
          sizes: i.sizes,
          purpose: i.purpose,
        })),
      };
    }, head.manifest);

    if (!manifest.ok) {
      failures.push(`manifest fetch returned ${manifest.status}`);
    } else {
      const base = new globalThis.URL(target).href;
      // The subdirectory check. An absolute start_url would launch whatever
      // sits at the domain root instead of the game.
      if (!manifest.startUrl.startsWith(base)) {
        failures.push(`start_url ${manifest.startUrl} points outside ${base}`);
      }
      if (!manifest.scope.startsWith(base)) {
        failures.push(`scope ${manifest.scope} points outside ${base}`);
      }
      if (manifest.orientation !== 'landscape') {
        failures.push(`orientation is "${manifest.orientation}" - this is a landscape game`);
      }
      if (!['fullscreen', 'standalone'].includes(manifest.display)) {
        failures.push(`display is "${manifest.display}" - browser chrome would stay`);
      }
      if (!manifest.icons.some((i) => i.purpose?.includes('maskable'))) {
        failures.push('no maskable icon - Android would letterbox it in a white circle');
      }

      // Every icon has to exist. A 404 here is the usual reason a home-screen
      // entry comes out as a grey rectangle.
      for (const icon of [...manifest.icons.map((i) => i.src), head.appleIcon].filter(Boolean)) {
        const status = await page.evaluate(async (u) => (await fetch(u)).status, icon);
        const label = icon.replace(target, '');
        console.log(`  ${status === 200 ? 'ok  ' : 'FAIL'} ${String(status).padStart(3)}  ${label}`);
        if (status !== 200) failures.push(`icon ${label} returned ${status}`);
      }
    }
  }

  // And the service worker, without which the installed icon needs a network.
  const controlled = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (!reg) return 'failed';
    if (navigator.serviceWorker.controller) return 'controlled';
    return await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve('controlled'), { once: true });
      setTimeout(() => resolve('uncontrolled'), 5000);
    });
  });
  if (controlled !== 'controlled') failures.push(`service worker is "${controlled}", so the app would need a network`);

  console.log(`\n  title        ${head.title}`);
  console.log(`  icon label   ${head.appleTitle}`);
  if (manifest?.ok) {
    console.log(`  start        ${manifest.startUrl}`);
    console.log(`  display      ${manifest.display}, ${manifest.orientation}`);
  }
  console.log(`  worker       ${controlled}`);
} catch (err) {
  failures.push(`could not reach ${target}: ${err.message}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nPWA check failed for ${target}:\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log(`\nPWA check passed. ${target} installs as an app.`);
