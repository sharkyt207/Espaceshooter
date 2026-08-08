/**
 * Service worker - what makes this an app rather than a bookmark.
 *
 * The game is offline by design: no servers, no accounts, every asset
 * generated at runtime. That claim was only true once the page had already
 * loaded. Open the home-screen icon on a train with no signal and you got a
 * browser error, which is precisely the moment a phone game is worth having.
 *
 * Strategy is deliberately not one of the fashionable ones:
 *
 *   - **Cache first for the shell.** The bundle is a build artefact with a
 *     hashed filename, so a cached copy can never be stale - a new build has a
 *     new name and misses the cache by construction. Serving it from disk also
 *     removes a network round trip from cold start, which on a phone is the
 *     difference between "tap, play" and "tap, wait, play".
 *   - **Network first for the entry document.** `index.html` is the one file
 *     whose name never changes, so it is the only way a new build announces
 *     itself. Trying the network first and falling back to cache means an
 *     update lands on the next launch with signal, and no signal still starts
 *     the game.
 *
 * Nothing here talks to a server the game does not already ship with, because
 * there is no server.
 */

// Bumped whenever the precache list changes. Old caches are deleted on
// activate, so a version bump is also the uninstall.
const CACHE = 'grayzone-v1';

/**
 * Cache lookup options, and the reason they are not the defaults.
 *
 * `Cache.match` honours the stored response's `Vary` header, so a response
 * saved under one set of request headers will not be returned for a request
 * carrying different ones. Static hosts routinely send `Vary: Origin` - the
 * local preview server does - while `cache.add()` fetches without the `Origin`
 * header the browser attaches to the CORS-mode requests it later makes for
 * module scripts and stylesheets.
 *
 * The symptom was a cache holding exactly the right URL, a worker in control
 * of the page, and a bundle request that failed anyway. It read as a precache
 * that had not worked. It had; the lookup was refusing the hit.
 *
 * Safe here because every entry is a build artefact on this origin addressed
 * by a hashed name - there is no second representation of any of these URLs
 * for a `Vary` to be disambiguating between.
 */
const MATCH = { ignoreVary: true };

/**
 * Everything needed for a cold start with no network.
 *
 * Written by `scripts/build-sw.mjs` at build time, because the entries that
 * matter most are hashed - `assets/index-f-E-C48k.js` cannot be named by a
 * static file. The list below is the development placeholder; a built worker
 * carries the real one, and the build fails rather than shipping a list with
 * no script bundle in it.
 *
 * Leaving these to the runtime cache instead does not work, and the offline
 * test is what proved it: on the very first visit the worker is installing
 * while the page is already loading, so the bundle is fetched before the fetch
 * handler exists and never passes through it. Install the app, walk into a
 * tunnel, and the cache holds the icons and nothing to run.
 */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // `addAll` rejects the whole batch if any single request fails, which
      // would leave the worker uninstalled over one missing icon. Each entry
      // is fetched on its own so a partial precache still beats none.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Only ever serve this origin. A cross-origin request has nothing to do with
  // the game and caching it would be someone else's data on the user's disk.
  if (url.origin !== self.location.origin) return;

  const isDocument =
    request.mode === 'navigate' || request.destination === 'document';

  if (isDocument) {
    // Network first: the entry document is how a new build announces itself.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches
            .match(request, MATCH)
            .then((hit) => hit ?? caches.match('./index.html', MATCH))
            .then((hit) => hit ?? new Response('Offline', { status: 503 })),
        ),
    );
    return;
  }

  // Everything else: cache first, then fill the cache behind the player.
  event.respondWith(
    caches.match(request, MATCH).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        // Opaque and error responses are not worth keeping - caching a 404
        // would pin the failure until the next version bump.
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
