import { TileMap, TILE_DEFS, METERS_PER_TILE, Tile } from '../../world/TileMap';
import { floorTextureFor } from '../Textures';

/**
 * WorldMesh - real geometry, built once per raid from the tile grid.
 *
 * This is the change that makes the GPU path worth having. The software
 * renderer reconstructs the world every frame by marching a ray per screen
 * column; here the world is turned into triangles once at raid start and the
 * hardware rasterises it. That buys, in order of how much they matter:
 *
 *   - **Perspective-correct texturing with mipmaps and anisotropy.** The
 *     single biggest fidelity difference. No crawling, no blockiness at
 *     grazing angles.
 *   - **A real depth buffer**, so sprites, glass and geometry interleave
 *     correctly with no sorting rules to get wrong.
 *   - **Per-pixel lighting and fog** rather than per column and per row.
 *
 * The tile data stays the authority. This mesh is generated *from* the
 * `TileMap`, and ballistics, AI and sound continue to read the tiles - so the
 * wall you see is still exactly the wall that stops a bullet. Nothing reads
 * the mesh back.
 *
 * Faces are culled against their neighbours: a wall face is only emitted where
 * the adjacent tile is shorter or not a wall at all. On a 96x96 map that is
 * the difference between roughly 40 000 triangles and 6 000.
 */

/** Floats per vertex: position 3, uv 2, layer 1, shade 1. */
export const FLOATS_PER_VERTEX = 7;

export interface MeshData {
  /** Interleaved vertex data for opaque geometry. */
  opaque: Float32Array;
  opaqueCount: number;
  /** See-through surfaces - fences, glass - drawn after, with blending. */
  transparent: Float32Array;
  transparentCount: number;
}

/**
 * Directional shading per face.
 *
 * There are no real normals in the lighting model, so faces get a constant
 * multiplier by orientation. It is a cheap trick and it is the reason corners
 * are legible at all: without it a box lit by an overhead lightmap is a
 * silhouette with no edges.
 */
const SHADE_TOP = 1.0;
const SHADE_NORTH_SOUTH = 0.82;
const SHADE_EAST_WEST = 1.0;
const SHADE_FLOOR = 1.0;
const SHADE_CEILING = 0.72;

export function buildWorldMesh(map: TileMap): MeshData {
  const opaque: number[] = [];
  const transparent: number[] = [];

  const heightOf = (x: number, y: number): number => {
    if (!map.inBounds(x, y)) return 10;
    const def = TILE_DEFS[map.tiles[y * map.width + x]];
    return def.wall ? def.height / METERS_PER_TILE : 0;
  };

  const isSeeThrough = (tile: number): boolean => {
    const def = TILE_DEFS[tile];
    return def.wall && !def.opaque;
  };

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const index = y * map.width + x;
      const tile = map.tiles[index];
      const def = TILE_DEFS[tile];

      if (!def.wall) {
        // --- floor ---------------------------------------------------------
        const floorLayer = floorTextureFor(map.floor[index]);
        // Water sits fractionally lower so a pier reads as standing above it.
        const z = map.floor[index] === Tile.Water ? -0.03 : 0;
        pushQuad(
          opaque,
          x, y, z, x + 1, y, z, x + 1, y + 1, z, x, y + 1, z,
          floorLayer, SHADE_FLOOR,
        );

        // --- ceiling -------------------------------------------------------
        const ceilTile = map.ceiling[index];
        if (ceilTile !== 0) {
          const layer = TILE_DEFS[ceilTile]?.texture ?? 1;
          // Wound the other way so it faces down.
          pushQuad(
            opaque,
            x, y + 1, 1, x + 1, y + 1, 1, x + 1, y, 1, x, y, 1,
            layer, SHADE_CEILING,
          );
        }
        continue;
      }

      // --- wall ------------------------------------------------------------
      const h = def.height / METERS_PER_TILE;
      const layer = def.texture;
      const target = isSeeThrough(tile) ? transparent : opaque;

      // Top face, wherever the wall does not reach the ceiling.
      if (h < 1 || map.ceiling[index] === 0) {
        pushQuad(target, x, y, h, x + 1, y, h, x + 1, y + 1, h, x, y + 1, h, layer, SHADE_TOP);
      }

      // Side faces, only where the neighbour is lower. A face buried inside a
      // solid block is invisible from every position the player can occupy,
      // and emitting it costs vertex bandwidth for nothing.
      //
      // The quad spans from the neighbour's height to this one, so a low crate
      // against a tall wall does not produce a face hidden behind the wall.
      // The texture maps over the wall's full height, so a face that starts
      // partway up samples from partway down the image - otherwise the same
      // material on a crate and on a wall would not line up where they meet.
      const vAt = (z: number): number => 1 - z / h;

      const west = heightOf(x - 1, y);
      if (west < h) {
        pushQuad(target, x, y + 1, west, x, y, west, x, y, h, x, y + 1, h, layer, SHADE_EAST_WEST, 0, vAt(west));
      }
      const east = heightOf(x + 1, y);
      if (east < h) {
        pushQuad(target, x + 1, y, east, x + 1, y + 1, east, x + 1, y + 1, h, x + 1, y, h, layer, SHADE_EAST_WEST, 0, vAt(east));
      }
      const south = heightOf(x, y - 1);
      if (south < h) {
        pushQuad(target, x, y, south, x + 1, y, south, x + 1, y, h, x, y, h, layer, SHADE_NORTH_SOUTH, 0, vAt(south));
      }
      const north = heightOf(x, y + 1);
      if (north < h) {
        pushQuad(target, x + 1, y + 1, north, x, y + 1, north, x, y + 1, h, x + 1, y + 1, h, layer, SHADE_NORTH_SOUTH, 0, vAt(north));
      }
    }
  }

  return {
    opaque: new Float32Array(opaque),
    opaqueCount: opaque.length / FLOATS_PER_VERTEX,
    transparent: new Float32Array(transparent),
    transparentCount: transparent.length / FLOATS_PER_VERTEX,
  };
}

/**
 * Emit two triangles for a quad, winding counter-clockwise from the outside.
 *
 * `v0`..`v1` optionally override the vertical texture range, so a wall face
 * that starts partway up still samples the correct part of its texture -
 * otherwise a half-height face would stretch the whole texture over half the
 * wall and mortar lines would not line up between neighbouring tiles.
 */
function pushQuad(
  out: number[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  layer: number,
  shade: number,
  v0 = 0,
  v1 = 1,
): void {
  // UVs: (0,v1) at the first corner running to (1,v0), which puts the texture
  // the right way up on vertical faces and tiles correctly on horizontal ones.
  const u0 = 0;
  const u1 = 1;

  pushVertex(out, ax, ay, az, u0, v1, layer, shade);
  pushVertex(out, bx, by, bz, u1, v1, layer, shade);
  pushVertex(out, cx, cy, cz, u1, v0, layer, shade);

  pushVertex(out, ax, ay, az, u0, v1, layer, shade);
  pushVertex(out, cx, cy, cz, u1, v0, layer, shade);
  pushVertex(out, dx, dy, dz, u0, v0, layer, shade);
}

function pushVertex(
  out: number[],
  x: number, y: number, z: number,
  u: number, v: number,
  layer: number,
  shade: number,
): void {
  out.push(x, y, z, u, v, layer, shade);
}
