/**
 * Random - seeded, deterministic PRNG (xoshiro128**).
 *
 * Every system that needs randomness takes an Rng instance rather than calling
 * Math.random(). This gives us:
 *   - Reproducible raids from a seed (invaluable for bug reports / balancing).
 *   - Independent streams, so spawning more particles never desyncs loot rolls.
 *
 * Streams used across the game: world gen, loot, ballistics, AI, cosmetic FX.
 */
export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed: number | string = Date.now()) {
    this.reseed(seed);
  }

  reseed(seed: number | string): void {
    let h = typeof seed === 'string' ? hashString(seed) : (seed >>> 0) || 1;
    // SplitMix32 expansion so a small seed still fills all four words.
    this.s0 = (h = splitmix32(h));
    this.s1 = (h = splitmix32(h));
    this.s2 = (h = splitmix32(h));
    this.s3 = splitmix32(h);
    // Discard the first few outputs to escape low-entropy start states.
    for (let i = 0; i < 8; i++) this.next();
  }

  /** Raw 32-bit unsigned output. */
  next(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next() / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.float() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  /** True with probability `p` (0..1). */
  chance(p: number): boolean {
    return this.float() < p;
  }

  /** Random element of a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.float() * arr.length)];
  }

  /**
   * Weighted pick. `weights[i]` corresponds to `items[i]`; weights need not sum
   * to 1. Returns undefined only if every weight is <= 0.
   */
  weighted<T>(items: readonly T[], weights: readonly number[]): T | undefined {
    let total = 0;
    for (let i = 0; i < items.length; i++) total += Math.max(0, weights[i] ?? 0);
    if (total <= 0) return undefined;
    let roll = this.float() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= Math.max(0, weights[i] ?? 0);
      if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Fisher-Yates shuffle in place. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /**
   * Standard-normal sample (Box-Muller, cached pair). Used for recoil, spread
   * and AI aim error - a bell curve reads far more "real" than a flat roll.
   */
  private spare: number | null = null;
  gaussian(mean = 0, stdDev = 1): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return mean + v * stdDev;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.float() * 2 - 1;
      v = this.float() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return mean + u * mul * stdDev;
  }

  /** Gaussian clamped to +/- `sigmas` - keeps outliers from breaking feel. */
  gaussianClamped(mean: number, stdDev: number, sigmas = 2.5): number {
    const raw = this.gaussian(0, 1);
    const c = raw < -sigmas ? -sigmas : raw > sigmas ? sigmas : raw;
    return mean + c * stdDev;
  }

  /** Random unit-circle direction written into an out param (no allocation). */
  direction(out: { x: number; y: number }): void {
    const a = this.float() * Math.PI * 2;
    out.x = Math.cos(a);
    out.y = Math.sin(a);
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function splitmix32(a: number): number {
  a = (a + 0x9e3779b9) | 0;
  let t = a ^ (a >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  return (t ^ (t >>> 15)) >>> 0;
}

export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0 || 1;
}

/** Shared cosmetic stream - safe for anything that does not affect simulation. */
export const fxRng = new Rng('fx');
