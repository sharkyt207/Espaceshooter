import type { SpriteFrame } from '../Sprites';

/**
 * SpriteAtlas - every baked sprite frame packed into one GPU texture.
 *
 * Sprites are generated procedurally at boot as separate ABGR buffers. Uploaded
 * individually that would be one texture bind per draw, which on a phone is the
 * expensive part of drawing a hundred small things. Packed into a single sheet,
 * every character, prop and effect in the frame is one instanced draw call.
 *
 * The packer is a shelf packer: rows of equal height, next row starts below the
 * tallest so far. It is not optimal, and it does not need to be - the frames
 * are known at boot, they are all similar sizes, and the sheet is built once.
 *
 * One padding texel is left between frames. Without it, bilinear filtering at
 * the edge of a frame pulls in its neighbour, which shows up as a bright fringe
 * around every sprite - the classic atlas bleed.
 */

const PADDING = 2;

export interface AtlasRect {
  /** Normalised uv rectangle: u0, v0, u1, v1. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Pixel dimensions, for the billboard aspect ratio. */
  width: number;
  height: number;
}

export class SpriteAtlas {
  readonly size: number;
  readonly pixels: Uint32Array;
  private readonly rects = new Map<SpriteFrame, AtlasRect>();

  private cursorX = PADDING;
  private cursorY = PADDING;
  private shelfHeight = 0;
  private full = false;

  constructor(size = 2048) {
    this.size = size;
    this.pixels = new Uint32Array(size * size);
  }

  /**
   * Copy a frame into the sheet.
   *
   * Returns the rectangle, or null when the sheet is full - in which case the
   * caller draws nothing for that sprite rather than drawing something wrong.
   */
  add(frame: SpriteFrame): AtlasRect | null {
    const existing = this.rects.get(frame);
    if (existing) return existing;
    if (this.full) return null;

    const w = frame.width;
    const h = frame.height;

    if (this.cursorX + w + PADDING > this.size) {
      // Next shelf.
      this.cursorX = PADDING;
      this.cursorY += this.shelfHeight + PADDING;
      this.shelfHeight = 0;
    }
    if (this.cursorY + h + PADDING > this.size) {
      this.full = true;
      console.warn('[SpriteAtlas] out of space - some sprites will not draw');
      return null;
    }

    const x = this.cursorX;
    const y = this.cursorY;
    for (let row = 0; row < h; row++) {
      this.pixels.set(
        frame.pixels.subarray(row * w, row * w + w),
        (y + row) * this.size + x,
      );
    }

    this.cursorX += w + PADDING;
    if (h > this.shelfHeight) this.shelfHeight = h;

    // Half-texel inset. Sampling exactly on the boundary is undefined between
    // two texels and shows as a one-pixel seam that flickers with distance.
    const inset = 0.5 / this.size;
    const rect: AtlasRect = {
      u0: x / this.size + inset,
      v0: y / this.size + inset,
      u1: (x + w) / this.size - inset,
      v1: (y + h) / this.size - inset,
      width: w,
      height: h,
    };
    this.rects.set(frame, rect);
    return rect;
  }

  get(frame: SpriteFrame): AtlasRect | null {
    return this.rects.get(frame) ?? null;
  }

  /** A solid white texel, for untextured particles. */
  addSolid(): AtlasRect | null {
    const frame: SpriteFrame = {
      width: 4,
      height: 4,
      pixels: new Uint32Array(16).fill(0xffffffff),
      minX: 0, maxX: 3, minY: 0, maxY: 3,
    };
    return this.add(frame);
  }
}
