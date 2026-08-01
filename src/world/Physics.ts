import type { TileMap } from './TileMap';

/**
 * Physics - circle-vs-grid movement resolution.
 *
 * Actors are circles on a tile grid. We resolve each axis independently, which
 * gives free wall-sliding: pushing diagonally into a wall keeps the component
 * that is legal. This is the behaviour players expect from a shooter, and it
 * costs two cheap tests instead of a full swept-shape solve.
 *
 * Corner handling matters: testing only the centre lets an actor clip a
 * diagonal seam between two solid tiles, so we probe the leading edge of the
 * circle across the tiles it would overlap.
 */

export interface MoveResult {
  x: number;
  y: number;
  /** True when movement was blocked on that axis this step. */
  hitX: boolean;
  hitY: boolean;
}

const result: MoveResult = { x: 0, y: 0, hitX: false, hitY: false };

/**
 * Attempt to move a circle by (dx, dy).
 * Returns a shared result object - copy out what you need, do not retain it.
 */
export function moveCircle(
  map: TileMap,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
): MoveResult {
  let nx = x;
  let ny = y;
  let hitX = false;
  let hitY = false;

  // Long steps must be subdivided or a fast actor tunnels through a wall.
  const dist = Math.hypot(dx, dy);
  const steps = dist > radius ? Math.ceil(dist / radius) : 1;
  const stepX = dx / steps;
  const stepY = dy / steps;

  for (let i = 0; i < steps; i++) {
    if (stepX !== 0) {
      const tryX = nx + stepX;
      if (circleFits(map, tryX, ny, radius)) nx = tryX;
      else hitX = true;
    }
    if (stepY !== 0) {
      const tryY = ny + stepY;
      if (circleFits(map, nx, tryY, radius)) ny = tryY;
      else hitY = true;
    }
  }

  result.x = nx;
  result.y = ny;
  result.hitX = hitX;
  result.hitY = hitY;
  return result;
}

/** True when a circle of `radius` at (x, y) overlaps no solid tile. */
export function circleFits(map: TileMap, x: number, y: number, radius: number): boolean {
  const minTx = Math.floor(x - radius);
  const maxTx = Math.floor(x + radius);
  const minTy = Math.floor(y - radius);
  const maxTy = Math.floor(y + radius);

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!map.isSolid(tx, ty)) continue;
      // Closest point on the tile's AABB to the circle centre.
      const cx = x < tx ? tx : x > tx + 1 ? tx + 1 : x;
      const cy = y < ty ? ty : y > ty + 1 ? ty + 1 : y;
      const ddx = x - cx;
      const ddy = y - cy;
      if (ddx * ddx + ddy * ddy < radius * radius) return false;
    }
  }
  return true;
}

/**
 * Push actors apart so they never occupy the same space.
 * Called once per tick over the near-pairs the spatial hash reports; the
 * displacement is split evenly, which keeps a crowd from shunting one member
 * through a wall.
 */
export function separate(
  a: { x: number; y: number; radius: number },
  b: { x: number; y: number; radius: number },
  map: TileMap,
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const minDist = a.radius + b.radius;
  const distSq = dx * dx + dy * dy;
  if (distSq >= minDist * minDist || distSq < 1e-8) return;

  const dist = Math.sqrt(distSq);
  const overlap = (minDist - dist) * 0.5;
  const nx = dx / dist;
  const ny = dy / dist;

  const ax = a.x - nx * overlap;
  const ay = a.y - ny * overlap;
  const bx = b.x + nx * overlap;
  const by = b.y + ny * overlap;

  // Only commit a push that keeps the actor out of geometry.
  if (circleFits(map, ax, ay, a.radius)) {
    a.x = ax;
    a.y = ay;
  }
  if (circleFits(map, bx, by, b.radius)) {
    b.x = bx;
    b.y = by;
  }
}
