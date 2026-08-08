/**
 * Sprites - procedural billboard generation.
 *
 * All characters and props are drawn at boot with the Canvas 2D API and then
 * baked into flat ABGR arrays the software renderer can sample. Nothing is
 * loaded from disk, so the whole game ships as one JS bundle and every asset is
 * original by construction.
 *
 * Characters are generated as 8 facing directions x 4 animation poses. The
 * renderer picks a frame from the angle between the camera and the actor's own
 * facing, which is what sells "that guy has his back to me" - the single most
 * important read in a tense extraction shooter.
 *
 * Unity port note: this file is replaced by real rigged meshes. The frame
 * selection logic (direction index from relative angle) is not needed there.
 */

export interface SpriteFrame {
  width: number;
  height: number;
  /** ABGR pixels, length width*height. Alpha 0 = transparent. */
  pixels: Uint32Array;
  /** Tight bounds of non-transparent pixels, used to skip empty scanlines. */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface CharacterSheet {
  /** frames[direction * POSE_COUNT + pose] */
  frames: SpriteFrame[];
  directions: number;
  poses: number;
  /** World height in tiles this sprite should occupy. */
  worldHeight: number;
}

export const SPRITE_DIRECTIONS = 8;
export const SPRITE_POSES = 4; // 0 idle, 1 walk A, 2 walk B, 3 firing

const SPR_W = 48;
const SPR_H = 72;

export interface CharacterStyle {
  /** Base fatigues colour. */
  uniform: string;
  /** Load-bearing vest / plate carrier. */
  vest: string;
  /** Helmet or headwear; null = bare head. */
  helmet: string | null;
  skin: string;
  /** Scale multiplier - bosses read as physically larger. */
  bulk: number;
  /** Adds a backpack silhouette. */
  backpack: boolean;
  /** Weapon silhouette length in pixels. */
  weaponLength: number;
}

/** Draws one articulated humanoid frame into a 2D context. */
function drawHumanoid(
  ctx: CanvasRenderingContext2D,
  style: CharacterStyle,
  direction: number,
  pose: number,
): void {
  const cx = SPR_W / 2;
  const bulk = style.bulk;
  // Facing angle relative to viewer: 0 = facing away, PI = facing us.
  const ang = (direction / SPRITE_DIRECTIONS) * Math.PI * 2;
  const facingUs = -Math.cos(ang); // 1 when looking at camera
  const sideness = Math.sin(ang); // -1..1, how much we see the profile

  // Perspective foreshortening: a body seen edge-on is narrower.
  const bodyW = (13 + 5 * Math.abs(facingUs)) * bulk;
  const shoulderW = (17 + 4 * Math.abs(facingUs)) * bulk;

  const legPhase = pose === 1 ? 1 : pose === 2 ? -1 : 0;

  const hipY = 46;
  const shoulderY = 24;
  const headY = 15;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // --- legs ---------------------------------------------------------------
  ctx.strokeStyle = shadeColor(style.uniform, -0.18);
  ctx.lineWidth = 5.4 * bulk;
  for (const sign of [-1, 1]) {
    const swing = legPhase * sign * 5;
    ctx.beginPath();
    ctx.moveTo(cx + sign * 3.4 * bulk, hipY);
    ctx.lineTo(cx + sign * 3.4 * bulk + swing * 0.4, hipY + 10);
    ctx.lineTo(cx + sign * 3.2 * bulk + swing, SPR_H - 6);
    ctx.stroke();
  }
  // Boots
  ctx.fillStyle = '#1d1b19';
  for (const sign of [-1, 1]) {
    const swing = legPhase * sign * 5;
    ctx.fillRect(cx + sign * 3.2 * bulk + swing - 3.4, SPR_H - 8, 6.8, 5);
  }

  // --- backpack (drawn behind the torso when facing away) -----------------
  if (style.backpack && facingUs < 0.35) {
    ctx.fillStyle = shadeColor(style.vest, -0.3);
    roundRect(ctx, cx - bodyW * 0.62, shoulderY + 1, bodyW * 1.24, 20 * bulk, 3);
    ctx.fill();
  }

  // --- torso --------------------------------------------------------------
  const torsoGrad = ctx.createLinearGradient(cx - bodyW / 2, 0, cx + bodyW / 2, 0);
  torsoGrad.addColorStop(0, shadeColor(style.uniform, -0.28));
  torsoGrad.addColorStop(0.45, style.uniform);
  torsoGrad.addColorStop(1, shadeColor(style.uniform, -0.4));
  ctx.fillStyle = torsoGrad;
  roundRect(ctx, cx - bodyW / 2, shoulderY, bodyW, hipY - shoulderY + 3, 3.5);
  ctx.fill();

  // --- plate carrier ------------------------------------------------------
  const vestGrad = ctx.createLinearGradient(cx - bodyW / 2, 0, cx + bodyW / 2, 0);
  vestGrad.addColorStop(0, shadeColor(style.vest, -0.3));
  vestGrad.addColorStop(0.4, style.vest);
  vestGrad.addColorStop(1, shadeColor(style.vest, -0.45));
  ctx.fillStyle = vestGrad;
  roundRect(ctx, cx - bodyW * 0.46, shoulderY + 2, bodyW * 0.92, 17 * bulk, 2.5);
  ctx.fill();
  // Magazine pouches read as horizontal blocks on the front only.
  if (facingUs > 0.2) {
    ctx.fillStyle = shadeColor(style.vest, -0.55);
    for (let i = -1; i <= 1; i++) {
      ctx.fillRect(cx + i * 4.6 * bulk - 1.8, shoulderY + 11 * bulk, 3.6, 6);
    }
  }

  // --- shoulders / arms ---------------------------------------------------
  ctx.strokeStyle = shadeColor(style.uniform, -0.1);
  ctx.lineWidth = 4.4 * bulk;
  const aiming = pose === 3 || Math.abs(facingUs) > 0.6;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + sign * shoulderW * 0.42, shoulderY + 3);
    if (aiming && sign > 0) {
      // Weapon-side arm comes forward across the chest.
      ctx.lineTo(cx + sign * shoulderW * 0.32 + sideness * 3, shoulderY + 13);
      ctx.lineTo(cx + sign * 3 + sideness * 6, shoulderY + 16);
    } else {
      const swing = -legPhase * sign * 3;
      ctx.lineTo(cx + sign * shoulderW * 0.5, shoulderY + 12 + swing);
      ctx.lineTo(cx + sign * shoulderW * 0.46, shoulderY + 21 + swing);
    }
    ctx.stroke();
  }

  // --- head ---------------------------------------------------------------
  ctx.fillStyle = style.skin;
  ctx.beginPath();
  ctx.ellipse(cx + sideness * 1.2, headY, 5.4 * bulk, 6.2 * bulk, 0, 0, Math.PI * 2);
  ctx.fill();
  // Face features only when we can actually see the front of the head.
  if (facingUs > 0.35) {
    ctx.fillStyle = 'rgba(20,18,16,0.75)';
    ctx.fillRect(cx - 3.4 + sideness * 1.2, headY - 1.4, 6.8, 2.6);
  }
  if (style.helmet) {
    const helmGrad = ctx.createLinearGradient(cx - 7, headY - 8, cx + 7, headY + 2);
    helmGrad.addColorStop(0, shadeColor(style.helmet, 0.14));
    helmGrad.addColorStop(1, shadeColor(style.helmet, -0.35));
    ctx.fillStyle = helmGrad;
    ctx.beginPath();
    ctx.ellipse(cx + sideness * 1.2, headY - 1.6, 6.6 * bulk, 6.4 * bulk, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(cx - 6.6 * bulk + sideness * 1.2, headY - 2.4, 13.2 * bulk, 3);
  }

  // --- weapon -------------------------------------------------------------
  // Held across the body; length foreshortens as the actor turns away.
  const wLen = style.weaponLength * (0.42 + 0.58 * Math.abs(sideness) + 0.25 * Math.max(0, facingUs));
  const wy = shoulderY + 15;
  const wx = cx + sideness * 4;
  ctx.strokeStyle = '#26241f';
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(wx - Math.sign(sideness || 1) * wLen * 0.28, wy + 2);
  ctx.lineTo(wx + Math.sign(sideness || 1) * wLen * 0.72, wy - 1);
  ctx.stroke();
  // Magazine
  ctx.fillStyle = '#1b1a17';
  ctx.fillRect(wx - 1.6, wy + 1, 3.4, 6);
}

/** Container / prop drawing routines - single frame, viewed from any angle. */
type PropDrawer = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

const PROP_DRAWERS: Record<string, PropDrawer> = {
  supply_crate: (ctx, w, h) => {
    boxBody(ctx, w * 0.14, h * 0.42, w * 0.72, h * 0.5, '#8a6d3f', '#5d492a');
    ctx.fillStyle = '#c9a94f';
    ctx.fillRect(w * 0.2, h * 0.56, w * 0.6, h * 0.05);
  },
  weapon_crate: (ctx, w, h) => {
    boxBody(ctx, w * 0.08, h * 0.5, w * 0.84, h * 0.42, '#424b3a', '#272e22');
    ctx.strokeStyle = '#8f9a7a';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(w * 0.14, h * 0.55, w * 0.72, h * 0.3);
    ctx.fillStyle = '#b8a33c';
    ctx.fillRect(w * 0.4, h * 0.5, w * 0.2, h * 0.04);
  },
  med_cabinet: (ctx, w, h) => {
    boxBody(ctx, w * 0.22, h * 0.22, w * 0.56, h * 0.72, '#d8dde0', '#96a0a6');
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(w * 0.44, h * 0.36, w * 0.12, h * 0.28);
    ctx.fillRect(w * 0.36, h * 0.44, w * 0.28, h * 0.12);
  },
  tool_chest: (ctx, w, h) => {
    boxBody(ctx, w * 0.16, h * 0.44, w * 0.68, h * 0.48, '#b04a2a', '#6d2c18');
    ctx.fillStyle = '#2f2f31';
    for (let i = 0; i < 3; i++) ctx.fillRect(w * 0.22, h * (0.52 + i * 0.12), w * 0.56, h * 0.04);
  },
  safe: (ctx, w, h) => {
    boxBody(ctx, w * 0.24, h * 0.4, w * 0.52, h * 0.54, '#4a4f55', '#23262a');
    ctx.strokeStyle = '#c8b46a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.67, w * 0.1, 0, Math.PI * 2);
    ctx.stroke();
  },
  filing_cabinet: (ctx, w, h) => {
    boxBody(ctx, w * 0.28, h * 0.16, w * 0.44, h * 0.78, '#7d8489', '#4a5054');
    ctx.fillStyle = '#3a3f42';
    for (let i = 0; i < 4; i++) ctx.fillRect(w * 0.34, h * (0.24 + i * 0.18), w * 0.32, h * 0.03);
  },
  barrel: (ctx, w, h) => {
    const grad = ctx.createLinearGradient(w * 0.28, 0, w * 0.72, 0);
    grad.addColorStop(0, '#2f6b4a');
    grad.addColorStop(0.4, '#4c9c6f');
    grad.addColorStop(1, '#1f4530');
    ctx.fillStyle = grad;
    ctx.fillRect(w * 0.3, h * 0.36, w * 0.4, h * 0.58);
    ctx.fillStyle = '#173525';
    ctx.fillRect(w * 0.3, h * 0.5, w * 0.4, h * 0.04);
    ctx.fillRect(w * 0.3, h * 0.76, w * 0.4, h * 0.04);
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.36, w * 0.2, h * 0.05, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#5fb383';
    ctx.fill();
  },
  toolbox: (ctx, w, h) => {
    boxBody(ctx, w * 0.24, h * 0.62, w * 0.52, h * 0.3, '#b5443a', '#6d241e');
    ctx.strokeStyle = '#2a2a2c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.6, w * 0.1, Math.PI, 0);
    ctx.stroke();
  },
  duffel: (ctx, w, h) => {
    ctx.fillStyle = '#3e4a3a';
    roundRect(ctx, w * 0.16, h * 0.62, w * 0.68, h * 0.28, 8);
    ctx.fill();
    ctx.strokeStyle = '#232a20';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.62, w * 0.14, Math.PI, 0);
    ctx.stroke();
  },
  corpse: (ctx, w, h) => {
    ctx.fillStyle = '#3a3d33';
    roundRect(ctx, w * 0.1, h * 0.74, w * 0.8, h * 0.16, 6);
    ctx.fill();
    ctx.fillStyle = '#8d6f57';
    ctx.beginPath();
    ctx.ellipse(w * 0.2, h * 0.78, w * 0.08, h * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
    // Pooled blood grounds the corpse and reads instantly as lootable.
    ctx.fillStyle = 'rgba(96,14,14,0.55)';
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.9, w * 0.42, h * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
  },
  weapon_drop: (ctx, w, h) => {
    ctx.strokeStyle = '#33312b';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(w * 0.2, h * 0.84);
    ctx.lineTo(w * 0.8, h * 0.78);
    ctx.stroke();
    ctx.fillStyle = '#1d1c19';
    ctx.fillRect(w * 0.44, h * 0.82, w * 0.08, h * 0.1);
  },
  extract_marker: (ctx, w, h) => {
    // A tall luminous column: readable through fog from across the map.
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, 'rgba(120,255,180,0.85)');
    grad.addColorStop(0.6, 'rgba(120,255,180,0.28)');
    grad.addColorStop(1, 'rgba(120,255,180,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(w * 0.38, 0, w * 0.24, h);
    ctx.fillStyle = 'rgba(190,255,220,0.9)';
    ctx.fillRect(w * 0.46, h * 0.1, w * 0.08, h * 0.9);
  },
};

export class SpriteLibrary {
  readonly characters = new Map<string, CharacterSheet>();
  readonly props = new Map<string, SpriteFrame>();

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SPR_W;
    this.canvas.height = SPR_H;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D context unavailable - cannot bake sprites');
    this.ctx = ctx;
  }

  /** Bake a character archetype into all direction/pose frames. */
  buildCharacter(id: string, style: CharacterStyle, worldHeight = 0.92): CharacterSheet {
    const frames: SpriteFrame[] = [];
    for (let dir = 0; dir < SPRITE_DIRECTIONS; dir++) {
      for (let pose = 0; pose < SPRITE_POSES; pose++) {
        this.ctx.clearRect(0, 0, SPR_W, SPR_H);
        drawHumanoid(this.ctx, style, dir, pose);
        frames.push(this.capture(SPR_W, SPR_H));
      }
    }
    const sheet: CharacterSheet = { frames, directions: SPRITE_DIRECTIONS, poses: SPRITE_POSES, worldHeight };
    this.characters.set(id, sheet);
    return sheet;
  }

  buildProp(id: string, worldHeight = 0.5, size = 48): SpriteFrame {
    const drawer = PROP_DRAWERS[id];
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx.clearRect(0, 0, size, size);
    if (drawer) drawer(this.ctx, size, size);
    const frame = this.capture(size, size);
    this.canvas.width = SPR_W;
    this.canvas.height = SPR_H;
    (frame as SpriteFrame & { worldHeight?: number }).worldHeight = worldHeight;
    this.props.set(id, frame);
    return frame;
  }

  /** Read the canvas back into a tightly-bounded ABGR frame. */
  private capture(w: number, h: number): SpriteFrame {
    const img = this.ctx.getImageData(0, 0, w, h);
    const pixels = new Uint32Array(img.data.buffer.slice(0));
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((pixels[y * w + x] >>> 24) > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      minX = 0;
      maxX = w - 1;
      minY = 0;
      maxY = h - 1;
    }
    return { width: w, height: h, pixels, minX, maxX, minY, maxY };
  }
}

/** Pick the animation frame for a sprite given camera and actor headings. */
export function frameIndexFor(
  sheet: CharacterSheet,
  actorAngle: number,
  cameraToActorAngle: number,
  pose: number,
): number {
  // Relative bearing: 0 means we are looking at the actor's back.
  let rel = actorAngle - cameraToActorAngle;
  rel = ((rel % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const dir = Math.round((rel / (Math.PI * 2)) * sheet.directions) % sheet.directions;
  const p = pose < 0 ? 0 : pose >= sheet.poses ? sheet.poses - 1 : pose;
  return dir * sheet.poses + p;
}

// --- small drawing helpers ------------------------------------------------

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Box with a lit left face and a dark right face - cheap volume cue. */
function boxBody(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  light: string,
  dark: string,
): void {
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, light);
  grad.addColorStop(0.55, shadeColor(light, -0.12));
  grad.addColorStop(1, dark);
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(x, y, w, Math.max(1, h * 0.06));
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(x, y + h - Math.max(1, h * 0.06), w, Math.max(1, h * 0.06));
}

/** Lighten (amount > 0) or darken (amount < 0) a hex colour string. */
function shadeColor(hex: string, amount: number): string {
  const c = hex.replace('#', '');
  const num = parseInt(c, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  if (amount >= 0) {
    r += (255 - r) * amount;
    g += (255 - g) * amount;
    b += (255 - b) * amount;
  } else {
    r *= 1 + amount;
    g *= 1 + amount;
    b *= 1 + amount;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
