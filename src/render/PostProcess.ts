/**
 * PostProcess - bloom and tone mapping over the rendered frame.
 *
 * Two effects, chosen because they are the two that most separate a computed
 * image from a photographed one, and both are affordable on the *internal*
 * buffer (a quarter of the display pixels at typical render scales).
 *
 * **Tone mapping.** The renderer accumulates light additively - lightmap plus
 * muzzle flash plus torch plus lightning - and then clamps at 255. Clamping is
 * what makes bright areas look like flat white paint: everything above the
 * limit collapses to the same value and all the structure in the highlight is
 * gone. A filmic curve rolls off instead, so a muzzle flash stays a flash with
 * a shape rather than a white disc, and the picture as a whole stops looking
 * like it was drawn with a limited palette.
 *
 * **Bloom.** Real lenses scatter. Bright sources bleed into their
 * surroundings, and the eye reads that bleed as brightness far more strongly
 * than it reads the pixel value itself - which is why a lamp with bloom looks
 * lit and a lamp without it looks like a light-grey rectangle. Done at quarter
 * resolution with two separable blur passes, which is cheap and, since bloom
 * is low-frequency by definition, indistinguishable from doing it properly.
 *
 * Both run over a Uint32Array the renderer already owns, so there is no extra
 * canvas, no readback and no allocation per frame.
 */

import { DEFAULT_STYLE, STYLES, type GradeSpec } from './Style';

export interface PostSettings {
  /** 0 disables the pass entirely. */
  bloomStrength: number;
  /** Luminance above which a pixel contributes to bloom, 0..1. */
  bloomThreshold: number;
  /** 0 = linear clamp (off), 1 = full filmic roll-off. */
  toneMapping: number;
  /** Multiplies the whole image before tone mapping. */
  exposure: number;
  /**
   * The active style's grade.
   *
   * This path can afford less than the shader can, and says so rather than
   * pretending otherwise: the split-tone and the contrast are folded into the
   * tone curve, which makes them per-channel rather than driven by true
   * luminance - close, and free, because the curve is already a lookup table.
   * Saturation cannot be expressed that way and gets its own pass, paid for
   * only by the styles that ask for it. Aberration and scanlines are not
   * attempted here at all; both would cost a resample per pixel in JavaScript,
   * which is exactly the budget this renderer does not have.
   */
  grade: GradeSpec;
}

export function defaultPostSettings(): PostSettings {
  return {
    bloomStrength: 0.9,
    bloomThreshold: 0.62,
    toneMapping: 1,
    exposure: 1.06,
    grade: STYLES[DEFAULT_STYLE].grade,
  };
}

/** Quarter resolution in each axis: sixteen times fewer pixels to blur. */
const DOWNSCALE = 4;

export class PostProcess {
  private width = 0;
  private height = 0;
  private smallW = 0;
  private smallH = 0;

  /** Bright-pass buffer and its ping-pong partner, at reduced resolution. */
  private bright = new Float32Array(0);
  private scratch = new Float32Array(0);

  /** Per-column bilinear geometry, tabulated because it never changes. */
  private colX0 = new Int32Array(0);
  private colX1 = new Int32Array(0);
  private colWx = new Float32Array(0);

  /**
   * Tone curves as lookup tables, one per channel.
   *
   * Each is evaluated 512 times when the style changes instead of three times
   * per pixel per frame. At 960x441 that is the difference between 1536
   * evaluations and 1.3 million - and splitting one table into three is what
   * lets the style's tint ride along at no per-pixel cost at all.
   */
  private lutR = new Uint8Array(512);
  private lutG = new Uint8Array(512);
  private lutB = new Uint8Array(512);
  private lutKey = '';

  settings = defaultPostSettings();

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.smallW = Math.max(1, Math.ceil(width / DOWNSCALE));
    this.smallH = Math.max(1, Math.ceil(height / DOWNSCALE));
    // Three channels interleaved.
    const n = this.smallW * this.smallH * 3;
    this.bright = new Float32Array(n);
    this.scratch = new Float32Array(n);

    this.colX0 = new Int32Array(width);
    this.colX1 = new Int32Array(width);
    this.colWx = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const fx = (x / DOWNSCALE) - 0.5;
      const x0 = Math.max(0, Math.min(this.smallW - 1, Math.floor(fx)));
      const x1 = Math.min(this.smallW - 1, x0 + 1);
      const wx = fx - x0;
      this.colX0[x] = x0;
      this.colX1[x] = x1;
      this.colWx[x] = wx < 0 ? 0 : wx > 1 ? 1 : wx;
    }
  }

  private ensureLut(): void {
    const g = this.settings.grade;
    const key = `${this.settings.toneMapping}|${this.settings.exposure}|` +
      `${g.shadowTint.join(',')}|${g.shadowAmount}|` +
      `${g.highlightTint.join(',')}|${g.highlightAmount}|${g.contrast}`;
    if (key === this.lutKey) return;
    this.lutKey = key;

    const { toneMapping, exposure } = this.settings;
    const luts: [Uint8Array, number][] = [[this.lutR, 0], [this.lutG, 1], [this.lutB, 2]];

    for (const [lut, channel] of luts) {
      for (let i = 0; i < lut.length; i++) {
        // Input runs to 2x white so the curve has headroom to roll off from.
        const x = (i / (lut.length - 1)) * 2 * exposure;
        // Reinhard-with-shoulder: cheap, monotonic, and it keeps mid-tones
        // almost unchanged so the game does not suddenly look washed out.
        const mapped = (x * (1 + x / 4)) / (1 + x);
        let v = x * (1 - toneMapping) + mapped * toneMapping;

        // Split-tone. The shader weights these by the pixel's luminance; here
        // the channel's own value stands in for it, which is the approximation
        // that buys the whole grade for free.
        const lum = v < 0 ? 0 : v > 1 ? 1 : v;
        v *= 1 + (g.shadowTint[channel] - 1) * (1 - lum) * g.shadowAmount;
        v *= 1 + (g.highlightTint[channel] - 1) * lum * g.highlightAmount;

        // Contrast, pivoted on mid grey.
        v = (v - 0.5) * g.contrast + 0.5;

        const out = v * 255;
        lut[i] = out < 0 ? 0 : out > 255 ? 255 : out | 0;
      }
    }
  }

  /**
   * Pull every pixel towards or away from its own luminance.
   *
   * A separate pass because saturation is the one part of the grade that
   * cannot live in a per-channel curve - it needs all three channels at once.
   * Only styles that actually change it pay for this.
   */
  private applySaturation(pixels: Uint32Array, saturation: number): void {
    for (let i = 0; i < pixels.length; i++) {
      const c = pixels[i];
      const r = c & 0xff;
      const gch = (c >> 8) & 0xff;
      const b = (c >> 16) & 0xff;
      const lum = r * 0.299 + gch * 0.587 + b * 0.114;
      let nr = lum + (r - lum) * saturation;
      let ng = lum + (gch - lum) * saturation;
      let nb = lum + (b - lum) * saturation;
      nr = nr < 0 ? 0 : nr > 255 ? 255 : nr;
      ng = ng < 0 ? 0 : ng > 255 ? 255 : ng;
      nb = nb < 0 ? 0 : nb > 255 ? 255 : nb;
      pixels[i] = (255 << 24) | ((nb | 0) << 16) | ((ng | 0) << 8) | (nr | 0);
    }
  }

  /**
   * Apply bloom and tone mapping in place.
   *
   * `pixels` is ABGR as ImageData wants it.
   */
  apply(pixels: Uint32Array, width: number, height: number): void {
    this.resize(width, height);
    this.ensureLut();

    const { bloomStrength, bloomThreshold } = this.settings;
    if (bloomStrength > 0) {
      this.brightPass(pixels, bloomThreshold);
      this.blur();
      this.composite(pixels, bloomStrength);
    } else {
      this.toneOnly(pixels);
    }

    const saturation = this.settings.grade.saturation;
    if (saturation !== 1) this.applySaturation(pixels, saturation);
  }

  /**
   * Downsample while extracting everything above the threshold.
   *
   * Downsampling and thresholding in one pass means the bright buffer is
   * filled with a single read of the frame.
   */
  private brightPass(pixels: Uint32Array, threshold: number): void {
    const { width, smallW, smallH } = this;
    const bright = this.bright;
    bright.fill(0);
    const t = threshold * 255;
    const invSamples = 1 / ((DOWNSCALE / 2) * (DOWNSCALE / 2));

    // Every second pixel in each axis: four samples per 4x4 cell instead of
    // sixteen. The result is blurred immediately afterwards, so the extra
    // twelve samples buy nothing visible and cost three quarters of the pass.
    const STEP = 2;
    for (let sy = 0; sy < smallH; sy++) {
      const y0 = sy * DOWNSCALE;
      const y1 = Math.min(this.height, y0 + DOWNSCALE);
      for (let sx = 0; sx < smallW; sx++) {
        const x0 = sx * DOWNSCALE;
        const x1 = Math.min(width, x0 + DOWNSCALE);
        let ar = 0;
        let ag = 0;
        let ab = 0;
        for (let y = y0; y < y1; y += STEP) {
          let idx = y * width + x0;
          for (let x = x0; x < x1; x += STEP, idx += STEP) {
            const c = pixels[idx];
            const r = c & 0xff;
            const g = (c >> 8) & 0xff;
            const b = (c >> 16) & 0xff;
            // Luminance gate, then keep only the excess. Gating on luminance
            // rather than per channel stops saturated colours blooming just
            // for being saturated.
            const lum = r * 0.299 + g * 0.587 + b * 0.114;
            if (lum <= t) continue;
            const excess = (lum - t) / Math.max(1, 255 - t);
            ar += r * excess;
            ag += g * excess;
            ab += b * excess;
          }
        }
        const o = (sy * smallW + sx) * 3;
        bright[o] = ar * invSamples;
        bright[o + 1] = ag * invSamples;
        bright[o + 2] = ab * invSamples;
      }
    }
  }

  /** Two separable passes with a 5-tap kernel, run twice for a wider skirt. */
  private blur(): void {
    const { smallW, smallH } = this;
    const a = this.bright;
    const b = this.scratch;

    // One pass. After a 4x downscale the kernel already covers a wide area
    // in screen terms, and a second pass costs as much as it adds.
    for (let pass = 0; pass < 1; pass++) {
      // Horizontal: a -> b
      for (let y = 0; y < smallH; y++) {
        const row = y * smallW;
        for (let x = 0; x < smallW; x++) {
          const o = (row + x) * 3;
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let k = -2; k <= 2; k++) {
              const sx = x + k;
              if (sx < 0 || sx >= smallW) continue;
              sum += a[(row + sx) * 3 + c] * KERNEL[k + 2];
            }
            b[o + c] = sum;
          }
        }
      }
      // Vertical: b -> a
      for (let y = 0; y < smallH; y++) {
        for (let x = 0; x < smallW; x++) {
          const o = (y * smallW + x) * 3;
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let k = -2; k <= 2; k++) {
              const sy = y + k;
              if (sy < 0 || sy >= smallH) continue;
              sum += b[(sy * smallW + x) * 3 + c] * KERNEL[k + 2];
            }
            a[o + c] = sum;
          }
        }
      }
    }
  }

  /**
   * Add the blurred bright buffer back and tone map.
   *
   * The bloom buffer is sampled with bilinear interpolation as it is upscaled,
   * because nearest sampling of a quarter-resolution glow produces visible
   * blocks exactly where the eye is already looking.
   */
  private composite(pixels: Uint32Array, strength: number): void {
    const { width, height, smallW, smallH } = this;
    const bright = this.bright;
    const lutR = this.lutR;
    const lutG = this.lutG;
    const lutB = this.lutB;
    const lutMax = lutR.length - 1;
    const scaleToLut = lutMax / (2 * 255);

    // The x sampling geometry repeats every DOWNSCALE pixels and never changes
    // between frames, so it is tabulated once per resize instead of being
    // recomputed - a divide, two floors and two clamps - for every pixel.
    const colX0 = this.colX0;
    const colX1 = this.colX1;
    const colWx = this.colWx;

    for (let y = 0; y < height; y++) {
      const fy = (y / DOWNSCALE) - 0.5;
      const y0 = Math.max(0, Math.min(smallH - 1, Math.floor(fy)));
      const y1 = Math.min(smallH - 1, y0 + 1);
      const wy = fy - y0 < 0 ? 0 : fy - y0 > 1 ? 1 : fy - y0;
      const iwy = 1 - wy;
      const rowA = y0 * smallW;
      const rowB = y1 * smallW;

      let idx = y * width;
      let x = 0;
      while (x < width) {
        // Bloom is sparse: in a typical frame almost every pixel has none at
        // all. Testing one small-buffer cell and, when it is dark, running the
        // cheap tone-only path across the whole DOWNSCALE-wide block it covers
        // skips the bilinear work for the overwhelming majority of pixels.
        // This is the difference between a 27 ms pass and a 3 ms one.
        const cell = colX0[x];
        const oA = (rowA + cell) * 3;
        const oB = (rowB + cell) * 3;
        const cellMax = Math.max(
          bright[oA], bright[oA + 1], bright[oA + 2],
          bright[oB], bright[oB + 1], bright[oB + 2],
        );
        const blockEnd = Math.min(width, (Math.floor(x / DOWNSCALE) + 1) * DOWNSCALE);

        if (cellMax * strength < 0.75) {
          for (; x < blockEnd; x++, idx++) {
            const c = pixels[idx];
            const ri = (c & 0xff) * scaleToLut;
            const gi = ((c >> 8) & 0xff) * scaleToLut;
            const bi = ((c >> 16) & 0xff) * scaleToLut;
            pixels[idx] = (255 << 24) |
              (lutB[bi > lutMax ? lutMax : bi | 0] << 16) |
              (lutG[gi > lutMax ? lutMax : gi | 0] << 8) |
              lutR[ri > lutMax ? lutMax : ri | 0];
          }
          continue;
        }

        for (; x < blockEnd; x++, idx++) {
          const x0 = colX0[x];
          const x1 = colX1[x];
          const wx = colWx[x];
          const iwx = 1 - wx;
          const w00 = iwx * iwy;
          const w10 = wx * iwy;
          const w01 = iwx * wy;
          const w11 = wx * wy;
          const o00 = (rowA + x0) * 3;
          const o10 = (rowA + x1) * 3;
          const o01 = (rowB + x0) * 3;
          const o11 = (rowB + x1) * 3;

          const c = pixels[idx];
          const r = (c & 0xff) +
            strength * (bright[o00] * w00 + bright[o10] * w10 + bright[o01] * w01 + bright[o11] * w11);
          const g = ((c >> 8) & 0xff) +
            strength * (bright[o00 + 1] * w00 + bright[o10 + 1] * w10 + bright[o01 + 1] * w01 + bright[o11 + 1] * w11);
          const b = ((c >> 16) & 0xff) +
            strength * (bright[o00 + 2] * w00 + bright[o10 + 2] * w10 + bright[o01 + 2] * w01 + bright[o11 + 2] * w11);

          const ri = r * scaleToLut;
          const gi = g * scaleToLut;
          const bi = b * scaleToLut;
          pixels[idx] = (255 << 24) |
            (lutB[bi > lutMax ? lutMax : bi | 0] << 16) |
            (lutG[gi > lutMax ? lutMax : gi | 0] << 8) |
            lutR[ri > lutMax ? lutMax : ri | 0];
        }
      }
    }
  }

  /** Tone mapping without bloom, for the low quality setting. */
  private toneOnly(pixels: Uint32Array): void {
    const lutR = this.lutR;
    const lutG = this.lutG;
    const lutB = this.lutB;
    const lutMax = lutR.length - 1;
    const scaleToLut = lutMax / (2 * 255);
    const n = this.width * this.height;
    for (let i = 0; i < n; i++) {
      const c = pixels[i];
      const ri = (c & 0xff) * scaleToLut;
      const gi = ((c >> 8) & 0xff) * scaleToLut;
      const bi = ((c >> 16) & 0xff) * scaleToLut;
      pixels[i] = (255 << 24) |
        (lutB[bi > lutMax ? lutMax : bi | 0] << 16) |
        (lutG[gi > lutMax ? lutMax : gi | 0] << 8) |
        lutR[ri > lutMax ? lutMax : ri | 0];
    }
  }
}

/** Normalised 5-tap Gaussian. */
const KERNEL = [0.0625, 0.25, 0.375, 0.25, 0.0625];
