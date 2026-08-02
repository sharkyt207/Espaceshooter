using System;

namespace Greyzone.Simulation.World
{
    /// <summary>Result of a grid ray cast.</summary>
    public struct RayHit
    {
        public bool Hit;
        /// <summary>Euclidean distance in tiles from the origin.</summary>
        public float Distance;
        public int TileX;
        public int TileY;
        public Tile Tile;
        /// <summary>0 = hit a vertical face, 1 = hit a horizontal face.</summary>
        public int Side;
        /// <summary>Horizontal coordinate along the hit face, 0..1.</summary>
        public float U;
        public float X;
        public float Y;
    }

    /// <summary>
    /// Grid DDA traversal shared by line of sight, ballistics and sound.
    /// </summary>
    /// <remarks>
    /// One well-tested traversal used everywhere means the geometry the player
    /// can see, the geometry that stops a bullet and the geometry that muffles
    /// a sound can never disagree.
    ///
    /// Everything writes into caller-supplied values; nothing allocates.
    /// </remarks>
    public static class Raycast
    {
        public delegate bool BlockPredicate(TileMap map, int x, int y);

        /// <summary>Blocker: anything presenting a wall surface.</summary>
        public static readonly BlockPredicate BlocksWall = (map, x, y) => map.IsWall(x, y);

        /// <summary>Blocker: anything blocking vision. Used by AI and LOS.</summary>
        public static readonly BlockPredicate BlocksSight = (map, x, y) => map.IsOpaque(x, y);

        /// <summary>Blocker: anything blocking movement.</summary>
        public static readonly BlockPredicate BlocksMovement = (map, x, y) => map.IsSolid(x, y);

        /// <summary>
        /// Marches a ray until <paramref name="blocks"/> reports a hit.
        /// </summary>
        public static RayHit Cast(TileMap map, float originX, float originY, float dirX, float dirY,
            float maxDistance, BlockPredicate blocks)
        {
            var hit = new RayHit();

            int mapX = (int)Math.Floor(originX);
            int mapY = (int)Math.Floor(originY);

            // Distance the ray travels crossing one whole tile on each axis.
            float deltaX = dirX == 0f ? float.PositiveInfinity : Math.Abs(1f / dirX);
            float deltaY = dirY == 0f ? float.PositiveInfinity : Math.Abs(1f / dirY);

            int stepX, stepY;
            float sideDistX, sideDistY;

            if (dirX < 0f)
            {
                stepX = -1;
                sideDistX = (originX - mapX) * deltaX;
            }
            else
            {
                stepX = 1;
                sideDistX = (mapX + 1 - originX) * deltaX;
            }

            if (dirY < 0f)
            {
                stepY = -1;
                sideDistY = (originY - mapY) * deltaY;
            }
            else
            {
                stepY = 1;
                sideDistY = (mapY + 1 - originY) * deltaY;
            }

            int side = 0;
            float dist = 0f;

            // Guard against a pathological direction eating the frame.
            int maxSteps = (int)Math.Ceiling(maxDistance * 2f) + 4;
            for (int i = 0; i < maxSteps; i++)
            {
                if (sideDistX < sideDistY)
                {
                    dist = sideDistX;
                    sideDistX += deltaX;
                    mapX += stepX;
                    side = 0;
                }
                else
                {
                    dist = sideDistY;
                    sideDistY += deltaY;
                    mapY += stepY;
                    side = 1;
                }

                if (dist > maxDistance) break;

                if (blocks(map, mapX, mapY))
                {
                    hit.Hit = true;
                    hit.Distance = dist;
                    hit.TileX = mapX;
                    hit.TileY = mapY;
                    hit.Tile = map.At(mapX, mapY);
                    hit.Side = side;
                    hit.X = originX + dirX * dist;
                    hit.Y = originY + dirY * dist;

                    float u = side == 0
                        ? hit.Y - (float)Math.Floor(hit.Y)
                        : hit.X - (float)Math.Floor(hit.X);
                    // Mirror on back faces so surface detail is not flipped.
                    if ((side == 0 && dirX > 0f) || (side == 1 && dirY < 0f)) u = 1f - u;
                    hit.U = u;
                    return hit;
                }
            }

            hit.Hit = false;
            hit.Distance = maxDistance;
            hit.TileX = mapX;
            hit.TileY = mapY;
            hit.Side = side;
            hit.X = originX + dirX * maxDistance;
            hit.Y = originY + dirY * maxDistance;
            return hit;
        }

        /// <summary>
        /// True when nothing opaque lies between two points.
        /// </summary>
        /// <remarks>
        /// The epsilon stops a target standing flush against a wall from
        /// occluding itself, which otherwise makes AI blind to anyone hugging
        /// cover.
        /// </remarks>
        public static bool HasLineOfSight(TileMap map, float ax, float ay, float bx, float by)
        {
            float dx = bx - ax;
            float dy = by - ay;
            float dist = (float)Math.Sqrt(dx * dx + dy * dy);
            if (dist < 1e-4f) return true;

            RayHit hit = Cast(map, ax, ay, dx / dist, dy / dist, dist, BlocksSight);
            return !hit.Hit || hit.Distance >= dist - 0.02f;
        }

        /// <summary>
        /// Visits every tile a segment passes through. Return false from
        /// <paramref name="visit"/> to stop early.
        /// </summary>
        /// <remarks>
        /// Used by ballistics (accumulating penetration) and sound propagation
        /// (accumulating occlusion), where every tile crossed matters - not just
        /// the first blocker.
        /// </remarks>
        public static void WalkSegment(float ax, float ay, float bx, float by, Func<int, int, float, bool> visit)
        {
            float dx = bx - ax;
            float dy = by - ay;
            float dist = (float)Math.Sqrt(dx * dx + dy * dy);
            if (dist < 1e-6f) return;

            float dirX = dx / dist;
            float dirY = dy / dist;

            int mapX = (int)Math.Floor(ax);
            int mapY = (int)Math.Floor(ay);
            float deltaX = dirX == 0f ? float.PositiveInfinity : Math.Abs(1f / dirX);
            float deltaY = dirY == 0f ? float.PositiveInfinity : Math.Abs(1f / dirY);
            int stepX = dirX < 0f ? -1 : 1;
            int stepY = dirY < 0f ? -1 : 1;
            float sideDistX = dirX < 0f ? (ax - mapX) * deltaX : (mapX + 1 - ax) * deltaX;
            float sideDistY = dirY < 0f ? (ay - mapY) * deltaY : (mapY + 1 - ay) * deltaY;

            float travelled = 0f;
            if (!visit(mapX, mapY, 0f)) return;

            int maxSteps = (int)Math.Ceiling(dist * 2f) + 4;
            for (int i = 0; i < maxSteps && travelled <= dist; i++)
            {
                if (sideDistX < sideDistY)
                {
                    travelled = sideDistX;
                    sideDistX += deltaX;
                    mapX += stepX;
                }
                else
                {
                    travelled = sideDistY;
                    sideDistY += deltaY;
                    mapY += stepY;
                }

                if (travelled > dist) return;
                if (!visit(mapX, mapY, travelled)) return;
            }
        }
    }
}
