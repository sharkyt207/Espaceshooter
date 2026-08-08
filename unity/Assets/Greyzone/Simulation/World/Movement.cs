using System;

namespace Greyzone.Simulation.World
{
    public struct MoveResult
    {
        public float X;
        public float Y;
        /// <summary>Movement was blocked on that axis this step.</summary>
        public bool HitX;
        public bool HitY;
    }

    /// <summary>
    /// Circle-versus-grid movement resolution.
    /// </summary>
    /// <remarks>
    /// Actors are circles on a tile grid. Each axis resolves independently,
    /// which gives wall-sliding for free: pushing diagonally into a wall keeps
    /// the component that is legal. That is the behaviour players expect from a
    /// shooter, and it costs two cheap tests instead of a swept-shape solve.
    ///
    /// Deliberately not Unity's physics: this runs identically in tests without
    /// the Editor, is fully deterministic, and matches the same tile data the
    /// ballistics solver uses.
    /// </remarks>
    public static class Movement
    {
        /// <summary>Attempts to move a circle by a delta, sliding along geometry.</summary>
        public static MoveResult MoveCircle(TileMap map, float x, float y, float dx, float dy, float radius)
        {
            float nx = x;
            float ny = y;
            bool hitX = false;
            bool hitY = false;

            // Long steps must be subdivided, or a fast actor tunnels through a
            // wall between two frames.
            float dist = (float)Math.Sqrt(dx * dx + dy * dy);
            int steps = dist > radius ? (int)Math.Ceiling(dist / radius) : 1;
            float stepX = dx / steps;
            float stepY = dy / steps;

            for (int i = 0; i < steps; i++)
            {
                if (stepX != 0f)
                {
                    float tryX = nx + stepX;
                    if (CircleFits(map, tryX, ny, radius)) nx = tryX;
                    else hitX = true;
                }

                if (stepY != 0f)
                {
                    float tryY = ny + stepY;
                    if (CircleFits(map, nx, tryY, radius)) ny = tryY;
                    else hitY = true;
                }
            }

            return new MoveResult { X = nx, Y = ny, HitX = hitX, HitY = hitY };
        }

        /// <summary>True when a circle overlaps no solid tile.</summary>
        public static bool CircleFits(TileMap map, float x, float y, float radius)
        {
            int minTx = (int)Math.Floor(x - radius);
            int maxTx = (int)Math.Floor(x + radius);
            int minTy = (int)Math.Floor(y - radius);
            int maxTy = (int)Math.Floor(y + radius);

            for (int ty = minTy; ty <= maxTy; ty++)
            {
                for (int tx = minTx; tx <= maxTx; tx++)
                {
                    if (!map.IsSolid(tx, ty)) continue;

                    // Closest point on the tile's box to the circle centre.
                    float cx = x < tx ? tx : (x > tx + 1 ? tx + 1 : x);
                    float cy = y < ty ? ty : (y > ty + 1 ? ty + 1 : y);
                    float ddx = x - cx;
                    float ddy = y - cy;
                    if (ddx * ddx + ddy * ddy < radius * radius) return false;
                }
            }
            return true;
        }

        /// <summary>
        /// Pushes two overlapping actors apart, splitting the displacement.
        /// </summary>
        /// <remarks>
        /// Splitting evenly and validating each side against geometry is what
        /// stops a crowd from shunting one of its members through a wall.
        /// </remarks>
        public static void Separate(TileMap map,
            ref float ax, ref float ay, float aRadius,
            ref float bx, ref float by, float bRadius)
        {
            float dx = bx - ax;
            float dy = by - ay;
            float minDist = aRadius + bRadius;
            float distSq = dx * dx + dy * dy;
            if (distSq >= minDist * minDist || distSq < 1e-8f) return;

            float dist = (float)Math.Sqrt(distSq);
            float overlap = (minDist - dist) * 0.5f;
            float nx = dx / dist;
            float ny = dy / dist;

            float newAx = ax - nx * overlap;
            float newAy = ay - ny * overlap;
            float newBx = bx + nx * overlap;
            float newBy = by + ny * overlap;

            if (CircleFits(map, newAx, newAy, aRadius))
            {
                ax = newAx;
                ay = newAy;
            }
            if (CircleFits(map, newBx, newBy, bRadius))
            {
                bx = newBx;
                by = newBy;
            }
        }
    }
}
