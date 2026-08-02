/**
 * Platform - the difference between a web page and an app.
 *
 * Everything here is a browser capability that either does not exist or
 * behaves differently on the two targets, wrapped so the game can ask for what
 * it wants and get silence rather than an exception when the platform cannot
 * provide it. That "silence rather than an exception" rule matters more than
 * it sounds: iOS Safari is missing roughly half of this API surface, and a
 * game that throws on a missing vendor prefix is a game that does not start.
 *
 * The specific gaps this exists to cover:
 *
 *   - **Screen sleep.** A raid can run 25 minutes with long stretches of no
 *     touch input. Without a wake lock the screen dims and locks mid-approach.
 *     Chrome has the Wake Lock API; iOS Safari got it in 16.4, and before that
 *     there is nothing to do about it.
 *   - **The back gesture.** Android's back button and back swipe close the
 *     page by default. Losing a raid to a stray edge swipe is unacceptable, so
 *     a history entry is kept on the stack and back is routed into the game's
 *     own screen stack instead.
 *   - **Browser chrome.** Android Chrome will go fullscreen on request; iOS
 *     Safari will not, and only honours it when the page is installed to the
 *     home screen. Both paths have to work.
 *   - **Haptics.** `navigator.vibrate` is Android-only - iOS has never shipped
 *     it. It is used where it carries information (a hit landed, you are
 *     bleeding), never as UI garnish.
 */

/** True on iOS, including iPadOS pretending to be a Mac. */
export const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1);

export const IS_ANDROID = /Android/.test(navigator.userAgent);

/** Running from the home screen rather than inside browser chrome. */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

// ===========================================================================
// Screen wake lock
// ===========================================================================

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

let wakeLock: WakeLockSentinelLike | null = null;
let wakeLockWanted = false;

function wakeLockApi(): WakeLockLike | null {
  return (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock ?? null;
}

/**
 * Keep the screen awake. Safe to call repeatedly.
 *
 * The lock is dropped by the browser whenever the page is hidden and is *not*
 * restored automatically, so `reacquireWakeLock` has to run on every return to
 * the foreground - otherwise the screen starts sleeping again after the first
 * notification the player swipes away.
 */
export async function requestWakeLock(): Promise<void> {
  wakeLockWanted = true;
  const api = wakeLockApi();
  if (!api || wakeLock) return;
  try {
    const sentinel = await api.request('screen');
    sentinel.addEventListener('release', () => {
      wakeLock = null;
    });
    wakeLock = sentinel;
  } catch {
    // Denied, unsupported, or the document was not visible. Not worth telling
    // the player about - the game is entirely playable without it.
  }
}

export function releaseWakeLock(): void {
  wakeLockWanted = false;
  const held = wakeLock;
  wakeLock = null;
  void held?.release().catch(() => undefined);
}

export function reacquireWakeLock(): void {
  if (wakeLockWanted && !wakeLock) void requestWakeLock();
}

// ===========================================================================
// Fullscreen
// ===========================================================================

/**
 * Ask for fullscreen. Must be called from a user gesture.
 *
 * On iOS this does nothing on iPhone (the API is iPad-only), which is exactly
 * why the install prompt exists: adding to the home screen is the only way to
 * get the address bar out of the way there.
 */
export function requestFullscreen(): void {
  if (IS_IOS) return;
  const target = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>;
  };
  const request = target.requestFullscreen ?? target.webkitRequestFullscreen;
  if (!request) return;
  try {
    const result = request.call(target) as unknown;
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // Rejected by the browser; nothing to recover from.
  }
}

/**
 * Lock to landscape where the platform allows it. Only works in fullscreen or
 * standalone, and never on iOS - hence the rotate prompt as the fallback.
 */
export function lockLandscape(): void {
  const orientation = screen.orientation as (ScreenOrientation & {
    lock?: (o: string) => Promise<void>;
  }) | undefined;
  if (!orientation?.lock) return;
  try {
    void orientation.lock('landscape').catch(() => undefined);
  } catch {
    // Not permitted in this context.
  }
}

// ===========================================================================
// Haptics
// ===========================================================================

let hapticsEnabled = true;

export function setHapticsEnabled(enabled: boolean): void {
  hapticsEnabled = enabled;
}

export function hapticsSupported(): boolean {
  return typeof navigator.vibrate === 'function';
}

/**
 * Haptic patterns, named for what they mean rather than how they feel.
 *
 * Each one is tied to information the player would otherwise have to read off
 * the screen while looking somewhere else - which, in a shooter, is exactly
 * when they cannot afford to look.
 */
export type Haptic = 'hit' | 'kill' | 'hurt' | 'critical' | 'extract' | 'deny';

const PATTERNS: Record<Haptic, number | number[]> = {
  hit: 12,
  kill: [18, 40, 26],
  hurt: 30,
  critical: [40, 60, 40, 60, 90],
  extract: [24, 70, 24, 70, 120],
  deny: [14, 50, 14],
};

export function haptic(kind: Haptic): void {
  if (!hapticsEnabled || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    // Some browsers expose vibrate and then refuse to run it.
  }
}

// ===========================================================================
// Back navigation
// ===========================================================================

/**
 * Route the Android back button and back gesture into the game.
 *
 * The trick is a sacrificial history entry: one `pushState` at boot means the
 * first back press pops *that* rather than leaving the page, and the handler
 * immediately pushes a replacement so the next press has something to pop too.
 * The page can then only be left through the browser's own UI, which is the
 * correct behaviour for a game holding 25 minutes of unsaved progress.
 *
 * Returns a disposer.
 */
export function interceptBack(onBack: () => void): () => void {
  const marker = { grayzone: true };
  history.pushState(marker, '');

  const onPopState = (): void => {
    // Put the guard entry back before handling, so a rapid double press
    // cannot get past it.
    history.pushState(marker, '');
    onBack();
  };

  window.addEventListener('popstate', onPopState);
  return () => window.removeEventListener('popstate', onPopState);
}

// ===========================================================================
// Device capability
// ===========================================================================

export type DeviceTier = 'low' | 'medium' | 'high';

/**
 * Guess how much rendering this device can take, for the *starting* render
 * scale only.
 *
 * This is a starting point, not a verdict: the frame-time governor measures
 * the real thing within a couple of seconds and overrides it either way. The
 * guess exists because those first seconds are the player's first impression,
 * and a mid-range phone that opens at full resolution stutters through them
 * before the governor has data to act on.
 *
 * Core count and memory are crude proxies, but they are the only numbers a
 * browser will hand over, and they are directionally right.
 */
export function detectDeviceTier(): DeviceTier {
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const pixels = window.screen.width * window.screen.height * (window.devicePixelRatio || 1) ** 2;

  // A high pixel count is a cost, not a capability: the same chip has to fill
  // more of them.
  if (cores <= 4 || memory <= 2) return 'low';
  if (cores >= 8 && memory >= 6 && pixels < 4_500_000) return 'high';
  return 'medium';
}

/** Initial render scale for a tier. 0 would mean "let the governor decide". */
export function initialRenderScale(tier: DeviceTier): number {
  switch (tier) {
    case 'low':
      return 0.6;
    case 'medium':
      return 0.78;
    default:
      return 1;
  }
}
