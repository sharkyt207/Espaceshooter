import { TileMap, TILE_DEFS, METERS_PER_TILE } from '../world/TileMap';
import { TextureAtlas, TEX_SIZE, floorTextureFor } from './Textures';
import { valueNoise } from '../core/Noise';

/**
 * Raycaster - the first-person software renderer.
 *
 * A DDA raycaster was chosen over a polygon renderer for three reasons:
 *   1. Cost scales with screen resolution, not scene complexity, so a dense
 *      container yard costs the same as an empty field - predictable on mobile.
 *   2. The renderer traverses the exact same grid the simulation uses, so what
 *      you see and what your bullets hit can never disagree.
 *   3. It gives us a full per-pixel depth buffer for free, which we need for
 *      correct sprite/glass/fence interleaving.
 *
 * Rendering order per frame:
 *   1. Sky and ceiling (rows above the horizon)
 *   2. Floor (rows below the horizon)
 *   3. Opaque walls (per column DDA, terminal hit)
 *   4. Sprites (SpriteRenderer, depth-tested)
 *   5. Transparent walls - fences, glazing, low crates - back to front
 *
 * Shading is deliberately per-column / per-row rather than per-pixel: light and
 * fog are constant along a wall column and along a floor row, so the inner loop
 * is three multiplies and a store.
 *
 * Unity port note: none of this survives the port - it is replaced by the URP
 * renderer. Everything it *reads* (TileMap, lightmap, camera) does survive.
 */

export interface Camera {
  /** World position in tiles. */
  x: number;
  y: number;
  /** Yaw in radians. */
  angle: number;
  /** Vertical look, in screen pixels of horizon offset. */
  pitch: number;
  /** Eye height in tile units above the floor (1 tile = wall height). */
  eyeHeight: number;
  /** Horizontal field of view in radians. */
  fov: number;
  /** Roll in radians - used for lean and death animation. */
  roll: number;
}

export function createCamera(): Camera {
  return { x: 0, y: 0, angle: 0, pitch: 0, eyeHeight: 0.52, fov: 1.28, roll: 0 };
}

export interface RenderSettings {
  /** Exponential fog density per tile. Sells depth and hides the draw distance. */
  fogDensity: number;
  fogColor: number;
  /** Global exposure multiplier applied after lighting. */
  exposure: number;
  /** Max ray length in tiles. */
  viewDistance: number;
  /**
   * Render floor/ceiling every Nth row and duplicate. 1 = full quality,
   * 2 = half cost with a barely visible difference at phone DPI.
   */
  floorRowStep: number;
  /** Draw the ceiling/sky at all (disabling is a large win on weak devices). */
  drawCeiling: boolean;
}

export function defaultRenderSettings(): RenderSettings {
  return {
    fogDensity: 0.055,
    fogColor: 0x2a3038,
    exposure: 1.0,
    viewDistance: 42,
    floorRowStep: 1,
    drawCeiling: true,
  };
}

/** How many see-through / low surfaces a single column may stack. */
const MAX_LAYERS_PER_COLUMN = 6;

export class Raycaster {
  width = 0;
  height = 0;

  /** ABGR framebuffer handed to ImageData. */
  pixels!: Uint32Array;
  imageData!: ImageData;
  /** Per-pixel depth in tiles; Infinity where nothing has been drawn. */
  depth!: Float32Array;

  private skyGradient!: Uint32Array;
  private cloudLut = new Float32Array(1024);
  private fogLut = new Float32Array(512);
  private fogR = 0;
  private fogG = 0;
  private fogB = 0;

  /** Per-column transparent layer scratch, flat for cache friendliness. */
  private layerDist!: Float32Array;
  private layerTex!: Int32Array;
  private layerU!: Float32Array;
  private layerHeight!: Float32Array;
  private layerLight!: Float32Array;
  private layerCount!: Int32Array;

  private settings = defaultRenderSettings();

  constructor(private readonly atlas: TextureAtlas) {
    this.buildCloudLut();
  }

  get renderSettings(): RenderSettings {
    return this.settings;
  }

  applySettings(s: Partial<RenderSettings>): void {
    Object.assign(this.settings, s);
    this.buildFogLut();
    if (this.height > 0) this.buildSkyGradient();
  }

  /** (Re)allocate all buffers. Called on resize and on render-scale changes. */
  resize(width: number, height: number): void {
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    const n = this.width * this.height;
    // Allocate through ImageData and view its bytes as 32-bit words. One
    // backing store serves both the renderer and putImageData, so presenting a
    // frame never copies the framebuffer.
    this.imageData = new ImageData(this.width, this.height);
    this.pixels = new Uint32Array(this.imageData.data.buffer);
    this.depth = new Float32Array(n);

    const cols = this.width;
    this.layerDist = new Float32Array(cols * MAX_LAYERS_PER_COLUMN);
    this.layerTex = new Int32Array(cols * MAX_LAYERS_PER_COLUMN);
    this.layerU = new Float32Array(cols * MAX_LAYERS_PER_COLUMN);
    this.layerHeight = new Float32Array(cols * MAX_LAYERS_PER_COLUMN);
    this.layerLight = new Float32Array(cols * MAX_LAYERS_PER_COLUMN);
    this.layerCount = new Int32Array(cols);

    this.buildFogLut();
    this.buildSkyGradient();
  }

  private buildFogLut(): void {
    const { fogDensity, viewDistance } = this.settings;
    for (let i = 0; i < this.fogLut.length; i++) {
      const d = (i / (this.fogLut.length - 1)) * viewDistance;
      // Exponential-squared fog: stays clear up close, closes fast at range.
      const f = 1 - Math.exp(-(d * fogDensity) * (d * fogDensity) * 1.15 - d * fogDensity * 0.35);
      this.fogLut[i] = f < 0 ? 0 : f > 1 ? 1 : f;
    }
    const c = this.settings.fogColor;
    this.fogR = (c >> 16) & 0xff;
    this.fogG = (c >> 8) & 0xff;
    this.fogB = c & 0xff;
  }

  private buildCloudLut(): void {
    for (let i = 0; i < this.cloudLut.length; i++) {
      const a = (i / this.cloudLut.length) * 8;
      this.cloudLut[i] = valueNoise(a, 0.5, 8, 1234) * 0.6 + valueNoise(a * 2.7, 1.5, 22, 77) * 0.4;
    }
  }

  /** Vertical sky ramp, recomputed on resize/settings change. */
  private buildSkyGradient(): void {
    this.skyGradient = new Uint32Array(this.height);
    for (let y = 0; y < this.height; y++) {
      const t = y / this.height;
      // Overcast industrial sky: cold at zenith, warmer haze near the horizon.
      const r = 44 + t * 96;
      const g = 52 + t * 100;
      const b = 62 + t * 96;
      this.skyGradient[y] = (255 << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
    }
  }

  /** Lookup fog factor for a distance in tiles. */
  private fogAt(dist: number): number {
    const i = (dist / this.settings.viewDistance) * (this.fogLut.length - 1);
    const idx = i < 0 ? 0 : i > this.fogLut.length - 1 ? this.fogLut.length - 1 : i | 0;
    return this.fogLut[idx];
  }

  /**
   * Render one frame.
   *
   * `flashIntensity` is the additive contribution of transient light (muzzle
   * flash, explosions) at the camera, falling off with distance. Handling it
   * here rather than as a post effect means it correctly lights the geometry.
   */
  render(cam: Camera, map: TileMap, flashIntensity: number, time: number): void {
    const h = this.height;
    this.depth.fill(Infinity);

    const dirX = Math.cos(cam.angle);
    const dirY = Math.sin(cam.angle);
    // Camera plane length sets the FOV; perpendicular to the view direction.
    const planeLen = Math.tan(cam.fov * 0.5);
    const planeX = -dirY * planeLen;
    const planeY = dirX * planeLen;

    const horizon = h * 0.5 + cam.pitch;
    const camZ = cam.eyeHeight;

    this.renderFloorAndCeiling(cam, map, dirX, dirY, planeX, planeY, horizon, camZ, flashIntensity, time);
    this.renderWalls(cam, map, dirX, dirY, planeX, planeY, horizon, camZ, flashIntensity);

    // Transparent surfaces stay deferred: the caller draws sprites, then calls
    // renderTransparentLayers() so glass and fences land on top of them.
  }

  // =========================================================================
  // Floor & ceiling
  // =========================================================================

  private renderFloorAndCeiling(
    cam: Camera,
    map: TileMap,
    dirX: number,
    dirY: number,
    planeX: number,
    planeY: number,
    horizon: number,
    camZ: number,
    flash: number,
    time: number,
  ): void {
    const w = this.width;
    const h = this.height;
    const px = this.pixels;
    const depth = this.depth;
    const atlas = this.atlas;
    const step = Math.max(1, this.settings.floorRowStep | 0);
    const exposure = this.settings.exposure;
    const viewDist = this.settings.viewDistance;

    // Ray directions at the left and right screen edges.
    const rayDirX0 = dirX - planeX;
    const rayDirY0 = dirY - planeY;
    const rayDirX1 = dirX + planeX;
    const rayDirY1 = dirY + planeY;

    const mapW = map.width;
    const lightmap = map.lightmap;
    const ceiling = map.ceiling;
    const floorLayer = map.floor;

    // --- rows below the horizon: floor -------------------------------------
    const floorStart = Math.max(0, Math.ceil(horizon));
    for (let y = floorStart; y < h; y += step) {
      const p = y - horizon;
      if (p <= 0.0001) continue;
      const rowDistance = (camZ * h) / p;
      if (rowDistance > viewDist) {
        // Beyond draw distance: flat fog, still cheaper than sampling.
        this.fillRowFog(y, step, rowDistance);
        continue;
      }

      const stepX = (rowDistance * (rayDirX1 - rayDirX0)) / w;
      const stepY = (rowDistance * (rayDirY1 - rayDirY0)) / w;
      let fx = cam.x + rowDistance * rayDirX0;
      let fy = cam.y + rowDistance * rayDirY0;

      const fog = this.fogAt(rowDistance);
      const invFog = 1 - fog;
      const fogRp = this.fogR * fog;
      const fogGp = this.fogG * fog;
      const fogBp = this.fogB * fog;
      // Transient light falls off with the square of distance.
      const flashAdd = flash > 0 ? flash / (1 + rowDistance * rowDistance * 0.09) : 0;

      const rowBase = y * w;
      // Light is sampled every 4 px: it varies per tile, not per pixel.
      let lightMul = 1;
      for (let x = 0; x < w; x++) {
        const cellX = fx | 0;
        const cellY = fy | 0;

        if ((x & 3) === 0) {
          const inBounds = cellX >= 0 && cellY >= 0 && cellX < mapW && cellY < map.height;
          const l = inBounds ? lightmap[cellY * mapW + cellX] / 255 : 0.1;
          lightMul = (l + flashAdd) * exposure * invFog;
        }

        const tileFloor = cellX >= 0 && cellY >= 0 && cellX < mapW && cellY < map.height
          ? floorLayer[cellY * mapW + cellX]
          : 0;
        const tex = atlas.texels[floorTextureFor(tileFloor)];
        const tu = ((fx - cellX) * TEX_SIZE) | 0;
        const tv = ((fy - cellY) * TEX_SIZE) | 0;
        const c = tex[(tv & (TEX_SIZE - 1)) * TEX_SIZE + (tu & (TEX_SIZE - 1))];

        const r = (c & 0xff) * lightMul + fogRp;
        const g = ((c >> 8) & 0xff) * lightMul + fogGp;
        const b = ((c >> 16) & 0xff) * lightMul + fogBp;
        const out = (255 << 24) | ((b > 255 ? 255 : b) << 16) | ((g > 255 ? 255 : g) << 8) | (r > 255 ? 255 : r);

        const i = rowBase + x;
        px[i] = out;
        depth[i] = rowDistance;
        fx += stepX;
        fy += stepY;
      }
      this.duplicateRow(y, step);
    }

    if (!this.settings.drawCeiling) {
      // Fill the upper half with sky only.
      const ceilEnd = Math.min(h, Math.floor(horizon));
      for (let y = 0; y < ceilEnd; y++) {
        const sky = this.skyColor(y, cam, 0);
        const rowBase = y * w;
        for (let x = 0; x < w; x++) px[rowBase + x] = sky;
      }
      return;
    }

    // --- rows above the horizon: interior ceiling, or sky ------------------
    const ceilEnd = Math.min(h, Math.floor(horizon));
    for (let y = 0; y < ceilEnd; y += step) {
      const p = horizon - y;
      if (p <= 0.0001) continue;
      // Ceilings sit at wall height (1 tile) above the floor.
      const rowDistance = ((1 - camZ) * h) / p;

      const rowBase = y * w;
      if (rowDistance > viewDist) {
        for (let k = 0; k < step && y + k < ceilEnd; k++) {
          const base = (y + k) * w;
          const sky = this.skyColor(y + k, cam, time);
          for (let x = 0; x < w; x++) px[base + x] = sky;
        }
        continue;
      }

      const stepX = (rowDistance * (rayDirX1 - rayDirX0)) / w;
      const stepY = (rowDistance * (rayDirY1 - rayDirY0)) / w;
      let fx = cam.x + rowDistance * rayDirX0;
      let fy = cam.y + rowDistance * rayDirY0;

      const fog = this.fogAt(rowDistance);
      const invFog = 1 - fog;
      const fogRp = this.fogR * fog;
      const fogGp = this.fogG * fog;
      const fogBp = this.fogB * fog;
      const flashAdd = flash > 0 ? flash / (1 + rowDistance * rowDistance * 0.09) : 0;

      let lightMul = 1;
      const skyRow = this.skyColor(y, cam, time);
      for (let x = 0; x < w; x++) {
        const cellX = fx | 0;
        const cellY = fy | 0;
        const inBounds = cellX >= 0 && cellY >= 0 && cellX < mapW && cellY < map.height;
        const ceilTile = inBounds ? ceiling[cellY * mapW + cellX] : 0;
        const i = rowBase + x;

        if (ceilTile === 0) {
          // Open sky - no depth write, so nothing occludes against it.
          px[i] = skyRow;
          fx += stepX;
          fy += stepY;
          continue;
        }

        if ((x & 3) === 0) {
          const l = inBounds ? lightmap[cellY * mapW + cellX] / 255 : 0.1;
          // Ceilings read darker than floors; light rarely points up.
          lightMul = (l * 0.72 + flashAdd) * exposure * invFog;
        }

        const tex = atlas.texels[TILE_DEFS[ceilTile]?.texture ?? 1];
        const tu = ((fx - cellX) * TEX_SIZE) | 0;
        const tv = ((fy - cellY) * TEX_SIZE) | 0;
        const c = tex[(tv & (TEX_SIZE - 1)) * TEX_SIZE + (tu & (TEX_SIZE - 1))];

        const r = (c & 0xff) * lightMul + fogRp;
        const g = ((c >> 8) & 0xff) * lightMul + fogGp;
        const b = ((c >> 16) & 0xff) * lightMul + fogBp;
        px[i] = (255 << 24) | ((b > 255 ? 255 : b) << 16) | ((g > 255 ? 255 : g) << 8) | (r > 255 ? 255 : r);
        depth[i] = rowDistance;
        fx += stepX;
        fy += stepY;
      }
      this.duplicateRow(y, step);
    }
  }

  /** Copy a rendered row into the (step-1) rows beneath it. */
  private duplicateRow(y: number, step: number): void {
    if (step <= 1) return;
    const w = this.width;
    const px = this.pixels;
    const depth = this.depth;
    const src = y * w;
    for (let k = 1; k < step; k++) {
      const dstY = y + k;
      if (dstY >= this.height) break;
      const dst = dstY * w;
      px.copyWithin(dst, src, src + w);
      depth.copyWithin(dst, src, src + w);
    }
  }

  private fillRowFog(y: number, step: number, dist: number): void {
    const w = this.width;
    const px = this.pixels;
    const depth = this.depth;
    const c = (255 << 24) | (this.fogB << 16) | (this.fogG << 8) | this.fogR;
    for (let k = 0; k < step && y + k < this.height; k++) {
      const base = (y + k) * w;
      for (let x = 0; x < w; x++) {
        px[base + x] = c;
        depth[base + x] = dist;
      }
    }
  }

  /** Sky colour for a screen row, with slow-drifting cloud banding. */
  private skyColor(y: number, cam: Camera, time: number): number {
    const base = this.skyGradient[y < 0 ? 0 : y >= this.height ? this.height - 1 : y];
    // Modulate by a cloud LUT indexed on view angle so the sky parallaxes.
    const idx = (((cam.angle / (Math.PI * 2)) * this.cloudLut.length + time * 1.6) | 0) & (this.cloudLut.length - 1);
    const cloud = this.cloudLut[idx] * 0.18;
    const r = (base & 0xff) * (1 + cloud);
    const g = ((base >> 8) & 0xff) * (1 + cloud);
    const b = ((base >> 16) & 0xff) * (1 + cloud);
    return (255 << 24) | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0);
  }

  // =========================================================================
  // Walls
  // =========================================================================

  private renderWalls(
    cam: Camera,
    map: TileMap,
    dirX: number,
    dirY: number,
    planeX: number,
    planeY: number,
    horizon: number,
    camZ: number,
    flash: number,
  ): void {
    const w = this.width;
    const atlas = this.atlas;
    const exposure = this.settings.exposure;
    const maxDist = this.settings.viewDistance;
    const mapW = map.width;
    const mapH = map.height;

    for (let x = 0; x < w; x++) {
      this.layerCount[x] = 0;

      const cameraX = (2 * x) / w - 1;
      const rayDirX = dirX + planeX * cameraX;
      const rayDirY = dirY + planeY * cameraX;

      let mapX = cam.x | 0;
      let mapY = cam.y | 0;
      const deltaX = rayDirX === 0 ? 1e30 : Math.abs(1 / rayDirX);
      const deltaY = rayDirY === 0 ? 1e30 : Math.abs(1 / rayDirY);
      let stepX: number;
      let stepY: number;
      let sideDistX: number;
      let sideDistY: number;

      if (rayDirX < 0) {
        stepX = -1;
        sideDistX = (cam.x - mapX) * deltaX;
      } else {
        stepX = 1;
        sideDistX = (mapX + 1 - cam.x) * deltaX;
      }
      if (rayDirY < 0) {
        stepY = -1;
        sideDistY = (cam.y - mapY) * deltaY;
      } else {
        stepY = 1;
        sideDistY = (mapY + 1 - cam.y) * deltaY;
      }

      let side = 0;
      let perpDist = 0;

      // March until we hit something that fully blocks the column, collecting
      // see-through and low surfaces as deferred layers on the way.
      for (let iter = 0; iter < 256; iter++) {
        if (sideDistX < sideDistY) {
          perpDist = sideDistX;
          sideDistX += deltaX;
          mapX += stepX;
          side = 0;
        } else {
          perpDist = sideDistY;
          sideDistY += deltaY;
          mapY += stepY;
          side = 1;
        }
        if (perpDist > maxDist) break;
        if (mapX < 0 || mapY < 0 || mapX >= mapW || mapY >= mapH) break;

        const tile = map.tiles[mapY * mapW + mapX];
        const tdef = TILE_DEFS[tile];
        if (!tdef.wall) continue;

        const texIndex = tdef.texture;
        const heightNorm = tdef.height / METERS_PER_TILE;
        const hitX = cam.x + rayDirX * perpDist;
        const hitY = cam.y + rayDirY * perpDist;
        let u = side === 0 ? hitY - Math.floor(hitY) : hitX - Math.floor(hitX);
        if ((side === 0 && rayDirX > 0) || (side === 1 && rayDirY < 0)) u = 1 - u;

        // Light sampled from the tile the ray came from, not the wall itself:
        // a wall face is lit by the room in front of it.
        const backX = mapX - (side === 0 ? stepX : 0);
        const backY = mapY - (side === 1 ? stepY : 0);
        const light = map.lightAt(backX, backY) / 255;

        const opaqueFull = heightNorm >= 1 && !atlas.hasAlpha[texIndex];
        if (opaqueFull) {
          this.drawWallColumn(x, perpDist, texIndex, u, heightNorm, side, light, horizon, camZ, flash, exposure, false);
          break;
        }

        // Defer: transparent or short. Drawn after sprites.
        const n = this.layerCount[x];
        if (n < MAX_LAYERS_PER_COLUMN) {
          const li = x * MAX_LAYERS_PER_COLUMN + n;
          this.layerDist[li] = perpDist;
          this.layerTex[li] = texIndex;
          this.layerU[li] = u;
          this.layerHeight[li] = heightNorm;
          this.layerLight[li] = light * (side === 1 ? 0.82 : 1);
          this.layerCount[x] = n + 1;
        }
      }
    }
  }

  /**
   * Draw one textured vertical strip.
   * `blend` enables alpha compositing and depth *testing* without writing depth
   * for translucent texels - used by the transparent pass.
   */
  private drawWallColumn(
    x: number,
    dist: number,
    texIndex: number,
    u: number,
    heightNorm: number,
    side: number,
    light: number,
    horizon: number,
    camZ: number,
    flash: number,
    exposure: number,
    blend: boolean,
  ): void {
    const h = this.height;
    const w = this.width;
    const px = this.pixels;
    const depth = this.depth;
    const tex = this.atlas.texels[texIndex];

    // Project the wall's world-space top and bottom onto the screen.
    const invDist = 1 / dist;
    const yTop = horizon + (camZ - heightNorm) * h * invDist;
    const yBottom = horizon + camZ * h * invDist;
    const span = yBottom - yTop;
    if (span <= 0) return;

    let start = Math.ceil(yTop);
    let end = Math.floor(yBottom);
    if (end < 0 || start >= h) return;
    const texStep = TEX_SIZE / span;
    let texPos = (start - yTop) * texStep;
    if (start < 0) {
      texPos += -start * texStep;
      start = 0;
    }
    if (end >= h) end = h - 1;

    const texU = (u * TEX_SIZE) | 0;
    const texColBase = texU < 0 ? 0 : texU >= TEX_SIZE ? TEX_SIZE - 1 : texU;

    const fog = this.fogAt(dist);
    const invFog = 1 - fog;
    const fogRp = this.fogR * fog;
    const fogGp = this.fogG * fog;
    const fogBp = this.fogB * fog;
    const flashAdd = flash > 0 ? flash / (1 + dist * dist * 0.09) : 0;
    // Faces perpendicular to the view read darker - a cheap directional cue
    // that makes corners legible without a normal buffer.
    const sideShade = side === 1 ? 0.78 : 1;
    const lightMul = (light * sideShade + flashAdd) * exposure * invFog;

    let idx = start * w + x;
    const stride = w;
    for (let y = start; y <= end; y++, idx += stride) {
      if (blend && dist >= depth[idx]) {
        texPos += texStep;
        continue;
      }
      const tv = texPos | 0;
      texPos += texStep;
      const c = tex[(tv < 0 ? 0 : tv >= TEX_SIZE ? TEX_SIZE - 1 : tv) * TEX_SIZE + texColBase];
      const a = (c >>> 24) & 0xff;
      if (a === 0) continue;

      const r = (c & 0xff) * lightMul + fogRp;
      const g = ((c >> 8) & 0xff) * lightMul + fogGp;
      const b = ((c >> 16) & 0xff) * lightMul + fogBp;

      if (a === 255) {
        px[idx] = (255 << 24) |
          ((b > 255 ? 255 : b) | 0) << 16 |
          ((g > 255 ? 255 : g) | 0) << 8 |
          ((r > 255 ? 255 : r) | 0);
        depth[idx] = dist;
      } else {
        // Source-over blend against what is already in the buffer.
        const dstc = px[idx];
        const alpha = a / 255;
        const ia = 1 - alpha;
        const nr = r * alpha + (dstc & 0xff) * ia;
        const ng = g * alpha + ((dstc >> 8) & 0xff) * ia;
        const nb = b * alpha + ((dstc >> 16) & 0xff) * ia;
        px[idx] = (255 << 24) |
          ((nb > 255 ? 255 : nb) | 0) << 16 |
          ((ng > 255 ? 255 : ng) | 0) << 8 |
          ((nr > 255 ? 255 : nr) | 0);
      }
    }
  }

  /**
   * Final pass: composite deferred transparent/low surfaces back to front so
   * they layer correctly against each other and against sprites.
   * Call after sprites have been drawn.
   */
  renderTransparentLayers(cam: Camera, horizon: number, flash: number): void {
    const w = this.width;
    const camZ = cam.eyeHeight;
    const exposure = this.settings.exposure;
    for (let x = 0; x < w; x++) {
      const n = this.layerCount[x];
      if (n === 0) continue;
      // Layers were collected front to back; draw in reverse.
      for (let k = n - 1; k >= 0; k--) {
        const li = x * MAX_LAYERS_PER_COLUMN + k;
        this.drawWallColumn(
          x,
          this.layerDist[li],
          this.layerTex[li],
          this.layerU[li],
          this.layerHeight[li],
          0,
          this.layerLight[li],
          horizon,
          camZ,
          flash,
          exposure,
          true,
        );
      }
    }
  }

  horizonFor(cam: Camera): number {
    return this.height * 0.5 + cam.pitch;
  }
}
