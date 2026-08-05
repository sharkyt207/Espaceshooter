import { clamp, clamp01, damp } from '../core/Math2D';
import { fxRng } from '../core/Random';
import { ItemDB } from '../data/ItemDatabase';
import { METERS_PER_TILE } from '../world/TileMap';
import type { RaidSession } from '../raid/RaidSession';
import { createCamera, Raycaster, type Camera } from './Raycaster';
import { SpriteRenderer } from './SpriteRenderer';
import { SpriteLibrary, frameIndexFor, type CharacterSheet, type SpriteFrame } from './Sprites';
import type { SpriteSink } from './SpriteSink';
import { TextureAtlas } from './Textures';
import { setPortraitStyle } from './Portraits';
import { DEFAULT_STYLE, STYLES, type VisualStyle } from './Style';
import { PerfGovernor } from '../core/Loop';
import { PostProcess } from './PostProcess';
import { detectDeviceTier, initialRenderScale } from '../platform/Platform';
import { GLWorldRenderer } from './gl/GLWorldRenderer';

/**
 * RaidRenderer - assembles a frame.
 *
 * Owns the two-canvas presentation path used throughout:
 *
 *   1. The software raycaster writes into an ImageData at *internal*
 *      resolution, which the performance governor scales between 45 % and
 *      100 % of the display.
 *   2. That buffer is blitted, scaled, onto the visible canvas, and the
 *      viewmodel, crosshair and screen effects are drawn on top in vector 2D
 *      so they stay razor sharp regardless of internal resolution.
 *
 * That split is the single most important performance decision in the project:
 * the expensive per-pixel work scales with device capability while the UI and
 * weapon never get blurry.
 */

/** Screen-space damage indicator. */
interface DamageMarker {
  /** World direction the damage came from. */
  angle: number;
  life: number;
}

export class RaidRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Offscreen canvas holding the raycaster output at internal resolution. */
  private readonly offscreen: HTMLCanvasElement;
  private readonly offCtx: CanvasRenderingContext2D;

  readonly atlas = new TextureAtlas();
  readonly sprites = new SpriteLibrary();
  readonly raycaster: Raycaster;
  private readonly spriteRenderer = new SpriteRenderer();
  private readonly post = new PostProcess();

  /**
   * The hardware path, when the device provides one.
   *
   * Null means the software raycaster runs instead - not an error state, just
   * the other branch. Everything above this class is identical either way.
   */
  private gl: GLWorldRenderer | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  /** Map the GL geometry was last built for, so it rebuilds once per raid. */
  private glMapKey = '';

  readonly camera: Camera = createCamera();
  /**
   * The starting scale is a guess from the device's reported cores and memory;
   * the governor measures the truth within a second or two and overrides it
   * either way. The guess only exists because those first seconds are the
   * player's first impression, and a mid-range phone that opens at full
   * resolution stutters through them before there is any data to act on.
   */
  readonly governor = new PerfGovernor(60, initialRenderScale(detectDeviceTier()), 0.45, 1);

  /** Fixed render scale from settings; 0 means let the governor decide. */
  fixedScale = 0;

  /**
   * 0 = no post processing, 1 = tone mapping only, 2 = bloom and tone mapping.
   * Exposed so the settings screen can trade it against frame rate, which is
   * the honest trade on a phone: bloom is the most expensive thing here and
   * also the most visible.
   */
  private postQuality = detectDeviceTier() === 'low' ? 1 : 2;

  /** `-1` means "decide from the device", otherwise 0, 1 or 2. */
  applyPostQuality(level: number): void {
    this.postQuality = level >= 0 ? level : (detectDeviceTier() === 'low' ? 1 : 2);
    this.refreshPost();
  }

  /**
   * Reconcile the style's grade with the quality level.
   *
   * Both have a say and they arrive independently - the style says how the
   * game should look, the quality level says how much of that this device can
   * afford - so they are combined in one place rather than each writing to the
   * post settings and whichever ran last winning.
   */
  private refreshPost(): void {
    const grade = this.style.grade;
    this.post.settings.grade = grade;
    this.post.settings.bloomStrength = this.postQuality >= 2 ? grade.bloomStrength : 0;
    this.post.settings.toneMapping = this.postQuality >= 1 ? 1 : 0;
    if (this.gl) {
      this.gl.grade = grade;
      this.gl.grain = grade.grain;
      this.gl.bloomStrength = this.postQuality >= 2 ? grade.bloomStrength : 0;
    }
  }

  private displayWidth = 0;
  private displayHeight = 0;
  private internalWidth = 0;
  private internalHeight = 0;
  private baseFov = 1.28;

  // --- transient screen state ---------------------------------------------
  private hitMarkerLife = 0;
  private killMarkerLife = 0;
  private damageMarkers: DamageMarker[] = [];
  private damageFlash = 0;
  private shakeX = 0;
  private shakeY = 0;
  /** Smoothed viewmodel sway. */
  private swayX = 0;
  private swayY = 0;
  private viewmodelRecoil = 0;
  private lastAngle = 0;

  // --- weather -------------------------------------------------------------
  /** Conditions the raycaster is currently configured for. */
  private conditionsKey = '';
  /** Mirror of the session's lightning, read once per frame. */
  private lightningFlash = 0;
  /** Rain streaks in screen space: x, y, length, speed per drop. */
  private rain = new Float32Array(0);
  private rainDrops = 0;

  /** Set false to force the software path even where GL works. */
  private glAllowed = true;

  /** The active visual direction. Drives the grade and the weapon finish. */
  private style: VisualStyle = STYLES[DEFAULT_STYLE];

  /**
   * Switch the visual style.
   *
   * Everything downstream reads `this.style` per frame, so there is nothing to
   * rebuild here except the software renderer's tone curves, which are keyed
   * on the grade and notice by themselves.
   */
  setStyle(style: VisualStyle): void {
    this.style = style;
    this.refreshPost();
    setPortraitStyle(style.portrait);
  }

  constructor(container: HTMLElement, preferGL = true) {
    // The world canvas goes in first so the overlay canvas paints above it.
    // Under GL the world is drawn here and the 2D canvas carries only the
    // viewmodel, crosshair and screen effects; without GL this canvas is
    // unused and the 2D one carries everything.
    if (preferGL) {
      this.glCanvas = document.createElement('canvas');
      this.glCanvas.className = 'game-canvas';
      container.appendChild(this.glCanvas);
    }

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas overlay';
    container.appendChild(this.canvas);

    // Transparent only when there is something behind it to show through.
    const ctx = this.canvas.getContext('2d', { alpha: preferGL });
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;

    this.offscreen = document.createElement('canvas');
    const offCtx = this.offscreen.getContext('2d', { alpha: false });
    if (!offCtx) throw new Error('offscreen 2D context unavailable');
    this.offCtx = offCtx;

    this.raycaster = new Raycaster(this.atlas);
    this.buildSprites();

    if (this.glCanvas) {
      this.gl = GLWorldRenderer.create(this.glCanvas, this.atlas);
      if (this.gl) {
        this.gl.registerSprites(this.allSpriteFrames());
      } else {
        // Nothing to show behind the overlay, so take the canvas back out and
        // let the software path own the screen.
        this.glCanvas.remove();
        this.glCanvas = null;
        console.info('[render] WebGL2 unavailable - using the software renderer');
      }
    }
  }

  /** True when the hardware path is active. */
  get usingGL(): boolean {
    return this.gl !== null && !this.gl.failed && this.glAllowed;
  }

  get rendererName(): string {
    return this.usingGL ? this.gl!.rendererName : 'Software';
  }

  /**
   * The canvas the world is actually drawn on.
   *
   * Under GL that is the backing canvas; the 2D one in front holds only the
   * viewmodel and the HUD over a transparent background. Without GL the 2D
   * canvas holds everything. Anything that wants to read the rendered world -
   * the test harnesses do - has to ask rather than guess from the DOM, because
   * a forced-software run still has a GL canvas sitting there, hidden and
   * holding a stale frame.
   */
  get worldCanvas(): HTMLCanvasElement {
    return this.usingGL && this.glCanvas ? this.glCanvas : this.canvas;
  }

  /**
   * Choose a renderer: -1 automatic, 1 force GPU, 0 force software.
   *
   * The GL context is kept alive either way rather than torn down and rebuilt.
   * Recreating it means re-uploading the texture array, the sprite sheet and
   * the world mesh, which is a visible stall, and context creation is the part
   * most likely to fail on the hardware where someone would be reaching for
   * this switch in the first place. Toggling a flag cannot fail.
   *
   * Forcing the GPU path cannot conjure one: if the context never came up,
   * this stays on software.
   */
  setRendererMode(mode: number): void {
    const allowed = mode !== 0;
    if (allowed === this.glAllowed) return;
    this.glAllowed = allowed;
    if (this.glCanvas) this.glCanvas.style.display = allowed ? '' : 'none';
    // The software path has to repaint the full frame from scratch now, and
    // the raycaster's buffers were sized for whichever path was last active.
    this.resize();
  }

  /** Every baked frame, for the GPU sprite sheet. */
  private allSpriteFrames(): SpriteFrame[] {
    const frames: SpriteFrame[] = [];
    for (const sheet of this.sprites.characters.values()) frames.push(...sheet.frames);
    for (const prop of this.sprites.props.values()) frames.push(prop);
    return frames;
  }

  /** Bake every character and prop billboard once at boot. */
  private buildSprites(): void {
    this.sprites.buildCharacter('scavenger', {
      uniform: '#5a5240', vest: '#4a4436', helmet: null, skin: '#a8825e',
      bulk: 0.95, backpack: false, weaponLength: 22,
    });
    this.sprites.buildCharacter('guard', {
      uniform: '#3f4a3c', vest: '#2f3a30', helmet: '#4a4f45', skin: '#a8825e',
      bulk: 1.0, backpack: true, weaponLength: 26,
    });
    this.sprites.buildCharacter('contractor', {
      uniform: '#3a3f46', vest: '#2a2f36', helmet: '#3a3f42', skin: '#9a7454',
      bulk: 1.05, backpack: true, weaponLength: 28,
    });
    this.sprites.buildCharacter('commander', {
      uniform: '#2e3238', vest: '#1f2228', helmet: '#43261f', skin: '#8f6a4a',
      bulk: 1.22, backpack: true, weaponLength: 32,
    }, 1.05);

    for (const id of [
      'supply_crate', 'weapon_crate', 'med_cabinet', 'tool_chest', 'safe',
      'filing_cabinet', 'barrel', 'toolbox', 'duffel', 'corpse', 'weapon_drop',
    ]) {
      this.sprites.buildProp(id, 0.5);
    }
    this.sprites.buildProp('extract_marker', 2.4, 64);
  }

  /** Resize both canvases. `dpr` is capped to keep fill rate sane on phones. */
  resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    const cssWidth = Math.max(320, Math.floor(rect?.width ?? window.innerWidth));
    const cssHeight = Math.max(200, Math.floor(rect?.height ?? window.innerHeight));
    // Two caps, for two different costs.
    //
    // DPR is capped at 2 because beyond that the pixel cost multiplies for no
    // visible gain on a phone held at arm's length. The absolute width cap
    // then bounds the *upscale blit*, which is a full-screen filtered copy
    // every frame: on a 3x 1440p phone an uncapped backing store would spend
    // more time blitting than rendering.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const MAX_BACKING_WIDTH = 1600;
    const effectiveDpr = Math.min(dpr, MAX_BACKING_WIDTH / cssWidth);

    this.displayWidth = Math.floor(cssWidth * effectiveDpr);
    this.displayHeight = Math.floor(cssHeight * effectiveDpr);
    this.canvas.width = this.displayWidth;
    this.canvas.height = this.displayHeight;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    if (this.glCanvas) {
      this.glCanvas.width = this.displayWidth;
      this.glCanvas.height = this.displayHeight;
      this.glCanvas.style.width = `${cssWidth}px`;
      this.glCanvas.style.height = `${cssHeight}px`;
    }

    this.applyRenderScale();
  }

  private applyRenderScale(): void {
    const scale = this.fixedScale > 0 ? this.fixedScale : this.governor.scale;
    const w = Math.max(160, Math.floor(this.displayWidth * scale));
    const h = Math.max(120, Math.floor(this.displayHeight * scale));
    if (w === this.internalWidth && h === this.internalHeight) return;

    this.internalWidth = w;
    this.internalHeight = h;
    this.offscreen.width = w;
    this.offscreen.height = h;
    this.raycaster.resize(w, h);

    // Horizontal FOV derived from aspect so pixels stay square and vertical
    // geometry matches the wall projection exactly.
    this.baseFov = 2 * Math.atan(w / (2 * h));

    // Floor/ceiling casting is the biggest per-pixel cost; drop to every
    // second row once the internal buffer gets large.
    this.raycaster.applySettings({ floorRowStep: w * h > 380000 ? 2 : 1 });
  }

  // =========================================================================
  // Frame
  // =========================================================================

  render(session: RaidSession, dt: number, frameMs: number): void {
    if (this.fixedScale <= 0 && this.governor.sample(frameMs, dt)) {
      this.applyRenderScale();
    }

    this.updateCamera(session);
    this.updateScreenEffects(session, dt);
    this.syncConditions(session);

    const cam = this.camera;
    const flash = session.effects.flash + this.lightningFlash;

    if (this.usingGL) {
      this.renderGL(session, flash);
      this.drawPrecipitation(session);
      this.drawViewmodel(session);
      this.drawCrosshair(session);
      this.drawScreenEffects(session);
      return;
    }

    const horizon = this.raycaster.horizonFor(cam);
    this.raycaster.render(cam, session.map, flash, session.elapsed);

    this.spriteRenderer.begin();
    this.submitSpritesTo(session, this.spriteRenderer);
    const settings = this.raycaster.renderSettings;
    this.spriteRenderer.render(
      cam,
      session.map,
      this.raycaster.pixels,
      this.raycaster.depth,
      this.internalWidth,
      this.internalHeight,
      (d) => this.fogFactor(d, settings.fogDensity, settings.viewDistance),
      {
        r: (settings.fogColor >> 16) & 0xff,
        g: (settings.fogColor >> 8) & 0xff,
        b: settings.fogColor & 0xff,
      },
      settings.exposure,
      flash,
      settings.viewDistance,
      (sx, sy, d) => this.raycaster.beamAt(sx, sy, d, horizon),
    );
    this.raycaster.renderTransparentLayers(cam, horizon, flash);

    // Bloom and tone mapping, on the internal buffer before it is handed to
    // the canvas. Doing it here rather than over the display costs a quarter
    // of the pixels and is the last chance to touch linear-ish values before
    // they are clamped into a bitmap.
    if (this.postQuality > 0) {
      this.post.apply(this.raycaster.pixels, this.internalWidth, this.internalHeight);
    }

    // Blit the internal buffer up to the display.
    this.offCtx.putImageData(this.raycaster.imageData, 0, 0);
    this.drawGrain();
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.offscreen, 0, 0, this.displayWidth, this.displayHeight);

    // Sharp overlays on top.
    this.drawPrecipitation(session);
    this.drawViewmodel(session);
    this.drawCrosshair(session);
    this.drawScreenEffects(session);
  }

  /**
   * The hardware frame.
   *
   * Same camera, same lighting model, same conditions as the software path -
   * the only difference is where the work happens. The 2D overlay canvas is
   * cleared to transparent so the GL world shows through it.
   */
  private renderGL(session: RaidSession, flash: number): void {
    const gl = this.gl;
    if (!gl) return;
    const cam = this.camera;
    const settings = this.raycaster.renderSettings;
    const cond = session.conditions;

    // The GPU path obeys the same render-scale governor as the software one.
    //
    // This matters more here than it looks. The governor exists to hold the
    // frame rate when a device cannot keep up, and it does that by shrinking
    // the resolution the *scene* is rendered at. Sizing the GL targets to the
    // full display would opt the GPU path out of that entirely: on a phone
    // that thermal-throttles mid-raid there would be nothing left to give.
    //
    // Only the scene and bloom targets shrink. The canvas itself stays at
    // display resolution and the composite pass upscales, so the HUD overlay
    // and the crosshair stay sharp - the same arrangement as the software
    // renderer's offscreen buffer and blit.
    gl.resize(this.internalWidth, this.internalHeight, this.displayWidth, this.displayHeight);

    // Geometry is per raid, not per frame. The seed identifies the map, and a
    // blackout changes lighting without changing geometry, so the lightmap is
    // re-uploaded separately whenever the conditions key moves.
    const mapKey = `${session.generated.blueprintId}:${session.generated.seed}`;
    if (mapKey !== this.glMapKey) {
      this.glMapKey = mapKey;
      gl.setMap(session.map);
    } else if (this.lightmapDirty) {
      gl.uploadLightmap(session.map);
    }
    this.lightmapDirty = false;

    // --- sprites ----------------------------------------------------------
    gl.beginSprites();
    this.submitSpritesTo(session, gl);

    // --- the frame --------------------------------------------------------
    const torchRadius = session.torchRadius;
    // Cone half-angles as cosines, matching the software beam.
    const outer = Math.cos(0.42);
    const inner = Math.cos(0.42 * 0.42);
    const health = session.player.health;
    const painVignette = clamp01(
      (1 - clamp01(health.totalHp / health.totalMaxHp)) * 0.9 + health.modifiers.painIntensity * 0.4,
    );

    // The vignette is the one post value the game itself moves: it closes in
    // as the player is hurt. So it is set per frame from the style's base
    // rather than once when the style changes.
    gl.vignette = this.style.grade.vignette + painVignette * 0.9;
    gl.render(session.map, {
      camX: cam.x,
      camY: cam.y,
      camZ: cam.eyeHeight,
      yaw: cam.angle,
      pitch: cam.pitchRad,
      roll: cam.roll,
      // The camera's `fov` is horizontal; the projection wants vertical.
      fovY: 2 * Math.atan(Math.tan(cam.fov / 2) / (this.displayWidth / this.displayHeight)),
      aspect: this.displayWidth / this.displayHeight,
      viewDistance: settings.viewDistance,
      fogColor: cond.fogColor,
      fogDensity: cond.fogDensity,
      skyTop: cond.skyTop,
      skyHorizon: cond.skyHorizon,
      exposure: session.lightMultiplier,
      flash,
      torch: [torchRadius > 0 ? 0.95 : 0, torchRadius * 1.5, inner, outer],
      time: session.elapsed,
      overlay: [0.59, 0.08, 0.06, this.damageFlash * 0.32],
      sunDir: cond.sunDir,
      sunAmount: cond.sunAmount,
    });

    // Clear the overlay so the world is visible through it.
    this.ctx.clearRect(0, 0, this.displayWidth, this.displayHeight);
  }

  /** Set whenever the lightmap changed and the GPU copy is stale. */
  private lightmapDirty = false;

  markLightmapDirty(): void {
    this.lightmapDirty = true;
  }

  /**
   * Push the raid's conditions into the renderer.
   *
   * Cheap to call every frame: the settings rebuild (fog LUT, sky ramp) only
   * runs when something actually changed, which in practice is once per raid
   * plus whenever a blackout switches the power off.
   */
  private syncConditions(session: RaidSession): void {
    const cond = session.conditions;
    const exposure = session.lightMultiplier;
    const torchRadius = session.torchRadius;
    const key = `${cond.label}|${exposure.toFixed(2)}|${torchRadius}`;
    if (key !== this.conditionsKey) {
      this.conditionsKey = key;
      this.lightmapDirty = true;
      this.raycaster.applySettings({
        fogDensity: cond.fogDensity,
        fogColor: cond.fogColor,
        skyTop: cond.skyTop,
        skyHorizon: cond.skyHorizon,
        exposure,
      });
      // Beam reach runs past the lit radius: a torch throws further than it
      // usefully illuminates, and the dim outer spill is what you navigate by.
      this.raycaster.setTorch(torchRadius > 0 ? 0.95 : 0, torchRadius * 1.5);
    }
  }

  /** Mirrors the raycaster's fog curve for sprite shading. */
  private fogFactor(dist: number, density: number, viewDistance: number): number {
    const d = Math.min(dist, viewDistance);
    const f = 1 - Math.exp(-(d * density) * (d * density) * 1.15 - d * density * 0.35);
    return clamp01(f);
  }

  // =========================================================================
  // Camera
  // =========================================================================

  private updateCamera(session: RaidSession): void {
    const player = session.player;
    const controller = session.playerWeapon;
    const cam = this.camera;

    // Lean shifts the eye laterally, which is what makes peeking a corner
    // actually expose less of you.
    const leanOffset = player.lean * 0.34;
    const rightX = -Math.sin(player.angle);
    const rightY = Math.cos(player.angle);

    cam.x = player.x + rightX * leanOffset;
    cam.y = player.y + rightY * leanOffset;

    // Recoil is folded into the aim itself, not applied as a cosmetic shake,
    // so the player genuinely has to bring the muzzle back down.
    cam.angle = player.angle + (controller?.recoilYaw ?? 0);

    const pitchRad = clamp(player.pitch + (controller?.recoilPitch ?? 0), -0.7, 0.7);
    const bob = Math.sin(player.bobPhase) * (player.sprinting ? 5.5 : 3.0) * Math.min(1, player.speed);
    cam.pitch = this.internalHeight * Math.tan(pitchRad) + bob + this.shakeY;
    // The GL path needs the angle, not the scanline offset. Bob and shake are
    // folded back in as an angle so both renderers move identically.
    cam.pitchRad = pitchRad + Math.atan((bob + this.shakeY) / Math.max(1, this.internalHeight));

    cam.eyeHeight = player.eyeHeightTiles;
    cam.roll = player.lean * 0.06;

    // ADS narrows the FOV by the optic's magnification.
    const zoom = controller?.resolved?.zoom ?? 1;
    const adsProgress = controller?.adsProgress ?? 0;
    const effectiveZoom = 1 + (zoom - 1) * adsProgress;
    cam.fov = 2 * Math.atan(Math.tan(this.baseFov / 2) / effectiveZoom);
  }

  private updateScreenEffects(session: RaidSession, dt: number): void {
    const shake = session.effects.shakeAmount;
    if (shake > 0) {
      this.shakeX = fxRng.gaussian(0, shake * 6);
      this.shakeY = fxRng.gaussian(0, shake * 6);
    } else {
      this.shakeX = damp(this.shakeX, 0, 18, dt);
      this.shakeY = damp(this.shakeY, 0, 18, dt);
    }

    if (this.hitMarkerLife > 0) this.hitMarkerLife -= dt;
    if (this.killMarkerLife > 0) this.killMarkerLife -= dt;
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt * 1.8);

    for (let i = this.damageMarkers.length - 1; i >= 0; i--) {
      this.damageMarkers[i].life -= dt;
      if (this.damageMarkers[i].life <= 0) this.damageMarkers.splice(i, 1);
    }

    // Viewmodel sway follows how fast the player is turning, which is what
    // makes a heavy weapon feel heavy.
    const turnDelta = session.player.angle - this.lastAngle;
    this.lastAngle = session.player.angle;
    const targetSwayX = clamp(-turnDelta * 260, -34, 34);
    const targetSwayY = clamp(session.player.speed * 6, 0, 16);
    this.swayX = damp(this.swayX, targetSwayX, 7, dt);
    this.swayY = damp(this.swayY, targetSwayY, 7, dt);
    this.viewmodelRecoil = damp(this.viewmodelRecoil, 0, 9, dt);

    this.updateWeather(session, dt, turnDelta);
  }

  /**
   * Rain and lightning.
   *
   * Precipitation is drawn in screen space on the sharp overlay canvas rather
   * than as world particles: it costs a few hundred line segments instead of
   * thousands of depth-tested sprites, and at phone resolution the difference
   * is invisible. Lightning is *not* cosmetic - it feeds the same additive
   * world light the muzzle flash uses, so a strike genuinely lights the map
   * and briefly shows you what is out there.
   */
  private updateWeather(session: RaidSession, dt: number, turnDelta: number): void {
    const cond = session.conditions;
    // The strike itself is simulated - see RaidSession.updateLightning.
    this.lightningFlash = session.lightning;

    const wanted = cond.precipitation > 0 ? Math.round(220 * cond.precipitation) : 0;
    if (wanted !== this.rainDrops) {
      this.rainDrops = wanted;
      // 4 floats per drop: x, y, length, speed.
      this.rain = new Float32Array(wanted * 4);
      for (let i = 0; i < wanted; i++) {
        this.rain[i * 4] = fxRng.float();
        this.rain[i * 4 + 1] = fxRng.float();
        this.rain[i * 4 + 2] = 0.03 + fxRng.float() * 0.05;
        this.rain[i * 4 + 3] = 1.1 + fxRng.float() * 0.9;
      }
    }

    if (this.rainDrops === 0) return;
    // Turning drags the streaks sideways, which is what sells that they are in
    // the world and not painted on the glass.
    const drift = clamp(-turnDelta * 3.5, -0.4, 0.4);
    for (let i = 0; i < this.rainDrops; i++) {
      const o = i * 4;
      this.rain[o + 1] += this.rain[o + 3] * dt;
      this.rain[o] += drift * dt * 6;
      if (this.rain[o + 1] > 1) {
        this.rain[o + 1] -= 1;
        this.rain[o] = fxRng.float();
      }
      if (this.rain[o] < -0.1) this.rain[o] += 1.2;
      else if (this.rain[o] > 1.1) this.rain[o] -= 1.2;
    }
  }

  // --- external notifications ----------------------------------------------

  onPlayerHit(fromAngleRelative: number): void {
    this.damageMarkers.push({ angle: fromAngleRelative, life: 1.8 });
    this.damageFlash = Math.min(1, this.damageFlash + 0.55);
  }

  onHitConfirmed(killed: boolean): void {
    this.hitMarkerLife = 0.22;
    if (killed) this.killMarkerLife = 0.5;
  }

  onShotFired(recoilStrength: number): void {
    this.viewmodelRecoil = Math.min(1.4, this.viewmodelRecoil + recoilStrength);
  }

  // =========================================================================
  // Sprite submission
  // =========================================================================

  private submitSpritesTo(session: RaidSession, sink: SpriteSink): void {
    const cam = this.camera;

    // --- enemies ------------------------------------------------------------
    for (const enemy of session.ai.enemies) {
      const sheet = this.sprites.characters.get(enemy.tier) as CharacterSheet | undefined;
      if (!sheet) continue;
      if (!enemy.alive) continue;

      const bearing = Math.atan2(enemy.y - cam.y, enemy.x - cam.x);
      const frameIndex = frameIndexFor(sheet, enemy.angle, bearing, enemy.animationPose);
      const frame = sheet.frames[frameIndex];
      // Crouching enemies are physically smaller targets, and look it.
      const heightTiles = (enemy.height / METERS_PER_TILE) * (sheet.worldHeight / 0.92);
      sink.submit(enemy.x, enemy.y, frame, heightTiles);
    }

    // --- containers and corpses ---------------------------------------------
    for (const container of session.loot.containers) {
      const frame = this.sprites.props.get(container.sprite) as SpriteFrame | undefined;
      if (!frame) continue;
      // Searched containers read dimmer so the player can see at a glance
      // what they have already been through.
      const tint = container.searched ? 0x707070 : 0xffffff;
      const heightTiles = container.isCorpse ? 0.24 : 0.5;
      sink.submit(container.x, container.y, frame, heightTiles, 0, tint);
    }

    // --- extraction markers --------------------------------------------------
    const marker = this.sprites.props.get('extract_marker') as SpriteFrame | undefined;
    if (marker) {
      for (const ex of session.extraction.extracts) {
        if (!ex.discovered) continue;
        const tint = ex.available ? 0xffffff : 0x4060a0;
        sink.submit(ex.def.x, ex.def.y, marker, 2.4, 0, tint, ex.available ? 0.85 : 0.4);
      }
    }

    // --- particles, tracers, decals ------------------------------------------
    session.effects.submit(sink);
  }

  // =========================================================================
  // Overlays
  // =========================================================================

  /**
   * Weapon viewmodel.
   *
   * Drawn procedurally per weapon category rather than from art, so a
   * suppressor or an optic that the player fitted actually appears on the
   * silhouette in their hands.
   */
  private drawViewmodel(session: RaidSession): void {
    const controller = session.playerWeapon;
    const weapon = controller?.weapon;
    if (!controller || !weapon) return;

    const def = ItemDB.get(weapon.defId);
    const w = this.displayWidth;
    const h = this.displayHeight;
    const ctx = this.ctx;

    const ads = controller.adsProgress;
    const reloading = controller.isReloading;

    // Hip position is low and to the right; ADS brings it to centre.
    const restX = w * 0.72;
    const restY = h * 0.74;
    const adsX = w * 0.5;
    const adsY = h * 0.6;

    const bob = Math.sin(session.player.bobPhase) * (1 - ads) * 9 * Math.min(1, session.player.speed);
    const reloadDrop = reloading ? h * 0.16 : 0;

    const x = restX + (adsX - restX) * ads + this.swayX * (1 - ads * 0.75);
    const y = restY + (adsY - restY) * ads + bob + this.swayY * (1 - ads * 0.8)
      + reloadDrop + this.viewmodelRecoil * h * 0.035;

    const scale = (h / 720) * (1 - ads * 0.12) * (def.width >= 4 ? 1.25 : 0.85);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((this.swayX * 0.0006) + (reloading ? 0.25 : 0) - this.viewmodelRecoil * 0.05);
    ctx.scale(scale, scale);

    const suppressed = controller.resolved?.suppressed ?? false;
    const hasOptic = !!weapon.attachments?.optic;
    this.drawWeaponSilhouette(ctx, def.category === 'weapon' ? def.weapon!.caliber : '', def.width, suppressed, hasOptic);

    ctx.restore();

    // Muzzle flash at the barrel tip, aligned with the viewmodel.
    if (session.effects.flash > 0.35 && !suppressed) {
      const flashAlpha = clamp01(session.effects.flash);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const fx = x - 150 * scale;
      const fy = y - 44 * scale;
      const grad = ctx.createRadialGradient(fx, fy, 0, fx, fy, 90 * scale);
      grad.addColorStop(0, `rgba(255,230,170,${0.9 * flashAlpha})`);
      grad.addColorStop(0.4, `rgba(255,160,60,${0.45 * flashAlpha})`);
      grad.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(fx, fy, 90 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /** Simple but readable weapon silhouette, assembled from the fitted parts. */
  /**
   * The weapon in the player's hands.
   *
   * Rewritten from flat fills to shaded panels, which is most of the
   * difference between a silhouette and a model. Three things do that work:
   *
   *   - **A vertical gradient on every panel.** A rectangle of one colour
   *     reads as a cut-out no matter how good the outline is. A rectangle that
   *     is lighter at the top reads as a rounded surface under a sky.
   *   - **A rim light along the top edge**, which is what separates the weapon
   *     from whatever is behind it. Without it the gun disappears into a dark
   *     wall, which is exactly when the player most needs to see it.
   *   - **A cast shadow under the receiver**, so the magazine and grip sit
   *     beneath the body rather than beside it.
   *
   * All three come from the style's `WeaponSpec`, so a documentary finish, a
   * high-contrast one and a warm graphic one are the same geometry lit
   * differently rather than three separate drawings to keep in sync.
   */
  private drawWeaponSilhouette(
    ctx: CanvasRenderingContext2D,
    caliber: string,
    widthCells: number,
    suppressed: boolean,
    optic: boolean,
  ): void {
    const long = widthCells >= 4;
    const bodyLength = long ? 170 : 100;
    const w = this.style.weapon;

    /** A panel with a top-lit gradient, an outline, and an optional rim. */
    const panel = (
      x: number, y: number, width: number, height: number, radius: number,
      dark: string, lit: string, rim = false,
    ): void => {
      const g = ctx.createLinearGradient(0, y, 0, y + height);
      // `modelling` is how far apart the two ends of the panel are pushed.
      // Above 1 the top goes past the lit colour, which is what gives the
      // high-contrast styles their hard highlight.
      g.addColorStop(0, mixHex(dark, lit, Math.min(1, 0.85 * w.modelling)));
      g.addColorStop(0.55, mixHex(dark, lit, 0.22 * w.modelling));
      g.addColorStop(1, dark);
      ctx.fillStyle = g;
      roundRectPath(ctx, x, y, width, height, radius);
      ctx.fill();
      if (w.outline) {
        ctx.strokeStyle = w.outline;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (rim && w.rimStrength > 0) {
        ctx.save();
        ctx.globalAlpha = w.rimStrength;
        ctx.strokeStyle = w.rim;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x + radius, y + 0.8);
        ctx.lineTo(x + width - radius, y + 0.8);
        ctx.stroke();
        ctx.restore();
      }
    };

    // Contact shadow first, so everything else sits on top of it.
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#000000';
    roundRectPath(ctx, -bodyLength - 4, -18, bodyLength + 10, 16, 8);
    ctx.fill();
    ctx.restore();

    // Barrel and suppressor, behind the receiver.
    panel(-bodyLength - (long ? 62 : 26), -46, long ? 62 : 26, 13, 2,
      w.metal, w.metalLit, true);
    if (suppressed) {
      panel(-bodyLength - (long ? 118 : 76), -52, 58, 24, 8,
        w.metal, w.metalLit, true);
    }

    // Handguard.
    panel(-bodyLength - 8, -48, long ? 78 : 40, 22, 4,
      w.furniture, w.furnitureLit, true);

    // Magazine. The tilt implies calibre without needing a label.
    ctx.save();
    ctx.translate(-bodyLength * 0.42, -20);
    ctx.rotate(0.16);
    panel(-13, 0, 26, long ? 62 : 34, 3, w.metal, w.metalLit);
    ctx.restore();

    // Grip.
    ctx.save();
    ctx.translate(-bodyLength * 0.1, -20);
    ctx.rotate(0.3);
    panel(-11, 0, 22, 48, 5, w.furniture, w.furnitureLit);
    ctx.restore();

    // Stock.
    if (long) panel(-8, -50, 62, 30, 6, w.furniture, w.furnitureLit, true);

    // Receiver last of the body, so it reads as the frontmost plane.
    panel(-bodyLength, -54, bodyLength, 34, 5, w.metal, w.metalLit, true);

    // Selector marking: a small painted detail at the natural focal point of
    // the shape. It is the one place a spot of the style's accent colour reads
    // as a marking on the weapon rather than as a light on it.
    ctx.fillStyle = w.detail;
    ctx.fillRect(-bodyLength * 0.30, -32, 9, 3);
    ctx.fillRect(-bodyLength * 0.30, -26, 5, 3);

    // Optic or iron sights.
    if (optic) {
      panel(-bodyLength * 0.72, -84, 74, 30, 6, w.metal, w.metalLit, true);
      // Objective glass, tinted towards the rim colour so the coating reads.
      const glass = ctx.createLinearGradient(0, -78, 0, -60);
      glass.addColorStop(0, mixHex(w.metal, w.rim, 0.5));
      glass.addColorStop(1, mixHex(w.metal, w.rim, 0.12));
      ctx.fillStyle = glass;
      ctx.fillRect(-bodyLength * 0.72 + 6, -78, 62, 18);
    } else {
      ctx.fillStyle = w.outline || w.metal;
      ctx.fillRect(-bodyLength * 0.95, -66, 5, 14);
      ctx.fillRect(-bodyLength * 0.12, -66, 5, 14);
    }

    // Hands. Lit from the same direction as the weapon.
    const handG = ctx.createLinearGradient(0, -10, 0, 24);
    handG.addColorStop(0, '#a9805d');
    handG.addColorStop(1, '#6d5138');
    ctx.fillStyle = handG;
    ctx.beginPath();
    ctx.ellipse(-bodyLength * 0.08, 6, 22, 17, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-bodyLength - (long ? 4 : -14), -22, 20, 15, -0.2, 0, Math.PI * 2);
    ctx.fill();

    void caliber;
  }

  /**
   * Dynamic crosshair sized by the weapon's *actual* current dispersion.
   * The reticle is therefore never a lie: if it is wide, your rounds are going
   * where it says they might.
   */
  private drawCrosshair(session: RaidSession): void {
    const controller = session.playerWeapon;
    if (!controller?.resolved) return;
    const ctx = this.ctx;
    const w = this.displayWidth;
    const h = this.displayHeight;
    const cx = w * 0.5;
    const cy = h * 0.5;

    const ads = controller.adsProgress;
    const spread = session.playerSpread;
    // Convert the cone half-angle to pixels using the vertical focal length.
    const focal = this.displayHeight;
    const radius = clamp(Math.tan(spread) * focal, 3, h * 0.35);

    ctx.save();
    ctx.lineWidth = Math.max(1.5, h * 0.0022);
    ctx.strokeStyle = `rgba(220,235,225,${0.55 + 0.25 * (1 - ads)})`;

    if (ads > 0.85 && (controller.resolved.zoom > 1.5)) {
      // Magnified optic: a fine reticle rather than a hip-fire cone.
      ctx.beginPath();
      ctx.moveTo(cx - h * 0.06, cy);
      ctx.lineTo(cx - h * 0.012, cy);
      ctx.moveTo(cx + h * 0.012, cy);
      ctx.lineTo(cx + h * 0.06, cy);
      ctx.moveTo(cx, cy - h * 0.06);
      ctx.lineTo(cx, cy - h * 0.012);
      ctx.moveTo(cx, cy + h * 0.012);
      ctx.lineTo(cx, cy + h * 0.06);
      ctx.stroke();
      ctx.fillStyle = 'rgba(230,90,70,0.9)';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1.5, h * 0.0025), 0, Math.PI * 2);
      ctx.fill();
    } else {
      const gap = radius;
      const len = h * 0.018;
      ctx.beginPath();
      ctx.moveTo(cx - gap - len, cy);
      ctx.lineTo(cx - gap, cy);
      ctx.moveTo(cx + gap, cy);
      ctx.lineTo(cx + gap + len, cy);
      ctx.moveTo(cx, cy - gap - len);
      ctx.lineTo(cx, cy - gap);
      ctx.moveTo(cx, cy + gap);
      ctx.lineTo(cx, cy + gap + len);
      ctx.stroke();
    }

    // Hit and kill confirmation.
    if (this.hitMarkerLife > 0) {
      const a = clamp01(this.hitMarkerLife / 0.22);
      ctx.strokeStyle = this.killMarkerLife > 0 ? `rgba(235,80,60,${a})` : `rgba(255,255,255,${a})`;
      ctx.lineWidth = Math.max(2, h * 0.003);
      const r1 = h * 0.012;
      const r2 = h * 0.026;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        ctx.moveTo(cx + sx * r1, cy + sy * r1);
        ctx.lineTo(cx + sx * r2, cy + sy * r2);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Film grain.
   *
   * A tile of noise is baked once and blitted over the frame at a random
   * offset. The honest way would be per-pixel noise every frame, which on a
   * 1280x600 buffer is 768 000 random numbers and a visible slice of the frame
   * budget; this is one drawImage and looks the same in motion.
   *
   * It matters more than it sounds on a software renderer: flat untextured
   * gradients are the tell that a frame was computed rather than captured, and
   * a little uniform noise across everything is what photographic images have
   * and synthetic ones do not.
   */
  private grainTile: HTMLCanvasElement | null = null;

  private buildGrain(): HTMLCanvasElement {
    const size = 128;
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const ctx = tile.getContext('2d');
    if (!ctx) return tile;
    const image = ctx.createImageData(size, size);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = 128 + (Math.random() - 0.5) * 90;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return tile;
  }

  private drawGrain(): void {
    if (!this.grainTile) this.grainTile = this.buildGrain();
    // Applied to the *internal* buffer, not the display. Two reasons: it is a
    // quarter of the pixels at typical render scales, and `overlay` is an
    // expensive blend in software - the same pass on the display buffer cost
    // roughly a third of the frame budget. Upscaling the grain with the frame
    // also reads more like film than pin-sharp noise over a soft image.
    const ctx = this.offCtx;
    const w = this.internalWidth;
    const h = this.internalHeight;
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.07;
    const tile = this.grainTile;
    const tw = tile.width;
    const th = tile.height;
    const ox = -Math.floor(Math.random() * tw);
    const oy = -Math.floor(Math.random() * th);
    for (let y = oy; y < h; y += th) {
      for (let x = ox; x < w; x += tw) {
        ctx.drawImage(tile, x, y);
      }
    }
    ctx.restore();
  }

  /** Rain streaks over the finished frame. */
  private drawPrecipitation(session: RaidSession): void {
    if (this.rainDrops === 0) return;
    const ctx = this.ctx;
    const w = this.displayWidth;
    const h = this.displayHeight;
    const heavy = session.conditions.precipitation > 0.8;

    ctx.save();
    ctx.strokeStyle = heavy ? 'rgba(186,204,220,0.30)' : 'rgba(178,196,212,0.22)';
    ctx.lineWidth = Math.max(1, h * 0.0016);
    ctx.beginPath();
    for (let i = 0; i < this.rainDrops; i++) {
      const o = i * 4;
      const x = this.rain[o] * w;
      const y = this.rain[o + 1] * h;
      const len = this.rain[o + 2] * h;
      // Slight lean so the streaks read as falling, not as static scratches.
      ctx.moveTo(x, y);
      ctx.lineTo(x + len * 0.16, y + len);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Vignette, pain desaturation, damage flash and directional indicators. */
  private drawScreenEffects(session: RaidSession): void {
    const ctx = this.ctx;
    const w = this.displayWidth;
    const h = this.displayHeight;
    const health = session.player.health;

    // Lightning washes the whole frame a moment after it lights the world.
    if (this.lightningFlash > 0.02) {
      ctx.fillStyle = `rgba(196,214,236,${Math.min(0.42, this.lightningFlash * 0.3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    // Low health closes the frame in - a readable signal without a number.
    const healthFraction = clamp01(health.totalHp / health.totalMaxHp);
    const pain = health.modifiers.painIntensity;
    const vignette = clamp01((1 - healthFraction) * 0.9 + pain * 0.4);

    if (vignette > 0.02) {
      const grad = ctx.createRadialGradient(w * 0.5, h * 0.5, h * 0.25, w * 0.5, h * 0.5, h * 0.78);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, `rgba(46,4,4,${vignette * 0.85})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    if (this.damageFlash > 0.01) {
      ctx.fillStyle = `rgba(150,20,16,${this.damageFlash * 0.32})`;
      ctx.fillRect(0, 0, w, h);
    }

    // Stamina exhaustion darkens the edges and blurs the breath rhythm.
    if (session.player.stamina < 25) {
      const t = 1 - session.player.stamina / 25;
      const pulse = 0.5 + 0.5 * Math.sin(session.elapsed * 6);
      ctx.fillStyle = `rgba(0,0,0,${t * 0.18 * pulse})`;
      ctx.fillRect(0, 0, w, h);
    }

    // Directional damage indicators.
    if (this.damageMarkers.length > 0) {
      ctx.save();
      ctx.translate(w * 0.5, h * 0.5);
      for (const marker of this.damageMarkers) {
        const alpha = clamp01(marker.life / 1.8);
        const relative = marker.angle - session.player.angle;
        ctx.save();
        ctx.rotate(relative + Math.PI / 2);
        const radius = h * 0.24;
        ctx.strokeStyle = `rgba(220,60,45,${alpha * 0.85})`;
        ctx.lineWidth = Math.max(3, h * 0.006);
        ctx.beginPath();
        ctx.arc(0, 0, radius, -Math.PI / 2 - 0.28, -Math.PI / 2 + 0.28);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }

    // Extraction progress ring.
    const active = session.extraction.activeExtract;
    if (active) {
      const progress = clamp01(active.holdProgress / active.def.holdSeconds);
      ctx.save();
      ctx.translate(w * 0.5, h * 0.72);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(5, h * 0.011);
      ctx.beginPath();
      ctx.arc(0, 0, h * 0.06, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(120,235,170,0.95)';
      ctx.beginPath();
      ctx.arc(0, 0, h * 0.06, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Internal resolution, exposed for the debug overlay. */
  get internalResolution(): string {
    return `${this.internalWidth}x${this.internalHeight}`;
  }
}

/** Blend two #rrggbb colours. `t` of 0 is `a`, 1 is `b`. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 0xff) + (((pb >> 16) & 0xff) - ((pa >> 16) & 0xff)) * t);
  const g = Math.round(((pa >> 8) & 0xff) + (((pb >> 8) & 0xff) - ((pa >> 8) & 0xff)) * t);
  const bl = Math.round((pa & 0xff) + ((pb & 0xff) - (pa & 0xff)) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
