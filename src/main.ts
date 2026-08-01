import './ui/styles.css';
import { Game } from './game/Game';

/**
 * Entry point.
 *
 * Everything the game needs is created here and then handed to `Game`. The
 * only work done at this level is what belongs to the *page* rather than to
 * the game: locking gestures the browser would otherwise steal, keeping the
 * viewport stable when the on-screen keyboard or URL bar moves, and putting up
 * a rotate prompt because this is a landscape title.
 */

function boot(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app container missing');

  // A phone browser will happily interpret a fast swipe as a page gesture and
  // a two-finger tap as a zoom. Both are fatal to a shooter, so we suppress
  // them at the document level rather than fighting them per element.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener(
    'touchmove',
    (e) => {
      // Allow scrolling inside panels, block it everywhere else.
      const target = e.target as HTMLElement | null;
      if (target?.closest('.panel-body')) return;
      e.preventDefault();
    },
    { passive: false },
  );
  // Double-tap zoom has no keyboard equivalent to disable; this is the fix.
  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (now - lastTouchEnd < 320) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );

  const rotatePrompt = document.createElement('div');
  rotatePrompt.className = 'rotate-prompt';
  rotatePrompt.innerHTML =
    '<div class="icon">▭</div>' +
    '<div class="screen-title">Bitte Gerät drehen</div>' +
    '<div class="screen-sub">GRAYZONE PROTOCOL läuft im Querformat.</div>';
  document.body.appendChild(rotatePrompt);

  const game = new Game(app);

  // Desktop convenience: click the canvas to capture the mouse for look.
  //
  // Best-effort only. Embedded contexts (an iframe without allow-pointer-lock)
  // reject or throw, and a sandboxed page must stay playable - dragging on the
  // right half of the screen looks around regardless, on mouse and touch alike.
  app.addEventListener('click', () => {
    if (document.pointerLockElement) return;
    if (document.querySelector('.screen:not(.hidden)')) return;
    const canvas = app.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas?.requestPointerLock) return;
    try {
      const result = canvas.requestPointerLock() as unknown;
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // Pointer lock is unavailable here; the drag-to-look path still works.
    }
  });

  window.addEventListener('beforeunload', () => game.dispose());

  // Expose for debugging from the console; harmless in production.
  (window as unknown as { game: Game }).game = game;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
