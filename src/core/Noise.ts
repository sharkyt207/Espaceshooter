/**
 * Noise - tileable value noise and fBm.
 *
 * Used to author every material texture and sprite at runtime. Generating
 * assets procedurally keeps the build free of third-party art, keeps the
 * download tiny, and lets us re-derive textures at whatever resolution the
 * device can afford.
 */

/** Deterministic 2D hash in [0,1). */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Value noise that wraps seamlessly over `period` units, so textures tile
 * without a visible seam when repeated across a wall.
 */
export function valueNoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const xa = ((x0 % period) + period) % period;
  const ya = ((y0 % period) + period) % period;
  const xb = (xa + 1) % period;
  const yb = (ya + 1) % period;

  const n00 = hash2(xa, ya, seed);
  const n10 = hash2(xb, ya, seed);
  const n01 = hash2(xa, yb, seed);
  const n11 = hash2(xb, yb, seed);

  const top = n00 + (n10 - n00) * fx;
  const bottom = n01 + (n11 - n01) * fx;
  return top + (bottom - top) * fy;
}

/** Fractal Brownian motion - stacked octaves of value noise. */
export function fbm(
  x: number,
  y: number,
  basePeriod: number,
  octaves: number,
  seed: number,
  gain = 0.5,
  lacunarity = 2,
): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * frequency, y * frequency, Math.max(1, Math.round(basePeriod * frequency)), seed + o * 131) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise - good for cracks, rust streaks and scratches. */
export function ridged(x: number, y: number, period: number, octaves: number, seed: number): number {
  const v = fbm(x, y, period, octaves, seed);
  return 1 - Math.abs(v * 2 - 1);
}
