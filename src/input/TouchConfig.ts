/**
 * TouchConfig - what the player can change about how the game is driven.
 *
 * Split out from `InputSystem` because these values are persisted, edited in a
 * settings screen and shipped as presets, while the input system itself is
 * per-raid machinery. Keeping them apart means the settings screen never
 * reaches into live input state, and the input system never has to know that
 * profiles exist.
 *
 * The defaults are the three-finger claw, because it is the layout the rest of
 * this game is built around: left thumb walks, right thumb looks, right index
 * finger fires. Two-finger works and four-finger is better, but three is where
 * most players land.
 */

export type ClawPreset = 'two' | 'three' | 'four' | 'custom';

/** A button the player can move, resize and fade. */
export interface ButtonLayout {
  /** Fraction of the viewport, from the left/top edge, of the button centre. */
  x: number;
  y: number;
  /** Diameter as a fraction of the viewport's shorter side. */
  size: number;
  /** 0..1. Zero hides the button entirely, which some claw layouts want. */
  opacity: number;
}

export type ButtonId =
  | 'fire' | 'ads' | 'reload' | 'stance' | 'jump' | 'interact'
  | 'swapWeapon' | 'fireMode' | 'heal' | 'toggleLight'
  | 'inventory' | 'map' | 'pause';

export interface TouchConfig {
  preset: ClawPreset;

  // --- look ---------------------------------------------------------------
  /**
   * Radians of yaw per CSS pixel, before any multiplier.
   *
   * Horizontal and vertical are separate because a phone is far wider than it
   * is tall in landscape: the same physical thumb travel covers a much larger
   * fraction of the screen vertically, and players almost universally want the
   * vertical axis slower.
   */
  sensitivityX: number;
  sensitivityY: number;
  /** Multiplier while aiming down an unmagnified sight. */
  adsScale: number;
  /**
   * Multiplier while looking through a magnified optic.
   *
   * Separate from `adsScale` because magnification multiplies the *apparent*
   * angular speed: at 4x, the same thumb movement sweeps four times as much
   * across the field of view, and a single ADS setting cannot serve both.
   */
  scopeScale: number;
  /**
   * How much faster a fast drag turns than a slow one, 0 = linear.
   *
   * Acceleration is what lets one thumb both spin 180 degrees and make a
   * one-pixel correction. It is also what makes aim feel unpredictable when
   * overdone, so the default is mild and it can be switched off entirely.
   */
  acceleration: number;
  /**
   * Exponential smoothing on the look delta, 0 = none.
   *
   * Costs latency in exchange for steadiness. Off by default: on a good screen
   * the raw signal is already clean, and latency is the one thing an aiming
   * player notices immediately.
   */
  smoothing: number;
  invertY: boolean;
  /** Gyroscope aiming, added on top of touch rather than replacing it. */
  gyroEnabled: boolean;
  gyroScale: number;
  /**
   * Aim assist, deliberately small.
   *
   * Only slows the look speed while the crosshair is over a target - it never
   * moves the aim for the player. Anything stronger is felt as the game
   * playing itself, which is the opposite of what a tactical shooter wants.
   */
  aimAssist: number;

  // --- zones --------------------------------------------------------------
  /**
   * Where the movement zone ends, as a fraction of the width.
   *
   * Everything left of this drives the stick; everything right of it drives
   * the camera. Configurable because thumb reach differs enormously between a
   * small phone and a tablet.
   */
  moveZoneWidth: number;
  /** Stick throw in CSS pixels before the input reads as fully deflected. */
  stickRadius: number;
  /** Fixed stick position instead of one that appears where the thumb lands. */
  fixedStick: boolean;

  // --- buttons ------------------------------------------------------------
  buttons: Record<ButtonId, ButtonLayout>;
}

/**
 * The default button layout.
 *
 * Positions are fractions of the viewport so the layout survives every screen
 * size and aspect ratio without a second set of numbers. The right cluster
 * sits within a thumb's arc of the bottom-right corner; the small utility row
 * along the top is reachable by an index finger without leaving the grip.
 */
function defaultButtons(): Record<ButtonId, ButtonLayout> {
  return {
    fire:        { x: 0.895, y: 0.79, size: 0.222, opacity: 0.85 },
    ads:         { x: 0.80, y: 0.60, size: 0.165, opacity: 0.8 },
    reload:      { x: 0.935, y: 0.52, size: 0.155, opacity: 0.8 },
    stance:      { x: 0.735, y: 0.84, size: 0.135, opacity: 0.8 },
    jump:        { x: 0.655, y: 0.63, size: 0.125, opacity: 0.75 },
    interact:    { x: 0.625, y: 0.83, size: 0.145, opacity: 0.85 },
    swapWeapon:  { x: 0.845, y: 0.40, size: 0.135, opacity: 0.8 },
    fireMode:    { x: 0.945, y: 0.26, size: 0.12, opacity: 0.75 },
    heal:        { x: 0.700, y: 0.44, size: 0.135, opacity: 0.8 },
    toggleLight: { x: 0.045, y: 0.32, size: 0.12, opacity: 0.75 },
    inventory:   { x: 0.04, y: 0.06, size: 0.13, opacity: 0.7 },
    map:         { x: 0.10, y: 0.06, size: 0.13, opacity: 0.7 },
    pause:       { x: 0.16, y: 0.06, size: 0.13, opacity: 0.7 },
  };
}

export function defaultTouchConfig(): TouchConfig {
  return {
    preset: 'three',
    sensitivityX: 0.0042,
    sensitivityY: 0.0034,
    adsScale: 0.55,
    scopeScale: 0.32,
    acceleration: 0.35,
    smoothing: 0,
    invertY: false,
    gyroEnabled: false,
    gyroScale: 1,
    aimAssist: 0.15,
    moveZoneWidth: 0.42,
    stickRadius: 66,
    fixedStick: false,
    buttons: defaultButtons(),
  };
}

/**
 * Apply a claw preset.
 *
 * A preset is a button layout, not a different input model - the routing
 * underneath handles any number of fingers either way. What changes is where
 * the buttons sit and how big they are, because that is what decides which
 * grip is comfortable.
 *
 *   two   - both thumbs only. Fire sits under the right thumb's arc and is
 *           large, because the same thumb has to look and shoot.
 *   three - the standard. Fire moves up and shrinks: it belongs to the right
 *           index finger now, and the right thumb keeps the whole lower right
 *           for looking.
 *   four  - both index fingers work. Fire goes to the top right, ADS to the
 *           top left, and both thumbs are left free.
 */
export function applyPreset(config: TouchConfig, preset: ClawPreset): TouchConfig {
  const next: TouchConfig = { ...config, preset, buttons: { ...config.buttons } };
  if (preset === 'custom') return next;

  const set = (id: ButtonId, layout: Partial<ButtonLayout>): void => {
    next.buttons[id] = { ...next.buttons[id], ...layout };
  };

  if (preset === 'two') {
    set('fire', { x: 0.90, y: 0.80, size: 0.25, opacity: 0.9 });
    set('ads', { x: 0.745, y: 0.62, size: 0.18, opacity: 0.85 });
    set('reload', { x: 0.94, y: 0.50, size: 0.16, opacity: 0.85 });
    set('interact', { x: 0.605, y: 0.83, size: 0.15, opacity: 0.9 });
    next.moveZoneWidth = 0.40;
  } else if (preset === 'three') {
    set('fire', { x: 0.895, y: 0.79, size: 0.222, opacity: 0.85 });
    set('ads', { x: 0.795, y: 0.60, size: 0.165, opacity: 0.8 });
    set('reload', { x: 0.935, y: 0.52, size: 0.155, opacity: 0.8 });
    set('interact', { x: 0.625, y: 0.83, size: 0.145, opacity: 0.85 });
    next.moveZoneWidth = 0.42;
  } else {
    // Four fingers: the shoulders of the screen belong to the index fingers,
    // so the thumbs never have to leave the stick or the look area.
    set('fire', { x: 0.93, y: 0.15, size: 0.18, opacity: 0.8 });
    set('ads', { x: 0.07, y: 0.15, size: 0.17, opacity: 0.8 });
    set('reload', { x: 0.935, y: 0.40, size: 0.145, opacity: 0.8 });
    set('interact', { x: 0.615, y: 0.83, size: 0.145, opacity: 0.85 });
    set('stance', { x: 0.07, y: 0.40, size: 0.14, opacity: 0.8 });
    next.moveZoneWidth = 0.44;
  }
  return next;
}
