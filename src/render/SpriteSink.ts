import type { SpriteFrame } from './Sprites';

/**
 * SpriteSink - what a system needs to know about drawing a billboard.
 *
 * Both renderers implement this, which is what lets the effect system, the
 * enemy pass and the loot pass be written once. They submit world-space
 * billboards and particles; whether that ends up as a depth-tested scanline
 * composite in JavaScript or an instanced draw call on the GPU is not their
 * concern.
 *
 * Keeping this interface narrow is deliberate. The moment it grows a method
 * only one backend can implement, the callers start branching on which
 * renderer is active, and the point of having two is lost.
 */
export interface SpriteSink {
  /** A textured billboard standing on the ground (or at `elevation`). */
  submit(
    x: number,
    y: number,
    frame: SpriteFrame,
    worldHeight: number,
    elevation?: number,
    tint?: number,
    alpha?: number,
  ): void;

  /** An untextured point: smoke, sparks, blood, tracers. */
  submitParticle(
    x: number,
    y: number,
    elevation: number,
    size: number,
    color: number,
    alpha: number,
    additive: boolean,
  ): void;
}
