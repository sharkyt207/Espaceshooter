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

export class TextureAtlas {
  readonly size = TEX_SIZE;
  /** texels[textureIndex] - length size*size, ABGR. */
  readonly texels: Uint32Array[] = [];
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
    for (let i = 0; i < TEX_COUNT; i++) this.finalize(i);
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
      // Sparse cracks from ridged noise, thresholded so they stay rare.
      const crack = ridged(u * 0.2, v * 0.2, 16, 3, 77);
      const crackDark = crack > 0.93 ? -0.42 : 0;
      const l = 0.62 + grain * 0.2 - stain * 0.16 + form + crackDark;
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

  /** Chainlink fence - mostly transparent, diamond wire pattern. */
  private buildChainlink(idx: number): void {
    this.each(idx, (u, v) => {
      // Two diagonal families of wires form the diamond mesh.
      const d1 = Math.abs(((u + v) % 8) - 4);
      const d2 = Math.abs(((u - v + 64) % 8) - 4);
      const onWire = d1 < 1.1 || d2 < 1.1;
      // Posts every 32 texels give the fence structure at distance.
      const post = u % 32 < 2;
      if (post) {
        const l = 0.6 + valueNoise(u, v * 0.4, TEX_SIZE, 3) * 0.2;
        return rgba(clampByte(120 * l), clampByte(126 * l), clampByte(128 * l));
      }
      if (!onWire) return 0; // fully transparent
      const l = 0.75 + valueNoise(u * 2, v * 2, TEX_SIZE, 9) * 0.3;
      return rgba(clampByte(150 * l), clampByte(156 * l), clampByte(158 * l), 235);
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
