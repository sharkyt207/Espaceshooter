import { fbm, ridged, valueNoise } from '../core/Noise';
import { Tile, TILE_DEFS } from '../world/TileMap';

/**
 * Textures - procedural material atlas.
 *
 * Every surface in the game is generated here at boot: no external art, no
 * licensing questions, and the texture size can follow the device's capability.
 *
 * Format: each texture is a flat Uint32Array in ABGR order (what ImageData
 * expects on little-endian, which is every device we target). The renderer
 * indexes textures as `texels[texIndex][v * size + u]`, so the inner sampling
 * loop is a single array read.
 *
 * Transparency: textures may contain fully transparent texels (alpha 0). The
 * raycaster uses this for fences, windows and glass, which are see-through
 * walls that still need to be drawn.
 */

export const TEX_SIZE = 64;
const TEX_COUNT = 16;

/** Packs 0-255 channels into the ABGR word ImageData uses. */
function rgba(r: number, g: number, b: number, a = 255): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * Levels in the mip chain: 64, 32, 16, 8, 4, 2, 1.
 *
 * Mipmaps are the fix for the problem the box blur was papering over. A
 * raycaster point-samples one texel per screen pixel; at distance a wall
 * covers fewer pixels than it has texels, so which texel each pixel lands on
 * changes every frame the camera moves - the texture crawls. Pre-filtering the
 * texture down and picking the level whose texel density matches the pixel
 * density removes the crawl at its source, and unlike a blanket blur it costs
 * nothing up close where the detail should be sharp.
 */
export const MIP_LEVELS = 7;

/**
 * How much relief each material gets, indexed the same as the textures.
 *
 * Tuned by what the luminance in each one actually means. Corrugated metal and
 * brick get the most: their light and dark bands really are ridges and mortar
 * courses. Gravel, rubble and rock get a moderate amount - the grain is real
 * relief but tiny. Water, glass and windows get none, because there is nothing
 * there to catch a light, and painted surfaces like containers and doors get
 * little, since their dark areas are paint and rust rather than dents.
 */
const RELIEF = [
  2.0, // 0 gravel
  1.4, // 1 concrete
  3.0, // 2 brick
  3.6, // 3 corrugated metal
  2.6, // 4 planks
  1.0, // 5 container - mostly painted panel
  0.0, // 6 chainlink - alpha cutout, the wire is geometry not relief
  0.0, // 7 window
  1.2, // 8 door
  2.4, // 9 rubble
  1.8, // 10 crate
  2.2, // 11 rock
  0.0, // 12 water - handled by the surface, not by a normal map
  1.6, // 13 grate
  0.0, // 14 glass
  1.2, // 15 tarmac
];

export class TextureAtlas {
  readonly size = TEX_SIZE;
  /** texels[textureIndex] - length size*size, ABGR. Level 0 of the mip chain. */
  readonly texels: Uint32Array[] = [];
  /** mips[textureIndex][level] - level 0 is `texels[textureIndex]`. */
  readonly mips: Uint32Array[][] = [];
  /**
   * Tangent-space normal maps, one per texture, same mip layout as `mips`.
   *
   * Packed as ABGR like everything else here: r/g/b hold x/y/z remapped from
   * [-1,1] to [0,255], alpha is unused.
   *
   * Derived from each material's own luminance rather than authored
   * separately. That is an approximation - it assumes bright means raised -
   * but for this set of materials the assumption is close to true by
   * construction: mortar lines are drawn darker than brick, plank gaps darker
   * than plank, corrugated ridges brighter than troughs. The one place it
   * misreads is paint and rust, where a dark patch is a colour rather than a
   * dent, and the strength is dialled back per material to keep that from
   * turning a stain into a crater.
   *
   * Only the GPU path uses these. The software renderer cannot afford a
   * per-pixel dot product.
   */
  readonly normals: Uint32Array[][] = [];
  /** True when the texture contains any transparent texel. */
  readonly hasAlpha: boolean[] = [];
  /** Average colour, used for distant LOD and for the minimap. */
  readonly averageColor: number[] = [];

  constructor() {
    for (let i = 0; i < TEX_COUNT; i++) {
      this.texels.push(new Uint32Array(TEX_SIZE * TEX_SIZE));
      this.hasAlpha.push(false);
      this.averageColor.push(0);
    }
    this.generate();
  }

  private generate(): void {
    this.buildGravel(0);
    this.buildConcrete(1);
    this.buildBrick(2);
    this.buildCorrugatedMetal(3);
    this.buildPlanks(4);
    this.buildContainer(5);
    this.buildChainlink(6);
    this.buildWindow(7);
    this.buildDoor(8);
    this.buildRubble(9);
    this.buildCrate(10);
    this.buildRock(11);
    this.buildWater(12);
    this.buildGrate(13);
    this.buildGlass(14);
    this.buildTarmac(15);

    // Soften the high-frequency materials.
    //
    // The renderer point-samples one texel per screen pixel with no mip
    // chain, so any texture containing single-texel contrast - speckled
    // concrete, cracked rock, gravel grain - turns into crawling static at
    // distance and at grazing angles. A single tileable box blur removes that
    // frequency band while leaving the material's larger structure intact.
    // Brick, planking and containers are left sharp: their detail is already
    // low-frequency and blurring would only muddy the mortar lines.
    for (const index of [0, 1, 9, 11, 12, 15]) this.blur(index);

    for (let i = 0; i < TEX_COUNT; i++) this.finalize(i);
    for (let i = 0; i < TEX_COUNT; i++) this.buildMips(i);
    for (let i = 0; i < TEX_COUNT; i++) this.buildNormals(i, RELIEF[i] ?? 1);
  }

  /**
   * Derive a tangent-space normal map from the texture's own luminance.
   *
   * Central differences rather than a Sobel kernel. Sobel's extra row of
   * smoothing is there to survive photographic noise; these textures are
   * generated, their noise is deliberate surface grain, and blurring it away
   * is exactly the detail worth keeping. Sampling wraps, because every one of
   * these tiles.
   *
   * `strength` scales the gradient before it becomes a slope: a value of 1
   * gives roughly a 45 degree face where luminance changes by half across one
   * texel, which is far too much for a stained floor and about right for
   * corrugated metal.
   */
  private buildNormals(index: number, strength: number): void {
    const S = TEX_SIZE;
    const src = this.texels[index];
    const height = new Float32Array(S * S);
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      height[i] =
        ((c & 0xff) * 0.299 + ((c >> 8) & 0xff) * 0.587 + ((c >> 16) & 0xff) * 0.114) / 255;
    }

    const level0 = new Uint32Array(S * S);
    for (let v = 0; v < S; v++) {
      const up = ((v - 1 + S) & (S - 1)) * S;
      const down = ((v + 1) & (S - 1)) * S;
      const row = v * S;
      for (let u = 0; u < S; u++) {
        const left = (u - 1 + S) & (S - 1);
        const right = (u + 1) & (S - 1);
        // The gradient points uphill; the surface normal tilts the other way.
        const dx = (height[row + right] - height[row + left]) * strength;
        const dy = (height[down + u] - height[up + u]) * strength;
        const nx = -dx;
        const ny = -dy;
        const nz = 1;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        level0[row + u] =
          ((255 << 24) |
            (clampByte((nz * inv) * 127.5 + 127.5) << 16) |
            (clampByte((ny * inv) * 127.5 + 127.5) << 8) |
            clampByte((nx * inv) * 127.5 + 127.5)) >>> 0;
      }
    }

    // Mip the normals by the same box reduction as colour. Averaging unit
    // vectors and renormalising in the shader is not strictly correct - the
    // right answer shortens the average to encode lost variance - but the
    // practical effect is what is wanted anyway: detail flattens with distance
    // instead of aliasing into sparkle.
    const chain: Uint32Array[] = [level0];
    let size = S;
    for (let level = 1; level < MIP_LEVELS && size > 1; level++) {
      const prev = chain[level - 1];
      const half = size >> 1;
      const dst = new Uint32Array(half * half);
      for (let v = 0; v < half; v++) {
        for (let u = 0; u < half; u++) {
          let x = 0;
          let y = 0;
          let z = 0;
          for (let dv = 0; dv < 2; dv++) {
            for (let du = 0; du < 2; du++) {
              const c = prev[(v * 2 + dv) * size + (u * 2 + du)];
              x += (c & 0xff) - 127.5;
              y += ((c >> 8) & 0xff) - 127.5;
              z += ((c >> 16) & 0xff) - 127.5;
            }
          }
          const len = Math.sqrt(x * x + y * y + z * z) || 1;
          dst[v * half + u] =
            ((255 << 24) |
              (clampByte((z / len) * 127.5 + 127.5) << 16) |
              (clampByte((y / len) * 127.5 + 127.5) << 8) |
              clampByte((x / len) * 127.5 + 127.5)) >>> 0;
        }
      }
      chain.push(dst);
      size = half;
    }
    this.normals[index] = chain;
  }

  /**
   * Build the mip chain by repeated 2x2 box reduction.
   *
   * Alpha is averaged along with colour, but colour is *not* premultiplied:
   * these textures are either fully opaque or fully transparent per texel
   * (fences, glass), so averaging the two independently keeps a fence's wire
   * grey rather than letting it bleed towards black as it thins out.
   */
  private buildMips(index: number): void {
    const chain: Uint32Array[] = [this.texels[index]];
    let size = TEX_SIZE;
    for (let level = 1; level < MIP_LEVELS && size > 1; level++) {
      const src = chain[level - 1];
      const half = size >> 1;
      const dst = new Uint32Array(half * half);
      for (let v = 0; v < half; v++) {
        for (let u = 0; u < half; u++) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (let dv = 0; dv < 2; dv++) {
            for (let du = 0; du < 2; du++) {
              const c = src[(v * 2 + dv) * size + (u * 2 + du)];
              r += c & 0xff;
              g += (c >> 8) & 0xff;
              b += (c >> 16) & 0xff;
              a += (c >>> 24) & 0xff;
            }
          }
          dst[v * half + u] =
            ((clampByte(a / 4) << 24) | (clampByte(b / 4) << 16) |
              (clampByte(g / 4) << 8) | clampByte(r / 4)) >>> 0;
        }
      }
      chain.push(dst);
      size = half;
    }
    this.mips[index] = chain;
  }

  /**
   * Pick a mip level from how many texels one screen pixel covers.
   *
   * `texelsPerPixel` below 1 is magnification - level 0, and the surface is
   * simply sharp. Above 1 each doubling costs one level.
   */
  static levelFor(texelsPerPixel: number): number {
    if (texelsPerPixel <= 1) return 0;
    // log2 without a call: exponent of the float.
    const level = Math.log2(texelsPerPixel) | 0;
    return level >= MIP_LEVELS ? MIP_LEVELS - 1 : level;
  }

  /** Tileable 3x3 box blur, preserving alpha. */
  private blur(index: number): void {
    const src = this.texels[index];
    const dst = new Uint32Array(src.length);
    const S = TEX_SIZE;
    for (let v = 0; v < S; v++) {
      for (let u = 0; u < S; u++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let dv = -1; dv <= 1; dv++) {
          // Wrap so the blur does not introduce a visible seam at the edges.
          const sv = (v + dv + S) & (S - 1);
          for (let du = -1; du <= 1; du++) {
            const su = (u + du + S) & (S - 1);
            const c = src[sv * S + su];
            r += c & 0xff;
            g += (c >> 8) & 0xff;
            b += (c >> 16) & 0xff;
            a += (c >>> 24) & 0xff;
          }
        }
        dst[v * S + u] =
          ((clampByte(a / 9) << 24) | (clampByte(b / 9) << 16) | (clampByte(g / 9) << 8) | clampByte(r / 9)) >>> 0;
      }
    }
    src.set(dst);
  }

  /** Records alpha usage and the average colour for LOD/minimap sampling. */
  private finalize(index: number): void {
    const t = this.texels[index];
    let r = 0;
    let g = 0;
    let b = 0;
    let opaque = 0;
    let alpha = false;
    for (let i = 0; i < t.length; i++) {
      const px = t[i];
      const a = (px >>> 24) & 0xff;
      if (a < 255) alpha = true;
      if (a > 0) {
        r += px & 0xff;
        g += (px >> 8) & 0xff;
        b += (px >> 16) & 0xff;
        opaque++;
      }
    }
    this.hasAlpha[index] = alpha;
    if (opaque > 0) {
      this.averageColor[index] = rgba(clampByte(r / opaque), clampByte(g / opaque), clampByte(b / opaque));
    }
  }

  private each(index: number, fn: (u: number, v: number) => number): void {
    const t = this.texels[index];
    for (let v = 0; v < TEX_SIZE; v++) {
      for (let u = 0; u < TEX_SIZE; u++) {
        t[v * TEX_SIZE + u] = fn(u, v);
      }
    }
  }

  // --- individual materials ------------------------------------------------

  /** Loose gravel/dirt ground. Fine grain plus larger clumps. */
  private buildGravel(idx: number): void {
    this.each(idx, (u, v) => {
      const fine = valueNoise(u * 0.9, v * 0.9, TEX_SIZE, 11);
      const clump = fbm(u * 0.16, v * 0.16, 16, 3, 23);
      const l = 0.55 + fine * 0.32 + clump * 0.22;
      const warm = 0.94 + clump * 0.14;
      return rgba(clampByte(112 * l * warm), clampByte(108 * l), clampByte(94 * l * 0.95));
    });
  }

  /** Poured concrete with form lines, staining and hairline cracks. */
  private buildConcrete(idx: number): void {
    this.each(idx, (u, v) => {
      const grain = fbm(u * 0.35, v * 0.35, 32, 4, 5);
      const stain = fbm(u * 0.08, v * 0.1, 8, 3, 41);
      // Horizontal form lines every 16 texels read as poured sections.
      const form = v % 16 === 0 || v % 16 === 15 ? -0.16 : 0;
      // Sparse cracks from ridged noise. Kept rare and shallow: isolated dark
      // texels are exactly the frequency this renderer aliases worst.
      const crack = ridged(u * 0.18, v * 0.18, 16, 2, 77);
      const crackDark = crack > 0.955 ? -0.3 : 0;
      const l = 0.62 + grain * 0.15 - stain * 0.16 + form + crackDark;
      return rgba(clampByte(158 * l), clampByte(156 * l), clampByte(150 * l));
    });
  }

  /** Running-bond brickwork with mortar lines and per-brick colour variance. */
  private buildBrick(idx: number): void {
    const BRICK_H = 8;
    const BRICK_W = 16;
    const MORTAR = 1.5;
    this.each(idx, (u, v) => {
      const row = Math.floor(v / BRICK_H);
      // Offset alternate courses by half a brick.
      const offset = (row % 2) * (BRICK_W / 2);
      const bx = (u + offset) % BRICK_W;
      const by = v % BRICK_H;
      const isMortar = bx < MORTAR || by < MORTAR;
      if (isMortar) {
        const n = valueNoise(u * 1.2, v * 1.2, TEX_SIZE, 91);
        const l = 0.66 + n * 0.16;
        return rgba(clampByte(150 * l), clampByte(146 * l), clampByte(138 * l));
      }
      const brickId = Math.floor((u + offset) / BRICK_W) * 31 + row * 17;
      const variance = valueNoise(brickId * 0.7, row * 0.7, 64, 3) * 0.28 - 0.14;
      const grain = fbm(u * 0.6, v * 0.6, 32, 3, 12) * 0.18;
      const l = 0.78 + variance + grain;
      return rgba(clampByte(146 * l), clampByte(84 * l), clampByte(64 * l));
    });
  }

  /** Corrugated steel siding with rust bloom along the lower edge. */
  private buildCorrugatedMetal(idx: number): void {
    this.each(idx, (u, v) => {
      // Sinusoidal corrugation gives a strong vertical read.
      const wave = Math.sin((u / TEX_SIZE) * Math.PI * 2 * 8);
      const corr = 0.72 + wave * 0.22;
      const rust = fbm(u * 0.14, v * 0.1, 12, 3, 63);
      // Rust concentrates towards the bottom where water sits.
      const rustAmt = Math.max(0, rust - 0.45) * (v / TEX_SIZE) * 2.6;
      const scratch = ridged(u * 0.5, v * 0.08, 24, 2, 88) > 0.9 ? 0.12 : 0;
      const l = corr + scratch;
      const r = 108 * l + rustAmt * 96;
      const g = 118 * l + rustAmt * 40;
      const b = 126 * l + rustAmt * 8;
      return rgba(clampByte(r), clampByte(g), clampByte(b));
    });
  }

  /** Vertical timber planking with knots and gaps. */
  private buildPlanks(idx: number): void {
    const PLANK_W = 10;
    this.each(idx, (u, v) => {
      const px = u % PLANK_W;
      if (px === 0) return rgba(38, 28, 20);
      const plankId = Math.floor(u / PLANK_W);
      const tone = valueNoise(plankId * 3.3, 0, 64, 7) * 0.3 - 0.15;
      // Stretched noise along the grain direction.
      const grain = fbm(u * 1.4, v * 0.12, 32, 4, 19);
      const knot = ridged(u * 0.4, v * 0.4, 16, 2, 55);
      const knotDark = knot > 0.96 ? -0.35 : 0;
      const l = 0.72 + tone + grain * 0.24 + knotDark;
      return rgba(clampByte(150 * l), clampByte(112 * l), clampByte(70 * l));
    });
  }

  /** Shipping container: ribbed panel, weathered paint, edge wear. */
  private buildContainer(idx: number): void {
    this.each(idx, (u, v) => {
      // Trapezoidal ribs rather than a sine - reads as pressed steel.
      const ribPhase = (u % 12) / 12;
      const rib = ribPhase < 0.15 || ribPhase > 0.85 ? 0.62 : ribPhase < 0.3 || ribPhase > 0.7 ? 0.86 : 1.0;
      const wear = fbm(u * 0.18, v * 0.18, 16, 3, 31);
      const rustPatch = Math.max(0, fbm(u * 0.09, v * 0.09, 8, 2, 71) - 0.58) * 3;
      // Top and bottom rails are darker structural steel.
      const rail = v < 4 || v > TEX_SIZE - 5 ? 0.72 : 1;
      const l = rib * rail * (0.82 + wear * 0.24);
      const r = 158 * l + rustPatch * 70;
      const g = 82 * l + rustPatch * 34;
      const b = 58 * l + rustPatch * 12;
      return rgba(clampByte(r), clampByte(g), clampByte(b));
    });
  }

  /**
   * Chainlink fence - mostly transparent, diamond wire pattern.
   *
   * The mesh period is deliberately coarse (16 texels rather than 8). A fine
   * mesh looks correct up close but the software renderer point-samples one
   * texel per screen pixel, so at distance a fine mesh aliases into a solid
   * grey blur and the fence stops reading as a fence. Coarse wires stay
   * legible at every range, which matters because the player has to judge
   * instantly whether a boundary can be shot through.
   */
  private buildChainlink(idx: number): void {
    const PERIOD = 16;
    this.each(idx, (u, v) => {
      // Posts every 32 texels give the fence structure at distance.
      if (u % 32 < 2) {
        const l = 0.6 + valueNoise(u, v * 0.4, TEX_SIZE, 3) * 0.2;
        return rgba(clampByte(120 * l), clampByte(126 * l), clampByte(128 * l));
      }
      // A single top rail reads as the fence's frame.
      if (v < 2) return rgba(112, 118, 120);

      // Two diagonal families of wires form the diamond mesh.
      const d1 = Math.abs(((u + v) % PERIOD) - PERIOD / 2);
      const d2 = Math.abs(((u - v + TEX_SIZE * 2) % PERIOD) - PERIOD / 2);
      if (d1 > 1.3 && d2 > 1.3) return 0; // fully transparent
      const l = 0.75 + valueNoise(u * 2, v * 2, TEX_SIZE, 9) * 0.3;
      return rgba(clampByte(150 * l), clampByte(156 * l), clampByte(158 * l), 210);
    });
  }

  /** Window band: frame plus dirty translucent glazing. */
  private buildWindow(idx: number): void {
    this.each(idx, (u, v) => {
      const frame = u < 3 || u > TEX_SIZE - 4 || v < 3 || v > TEX_SIZE - 4 || Math.abs(u - TEX_SIZE / 2) < 1.5;
      if (frame) {
        const l = 0.55 + valueNoise(u * 0.8, v * 0.8, TEX_SIZE, 17) * 0.2;
        return rgba(clampByte(96 * l), clampByte(100 * l), clampByte(104 * l));
      }
      const grime = fbm(u * 0.2, v * 0.2, 16, 3, 44);
      const streak = fbm(u * 0.06, v * 0.9, 32, 2, 66);
      const l = 0.6 + grime * 0.3 + streak * 0.2;
      // Semi-transparent so interiors are readable through glazing.
      return rgba(clampByte(120 * l), clampByte(148 * l), clampByte(158 * l), 118);
    });
  }

  /** Steel industrial door with a kick plate and hinges. */
  private buildDoor(idx: number): void {
    this.each(idx, (u, v) => {
      const border = u < 4 || u > TEX_SIZE - 5 || v < 3 || v > TEX_SIZE - 4;
      const kick = v > TEX_SIZE - 18 && v < TEX_SIZE - 6 && u > 6 && u < TEX_SIZE - 7;
      const hinge = u < 8 && (Math.abs(v - 14) < 4 || Math.abs(v - 50) < 4);
      const grain = fbm(u * 0.5, v * 0.5, 32, 3, 21);
      let l = 0.68 + grain * 0.18;
      if (border) l *= 0.72;
      if (kick) l *= 1.14;
      if (hinge) return rgba(70, 72, 74);
      return rgba(clampByte(128 * l), clampByte(96 * l), clampByte(62 * l));
    });
  }

  private buildRubble(idx: number): void {
    this.each(idx, (u, v) => {
      const chunks = fbm(u * 0.5, v * 0.5, 32, 4, 29);
      const fine = valueNoise(u * 1.6, v * 1.6, TEX_SIZE, 37);
      const l = 0.42 + chunks * 0.5 + fine * 0.18;
      return rgba(clampByte(126 * l), clampByte(122 * l), clampByte(114 * l));
    });
  }

  /** Wooden supply crate with banding and stencilled stripe. */
  private buildCrate(idx: number): void {
    this.each(idx, (u, v) => {
      const border = u < 4 || u > TEX_SIZE - 5 || v < 4 || v > TEX_SIZE - 5;
      const band = Math.abs(v - TEX_SIZE / 2) < 3;
      const grain = fbm(u * 1.2, v * 0.15, 32, 3, 13);
      let l = 0.7 + grain * 0.26;
      if (border || band) l *= 0.74;
      // A single stencil stripe reads as "cargo" without needing decals.
      const stencil = v > 12 && v < 20 && u > 10 && u < TEX_SIZE - 11;
      if (stencil) return rgba(clampByte(190 * l), clampByte(170 * l), clampByte(60 * l));
      return rgba(clampByte(154 * l), clampByte(118 * l), clampByte(66 * l));
    });
  }

  private buildRock(idx: number): void {
    this.each(idx, (u, v) => {
      const body = fbm(u * 0.3, v * 0.3, 32, 4, 3);
      const strata = Math.sin(v * 0.35 + body * 3) * 0.08;
      const crack = ridged(u * 0.35, v * 0.35, 16, 3, 47);
      const l = 0.5 + body * 0.42 + strata + (crack > 0.9 ? -0.28 : 0);
      return rgba(clampByte(112 * l), clampByte(110 * l), clampByte(106 * l));
    });
  }

  private buildWater(idx: number): void {
    this.each(idx, (u, v) => {
      const ripple = fbm(u * 0.25, v * 0.4, 16, 3, 87);
      const l = 0.5 + ripple * 0.5;
      return rgba(clampByte(38 * l), clampByte(76 * l), clampByte(94 * l));
    });
  }

  /** Walkway grating - open grid, loud underfoot, partially see-through. */
  private buildGrate(idx: number): void {
    this.each(idx, (u, v) => {
      const bar = u % 8 < 3 || v % 8 < 2;
      const n = valueNoise(u * 0.9, v * 0.9, TEX_SIZE, 57);
      if (!bar) {
        const l = 0.22 + n * 0.14;
        return rgba(clampByte(60 * l), clampByte(60 * l), clampByte(58 * l));
      }
      const l = 0.66 + n * 0.24;
      return rgba(clampByte(122 * l), clampByte(126 * l), clampByte(126 * l));
    });
  }

  /** Curtain-wall glazing: strongly transparent with a mullion grid. */
  private buildGlass(idx: number): void {
    this.each(idx, (u, v) => {
      const mullion = u % 32 < 3 || v % 32 < 3;
      if (mullion) return rgba(78, 82, 86);
      const sheen = fbm(u * 0.12, v * 0.12, 16, 2, 99);
      const l = 0.7 + sheen * 0.4;
      return rgba(clampByte(140 * l), clampByte(180 * l), clampByte(190 * l), 74);
    });
  }

  /** Asphalt for roads and hardstanding. */
  private buildTarmac(idx: number): void {
    this.each(idx, (u, v) => {
      const grain = valueNoise(u * 1.5, v * 1.5, TEX_SIZE, 71);
      const patch = fbm(u * 0.1, v * 0.1, 8, 2, 83);
      const l = 0.4 + grain * 0.22 + patch * 0.16;
      return rgba(clampByte(78 * l), clampByte(78 * l), clampByte(80 * l));
    });
  }

  /** Pre-shaded copies at fixed brightness steps would cost memory; instead the
   * renderer shades per pixel. Exposed for the minimap, which wants flat colour. */
  colorForTile(tile: number): number {
    const d = TILE_DEFS[tile];
    return d ? this.averageColor[d.texture] || d.tint : 0xff000000;
  }
}

export const TILE_TEXTURE_INDEX = new Uint8Array(TILE_DEFS.length);
for (const d of TILE_DEFS) TILE_TEXTURE_INDEX[d.id] = d.texture;

/** Floor material -> texture index. Water and grate get their own surfaces. */
export function floorTextureFor(tile: number): number {
  switch (tile) {
    case Tile.Concrete:
      return 15; // tarmac reads better underfoot than wall concrete
    case Tile.Wood:
      return 4;
    case Tile.Water:
      return 12;
    case Tile.Grate:
      return 13;
    default:
      return 0;
  }
}
