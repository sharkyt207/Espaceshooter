/**
 * Portraits - the traders, drawn as people.
 *
 * There are no image files in this project, so these faces are constructed at
 * runtime from paths and gradients. The obvious way to do that badly is to
 * attempt photorealism with beziers and land in the uncanny valley; the way
 * that works is to commit to a *treatment* and let the treatment carry the
 * realism.
 *
 * The treatment here is a surveillance dossier photograph: hard side light
 * from one edge, deep shadow on the other, then the whole thing pushed
 * through a two-colour ramp and dusted with grain and scanlines. Grain is not
 * decoration - it is what makes a drawn face read as a photograph of a face.
 * Every small imperfection in the geometry becomes sensor noise instead of a
 * mistake.
 *
 * Anatomy is built in one pass over a set of proportions rather than
 * hand-placed per character, so the four traders are recognisably drawn by the
 * same hand and differ where people actually differ: bone structure, weight,
 * age, hair, what they wear and how they hold their head.
 *
 * All four are original characters written for this project. No likeness of
 * any real person is used or intended.
 */

import { DEFAULT_STYLE, STYLES, type PortraitSpec } from './Style';

export interface FaceSpec {
  /** Base skin tone, before lighting. */
  skin: string;
  /** Cool shadow tone; the lit side is derived from `skin`. */
  shadow: string;
  hair: string;
  /** 0 = shaved, 1 = long. */
  hairLength: number;
  /** 0 = clean shaven, 1 = full beard. */
  beard: number;
  /** Overall face width, 1 = average. */
  width: number;
  /** Jaw squareness, 0 = tapered, 1 = square. */
  jaw: number;
  /** 0 = young, 1 = heavily lined. */
  age: number;
  /** Head tilt in radians; small values read as attitude. */
  tilt: number;
  clothing: string;
  collar: 'coat' | 'apron' | 'jacket' | 'harness';
  /** Optional headwear. */
  hat: 'none' | 'cap' | 'beanie' | 'hood';
  glasses: boolean;
  /** A scar across one brow. */
  scar: boolean;
  /** Duotone target for the lit end of the ramp. */
  tint: string;
}

export const PORTRAIT_W = 220;
export const PORTRAIT_H = 264;

// ===========================================================================
// Colour helpers
// ===========================================================================

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return `rgb(${r},${g},${bl})`;
}

/** Deterministic noise so a given face is identical every time it is drawn. */
function hashNoise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ===========================================================================
// Drawing
// ===========================================================================

/**
 * Draw one portrait into a fresh canvas.
 *
 * Order matters and mirrors how a face is actually lit: silhouette first, then
 * the light, then the features that the light reveals, then the treatment over
 * everything.
 */
export function drawPortrait(
  spec: FaceSpec,
  seed: number,
  portraitStyle: PortraitSpec = STYLES[DEFAULT_STYLE].portrait,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = PORTRAIT_W;
  canvas.height = PORTRAIT_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const rng = hashNoise(seed);
  const w = PORTRAIT_W;
  const h = PORTRAIT_H;

  // Geometry. The head is an oval with a jaw built onto it, sized so the
  // shoulders reach the bottom edge and the crown sits a little below the top -
  // the framing of an identification photograph, not a portrait.
  const cx = w * 0.5;
  const cy = h * 0.44;
  const headW = w * 0.30 * spec.width;
  const headH = h * 0.25;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(spec.tilt);
  ctx.translate(-cx, -cy);

  // Sub-pixel asymmetry. Faces are never symmetrical, and a perfectly mirrored
  // one reads as manufactured no matter how good the rest is.
  const jitter = (scale: number): number => (rng() - 0.5) * scale;

  drawBackdrop(ctx, w, h, spec);
  drawShoulders(ctx, spec, cx, cy, headW, headH, h);
  drawNeck(ctx, spec, cx, cy, headW, headH);
  const headPath = buildHeadPath(cx, cy, headW, headH, spec.jaw);
  drawHead(ctx, spec, headPath, cx, cy, headW, headH);
  drawSkinTexture(ctx, headPath, cx, cy, headW, headH, rng);
  drawEars(ctx, spec, cx, cy, headW, headH);
  drawBrowAndEyes(ctx, spec, cx, cy, headW, headH, jitter);
  drawNose(ctx, spec, cx, cy, headW, headH);
  drawMouth(ctx, spec, cx, cy, headW, headH);
  if (spec.beard > 0.05) drawBeard(ctx, spec, headPath, cx, cy, headW, headH, rng);
  drawHair(ctx, spec, cx, cy, headW, headH, rng);
  if (spec.hat !== 'none') drawHat(ctx, spec, cx, cy, headW, headH);
  if (spec.glasses) drawGlasses(ctx, spec, cx, cy, headW, headH);
  if (spec.scar) drawScar(ctx, cx, cy, headW, headH);
  drawKeyLight(ctx, spec, headPath, cx, cy, headW, headH);

  ctx.restore();

  applyTreatment(ctx, w, h, spec, rng, portraitStyle);
  return canvas;
}

function drawBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, spec: FaceSpec): void {
  const grad = ctx.createRadialGradient(w * 0.5, h * 0.38, w * 0.1, w * 0.5, h * 0.5, w * 0.85);
  grad.addColorStop(0, mix('#1a1f26', spec.tint, 0.1));
  grad.addColorStop(1, '#080a0d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

/** Head outline: a skull oval blended into a jaw whose taper is a parameter. */
function buildHeadPath(cx: number, cy: number, hw: number, hh: number, jaw: number): Path2D {
  const p = new Path2D();
  const jawW = hw * (0.62 + jaw * 0.30);
  const chinY = cy + hh * 1.02;
  const cheekY = cy + hh * 0.34;

  p.moveTo(cx - hw, cy - hh * 0.1);
  // Skull.
  p.bezierCurveTo(cx - hw, cy - hh * 1.05, cx + hw, cy - hh * 1.05, cx + hw, cy - hh * 0.1);
  // Right cheek into the jaw.
  p.bezierCurveTo(cx + hw, cheekY, cx + jawW, chinY - hh * 0.22, cx + jawW * 0.42, chinY);
  // Chin.
  p.bezierCurveTo(cx + jawW * 0.16, chinY + hh * 0.05, cx - jawW * 0.16, chinY + hh * 0.05, cx - jawW * 0.42, chinY);
  // Left jaw back up.
  p.bezierCurveTo(cx - jawW, chinY - hh * 0.22, cx - hw, cheekY, cx - hw, cy - hh * 0.1);
  p.closePath();
  return p;
}

function drawHead(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  head: Path2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
): void {
  // Base tone, then a lateral ramp: light from the upper left, shadow right.
  ctx.save();
  ctx.clip(head);

  const ramp = ctx.createLinearGradient(cx - hw, cy - hh, cx + hw * 1.1, cy + hh);
  ramp.addColorStop(0, mix(spec.skin, '#ffffff', 0.24));
  ramp.addColorStop(0.42, spec.skin);
  ramp.addColorStop(1, spec.shadow);
  ctx.fillStyle = ramp;
  ctx.fillRect(cx - hw * 2, cy - hh * 2, hw * 4, hh * 4);

  // Cheekbone and temple shading, which is most of what makes a face read as
  // three-dimensional rather than as a flat oval.
  const cheek = ctx.createRadialGradient(
    cx + hw * 0.42, cy + hh * 0.18, 1,
    cx + hw * 0.42, cy + hh * 0.18, hw * 0.9,
  );
  cheek.addColorStop(0, 'rgba(0,0,0,0.26)');
  cheek.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = cheek;
  ctx.fillRect(cx - hw * 2, cy - hh * 2, hw * 4, hh * 4);

  // Under-eye and under-jaw occlusion.
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + hh * 0.92, hw * 0.62, hh * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawNeck(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
): void {
  // Narrower than the jaw and considerably darker: the head casts onto the
  // neck, and getting that wrong is what makes a portrait look like a mask
  // sitting on a column.
  ctx.fillStyle = mix(mix(spec.shadow, '#4a4a52', 0.35), '#000000', 0.45);
  ctx.beginPath();
  ctx.moveTo(cx - hw * 0.34, cy + hh * 0.80);
  ctx.lineTo(cx + hw * 0.34, cy + hh * 0.80);
  ctx.lineTo(cx + hw * 0.44, cy + hh * 1.72);
  ctx.lineTo(cx - hw * 0.44, cy + hh * 1.72);
  ctx.closePath();
  ctx.fill();

  // Sternocleidomastoid, just enough to break the flat column.
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = Math.max(1, hh * 0.03);
  ctx.beginPath();
  ctx.moveTo(cx - hw * 0.26, cy + hh * 0.92);
  ctx.lineTo(cx - hw * 0.10, cy + hh * 1.6);
  ctx.stroke();
}

function drawShoulders(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  h: number,
): void {
  const top = cy + hh * 1.55;
  const grad = ctx.createLinearGradient(cx - hw * 2, top, cx + hw * 2, h);
  grad.addColorStop(0, mix(spec.clothing, '#ffffff', 0.14));
  grad.addColorStop(1, mix(spec.clothing, '#000000', 0.42));
  ctx.fillStyle = grad;

  ctx.beginPath();
  ctx.moveTo(cx - hw * 2.6, h);
  ctx.bezierCurveTo(cx - hw * 2.2, top + hh * 0.2, cx - hw * 0.8, top, cx, top);
  ctx.bezierCurveTo(cx + hw * 0.8, top, cx + hw * 2.2, top + hh * 0.2, cx + hw * 2.6, h);
  ctx.closePath();
  ctx.fill();

  drawCollar(ctx, spec, cx, top, hw, hh, h);
}

/** The collar is most of a character's silhouette, so each one differs. */
function drawCollar(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  cx: number,
  top: number,
  hw: number,
  hh: number,
  h: number,
): void {
  ctx.save();
  const dark = mix(spec.clothing, '#000000', 0.55);
  const light = mix(spec.clothing, '#ffffff', 0.2);

  switch (spec.collar) {
    case 'coat': {
      // Wide lapels, buttoned low.
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.55, top - hh * 0.1);
      ctx.lineTo(cx, top + hh * 1.3);
      ctx.lineTo(cx - hw * 1.5, h);
      ctx.lineTo(cx - hw * 1.9, top + hh * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + hw * 0.55, top - hh * 0.1);
      ctx.lineTo(cx, top + hh * 1.3);
      ctx.lineTo(cx + hw * 1.5, h);
      ctx.lineTo(cx + hw * 1.9, top + hh * 0.6);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'apron': {
      // A surgical top: high, plain, with a shoulder seam.
      ctx.fillStyle = light;
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.75, top - hh * 0.05);
      ctx.quadraticCurveTo(cx, top + hh * 0.42, cx + hw * 0.75, top - hh * 0.05);
      ctx.lineTo(cx + hw * 0.9, top + hh * 0.25);
      ctx.quadraticCurveTo(cx, top + hh * 0.85, cx - hw * 0.9, top + hh * 0.25);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'jacket': {
      ctx.strokeStyle = dark;
      ctx.lineWidth = hw * 0.12;
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.6, top);
      ctx.lineTo(cx - hw * 0.2, top + hh * 1.1);
      ctx.lineTo(cx - hw * 0.2, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + hw * 0.6, top);
      ctx.lineTo(cx + hw * 0.2, top + hh * 1.1);
      ctx.lineTo(cx + hw * 0.2, h);
      ctx.stroke();
      break;
    }
    case 'harness': {
      // Load-bearing straps over the shoulders.
      ctx.fillStyle = dark;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * hw * 0.35, top + hh * 0.05);
        ctx.lineTo(cx + side * hw * 0.85, top + hh * 0.05);
        ctx.lineTo(cx + side * hw * 1.55, h);
        ctx.lineTo(cx + side * hw * 1.05, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = mix(spec.clothing, '#ffffff', 0.35);
      ctx.fillRect(cx - hw * 0.6, top + hh * 1.15, hw * 1.2, hh * 0.16);
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

function drawEars(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
): void {
  for (const side of [-1, 1]) {
    ctx.fillStyle = side < 0 ? mix(spec.skin, '#000000', 0.12) : mix(spec.shadow, '#000000', 0.15);
    ctx.beginPath();
    ctx.ellipse(cx + side * hw * 0.97, cy + hh * 0.18, hw * 0.10, hh * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();
    // Inner shadow, so an ear is not a flat lozenge.
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(cx + side * hw * 0.95, cy + hh * 0.19, hw * 0.05, hh * 0.10, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Eyes, brows and the socket structure around them.
 *
 * The proportions here are the difference between a face and a caricature, so
 * they are taken from the standard head canon rather than guessed: the eye
 * line sits halfway between crown and chin, one eye is a fifth of the face
 * width, and there is exactly one eye-width of gap between them. An earlier
 * pass had eyes almost twice life size, which is the single fastest way to
 * make a drawn face look like a cartoon.
 */
function drawBrowAndEyes(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  jitter: (n: number) => number,
): void {
  const eyeY = cy + hh * 0.02;
  // Face width is 2*hw, so a fifth of it is 0.4*hw across - 0.20 as a radius.
  const eyeW = hw * 0.20;
  const eyeH = hh * 0.062;
  const eyeDx = hw * 0.36;

  // Brow ridge: a broad soft shadow, not a line. This is what gives a face a
  // skull underneath.
  ctx.fillStyle = 'rgba(0,0,0,0.17)';
  ctx.beginPath();
  ctx.ellipse(cx, eyeY - hh * 0.13, hw * 0.78, hh * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();

  for (const side of [-1, 1]) {
    // Nobody is symmetrical. A pixel or two of difference per side is below
    // conscious notice and above the threshold where a face looks stamped.
    const ex = cx + side * eyeDx + jitter(0.6);
    const ey = eyeY + jitter(0.5);

    // Socket hollow.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(ex, ey - eyeH * 0.4, eyeW * 1.5, eyeH * 3.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // The eye opening, as a clipped region: everything below is drawn inside
    // it, so the lids genuinely cut the iris off rather than sitting on top.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ex - eyeW, ey + eyeH * 0.1);
    // Upper lid: higher towards the nose, which is what gives an eye its
    // direction.
    ctx.quadraticCurveTo(ex - side * eyeW * 0.15, ey - eyeH * 1.75, ex + eyeW, ey + eyeH * 0.1);
    ctx.quadraticCurveTo(ex, ey + eyeH * 1.45, ex - eyeW, ey + eyeH * 0.1);
    ctx.closePath();
    ctx.clip();

    // Sclera, never white - a white eye in a dim portrait reads as plastic.
    ctx.fillStyle = '#a89f92';
    ctx.fillRect(ex - eyeW * 1.2, ey - eyeH * 3, eyeW * 2.4, eyeH * 6);
    // The sclera is a sphere, so it shades towards the corners.
    const sphere = ctx.createRadialGradient(ex, ey, eyeH * 0.2, ex, ey, eyeW);
    sphere.addColorStop(0, 'rgba(0,0,0,0)');
    sphere.addColorStop(1, 'rgba(0,0,0,0.40)');
    ctx.fillStyle = sphere;
    ctx.fillRect(ex - eyeW * 1.2, ey - eyeH * 3, eyeW * 2.4, eyeH * 6);

    // Iris, sized so the lid crops its top - an uncropped circle reads as a
    // stare.
    const irisR = eyeH * 1.55;
    const irisX = ex + side * eyeW * 0.04;
    ctx.fillStyle = mix('#5a4a38', spec.tint, 0.22);
    ctx.beginPath();
    ctx.arc(irisX, ey, irisR, 0, Math.PI * 2);
    ctx.fill();
    // Limbal ring and radial fibres.
    ctx.strokeStyle = 'rgba(20,14,10,0.55)';
    ctx.lineWidth = Math.max(0.8, irisR * 0.16);
    ctx.beginPath();
    ctx.arc(irisX, ey, irisR * 0.94, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#08080a';
    ctx.beginPath();
    ctx.arc(irisX, ey, irisR * 0.42, 0, Math.PI * 2);
    ctx.fill();
    // Catchlight, upper left on both eyes because there is one key light.
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.arc(irisX - irisR * 0.36, ey - irisR * 0.38, irisR * 0.22, 0, Math.PI * 2);
    ctx.fill();

    // Shadow the lid casts onto the eyeball.
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(ex - eyeW * 1.2, ey - eyeH * 3, eyeW * 2.4, eyeH * 2.55);
    ctx.restore();

    // Lash line: heaviest at the outer third.
    ctx.strokeStyle = 'rgba(18,14,12,0.8)';
    ctx.lineWidth = Math.max(1, hh * 0.012);
    ctx.beginPath();
    ctx.moveTo(ex - eyeW, ey + eyeH * 0.1);
    ctx.quadraticCurveTo(ex - side * eyeW * 0.15, ey - eyeH * 1.75, ex + eyeW, ey + eyeH * 0.1);
    ctx.stroke();

    // Lower lid highlight - a thin lit edge under the eye.
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = Math.max(1, hh * 0.010);
    ctx.beginPath();
    ctx.moveTo(ex - eyeW * 0.85, ey + eyeH * 0.7);
    ctx.quadraticCurveTo(ex, ey + eyeH * 1.7, ex + eyeW * 0.85, ey + eyeH * 0.6);
    ctx.stroke();

    // Brow, drawn as strokes so it has an edge rather than being a bar.
    const browY = ey - hh * 0.17;
    const browColor = mix(spec.hair, '#000000', 0.3);
    for (let i = 0; i < 14; i++) {
      const t = i / 13;
      const bx = ex + side * (t - 0.5) * eyeW * 2.5;
      const arc = Math.sin(t * Math.PI) * hh * 0.035;
      ctx.strokeStyle = browColor;
      ctx.globalAlpha = 0.35 + 0.5 * Math.sin(t * Math.PI);
      ctx.lineWidth = hh * (0.012 + spec.age * 0.006);
      ctx.beginPath();
      ctx.moveTo(bx, browY - arc + jitter(0.7));
      ctx.lineTo(bx + side * hw * 0.03, browY - arc + hh * 0.02 + jitter(0.7));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Age: crow's feet, and the fold of the upper lid.
  if (spec.age > 0.3) {
    ctx.strokeStyle = `rgba(0,0,0,${0.08 + spec.age * 0.10})`;
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      const ex = cx + side * eyeDx;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(ex + side * eyeW * 1.15, eyeY + (i - 1) * eyeH * 0.9);
        ctx.lineTo(ex + side * eyeW * (1.75 + i * 0.15), eyeY + (i - 1) * eyeH * 1.7);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(ex - eyeW * 0.9, eyeY - eyeH * 2.1);
      ctx.quadraticCurveTo(ex, eyeY - eyeH * 3.1, ex + eyeW * 0.9, eyeY - eyeH * 2.0);
      ctx.stroke();
    }
  }
}

function drawNose(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
): void {
  const tipY = cy + hh * 0.44;

  // The nose is drawn as light and shadow rather than as an outline: a line
  // down the middle of a face is the fastest way to make it look like a
  // cartoon.
  ctx.fillStyle = 'rgba(0,0,0,0.20)';
  ctx.beginPath();
  ctx.moveTo(cx + hw * 0.03, cy - hh * 0.05);
  ctx.quadraticCurveTo(cx + hw * 0.19, tipY - hh * 0.06, cx + hw * 0.13, tipY + hh * 0.02);
  ctx.quadraticCurveTo(cx + hw * 0.02, tipY + hh * 0.08, cx - hw * 0.02, tipY);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = `rgba(255,255,255,0.13)`;
  ctx.beginPath();
  ctx.ellipse(cx - hw * 0.06, tipY - hh * 0.12, hw * 0.06, hh * 0.20, -0.1, 0, Math.PI * 2);
  ctx.fill();

  // Nostrils.
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * hw * 0.13, tipY + hh * 0.03, hw * 0.045, hh * 0.03, side * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  void spec;
}

function drawMouth(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
): void {
  const y = cy + hh * 0.66;
  const halfW = hw * 0.30;

  // Line, not lips. These are not friendly people.
  ctx.strokeStyle = mix(spec.shadow, '#2a1512', 0.5);
  ctx.lineWidth = Math.max(1.4, hh * 0.035);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - halfW, y);
  ctx.quadraticCurveTo(cx, y + hh * 0.035, cx + halfW, y - hh * 0.01);
  ctx.stroke();

  // Lower lip catches the light; upper is in shadow under the nose.
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.beginPath();
  ctx.ellipse(cx, y + hh * 0.085, halfW * 0.78, hh * 0.055, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath();
  ctx.ellipse(cx, y + hh * 0.20, halfW * 0.5, hh * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Beard as stubble density rather than a filled shape.
 *
 * A solid ellipse of dark colour on a jaw reads as a smudge - it has no edge
 * quality, and hair is nothing but edge quality. Thousands of short strokes
 * following the jawline cost a millisecond and read correctly at any density,
 * from two-day stubble to a full beard, off the same parameter.
 */
function drawBeard(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  head: Path2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  rand: () => number,
): void {
  ctx.save();
  ctx.clip(head);

  const dark = mix(spec.hair, '#000000', 0.25);
  const light = mix(spec.hair, '#ffffff', 0.25);
  const count = Math.round(900 + spec.beard * 2600);
  const spread = 0.26 + spec.beard * 0.26;

  ctx.lineWidth = Math.max(0.7, hh * 0.009);
  ctx.lineCap = 'round';

  for (let i = 0; i < count; i++) {
    // Sample inside the beard region: jaw, chin, and up the cheeks a little.
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand());
    const bx = cx + Math.cos(a) * r * hw * 0.88;
    const by = cy + hh * 0.78 + Math.sin(a) * r * hh * spread * 2.2;

    // Keep it off the mouth.
    const mouthDx = (bx - cx) / (hw * 0.34);
    const mouthDy = (by - (cy + hh * 0.66)) / (hh * 0.10);
    if (mouthDx * mouthDx + mouthDy * mouthDy < 1) continue;
    // And density falls off towards the cheekbones.
    if (by < cy + hh * 0.42 && rand() > 0.12) continue;

    ctx.strokeStyle = rand() < 0.22 ? light : dark;
    ctx.globalAlpha = 0.20 + rand() * 0.5;
    const len = hh * (0.02 + rand() * 0.035);
    // Strands sweep down and slightly outwards.
    const dir = (bx - cx) / hw * 0.4;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + dir * len, by + len);
    ctx.stroke();
  }

  // Moustache: denser, and it has a hard upper edge under the nose.
  if (spec.beard > 0.4) {
    for (let i = 0; i < 700; i++) {
      const t = rand();
      const mx = cx + (t - 0.5) * hw * 0.78;
      const my = cy + hh * (0.53 + rand() * 0.11) + Math.abs(t - 0.5) * hh * 0.08;
      ctx.strokeStyle = rand() < 0.18 ? light : dark;
      ctx.globalAlpha = 0.3 + rand() * 0.5;
      const len = hh * (0.015 + rand() * 0.022);
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + (mx - cx) / hw * len * 0.8, my + len);
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Hair, built as a mass and then broken up with strands.
 *
 * The filled silhouette alone reads as a moulded helmet. What sells hair is
 * that its edge is ragged and its interior has direction, so the mass is laid
 * down first and then several hundred strokes are drawn along the flow, some
 * of them past the silhouette edge.
 */
function drawHair(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  rand: () => number,
): void {
  if (spec.hairLength < 0.04) return;
  const len = spec.hairLength;

  const mass = new Path2D();
  mass.moveTo(cx - hw * 1.02, cy - hh * 0.16);
  mass.bezierCurveTo(
    cx - hw * 1.06, cy - hh * 1.22,
    cx + hw * 1.06, cy - hh * 1.22,
    cx + hw * 1.02, cy - hh * 0.16,
  );
  mass.lineTo(cx + hw * (1.0 + len * 0.16), cy + hh * (0.1 + len * 1.5));
  mass.quadraticCurveTo(
    cx + hw * 0.84, cy + hh * (0.05 + len * 1.1),
    cx + hw * 0.78, cy - hh * 0.46,
  );
  // Hairline: shallow across the forehead, dipping at the temples. Sitting it
  // too low swallows the forehead and with it most of the face's age.
  mass.quadraticCurveTo(cx, cy - hh * (0.88 - len * 0.05), cx - hw * 0.78, cy - hh * 0.46);
  mass.quadraticCurveTo(
    cx - hw * 0.84, cy + hh * (0.05 + len * 1.1),
    cx - hw * (1.0 + len * 0.16), cy + hh * (0.1 + len * 1.5),
  );
  mass.closePath();

  ctx.save();
  const grad = ctx.createLinearGradient(cx - hw, cy - hh, cx + hw, cy);
  grad.addColorStop(0, mix(spec.hair, '#ffffff', 0.24));
  grad.addColorStop(0.55, spec.hair);
  grad.addColorStop(1, mix(spec.hair, '#000000', 0.45));
  ctx.fillStyle = grad;
  ctx.fill(mass);

  // Interior strands, following the sweep from the crown down and back.
  const highlight = mix(spec.hair, '#ffffff', 0.5);
  const shade = mix(spec.hair, '#000000', 0.5);
  ctx.save();
  ctx.clip(mass);
  ctx.lineWidth = Math.max(0.8, hh * 0.011);
  ctx.lineCap = 'round';
  for (let i = 0; i < 620; i++) {
    const t = rand();
    const side = t < 0.5 ? -1 : 1;
    const u = (t < 0.5 ? t * 2 : (t - 0.5) * 2);
    const sx = cx + side * u * hw * 1.05;
    const sy = cy - hh * (1.15 - u * u * 1.2) + rand() * hh * 0.5;
    const strandLen = hh * (0.12 + rand() * 0.3 + len * 0.5);
    ctx.strokeStyle = rand() < 0.3 ? highlight : shade;
    ctx.globalAlpha = 0.10 + rand() * 0.24;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(
      sx + side * strandLen * 0.35, sy + strandLen * 0.5,
      sx + side * strandLen * 0.5, sy + strandLen,
    );
    ctx.stroke();
  }
  ctx.restore();

  // Flyaways past the silhouette, which is what stops the edge looking cut.
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = Math.max(0.7, hh * 0.008);
  for (let i = 0; i < 90; i++) {
    const a = Math.PI + rand() * Math.PI;
    const ex = cx + Math.cos(a) * hw * 1.03;
    const ey = cy + Math.sin(a) * hh * 1.12;
    ctx.strokeStyle = shade;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(
      ex + Math.cos(a) * hh * (0.04 + rand() * 0.1),
      ey + Math.sin(a) * hh * (0.04 + rand() * 0.1),
    );
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Skin texture: mottling and pores.
 *
 * Flat skin is the last thing that gives a drawn face away. This is barely
 * visible individually and does most of the work of making the final grain
 * pass look like it belongs to the image rather than sitting on top of it.
 */
function drawSkinTexture(
  ctx: CanvasRenderingContext2D,
  head: Path2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  rand: () => number,
): void {
  ctx.save();
  ctx.clip(head);

  // Broad mottling.
  for (let i = 0; i < 60; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand());
    const px = cx + Math.cos(a) * r * hw;
    const py = cy + Math.sin(a) * r * hh * 1.05;
    ctx.fillStyle = rand() < 0.5 ? 'rgba(120,70,50,0.05)' : 'rgba(255,235,215,0.045)';
    ctx.beginPath();
    ctx.ellipse(px, py, hw * (0.06 + rand() * 0.16), hh * (0.05 + rand() * 0.12), rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pores.
  ctx.fillStyle = 'rgba(0,0,0,0.055)';
  for (let i = 0; i < 900; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand());
    ctx.fillRect(
      cx + Math.cos(a) * r * hw,
      cy + Math.sin(a) * r * hh * 1.05,
      1, 1,
    );
  }
  ctx.restore();
}

function drawHat(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
): void {
  const base = mix(spec.clothing, '#000000', 0.3);
  ctx.fillStyle = base;

  if (spec.hat === 'cap') {
    ctx.beginPath();
    ctx.moveTo(cx - hw * 1.06, cy - hh * 0.42);
    ctx.bezierCurveTo(cx - hw * 1.1, cy - hh * 1.45, cx + hw * 1.1, cy - hh * 1.45, cx + hw * 1.06, cy - hh * 0.42);
    ctx.closePath();
    ctx.fill();
    // Peak, angled down over the brow.
    ctx.fillStyle = mix(base, '#000000', 0.35);
    ctx.beginPath();
    ctx.ellipse(cx - hw * 0.12, cy - hh * 0.44, hw * 1.24, hh * 0.16, -0.06, Math.PI, Math.PI * 2);
    ctx.fill();
  } else if (spec.hat === 'beanie') {
    ctx.beginPath();
    ctx.moveTo(cx - hw * 1.04, cy - hh * 0.30);
    ctx.bezierCurveTo(cx - hw * 1.14, cy - hh * 1.55, cx + hw * 1.14, cy - hh * 1.55, cx + hw * 1.04, cy - hh * 0.30);
    ctx.closePath();
    ctx.fill();
    // Rolled brim.
    ctx.fillStyle = mix(base, '#ffffff', 0.14);
    ctx.fillRect(cx - hw * 1.06, cy - hh * 0.52, hw * 2.12, hh * 0.26);
  } else if (spec.hat === 'hood') {
    ctx.fillStyle = mix(spec.clothing, '#000000', 0.45);
    ctx.beginPath();
    ctx.moveTo(cx - hw * 1.5, cy + hh * 1.6);
    ctx.bezierCurveTo(cx - hw * 1.7, cy - hh * 1.3, cx + hw * 1.7, cy - hh * 1.3, cx + hw * 1.5, cy + hh * 1.6);
    ctx.closePath();
    ctx.fill();
    // Inner shadow where the hood overhangs the face.
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(cx, cy - hh * 0.55, hw * 1.06, hh * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGlasses(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
): void {
  const eyeY = cy + hh * 0.02;
  const r = hw * 0.24;
  ctx.strokeStyle = 'rgba(198,204,212,0.62)';
  ctx.lineWidth = Math.max(1, hh * 0.014);

  for (const side of [-1, 1]) {
    const ex = cx + side * hw * 0.36;
    ctx.beginPath();
    ctx.roundRect(ex - r, eyeY - r * 0.62, r * 2, r * 1.24, r * 0.28);
    ctx.stroke();
    // Lens glare, one streak, matching the key light direction.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(ex - r, eyeY - r * 0.62, r * 2, r * 1.24, r * 0.28);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = r * 0.5;
    ctx.beginPath();
    ctx.moveTo(ex - r * 1.2, eyeY + r);
    ctx.lineTo(ex + r * 0.4, eyeY - r);
    ctx.stroke();
    ctx.restore();
  }
  // Bridge.
  ctx.strokeStyle = 'rgba(198,204,212,0.62)';
  ctx.lineWidth = Math.max(1, hh * 0.012);
  ctx.beginPath();
  ctx.moveTo(cx - hw * 0.12, eyeY - hh * 0.02);
  ctx.lineTo(cx + hw * 0.12, eyeY - hh * 0.02);
  ctx.stroke();
  void spec;
}

function drawScar(ctx: CanvasRenderingContext2D, cx: number, cy: number, hw: number, hh: number): void {
  ctx.strokeStyle = 'rgba(150,105,95,0.55)';
  ctx.lineWidth = Math.max(1.4, hh * 0.022);
  ctx.beginPath();
  ctx.moveTo(cx - hw * 0.68, cy - hh * 0.42);
  ctx.lineTo(cx - hw * 0.30, cy + hh * 0.22);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - hw * 0.70, cy - hh * 0.42);
  ctx.lineTo(cx - hw * 0.32, cy + hh * 0.22);
  ctx.stroke();
}

/** Rim light along the shadow edge, which is what lifts the head off the backdrop. */
function drawKeyLight(
  ctx: CanvasRenderingContext2D,
  spec: FaceSpec,
  head: Path2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
): void {
  ctx.save();
  ctx.clip(head);
  ctx.globalCompositeOperation = 'lighter';
  const rim = ctx.createLinearGradient(cx + hw * 0.45, cy, cx + hw * 1.05, cy);
  rim.addColorStop(0, 'rgba(0,0,0,0)');
  rim.addColorStop(1, mix(spec.tint, '#ffffff', 0.45).replace('rgb', 'rgba').replace(')', ',0.34)'));
  ctx.fillStyle = rim;
  ctx.fillRect(cx - hw * 2, cy - hh * 2, hw * 4, hh * 4);
  ctx.restore();
}

/**
 * The treatment: duotone, scanlines, grain, vignette.
 *
 * This is what turns a drawing into a photograph of a person. Grain especially -
 * it gives the eye a uniform texture to read across the whole image, so the
 * places where the geometry is only approximately right stop standing out.
 */
function applyTreatment(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  spec: FaceSpec,
  rng: () => number,
  style: PortraitSpec,
): void {
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  // The character's own tint, pulled towards the style's. How far is the
  // difference between four people photographed by four cameras and four
  // people photographed by one.
  const [ur, ug, ub] = parseHex(style.unify);
  const [ctr, ctg, ctb] = parseHex(spec.tint);
  const k = style.unifyAmount;
  const tr = ctr + (ur - ctr) * k;
  const tg = ctg + (ug - ctg) * k;
  const tb = ctb + (ub - ctb) * k;

  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;

    // Drain colour first, where the style asks for it. Doing this before the
    // tint rather than after is what makes a duotone: the image is reduced to
    // tone, then the tone is coloured. Reversing the order leaves the original
    // skin and cloth hues fighting the tint.
    if (style.desaturation > 0) {
      const grey = lum * 255;
      data[i] += (grey - data[i]) * style.desaturation;
      data[i + 1] += (grey - data[i + 1]) * style.desaturation;
      data[i + 2] += (grey - data[i + 2]) * style.desaturation;
    }

    // Pull towards the tint at the lit end, so shadows stay dense and the
    // image does not turn into a flat wash.
    const pull = lum * lum * style.tintPull * 2;
    data[i] += (tr - data[i]) * pull;
    data[i + 1] += (tg - data[i + 1]) * pull;
    data[i + 2] += (tb - data[i + 2]) * pull;

    // Contrast, pivoted on mid grey.
    if (style.contrast !== 1) {
      data[i] = (data[i] - 128) * style.contrast + 128;
      data[i + 1] = (data[i + 1] - 128) * style.contrast + 128;
      data[i + 2] = (data[i + 2] - 128) * style.contrast + 128;
    }

    // Grain, stronger in the mid-tones where a sensor is actually noisiest.
    const grain = (rng() - 0.5) * style.grain * (0.35 + (1 - Math.abs(lum - 0.5) * 2) * 0.65);
    data[i] += grain;
    data[i + 1] += grain;
    data[i + 2] += grain;
  }
  ctx.putImageData(image, 0, 0);

  // Scanlines: every third row. Enough to read as a screen capture at low
  // strength, a deliberate artefact at high.
  if (style.scanlines > 0) {
    ctx.fillStyle = `rgba(0,0,0,${style.scanlines})`;
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
  }

  // Vignette.
  const vig = ctx.createRadialGradient(w * 0.5, h * 0.42, w * 0.25, w * 0.5, h * 0.5, w * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, `rgba(0,0,0,${style.vignette})`);
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}

// ===========================================================================
// The cast
// ===========================================================================

/**
 * Four originals, written so they read differently at a glance: an armourer
 * who has been shot at, a field surgeon who has not slept, a fence who wants
 * you to know he is comfortable, and a quartermaster who is the only one here
 * still wearing a uniform properly.
 */
export const TRADER_FACES: Record<string, FaceSpec> = {
  kessler: {
    skin: '#b08a68', shadow: '#5e4433', hair: '#3b3229',
    hairLength: 0.42, beard: 0, width: 0.96, jaw: 0.62, age: 0.62, tilt: -0.02,
    clothing: '#4a4238', collar: 'coat', hat: 'none', glasses: false, scar: true,
    tint: '#c07a3a',
  },
  marek: {
    skin: '#c39c7c', shadow: '#6a4f3c', hair: '#8a8378',
    hairLength: 0.18, beard: 0.35, width: 0.92, jaw: 0.34, age: 0.78, tilt: 0.03,
    clothing: '#5c7d74', collar: 'apron', hat: 'none', glasses: true, scar: false,
    tint: '#4a9a7a',
  },
  zoellner: {
    skin: '#9c7a5c', shadow: '#4f3a2c', hair: '#241f1b',
    hairLength: 0.06, beard: 0.62, width: 1.10, jaw: 0.86, age: 0.5, tilt: -0.04,
    clothing: '#2f2c33', collar: 'jacket', hat: 'none', glasses: false, scar: false,
    tint: '#b8a03a',
  },
  sana: {
    skin: '#8a6448', shadow: '#4a3325', hair: '#1c1815',
    hairLength: 0.10, beard: 0, width: 0.94, jaw: 0.46, age: 0.32, tilt: 0.02,
    clothing: '#3d4654', collar: 'harness', hat: 'cap', glasses: false, scar: false,
    tint: '#6a7ac0',
  },
};

/** Portraits are expensive enough to draw that they are built once and kept. */
const cache = new Map<string, HTMLCanvasElement>();

/** The treatment new portraits are drawn with. */
let activePortraitStyle: PortraitSpec = STYLES[DEFAULT_STYLE].portrait;

/**
 * Switch the treatment and throw away every cached portrait.
 *
 * The treatment is baked into the pixels - it is a per-pixel pass over the
 * finished drawing, not a filter hung in front of it - so a cached portrait
 * belongs to the style it was drawn under and cannot be reused across a
 * change. Four faces at 220x264 is a few milliseconds to redraw, paid once
 * when the player picks a style.
 */
export function setPortraitStyle(style: PortraitSpec): void {
  if (style === activePortraitStyle) return;
  activePortraitStyle = style;
  cache.clear();
}

export function portraitFor(id: string): HTMLCanvasElement | null {
  const cached = cache.get(id);
  if (cached) return cached;
  const spec = TRADER_FACES[id];
  if (!spec) return null;
  let seed = 0;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  const canvas = drawPortrait(spec, seed, activePortraitStyle);
  cache.set(id, canvas);
  return canvas;
}

/** A fresh <img>-like node for the DOM; the cached canvas can only live in one place. */
export function portraitNode(id: string, size = 1): HTMLElement | null {
  const source = portraitFor(id);
  if (!source) return null;
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  copy.className = 'portrait';
  copy.style.width = `${Math.round(PORTRAIT_W * size)}px`;
  copy.style.height = `${Math.round(PORTRAIT_H * size)}px`;
  const ctx = copy.getContext('2d');
  ctx?.drawImage(source, 0, 0);
  return copy;
}
