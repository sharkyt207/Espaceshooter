/**
 * InputSystem - touch-first control scheme with a desktop fallback.
 *
 * The layout is the one that has proven out for mobile shooters, adapted for a
 * game where precision matters more than twitch:
 *
 *   left  half  - floating movement stick, origin set where the thumb lands
 *   right half  - look area; drag to aim, with separate sensitivities for
 *                 hip fire and aimed fire so ADS is genuinely more precise
 *   buttons     - DOM elements, not canvas-drawn, so they stay crisp at any
 *                 DPI, respect safe areas, and cost the renderer nothing
 *
 * Continuous inputs (stick, look) are polled; discrete ones (reload, stance)
 * are edge-triggered and consumed exactly once, so a tap can never be
 * processed twice by two systems.
 *
 * Unity port note: replace this class with the Input System package. The
 * `InputState` shape is what the rest of the game consumes and should be kept.
 */

export interface InputState {
  /** Strafe, -1 (left) .. 1 (right). */
  moveX: number;
  /** Forward, -1 (back) .. 1 (forward). */
  moveY: number;
  /** Yaw delta accumulated since the last poll, in radians. */
  lookX: number;
  /** Pitch delta accumulated since the last poll, in radians. */
  lookY: number;
  fire: boolean;
  ads: boolean;
  sprint: boolean;
  leanLeft: boolean;
  leanRight: boolean;
}

export type ActionName =
  | 'reload'
  | 'stance'
  | 'interact'
  | 'swapWeapon'
  | 'fireMode'
  | 'heal'
  | 'inventory'
  | 'map'
  | 'pause'
  | 'toggleLight';

interface Stick {
  pointerId: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
}

const STICK_RADIUS_PX = 66;
/** Radians of yaw per CSS pixel of drag. */
const LOOK_SENSITIVITY = 0.0042;
/** Multiplier applied while aiming down sights. */
const ADS_SENSITIVITY_SCALE = 0.42;

export class InputSystem {
  readonly state: InputState = {
    moveX: 0, moveY: 0, lookX: 0, lookY: 0,
    fire: false, ads: false, sprint: false, leanLeft: false, leanRight: false,
  };

  /** Set by the game so look sensitivity can drop while aiming. */
  adsFactor = 0;
  /** User-facing sensitivity multiplier from the settings screen. */
  sensitivity = 1;
  /** Invert vertical look. */
  /**
   * Y inversion, off by default.
   *
   * The sign convention runs the whole length of the chain and it is easy to
   * get backwards, so it is worth stating: `pitch` is positive when looking
   * *up*, everywhere - ballistics launches the round with `sin(pitch)`, recoil
   * adds to it, and the renderer raises the horizon for it. Screen coordinates
   * run the other way, y grows downward, so a downward drag has to *subtract*
   * from pitch. Getting that backwards is what made dragging down look up.
   */
  invertY = false;

  private actions = new Set<ActionName>();
  private moveStick: Stick | null = null;
  private lookPointer: { id: number; lastX: number; lastY: number } | null = null;

  private keys = new Set<string>();
  private pointerCaptureEl: HTMLElement | null = null;
  private disposers: (() => void)[] = [];

  /** Visual state for the on-screen stick, consumed by the HUD. */
  readonly stickVisual = { active: false, originX: 0, originY: 0, knobX: 0, knobY: 0 };

  /** True once any touch has been seen - used to hide desktop hints. */
  touchDetected = false;

  attach(surface: HTMLElement): void {
    this.pointerCaptureEl = surface;

    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') this.touchDetected = true;

      // Never capture a pointer that started on the UI. Without this the
      // surface's setPointerCapture swallows the rest of the gesture and the
      // button never receives its click - which silently breaks every menu on
      // touch devices while still "working" for synthetic clicks.
      const target = e.target as HTMLElement | null;
      if (target && target.closest('.screen, .touch-btn, button, input, select, textarea, .panel')) {
        return;
      }

      const rect = surface.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const isLeftHalf = localX < rect.width * 0.42;

      if (isLeftHalf && !this.moveStick) {
        this.moveStick = {
          pointerId: e.pointerId,
          originX: e.clientX,
          originY: e.clientY,
          x: 0,
          y: 0,
        };
        this.stickVisual.active = true;
        this.stickVisual.originX = localX;
        this.stickVisual.originY = e.clientY - rect.top;
        this.stickVisual.knobX = 0;
        this.stickVisual.knobY = 0;
        surface.setPointerCapture(e.pointerId);
      } else if (!isLeftHalf && !this.lookPointer) {
        this.lookPointer = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY };
        surface.setPointerCapture(e.pointerId);
      }
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (this.moveStick && e.pointerId === this.moveStick.pointerId) {
        const dx = e.clientX - this.moveStick.originX;
        const dy = e.clientY - this.moveStick.originY;
        const dist = Math.hypot(dx, dy);
        const clamped = Math.min(dist, STICK_RADIUS_PX);
        const nx = dist > 0.001 ? (dx / dist) * clamped : 0;
        const ny = dist > 0.001 ? (dy / dist) * clamped : 0;
        this.moveStick.x = nx / STICK_RADIUS_PX;
        this.moveStick.y = ny / STICK_RADIUS_PX;
        this.stickVisual.knobX = nx;
        this.stickVisual.knobY = ny;

        // Pushing the stick past 85% is the sprint gesture - no extra button,
        // and it maps naturally onto "run in this direction".
        this.state.sprint = clamped / STICK_RADIUS_PX > 0.85 && this.moveStick.y < -0.35;
      } else if (this.lookPointer && e.pointerId === this.lookPointer.id) {
        const dx = e.clientX - this.lookPointer.lastX;
        const dy = e.clientY - this.lookPointer.lastY;
        this.lookPointer.lastX = e.clientX;
        this.lookPointer.lastY = e.clientY;
        const scale = LOOK_SENSITIVITY * this.sensitivity * (1 - this.adsFactor * (1 - ADS_SENSITIVITY_SCALE));
        this.state.lookX += dx * scale;
        this.state.lookY += (this.invertY ? dy : -dy) * scale;
      }
    };

    const endPointer = (e: PointerEvent): void => {
      if (this.moveStick && e.pointerId === this.moveStick.pointerId) {
        this.moveStick = null;
        this.stickVisual.active = false;
        this.state.sprint = false;
      }
      if (this.lookPointer && e.pointerId === this.lookPointer.id) {
        this.lookPointer = null;
      }
    };

    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', endPointer);
    surface.addEventListener('pointercancel', endPointer);
    this.disposers.push(() => {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', endPointer);
      surface.removeEventListener('pointercancel', endPointer);
    });

    this.attachKeyboard();
  }

  /**
   * Desktop fallback. Not shipped to players, but essential for iterating on
   * gameplay without a phone in hand and for automated smoke tests.
   */
  private attachKeyboard(): void {
    const keyToAction: Record<string, ActionName> = {
      KeyR: 'reload',
      KeyC: 'stance',
      KeyF: 'interact',
      KeyQ: 'swapWeapon',
      KeyV: 'fireMode',
      KeyH: 'heal',
      Tab: 'inventory',
      KeyM: 'map',
      Escape: 'pause',
      KeyL: 'toggleLight',
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) return;
      this.keys.add(e.code);
      const action = keyToAction[e.code];
      if (action) {
        this.actions.add(action);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      this.keys.delete(e.code);
    };

    // Mouse look for desktop, active while the pointer is locked.
    const onMouseMove = (e: MouseEvent): void => {
      if (document.pointerLockElement !== this.pointerCaptureEl) return;
      const scale = LOOK_SENSITIVITY * this.sensitivity * (1 - this.adsFactor * (1 - ADS_SENSITIVITY_SCALE));
      this.state.lookX += e.movementX * scale;
      this.state.lookY += (this.invertY ? e.movementY : -e.movementY) * scale;
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (document.pointerLockElement !== this.pointerCaptureEl) return;
      if (e.button === 0) this.state.fire = true;
      if (e.button === 2) this.state.ads = true;
    };
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button === 0) this.state.fire = false;
      if (e.button === 2) this.state.ads = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    this.disposers.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
    });
  }

  /**
   * Bind a DOM element as a hold button (fire, ADS, lean).
   * Returns a disposer.
   */
  bindHold(el: HTMLElement, key: 'fire' | 'ads' | 'sprint' | 'leanLeft' | 'leanRight'): () => void {
    const down = (e: PointerEvent): void => {
      e.stopPropagation();
      e.preventDefault();
      this.state[key] = true;
      el.classList.add('is-active');
      el.setPointerCapture(e.pointerId);
    };
    const up = (e: PointerEvent): void => {
      e.stopPropagation();
      this.state[key] = false;
      el.classList.remove('is-active');
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointerleave', up);
    };
  }

  /** Bind a DOM element as a one-shot action button. */
  bindTap(el: HTMLElement, action: ActionName): () => void {
    const down = (e: PointerEvent): void => {
      e.stopPropagation();
      e.preventDefault();
      this.actions.add(action);
      el.classList.add('is-active');
    };
    const up = (e: PointerEvent): void => {
      e.stopPropagation();
      el.classList.remove('is-active');
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointerleave', up);
    };
  }

  /**
   * Fold keyboard state into the continuous inputs and return the state.
   * Call exactly once per simulation tick.
   */
  poll(): InputState {
    let kx = 0;
    let ky = 0;
    if (this.keys.has('KeyA')) kx -= 1;
    if (this.keys.has('KeyD')) kx += 1;
    if (this.keys.has('KeyW')) ky += 1;
    if (this.keys.has('KeyS')) ky -= 1;

    if (kx !== 0 || ky !== 0) {
      const len = Math.hypot(kx, ky);
      this.state.moveX = kx / len;
      this.state.moveY = ky / len;
      this.state.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    } else if (this.moveStick) {
      this.state.moveX = this.moveStick.x;
      // Screen Y grows downward; forward is up.
      this.state.moveY = -this.moveStick.y;
    } else {
      this.state.moveX = 0;
      this.state.moveY = 0;
    }

    if (this.keys.has('KeyE')) this.state.leanRight = true;
    else if (!this.holdButtons.has('leanRight')) this.state.leanRight = false;
    if (this.keys.has('KeyQ') && this.keys.has('ShiftLeft')) this.state.leanLeft = true;

    return this.state;
  }

  /** Buttons currently held via DOM, so keyboard polling does not clear them. */
  private holdButtons = new Set<string>();

  /** Reset per-frame look deltas after the game has consumed them. */
  endFrame(): void {
    this.state.lookX = 0;
    this.state.lookY = 0;
  }

  /** True exactly once per press. */
  consumeAction(action: ActionName): boolean {
    if (!this.actions.has(action)) return false;
    this.actions.delete(action);
    return true;
  }

  clearActions(): void {
    this.actions.clear();
  }

  /** Release every held input - used when opening a menu. */
  releaseAll(): void {
    this.state.fire = false;
    this.state.ads = false;
    this.state.sprint = false;
    this.state.moveX = 0;
    this.state.moveY = 0;
    this.state.leanLeft = false;
    this.state.leanRight = false;
    this.moveStick = null;
    this.lookPointer = null;
    this.stickVisual.active = false;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
