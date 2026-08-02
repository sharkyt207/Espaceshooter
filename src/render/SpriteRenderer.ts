import type { Camera } from './Raycaster';
import type { SpriteFrame } from './Sprites';
import type { TileMap } from '../world/TileMap';

/**
 * SpriteRenderer - depth-tested billboard compositing.
 *
 * Sprites are transformed into camera space with the inverse of the raycaster's
 * direction/plane matrix, then drawn as scaled vertical strips with a per-pixel
 * depth test against the wall/floor buffer. That gives correct occlusion in
 * both directions: an enemy can stand behind a crate, and a fence can hang in
 * front of him.
 *
 * Draw submissions are collected during the frame and sorted back to front once
 * - sorting handles overlapping sprites and translucent particles in one pass.
 */

export interface SpriteDraw {
  x: number;
  y: number;
  /** Metres above the floor the sprite's base sits at (0 = on the ground). */
  elevation: number;
  frame: SpriteFrame | null;
  /** World height in tile units the sprite spans. */
  worldHeight: number;
  /** Multiplied into the sprite colour; 0xffffff = unchanged. */
  tint: number;
  /** 0..1 global alpha applied on top of per-texel alpha. */
  alpha: number;
  /** Solid-colour particle mode: when frame is null, draws a square of `tint`. */
  particleSize: number;
  /** Additive blending - used for tracers, sparks and flash. */
  additive: boolean;
  /** Cached camera-space depth, filled during submit. */
  depth: number;
}

const MAX_SPRITES = 512;

export class SpriteRenderer {
  private draws: SpriteDraw[] = [];
  private count = 0;
  private order: Int32Array = new Int32Array(MAX_SPRITES);

  constructor() {
    for (let i = 0; i < MAX_SPRITES; i++) {
      this.draws.push({
        x: 0, y: 0, elevation: 0, frame: null, worldHeight: 1,
        tint: 0xffffff, alpha: 1, particleSize: 0, additive: false, depth: 0,
      });
    }
  }

  begin(): void {
    this.count = 0;
  }

  /** Queue a textured billboard. */
  submit(
    x: number,
    y: number,
    frame: SpriteFrame,
    worldHeight: number,
    elevation = 0,
    tint = 0xffffff,
    alpha = 1,
  ): void {
    if (this.count >= MAX_SPRITES) return;
    const d = this.draws[this.count++];
    d.x = x;
    d.y = y;
    d.frame = frame;
    d.worldHeight = worldHeight;
    d.elevation = elevation;
    d.tint = tint;
    d.alpha = alpha;
    d.particleSize = 0;
    d.additive = false;
  }

  /** Queue a solid-colour point particle (smoke, sparks, blood, tracers). */
  submitParticle(
    x: number,
    y: number,
    elevation: number,
    size: number,
    color: number,
    alpha: number,
    additive: boolean,
  ): void {
    if (this.count >= MAX_SPRITES) return;
    const d = this.draws[this.count++];
    d.x = x;
    d.y = y;
    d.frame = null;
    d.worldHeight = size;
    d.elevation = elevation;
    d.tint = color;
    d.alpha = alpha;
    d.particleSize = size;
    d.additive = additive;
  }

  /**
   * Composite everything queued this frame.
   * Must run after walls/floors and before the transparent wall pass.
   */
  render(
    cam: Camera,
    map: TileMap,
    pixels: Uint32Array,
    depthBuf: Float32Array,
    screenW: number,
    screenH: number,
    fogLut: (d: number) => number,
    fogRGB: { r: number; g: number; b: number },
    exposure: number,
    flash: number,
    viewDistance: number,
    /** Weapon-light contribution at a screen point, 0 when no light is lit. */
    beamAt: (screenX: number, screenY: number, dist: number) => number = () => 0,
  ): void {
    if (this.count === 0) return;

    const dirX = Math.cos(cam.angle);
    const dirY = Math.sin(cam.angle);
    const planeLen = Math.tan(cam.fov * 0.5);
    const planeX = -dirY * planeLen;
    const planeY = dirX * planeLen;
    const horizon = screenH * 0.5 + cam.pitch;
    const camZ = cam.eyeHeight;

    const invDet = 1 / (planeX * dirY - dirX * planeY);

    // Compute camera-space depth for every submission, discarding what is
    // behind the near plane.
    let visible = 0;
    for (let i = 0; i < this.count; i++) {
      const d = this.draws[i];
      const rx = d.x - cam.x;
      const ry = d.y - cam.y;
      const tz = invDet * (-planeY * rx + planeX * ry);
      d.depth = tz;
      if (tz > 0.12 && tz < viewDistance) this.order[visible++] = i;
    }
    if (visible === 0) return;

    // Painter's order: far to near, so nearer translucency lands on top.
    const orderSlice = this.order.subarray(0, visible);
    const sorted = Array.from(orderSlice).sort((a, b) => this.draws[b].depth - this.draws[a].depth);

    for (let s = 0; s < sorted.length; s++) {
      const d = this.draws[sorted[s]];
      const rx = d.x - cam.x;
      const ry = d.y - cam.y;
      const tx = invDet * (dirY * rx - dirX * ry);
      const tz = d.depth;

      const screenX = (screenW * 0.5) * (1 + tx / tz);

      // Vertical extent, matching the wall projection exactly so a sprite's
      // feet land on the floor pixel the raycaster drew.
      const baseElev = d.elevation;
      const topElev = d.elevation + d.worldHeight;
      const yBottom = horizon + (camZ - baseElev) * screenH / tz;
      const yTop = horizon + (camZ - topElev) * screenH / tz;
      const spriteH = yBottom - yTop;
      if (spriteH < 0.5) continue;

      const frame = d.frame;
      const aspect = frame ? frame.width / frame.height : 1;
      const spriteW = spriteH * aspect;
      if (spriteW < 0.5) continue;

      let x0 = Math.floor(screenX - spriteW * 0.5);
      let x1 = Math.ceil(screenX + spriteW * 0.5);
      if (x1 < 0 || x0 >= screenW) continue;
      if (x0 < 0) x0 = 0;
      if (x1 > screenW) x1 = screenW;

      let y0 = Math.floor(yTop);
      let y1 = Math.ceil(yBottom);
      if (y1 < 0 || y0 >= screenH) continue;
      if (y0 < 0) y0 = 0;
      if (y1 > screenH) y1 = screenH;

      // Shading: lightmap at the sprite's tile, distance fog, muzzle flash.
      const light = map.lightAt(Math.floor(d.x), Math.floor(d.y)) / 255;
      const fog = fogLut(tz);
      const invFog = 1 - fog;
      const flashAdd = flash > 0 ? flash / (1 + tz * tz * 0.09) : 0;
      const beam = beamAt(screenX, (yTop + yBottom) * 0.5, tz);
      const lightMul = (light + flashAdd + beam) * exposure * invFog;
      const fogRp = fogRGB.r * fog;
      const fogGp = fogRGB.g * fog;
      const fogBp = fogRGB.b * fog;

      const tintR = (d.tint & 0xff) / 255;
      const tintG = ((d.tint >> 8) & 0xff) / 255;
      const tintB = ((d.tint >> 16) & 0xff) / 255;
      const globalAlpha = d.alpha;

      if (!frame) {
        // Solid particle: no texture fetch, additive or alpha blended.
        const pr = (d.tint & 0xff) * (d.additive ? 1 : lightMul) + (d.additive ? 0 : fogRp);
        const pg = ((d.tint >> 8) & 0xff) * (d.additive ? 1 : lightMul) + (d.additive ? 0 : fogGp);
        const pb = ((d.tint >> 16) & 0xff) * (d.additive ? 1 : lightMul) + (d.additive ? 0 : fogBp);
        for (let y = y0; y < y1; y++) {
          let idx = y * screenW + x0;
          for (let x = x0; x < x1; x++, idx++) {
            if (tz >= depthBuf[idx]) continue;
            const dst = pixels[idx];
            const dr = dst & 0xff;
            const dg = (dst >> 8) & 0xff;
            const db = (dst >> 16) & 0xff;
            let nr: number;
            let ng: number;
            let nb: number;
            if (d.additive) {
              nr = dr + pr * globalAlpha;
              ng = dg + pg * globalAlpha;
              nb = db + pb * globalAlpha;
            } else {
              const ia = 1 - globalAlpha;
              nr = pr * globalAlpha + dr * ia;
              ng = pg * globalAlpha + dg * ia;
              nb = pb * globalAlpha + db * ia;
            }
            pixels[idx] = (255 << 24) |
              ((nb > 255 ? 255 : nb) | 0) << 16 |
              ((ng > 255 ? 255 : ng) | 0) << 8 |
              ((nr > 255 ? 255 : nr) | 0);
          }
        }
        continue;
      }

      const fw = frame.width;
      const fpx = frame.pixels;
      const uStep = fw / spriteW;
      const vStep = frame.height / spriteH;
      const uStart = (x0 - (screenX - spriteW * 0.5)) * uStep;
      const vStart = (y0 - yTop) * vStep;

      let u = uStart;
      for (let x = x0; x < x1; x++, u += uStep) {
        const su = u | 0;
        if (su < frame.minX || su > frame.maxX) continue;
        let v = vStart;
        let idx = y0 * screenW + x;
        for (let y = y0; y < y1; y++, v += vStep, idx += screenW) {
          if (tz >= depthBuf[idx]) continue;
          const sv = v | 0;
          if (sv < frame.minY || sv > frame.maxY) continue;
          const c = fpx[sv * fw + su];
          const a = (c >>> 24) & 0xff;
          if (a === 0) continue;

          const sr = (c & 0xff) * tintR * lightMul + fogRp;
          const sg = ((c >> 8) & 0xff) * tintG * lightMul + fogGp;
          const sb = ((c >> 16) & 0xff) * tintB * lightMul + fogBp;
          const alpha = (a / 255) * globalAlpha;

          if (alpha >= 0.999) {
            pixels[idx] = (255 << 24) |
              ((sb > 255 ? 255 : sb) | 0) << 16 |
              ((sg > 255 ? 255 : sg) | 0) << 8 |
              ((sr > 255 ? 255 : sr) | 0);
            depthBuf[idx] = tz;
          } else {
            const dst = pixels[idx];
            const ia = 1 - alpha;
            const nr = sr * alpha + (dst & 0xff) * ia;
            const ng = sg * alpha + ((dst >> 8) & 0xff) * ia;
            const nb = sb * alpha + ((dst >> 16) & 0xff) * ia;
            pixels[idx] = (255 << 24) |
              ((nb > 255 ? 255 : nb) | 0) << 16 |
              ((ng > 255 ? 255 : ng) | 0) << 8 |
              ((nr > 255 ? 255 : nr) | 0);
          }
        }
      }
    }
  }
}
