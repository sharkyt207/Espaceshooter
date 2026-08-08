/**
 * InputSystem - multitouch control, built so that nothing blocks anything.
 *
 * The rule this is written around: **every pointer is routed exactly once, at
 * touch-down, and never re-routed.** A finger that lands in the movement zone
 * drives the stick until it lifts. A finger that lands in the look zone turns
 * the camera until it lifts. A finger that lands on a button holds that button
 * until it lifts. No later touch can steal a role, and no role is refused
 * because another finger is already down.
 *
 * That rule is the whole reason claw grips work here. The previous version
 * kept one movement pointer and one look pointer and dropped everything else,
 * which meant a third finger was silently ignored - the input equivalent of a
 * dead key. Anyone playing three- or four-finger would have found the game
 * unresponsive in a way no setting could fix.
 *
 * Concretely, all of this has to be simultaneously true and now is:
 *
 *   left thumb   walking forward
 *   right thumb  dragging the camera down against recoil
 *   left index   holding fire
 *   right index  holding ADS
 *
 * Continuous inputs (stick, look) are polled once per tick; discrete ones
 * (reload, stance) are edge-triggered and consumed exactly once, so a single
 * tap can never be handled twice.
 *
 * Unity port note: replace the pointer plumbing with the Input System package
 * and keep `InputState` and `TouchConfig` - they are what the game consumes.
 */

import { clamp } from '../core/Math2D';
import { defaultTouchConfig, type TouchConfig } from './TouchConfig';

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
  | 'jump'
  | 'interact'
  | 'swapWeapon'
  | 'fireMode'
  | 'heal'
  | 'inventory'
  | 'map'
  | 'pause'
  | 'toggleLight';

export type HoldName = 'fire' | 'ads' | 'sprint' | 'leanLeft' | 'leanRight';

/** What a live pointer is doing. Assigned on down, fixed until up. */
type PointerRole = 'move' | 'look';

interface MovePointer {
  id: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
}

interface LookPointer {
  id: number;
  lastX: number;
  lastY: number;
}

export class InputSystem {
  readonly state: InputState = {
    moveX: 0, moveY: 0, lookX: 0, lookY: 0,
    fire: false, ads: false, sprint: false, leanLeft: false, leanRight: false,
  };

  config: TouchConfig = defaultTouchConfig();

  /**
   * How far into ADS the weapon is, 0..1, and the optic's magnification.
   *
   * Both come from the game each frame. Magnification matters because it
   * multiplies apparent angular speed - the look scale has to divide it back
   * out or a 4x optic is unusable at any sensitivity that works for iron
   * sights.
   */
  adsFactor = 0;
  magnification = 1;

  /** User-facing multiplier from the settings screen, on top of the config. */
  sensitivity = 1;

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
  get invertY(): boolean { return this.config.invertY; }
  set invertY(value: boolean) { this.config.invertY = value; }

  /**
   * Set by the game when the crosshair is over a target.
   *
   * Drives the aim-assist slowdown and nothing else - this never moves the
   * player's aim for them.
   */
  aimAssistActive = false;

  private actions = new Set<ActionName>();

  /** Pointer id -> role, so a pointer can never change what it drives. */
  private roles = new Map<number, PointerRole>();
  private movePointer: MovePointer | null = null;
  /**
   * Every pointer currently turning the camera.
   *
   * A list rather than a single slot. Two fingers on the look area is not a
   * gesture anyone performs deliberately, but it happens constantly by
   * accident with a claw grip - a resting index finger, a thumb that has not
   * lifted cleanly - and the old single-slot version turned those into a dead
   * camera. Summing them costs nothing and cannot fail.
   */
  private lookPointers: LookPointer[] = [];

  /** Smoothed look, when the player has asked for smoothing. */
  private smoothX = 0;
  private smoothY = 0;

  /** Gyro delta accumulated since the last poll, in radians. */
  private gyroX = 0;
  private gyroY = 0;
  private lastGyro: { alpha: number; beta: number; gamma: number } | null = null;

  private keys = new Set<string>();
  private surface: HTMLElement | null = null;
  private disposers: (() => void)[] = [];

  /**
   * Which holds are driven by a DOM button right now.
   *
   * Without this the keyboard poll clears a hold the moment the key is not
   * pressed, which on a touch device means every held button is wiped one tick
   * after it is pressed. The previous version declared this set and never
   * filled it, so the lean buttons did exactly that.
   */
  private heldByButton = new Set<HoldName>();

  /** Visual state for the on-screen stick, consumed by the HUD. */
  readonly stickVisual = { active: false, originX: 0, originY: 0, knobX: 0, knobY: 0 };

  /** True once any touch has been seen - used to hide desktop hints. */
  touchDetected = false;

  attach(surface: HTMLElement): void {
    this.surface = surface;

    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') this.touchDetected = true;

      // Never claim a pointer that started on the UI. Without this the
      // surface's pointer capture swallows the rest of the gesture and the
      // button never receives its press - which silently breaks every menu on
      // touch devices while still working for synthetic clicks.
      const target = e.target as HTMLElement | null;
      if (target?.closest('.screen, .touch-btn, button, input, select, textarea, .panel')) {
        return;
      }

      const rect = surface.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const inMoveZone = localX < rect.width * this.config.moveZoneWidth;

      if (inMoveZone) {
        // One stick at a time: a second thumb in the same zone would make the
        // intended direction ambiguous. A second finger there is ignored for
        // movement but still consumes nothing, so it cannot block anything.
        if (this.movePointer) return;
        this.roles.set(e.pointerId, 'move');
        this.movePointer = {
          id: e.pointerId,
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
      } else {
        this.roles.set(e.pointerId, 'look');
        this.lookPointers.push({ id: e.pointerId, lastX: e.clientX, lastY: e.clientY });
      }

      // Capture so the gesture survives the finger sliding outside the
      // element, and so `pointerup` is guaranteed to arrive here.
      try {
        surface.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers refuse capture for a pointer that is already gone.
        // Losing capture only costs robustness at the edges, never correctness.
      }
    };

    const onPointerMove = (e: PointerEvent): void => {
      const role = this.roles.get(e.pointerId);
      if (role === undefined) return;

      if (role === 'move' && this.movePointer && this.movePointer.id === e.pointerId) {
        const radius = this.config.stickRadius;
        const dx = e.clientX - this.movePointer.originX;
        const dy = e.clientY - this.movePointer.originY;
        const dist = Math.hypot(dx, dy);
        const clamped = Math.min(dist, radius);
        const nx = dist > 0.001 ? (dx / dist) * clamped : 0;
        const ny = dist > 0.001 ? (dy / dist) * clamped : 0;
        this.movePointer.x = nx / radius;
        this.movePointer.y = ny / radius;
        this.stickVisual.knobX = nx;
        this.stickVisual.knobY = ny;

        // Pushing the stick past 85 percent forward is the sprint gesture - no
        // extra button, and it maps naturally onto "run that way".
        this.state.sprint =
          clamped / radius > 0.85 && this.movePointer.y < -0.35;
        return;
      }

      const look = this.lookPointers.find((p) => p.id === e.pointerId);
      if (!look) return;

      const dx = e.clientX - look.lastX;
      const dy = e.clientY - look.lastY;
      look.lastX = e.clientX;
      look.lastY = e.clientY;
      this.applyLook(dx, dy, e.timeStamp);
    };

    const endPointer = (e: PointerEvent): void => {
      const role = this.roles.get(e.pointerId);
      if (role === undefined) return;
      this.roles.delete(e.pointerId);

      if (role === 'move' && this.movePointer?.id === e.pointerId) {
        this.movePointer = null;
        this.stickVisual.active = false;
        this.stickVisual.knobX = 0;
        this.stickVisual.knobY = 0;
        this.state.sprint = false;
        return;
      }
      const index = this.lookPointers.findIndex((p) => p.id === e.pointerId);
      if (index >= 0) this.lookPointers.splice(index, 1);
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

  // =========================================================================
  // Look
  // =========================================================================

  /**
   * Turn a drag in pixels into a change of aim.
   *
   * Everything that scales aim lives here, in one place and in a fixed order,
   * because these multiply and the order is easy to get wrong:
   *
   *   1. per-axis base sensitivity - vertical is slower by default
   *   2. the player's overall multiplier
   *   3. acceleration, from how fast this particular drag is moving
   *   4. optics - ADS scale, then divided by magnification
   *   5. aim assist, which only ever slows down
   */
  private applyLook(dx: number, dy: number, timeStamp: number): void {
    const cfg = this.config;

    // Acceleration reads the speed of this sample. Guarded against a zero or
    // absurd frame gap, which a backgrounded tab produces in quantity.
    let accel = 1;
    if (cfg.acceleration > 0) {
      const dt = Math.max(4, Math.min(64, timeStamp - this.lastLookTime));
      this.lastLookTime = timeStamp;
      const pxPerMs = Math.hypot(dx, dy) / dt;
      accel = 1 + cfg.acceleration * Math.min(1, pxPerMs / 1.6);
    }

    // Optics. `adsScale` covers irons and red dots; magnified sights divide by
    // their own factor on top, because magnification multiplies how much of
    // the field of view a given thumb movement crosses.
    let optic = 1;
    if (this.adsFactor > 0) {
      const target = this.magnification > 1.2 ? cfg.scopeScale : cfg.adsScale;
      optic = 1 - this.adsFactor * (1 - target);
      if (this.magnification > 1.2) optic /= this.magnification;
    }

    const assist = this.aimAssistActive ? 1 - cfg.aimAssist : 1;
    const common = this.sensitivity * accel * optic * assist;

    this.state.lookX += dx * cfg.sensitivityX * common;
    this.state.lookY += (cfg.invertY ? dy : -dy) * cfg.sensitivityY * common;
  }

  private lastLookTime = 0;

  /**
   * Gyroscope aiming, added on top of touch rather than replacing it.
   *
   * Both sources land in the same accumulator, so a player can hold a coarse
   * drag with the thumb and fine-tune by tilting the phone - which is how gyro
   * is actually used well, and why it is additive rather than a mode.
   */
  enableGyro(): void {
    const onOrientation = (e: DeviceOrientationEvent): void => {
      if (!this.config.gyroEnabled) {
        this.lastGyro = null;
        return;
      }
      const alpha = e.alpha ?? 0;
      const beta = e.beta ?? 0;
      const gamma = e.gamma ?? 0;
      if (this.lastGyro) {
        // Yaw wraps at 360; take the short way round or every crossing sends
        // the camera spinning.
        let dAlpha = alpha - this.lastGyro.alpha;
        if (dAlpha > 180) dAlpha -= 360;
        if (dAlpha < -180) dAlpha += 360;
        const dBeta = beta - this.lastGyro.beta;
        const scale = (Math.PI / 180) * this.config.gyroScale;
        this.gyroX += -dAlpha * scale;
        this.gyroY += (this.config.invertY ? dBeta : -dBeta) * scale;
      }
      this.lastGyro = { alpha, beta, gamma };
    };
    window.addEventListener('deviceorientation', onOrientation);
    this.disposers.push(() => window.removeEventListener('deviceorientation', onOrientation));
  }

  // =========================================================================
  // Keyboard and mouse - desktop only
  // =========================================================================

  /**
   * Desktop fallback. Not what ships to players, but essential for iterating
   * on gameplay without a phone in hand and for the automated smoke tests.
   */
  private attachKeyboard(): void {
    const keyToAction: Record<string, ActionName> = {
      KeyR: 'reload',
      KeyC: 'stance',
      Space: 'jump',
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

    const onMouseMove = (e: MouseEvent): void => {
      if (document.pointerLockElement !== this.surface) return;
      this.applyLook(e.movementX, e.movementY, performance.now());
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (document.pointerLockElement !== this.surface) return;
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

  // =========================================================================
  // Buttons
  // =========================================================================

  /**
   * Bind a DOM element as a hold button (fire, ADS, lean).
   *
   * Capture is taken so the hold survives the finger sliding off the button,
   * which happens constantly under recoil - and because capture guarantees the
   * matching `pointerup` arrives here rather than at whatever is underneath.
   * `pointerleave` is deliberately *not* bound: with capture active it either
   * never fires or fires spuriously, and treating it as a release is what made
   * buttons drop mid-burst.
   */
  bindHold(el: HTMLElement, key: HoldName): () => void {
    let held: number | null = null;

    const down = (e: PointerEvent): void => {
      e.stopPropagation();
      e.preventDefault();
      if (held !== null) return;
      held = e.pointerId;
      this.state[key] = true;
      this.heldByButton.add(key);
      el.classList.add('is-active');
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // See the note in `attach`: losing capture costs robustness, not
        // correctness, and the window-level guard below still releases.
      }
    };
    const up = (e: PointerEvent): void => {
      e.stopPropagation();
      if (held !== e.pointerId) return;
      held = null;
      this.state[key] = false;
      this.heldByButton.delete(key);
      el.classList.remove('is-active');
    };
    // A last-resort release. If a pointer is lost without an up - the browser
    // cancels it, the element is removed mid-press - the button would
    // otherwise stay down forever, and a stuck fire button empties a magazine.
    const onWindowUp = (e: PointerEvent): void => {
      if (held === e.pointerId) up(e);
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowUp);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('pointercancel', onWindowUp);
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
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }

  // =========================================================================
  // Frame
  // =========================================================================

  /**
   * Fold keyboard, stick and gyro into the state and return it.
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
    } else if (this.movePointer) {
      this.state.moveX = this.movePointer.x;
      // Screen Y grows downward; forward is up.
      this.state.moveY = -this.movePointer.y;
    } else {
      this.state.moveX = 0;
      this.state.moveY = 0;
    }

    // Keyboard lean, but never clobbering a held button. This is the check the
    // old version tried to make against a set it never populated.
    if (!this.heldByButton.has('leanRight')) {
      this.state.leanRight = this.keys.has('KeyE');
    }
    if (!this.heldByButton.has('leanLeft')) {
      this.state.leanLeft = this.keys.has('KeyQ') && this.keys.has('ShiftLeft');
    }

    // Gyro rides on top of whatever the thumb contributed.
    if (this.config.gyroEnabled) {
      this.state.lookX += this.gyroX;
      this.state.lookY += this.gyroY;
    }
    this.gyroX = 0;
    this.gyroY = 0;

    // Smoothing last, so it filters the finished signal from every source.
    if (this.config.smoothing > 0) {
      const k = clamp(1 - this.config.smoothing, 0.08, 1);
      this.smoothX += (this.state.lookX - this.smoothX) * k;
      this.smoothY += (this.state.lookY - this.smoothY) * k;
      this.state.lookX = this.smoothX;
      this.state.lookY = this.smoothY;
    }

    return this.state;
  }

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
    this.heldByButton.clear();
    this.roles.clear();
    this.movePointer = null;
    this.lookPointers.length = 0;
    this.stickVisual.active = false;
    this.stickVisual.knobX = 0;
    this.stickVisual.knobY = 0;
    this.smoothX = 0;
    this.smoothY = 0;
  }

  /** How many fingers are currently driving the world. For diagnostics. */
  get activePointers(): number {
    return this.roles.size;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
