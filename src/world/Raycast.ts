import { TileMap } from './TileMap';

/**
 * Raycast - grid DDA traversal shared by rendering, line of sight, ballistics
 * and sound occlusion.
 *
 * A single well-tested traversal used everywhere means what the player sees and
 * what the simulation resolves can never disagree: the wall the renderer draws
 * is the wall the bullet hits.
 *
 * All functions write into caller-supplied result objects; nothing allocates.
 */

export interface RayHit {
  hit: boolean;
  /** Euclidean distance in tiles from the ray origin. */
  distance: number;
  /** Tile coordinates of the tile that was hit. */
  tileX: number;
  tileY: number;
  /** Tile id that was hit. */
  tile: number;
  /** 0 = hit a vertical face (x-side), 1 = hit a horizontal face (y-side). */
  side: 0 | 1;
  /** Horizontal texture coordinate along the hit face, 0..1. */
  u: number;
  /** World hit position. */
  x: number;
  y: number;
}

export function createRayHit(): RayHit {
  return { hit: false, distance: 0, tileX: 0, tileY: 0, tile: 0, side: 0, u: 0, x: 0, y: 0 };
}

/**
 * Standard DDA cast. `predicate` decides what counts as a blocker, letting the
 * renderer stop on any wall while line-of-sight stops only on opaque tiles.
 */
export function castRay(
  map: TileMap,
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
  maxDistance: number,
  blocks: (map: TileMap, x: number, y: number) => boolean,
  out: RayHit,
): RayHit {
  let mapX = Math.floor(originX);
  let mapY = Math.floor(originY);

  // Distance the ray travels to cross one full tile on each axis.
  const deltaX = dirX === 0 ? Infinity : Math.abs(1 / dirX);
  const deltaY = dirY === 0 ? Infinity : Math.abs(1 / dirY);

  let stepX: number;
  let stepY: number;
  let sideDistX: number;
  let sideDistY: number;

  if (dirX < 0) {
    stepX = -1;
    sideDistX = (originX - mapX) * deltaX;
  } else {
    stepX = 1;
    sideDistX = (mapX + 1 - originX) * deltaX;
  }
  if (dirY < 0) {
    stepY = -1;
    sideDistY = (originY - mapY) * deltaY;
  } else {
    stepY = 1;
    sideDistY = (mapY + 1 - originY) * deltaY;
  }

  let side: 0 | 1 = 0;
  let dist = 0;

  // Guard against pathological ray directions eating the frame.
  const maxSteps = Math.ceil(maxDistance * 2) + 4;
  for (let i = 0; i < maxSteps; i++) {
    if (sideDistX < sideDistY) {
      dist = sideDistX;
      sideDistX += deltaX;
      mapX += stepX;
      side = 0;
    } else {
      dist = sideDistY;
      sideDistY += deltaY;
      mapY += stepY;
      side = 1;
    }

    if (dist > maxDistance) break;

    if (blocks(map, mapX, mapY)) {
      out.hit = true;
      out.distance = dist;
      out.tileX = mapX;
      out.tileY = mapY;
      out.tile = map.at(mapX, mapY);
      out.side = side;
      out.x = originX + dirX * dist;
      out.y = originY + dirY * dist;
      // Texture coordinate: fractional position along the face that was hit.
      const u = side === 0 ? out.y - Math.floor(out.y) : out.x - Math.floor(out.x);
      // Mirror on back faces so textures do not appear flipped.
      out.u = (side === 0 && dirX > 0) || (side === 1 && dirY < 0) ? 1 - u : u;
      return out;
    }
  }

  out.hit = false;
  out.distance = maxDistance;
  out.tileX = mapX;
  out.tileY = mapY;
  out.tile = 0;
  out.side = side;
  out.u = 0;
  out.x = originX + dirX * maxDistance;
  out.y = originY + dirY * maxDistance;
  return out;
}

/** Blocker predicate: anything drawn as a wall. Used by the renderer. */
export function blocksWall(map: TileMap, x: number, y: number): boolean {
  return map.isWall(x, y);
}

/** Blocker predicate: anything that blocks vision. Used by AI and rendering LOS. */
export function blocksSight(map: TileMap, x: number, y: number): boolean {
  return map.isOpaque(x, y);
}

/** Blocker predicate: anything that blocks movement. Used by navigation. */
export function blocksMovement(map: TileMap, x: number, y: number): boolean {
  return map.isSolid(x, y);
}

const losHit = createRayHit();

/**
 * True when nothing opaque sits between the two points.
 * Distances are in tiles; the caller is responsible for range limits.
 */
export function hasLineOfSight(map: TileMap, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-4) return true;
  castRay(map, ax, ay, dx / dist, dy / dist, dist, blocksSight, losHit);
  // A hit strictly before the target means the view is blocked. The small
  // epsilon stops a target standing flush against a wall from occluding itself.
  return !losHit.hit || losHit.distance >= dist - 0.02;
}

/**
 * Walks every tile the segment passes through, invoking `visit`.
 * Returning false from `visit` stops the walk early.
 *
 * Used by ballistics (penetration accumulation) and sound propagation
 * (occlusion accumulation), where we care about all tiles crossed, not just
 * the first blocker.
 */
export function walkSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  visit: (tileX: number, tileY: number, distance: number) => boolean,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-6) return;
  const dirX = dx / dist;
  const dirY = dy / dist;

  let mapX = Math.floor(ax);
  let mapY = Math.floor(ay);
  const deltaX = dirX === 0 ? Infinity : Math.abs(1 / dirX);
  const deltaY = dirY === 0 ? Infinity : Math.abs(1 / dirY);
  const stepX = dirX < 0 ? -1 : 1;
  const stepY = dirY < 0 ? -1 : 1;
  let sideDistX = dirX < 0 ? (ax - mapX) * deltaX : (mapX + 1 - ax) * deltaX;
  let sideDistY = dirY < 0 ? (ay - mapY) * deltaY : (mapY + 1 - ay) * deltaY;

  let travelled = 0;
  if (!visit(mapX, mapY, 0)) return;

  const maxSteps = Math.ceil(dist * 2) + 4;
  for (let i = 0; i < maxSteps && travelled <= dist; i++) {
    if (sideDistX < sideDistY) {
      travelled = sideDistX;
      sideDistX += deltaX;
      mapX += stepX;
    } else {
      travelled = sideDistY;
      sideDistY += deltaY;
      mapY += stepY;
    }
    if (travelled > dist) return;
    if (!visit(mapX, mapY, travelled)) return;
  }
}
