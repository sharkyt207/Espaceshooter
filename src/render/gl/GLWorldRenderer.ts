import { TEX_SIZE, TextureAtlas } from '../Textures';
import type { SpriteFrame } from '../Sprites';
import type { TileMap } from '../../world/TileMap';
import {
  createGL, createProgram, mat4, multiply, perspective, viewMatrix,
  type GLSetup, type Mat4, type Program,
} from './GLContext';
import {
  BLUR_FS, BRIGHT_FS, COMPOSITE_FS, FULLSCREEN_VS,
  SKY_FS, SKY_VS, SPRITE_FS, SPRITE_VS, WORLD_FS, WORLD_VS,
} from './Shaders';
import { buildWorldMesh, FLOATS_PER_VERTEX } from './WorldMesh';
import { SpriteAtlas } from './SpriteAtlas';

/**
 * GLWorldRenderer - the hardware path.
 *
 * Draws the same world, with the same lighting model, as the software
 * raycaster. What changes is that the per-pixel work runs on the GPU, which
 * makes affordable the things that are simply out of reach in JavaScript:
 * trilinear and anisotropic texture filtering, per-pixel lighting and fog,
 * and a real bloom chain rather than a sparse approximation of one.
 *
 * Frame structure:
 *
 *   1. Scene into a half-float target, so light can exceed white and the
 *      tone curve has something to roll off. This is the part that most
 *      changes the look - clipping at 255 is why the software image goes flat
 *      wherever it is bright.
 *   2. Sky, then opaque geometry, then sprites, then transparent surfaces.
 *   3. Bright pass and two blur passes at quarter resolution.
 *   4. Composite: bloom, tone map, grade, vignette, grain, to the canvas.
 *
 * Everything is written so that a failure at any point can be reported to the
 * caller, which then falls back to the software renderer. There is no state in
 * here the game depends on.
 */

const MAX_SPRITES = 1024;
/** Floats per sprite instance: pos+height 4, rect 4, tint 4, width 1. */
const SPRITE_FLOATS = 13;

export interface GLSpriteDraw {
  x: number;
  y: number;
  /** Metres above the floor, in tile units. */
  z: number;
  heightTiles: number;
  frame: SpriteFrame | null;
  tint: number;
  alpha: number;
  additive: boolean;
}

export interface GLFrameParams {
  camX: number;
  camY: number;
  camZ: number;
  yaw: number;
  pitch: number;
  roll: number;
  fovY: number;
  aspect: number;
  viewDistance: number;
  fogColor: number;
  fogDensity: number;
  skyTop: number;
  skyHorizon: number;
  exposure: number;
  flash: number;
  /** Torch: intensity, range in tiles, cos(inner), cos(outer). */
  torch: [number, number, number, number];
  time: number;
  /** Damage flash and exhaustion, applied in the composite. */
  overlay: [number, number, number, number];
}

export class GLWorldRenderer {
  private readonly setup: GLSetup;
  private readonly gl: WebGL2RenderingContext;

  private worldProgram!: Program;
  private skyProgram!: Program;
  private spriteProgram!: Program;
  private brightProgram!: Program;
  private blurProgram!: Program;
  private compositeProgram!: Program;

  private atlasTexture: WebGLTexture | null = null;
  private lightmapTexture: WebGLTexture | null = null;
  private spriteTexture: WebGLTexture | null = null;

  private worldVao: WebGLVertexArrayObject | null = null;
  private worldBuffer: WebGLBuffer | null = null;
  private transparentVao: WebGLVertexArrayObject | null = null;
  private transparentBuffer: WebGLBuffer | null = null;
  private opaqueCount = 0;
  private transparentCount = 0;

  private quadVao: WebGLVertexArrayObject | null = null;
  private spriteVao: WebGLVertexArrayObject | null = null;
  private spriteInstanceBuffer: WebGLBuffer | null = null;
  private spriteData = new Float32Array(MAX_SPRITES * SPRITE_FLOATS);
  private spriteCount = 0;

  private sceneFbo: WebGLFramebuffer | null = null;
  private sceneColor: WebGLTexture | null = null;
  private sceneDepth: WebGLRenderbuffer | null = null;
  private bloomFbo: [WebGLFramebuffer | null, WebGLFramebuffer | null] = [null, null];
  private bloomTex: [WebGLTexture | null, WebGLTexture | null] = [null, null];

  private width = 0;
  private height = 0;
  private bloomWidth = 0;
  private bloomHeight = 0;
  /** Canvas backing-store size. Equal to the scene size at render scale 1. */
  private displayWidth = 0;
  private displayHeight = 0;

  private readonly spriteAtlas = new SpriteAtlas();
  private spriteAtlasDirty = true;

  private readonly view: Mat4 = mat4();
  private readonly proj: Mat4 = mat4();
  private readonly viewProj: Mat4 = mat4();

  /** Set when something failed and the caller should fall back. */
  failed = false;

  bloomStrength = 0.7;
  bloomThreshold = 0.75;
  grain = 0.045;
  vignette = 0.55;

  private constructor(setup: GLSetup) {
    this.setup = setup;
    this.gl = setup.gl;
  }

  /** Returns null when WebGL2 or any required resource is unavailable. */
  static create(canvas: HTMLCanvasElement, atlas: TextureAtlas): GLWorldRenderer | null {
    const setup = createGL(canvas);
    if (!setup) return null;
    const renderer = new GLWorldRenderer(setup);
    if (!renderer.init(atlas)) return null;
    return renderer;
  }

  get rendererName(): string {
    return this.setup.caps.renderer;
  }

  private init(atlas: TextureAtlas): boolean {
    const gl = this.gl;

    const world = createProgram(gl, WORLD_VS, WORLD_FS, [
      'uViewProj', 'uAtlas', 'uLightmap', 'uMapSize', 'uCamPos', 'uCamForward',
      'uFogColor', 'uFogDensity', 'uViewDistance', 'uExposure', 'uFlash',
      'uTorch', 'uAlphaCutoff',
    ], 'world');
    const sky = createProgram(gl, SKY_VS, SKY_FS, [
      'uSkyTop', 'uSkyHorizon', 'uHorizonNdc', 'uTime', 'uYaw',
    ], 'sky');
    const sprite = createProgram(gl, SPRITE_VS, SPRITE_FS, [
      'uViewProj', 'uCamRight', 'uSprites', 'uLightmap', 'uMapSize',
      'uCamPos', 'uCamForward', 'uFogColor', 'uFogDensity', 'uViewDistance',
      'uExposure', 'uFlash', 'uTorch', 'uLit',
    ], 'sprite');
    const bright = createProgram(gl, FULLSCREEN_VS, BRIGHT_FS, ['uSource', 'uThreshold'], 'bright');
    const blur = createProgram(gl, FULLSCREEN_VS, BLUR_FS, ['uSource', 'uDirection'], 'blur');
    const composite = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, [
      'uScene', 'uBloom', 'uBloomStrength', 'uExposure', 'uGrain',
      'uVignette', 'uTime', 'uOverlay',
    ], 'composite');

    if (!world || !sky || !sprite || !bright || !blur || !composite) return false;
    this.worldProgram = world;
    this.skyProgram = sky;
    this.spriteProgram = sprite;
    this.brightProgram = bright;
    this.blurProgram = blur;
    this.compositeProgram = composite;

    if (!this.uploadAtlas(atlas)) return false;
    this.createQuad();
    this.createSpriteVao();
    return true;
  }

  // =========================================================================
  // Resources
  // =========================================================================

  /**
   * Upload the procedural material atlas as a texture array.
   *
   * The mip chain is uploaded rather than generated: the CPU atlas already
   * builds one, and its box filter treats fully transparent texels the way
   * this renderer needs. `generateMipmap` on a layered texture would also
   * filter across the layer boundary on some drivers, which blends unrelated
   * materials together at distance.
   */
  private uploadAtlas(atlas: TextureAtlas): boolean {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return false;
    const layers = atlas.texels.length;

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    const levels = atlas.mips[0]?.length ?? 1;
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, TEX_SIZE, TEX_SIZE, layers);

    for (let layer = 0; layer < layers; layer++) {
      const chain = atlas.mips[layer];
      for (let level = 0; level < chain.length; level++) {
        const size = TEX_SIZE >> level;
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY, level, 0, 0, layer, size, size, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(chain[level].buffer),
        );
      }
    }

    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);

    // Anisotropy is what keeps a floor sharp when you look along it. Without
    // it, trilinear filtering picks a mip level from the worst axis and the
    // ground turns to mush a few metres out.
    const ext = this.setup.anisotropyExt;
    if (ext) {
      gl.texParameterf(
        gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, this.setup.caps.maxAnisotropy),
      );
    }

    this.atlasTexture = texture;
    return true;
  }

  /**
   * Upload sprite frames. Call once after the sprite library is baked.
   */
  registerSprites(frames: SpriteFrame[]): void {
    for (const frame of frames) this.spriteAtlas.add(frame);
    this.spriteAtlas.addSolid();
    this.spriteAtlasDirty = true;
  }

  private flushSpriteAtlas(): void {
    if (!this.spriteAtlasDirty) return;
    this.spriteAtlasDirty = false;
    const gl = this.gl;
    if (!this.spriteTexture) this.spriteTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.spriteTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, this.spriteAtlas.size, this.spriteAtlas.size, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(this.spriteAtlas.pixels.buffer),
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Build the geometry for a map. Called once per raid. */
  setMap(map: TileMap): void {
    const gl = this.gl;
    const mesh = buildWorldMesh(map);
    this.opaqueCount = mesh.opaqueCount;
    this.transparentCount = mesh.transparentCount;

    const upload = (
      data: Float32Array,
      vao: WebGLVertexArrayObject | null,
      buffer: WebGLBuffer | null,
    ): [WebGLVertexArrayObject | null, WebGLBuffer | null] => {
      const v = vao ?? gl.createVertexArray();
      const b = buffer ?? gl.createBuffer();
      gl.bindVertexArray(v);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const stride = FLOATS_PER_VERTEX * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 20);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 24);
      gl.bindVertexArray(null);
      return [v, b];
    };

    [this.worldVao, this.worldBuffer] = upload(mesh.opaque, this.worldVao, this.worldBuffer);
    [this.transparentVao, this.transparentBuffer] =
      upload(mesh.transparent, this.transparentVao, this.transparentBuffer);

    this.uploadLightmap(map);
  }

  /**
   * The lightmap as a texture, sampled bilinearly.
   *
   * Bilinear is the point. The software renderer reads one value per tile, so
   * light steps at every tile boundary; sampling the same data as a texture
   * interpolates it and light varies smoothly across a floor. It is the same
   * data the AI reads, so nothing about visibility changes - it just stops
   * looking like a grid.
   */
  uploadLightmap(map: TileMap): void {
    const gl = this.gl;
    if (!this.lightmapTexture) this.lightmapTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lightmapTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R8, map.width, map.height, 0,
      gl.RED, gl.UNSIGNED_BYTE, map.lightmap,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private createQuad(): void {
    const gl = this.gl;
    this.quadVao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private createSpriteVao(): void {
    const gl = this.gl;
    this.spriteVao = gl.createVertexArray();
    gl.bindVertexArray(this.spriteVao);

    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, 0, 0.5, 0, 0.5, 1,
      -0.5, 0, 0.5, 1, -0.5, 1,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.spriteInstanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteInstanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.spriteData.byteLength, gl.DYNAMIC_DRAW);
    const stride = SPRITE_FLOATS * 4;
    // instance: x, y, z, height
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    // rect
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    // tint
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);
    // width
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 48);
    gl.vertexAttribDivisor(4, 1);

    gl.bindVertexArray(null);
  }

  // =========================================================================
  // Targets
  // =========================================================================

  /**
   * Size the render targets.
   *
   * `width`/`height` size the *scene*: the offscreen target the world, sprites
   * and bloom are rendered into. `displayWidth`/`displayHeight` size the final
   * composite, which is the canvas backing store.
   *
   * They are separate because the render-scale governor lowers the first to
   * defend the frame rate while the second has to stay at the display's
   * resolution - dropping that too would soften the crosshair and the HUD,
   * which is exactly the part players notice.
   */
  resize(width: number, height: number, displayWidth = width, displayHeight = height): void {
    if (
      width === this.width && height === this.height &&
      displayWidth === this.displayWidth && displayHeight === this.displayHeight
    ) return;
    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.bloomWidth = Math.max(1, width >> 2);
    this.bloomHeight = Math.max(1, height >> 2);

    const gl = this.gl;
    // Half-float where available so the scene can exceed white and the tone
    // curve has headroom. Falling back to 8-bit only costs the roll-off.
    const hdr = this.setup.caps.floatRenderTargets;

    const makeTarget = (
      w: number, h: number, float: boolean,
      fbo: WebGLFramebuffer | null, tex: WebGLTexture | null,
    ): [WebGLFramebuffer | null, WebGLTexture | null] => {
      const f = fbo ?? gl.createFramebuffer();
      const t = tex ?? gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, float ? gl.RGBA16F : gl.RGBA8, w, h, 0,
        gl.RGBA, float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return [f, t];
    };

    [this.sceneFbo, this.sceneColor] = makeTarget(width, height, hdr, this.sceneFbo, this.sceneColor);
    if (!this.sceneDepth) this.sceneDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.sceneDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.sceneDepth);

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('[gl] scene framebuffer incomplete');
      this.failed = true;
    }

    for (const i of [0, 1] as const) {
      [this.bloomFbo[i], this.bloomTex[i]] =
        makeTarget(this.bloomWidth, this.bloomHeight, hdr, this.bloomFbo[i], this.bloomTex[i]);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // =========================================================================
  // Frame
  // =========================================================================

  beginSprites(): void {
    this.spriteCount = 0;
  }

  /**
   * The `SpriteSink` face of this renderer.
   *
   * The same interface the software sprite renderer implements, so the effect
   * system and the enemy and loot passes are written once and neither knows
   * which backend it is feeding.
   */
  submit(
    x: number,
    y: number,
    frame: SpriteFrame,
    worldHeight: number,
    elevation = 0,
    tint = 0xffffff,
    alpha = 1,
  ): void {
    this.submitSprite({ x, y, z: elevation, heightTiles: worldHeight, frame, tint, alpha, additive: false });
  }

  submitParticle(
    x: number,
    y: number,
    elevation: number,
    size: number,
    color: number,
    alpha: number,
    additive: boolean,
  ): void {
    this.submitSprite({ x, y, z: elevation, heightTiles: size, frame: null, tint: color, alpha, additive });
  }

  /** Queue one billboard. Silently dropped when the buffer is full. */
  submitSprite(draw: GLSpriteDraw): void {
    if (this.spriteCount >= MAX_SPRITES) return;
    const rect = draw.frame ? this.spriteAtlas.get(draw.frame) : null;
    if (draw.frame && !rect) return;

    const o = this.spriteCount * SPRITE_FLOATS;
    const d = this.spriteData;
    d[o] = draw.x;
    d[o + 1] = draw.y;
    d[o + 2] = draw.z;
    d[o + 3] = draw.heightTiles;
    if (rect) {
      d[o + 4] = rect.u0;
      d[o + 5] = rect.v0;
      d[o + 6] = rect.u1;
      d[o + 7] = rect.v1;
      // Width follows the frame's aspect so nothing is stretched.
      d[o + 12] = draw.heightTiles * (rect.width / rect.height);
    } else {
      d[o + 4] = 0; d[o + 5] = 0; d[o + 6] = 1; d[o + 7] = 1;
      d[o + 12] = draw.heightTiles;
    }
    // Tint arrives as ABGR from the software path's conventions.
    d[o + 8] = (draw.tint & 0xff) / 255;
    d[o + 9] = ((draw.tint >> 8) & 0xff) / 255;
    d[o + 10] = ((draw.tint >> 16) & 0xff) / 255;
    d[o + 11] = draw.alpha;
    this.spriteCount++;
  }

  render(map: TileMap, params: GLFrameParams): void {
    if (this.failed) return;
    const gl = this.gl;
    this.flushSpriteAtlas();

    perspective(this.proj, params.fovY, params.aspect, 0.02, params.viewDistance * 1.2);
    viewMatrix(this.view, params.camX, params.camY, params.camZ, params.yaw, params.pitch, params.roll);
    multiply(this.viewProj, this.proj, this.view);

    const forward: [number, number, number] = [
      Math.cos(params.yaw) * Math.cos(params.pitch),
      Math.sin(params.yaw) * Math.cos(params.pitch),
      Math.sin(params.pitch),
    ];
    const right: [number, number, number] = [-Math.sin(params.yaw), Math.cos(params.yaw), 0];
    const fog = unpack(params.fogColor);

    // --- scene ------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    this.drawSky(params);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // Front faces wind *clockwise* on screen, which looks wrong until you
    // follow the basis through.
    //
    // The world is the tile grid: +x east, +y south (rows increase downward,
    // as they do in the map arrays), +z up. `WorldMesh` winds every face
    // counter-clockwise about its outward normal under the right-hand rule, so
    // the mesh itself is consistent and conventional.
    //
    // The camera basis is the one the software raycaster established: screen
    // right is `plane` = (-sin yaw, cos yaw), which at yaw 0 is +y. Together
    // with +z up that basis is left-handed, so the view transform includes a
    // mirror - and a mirror reverses winding. World-space CCW therefore
    // arrives at the rasteriser as CW.
    //
    // The alternative is negating the right vector to make the basis
    // right-handed, but that mirrors the picture relative to the software
    // renderer: turning would go the other way and every texture would be
    // flipped. Matching the existing convention and telling GL about the
    // handedness is the honest fix.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CW);

    // Opaque world.
    const w = this.worldProgram;
    gl.useProgram(w.program);
    this.setWorldUniforms(w, map, params, forward, fog, 0.5);
    gl.bindVertexArray(this.worldVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.opaqueCount);

    // Sprites.
    this.drawSprites(map, params, forward, right, fog);

    // Transparent world last, so fences and glass composite over everything.
    if (this.transparentCount > 0) {
      gl.useProgram(w.program);
      this.setWorldUniforms(w, map, params, forward, fog, 0.5);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(this.transparentVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.transparentCount);
      gl.enable(gl.CULL_FACE);
    }

    gl.bindVertexArray(null);

    // --- post -------------------------------------------------------------
    this.bloomPass();
    this.compositePass(params);
  }

  private setWorldUniforms(
    p: Program,
    map: TileMap,
    params: GLFrameParams,
    forward: [number, number, number],
    fog: [number, number, number],
    alphaCutoff: number,
  ): void {
    const gl = this.gl;
    gl.uniformMatrix4fv(p.u.uViewProj, false, this.viewProj);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTexture);
    gl.uniform1i(p.u.uAtlas, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lightmapTexture);
    gl.uniform1i(p.u.uLightmap, 1);
    gl.uniform2f(p.u.uMapSize, map.width, map.height);
    gl.uniform3f(p.u.uCamPos, params.camX, params.camY, params.camZ);
    gl.uniform3f(p.u.uCamForward, forward[0], forward[1], forward[2]);
    gl.uniform3f(p.u.uFogColor, fog[0], fog[1], fog[2]);
    gl.uniform1f(p.u.uFogDensity, params.fogDensity);
    gl.uniform1f(p.u.uViewDistance, params.viewDistance);
    gl.uniform1f(p.u.uExposure, params.exposure);
    gl.uniform1f(p.u.uFlash, params.flash);
    gl.uniform4f(p.u.uTorch, params.torch[0], params.torch[1], params.torch[2], params.torch[3]);
    gl.uniform1f(p.u.uAlphaCutoff, alphaCutoff);
  }

  private drawSky(params: GLFrameParams): void {
    const gl = this.gl;
    const s = this.skyProgram;
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(s.program);
    const top = unpack(params.skyTop);
    const horizon = unpack(params.skyHorizon);
    gl.uniform3f(s.u.uSkyTop, top[0], top[1], top[2]);
    gl.uniform3f(s.u.uSkyHorizon, horizon[0], horizon[1], horizon[2]);
    // Where the horizon sits in clip space for the current pitch, so the
    // gradient stays anchored to the world rather than to the screen.
    gl.uniform1f(s.u.uHorizonNdc, Math.max(-1, Math.min(1, -Math.tan(params.pitch) / Math.tan(params.fovY / 2))));
    gl.uniform1f(s.u.uTime, params.time);
    gl.uniform1f(s.u.uYaw, params.yaw);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawSprites(
    map: TileMap,
    params: GLFrameParams,
    forward: [number, number, number],
    right: [number, number, number],
    fog: [number, number, number],
  ): void {
    if (this.spriteCount === 0) return;
    const gl = this.gl;
    const s = this.spriteProgram;

    gl.useProgram(s.program);
    gl.uniformMatrix4fv(s.u.uViewProj, false, this.viewProj);
    gl.uniform3f(s.u.uCamRight, right[0], right[1], right[2]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.spriteTexture);
    gl.uniform1i(s.u.uSprites, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lightmapTexture);
    gl.uniform1i(s.u.uLightmap, 1);
    gl.uniform2f(s.u.uMapSize, map.width, map.height);
    gl.uniform3f(s.u.uCamPos, params.camX, params.camY, params.camZ);
    gl.uniform3f(s.u.uCamForward, forward[0], forward[1], forward[2]);
    gl.uniform3f(s.u.uFogColor, fog[0], fog[1], fog[2]);
    gl.uniform1f(s.u.uFogDensity, params.fogDensity);
    gl.uniform1f(s.u.uViewDistance, params.viewDistance);
    gl.uniform1f(s.u.uExposure, params.exposure);
    gl.uniform1f(s.u.uFlash, params.flash);
    gl.uniform4f(s.u.uTorch, params.torch[0], params.torch[1], params.torch[2], params.torch[3]);
    gl.uniform1f(s.u.uLit, 1);

    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteInstanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.spriteData, 0, this.spriteCount * SPRITE_FLOATS);

    // Alpha blended, depth tested, but not depth written: a billboard's alpha
    // edge would otherwise punch a hole in whatever is drawn after it.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.spriteCount);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  private bloomPass(): void {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, this.bloomWidth, this.bloomHeight);
    gl.bindVertexArray(this.quadVao);

    // Bright pass into buffer 0.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo[0]);
    gl.useProgram(this.brightProgram.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneColor);
    gl.uniform1i(this.brightProgram.u.uSource, 0);
    gl.uniform1f(this.brightProgram.u.uThreshold, this.bloomThreshold);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Two separable blurs, ping-ponging.
    gl.useProgram(this.blurProgram.program);
    gl.uniform1i(this.blurProgram.u.uSource, 0);
    for (let pass = 0; pass < 2; pass++) {
      const src = pass % 2 === 0 ? 0 : 1;
      const dst = pass % 2 === 0 ? 1 : 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo[dst]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTex[src]);
      if (pass === 0) gl.uniform2f(this.blurProgram.u.uDirection, 1 / this.bloomWidth, 0);
      else gl.uniform2f(this.blurProgram.u.uDirection, 0, 1 / this.bloomHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  private compositePass(params: GLFrameParams): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // The composite is where the upscale happens: it samples the scene target
    // at whatever the governor picked and writes the canvas at full
    // resolution. The scene texture is linear-filtered, so this is a bilinear
    // stretch rather than a blocky one, and the grain and vignette are applied
    // *after* it - at display resolution, where they read as film rather than
    // as an upscaled artefact.
    gl.viewport(0, 0, this.displayWidth, this.displayHeight);
    const c = this.compositeProgram;
    gl.useProgram(c.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneColor);
    gl.uniform1i(c.u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    // Two blur passes leaves the result in buffer 0.
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTex[0]);
    gl.uniform1i(c.u.uBloom, 1);
    gl.uniform1f(c.u.uBloomStrength, this.bloomStrength);
    gl.uniform1f(c.u.uExposure, 1);
    gl.uniform1f(c.u.uGrain, this.grain);
    gl.uniform1f(c.u.uVignette, this.vignette);
    gl.uniform1f(c.u.uTime, params.time);
    gl.uniform4f(c.u.uOverlay, params.overlay[0], params.overlay[1], params.overlay[2], params.overlay[3]);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}

/** 0xRRGGBB to normalised rgb. */
function unpack(color: number): [number, number, number] {
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
}
