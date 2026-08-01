/**
 * Math2D - allocation-free 2D math helpers.
 *
 * The whole simulation runs on a flat XZ plane (top-down world space) with a
 * separate scalar `y` used only for bullet height / eye height. This mirrors
 * Unity's world space so ports map 1:1: our (x, y) is Unity's (x, z).
 *
 * Every function here is pure and allocation-free where possible - these are
 * called thousands of times per frame by ballistics and AI.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function vec2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a));
}

/** Frame-rate independent exponential smoothing. `rate` = how much of the gap closes per second. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed delta from `from` to `to`, in radians. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Rotate `current` towards `target` by at most `maxDelta` radians. */
export function rotateTowards(current: number, target: number, maxDelta: number): number {
  const d = angleDelta(current, target);
  if (Math.abs(d) <= maxDelta) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxDelta);
}

export function angleLerp(a: number, b: number, t: number): number {
  return wrapAngle(a + angleDelta(a, b) * t);
}

/** Smooth Hermite interpolation, used for falloff curves. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Remaps v from [inMin,inMax] into [outMin,outMax] with clamping. */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, v));
}

/** Axis-aligned circle vs circle overlap. */
export function circlesOverlap(ax: number, ay: number, ar: number, bx: number, by: number, br: number): boolean {
  const r = ar + br;
  return distanceSq(ax, ay, bx, by) <= r * r;
}

/**
 * Squared distance from point P to segment AB. Used for muzzle-line hit tests
 * and "is this AI near the patrol path" checks without allocating.
 */
export function pointSegmentDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq > 0 ? clamp01((apx * abx + apy * aby) / lenSq) : 0;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return distanceSq(px, py, cx, cy);
}

/** Normalizes a vector in place; returns the original length. */
export function normalize(v: Vec2): number {
  const len = Math.sqrt(v.x * v.x + v.y * v.y);
  if (len > 1e-6) {
    v.x /= len;
    v.y /= len;
  }
  return len;
}

/** Clamps a vector's magnitude to `max` in place. */
export function clampMagnitude(v: Vec2, max: number): void {
  const lenSq = v.x * v.x + v.y * v.y;
  if (lenSq > max * max) {
    const s = max / Math.sqrt(lenSq);
    v.x *= s;
    v.y *= s;
  }
}
