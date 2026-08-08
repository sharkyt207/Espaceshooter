using System;
using System.Collections.Generic;
using Greyzone.Simulation.Core;

namespace Greyzone.Simulation.World
{
    public struct PathResult
    {
        /// <summary>World-space waypoints, already smoothed. Empty when unreachable.</summary>
        public List<Vec2> Points;
        public bool Found;
    }

    /// <summary>
    /// Navigation for every AI on the map.
    /// </summary>
    /// <remarks>
    /// Two complementary tools, because they solve different problems:
    ///
    /// <list type="bullet">
    /// <item><b>A*</b> for individual, arbitrary destinations - go to that
    /// cover, go investigate that noise. Costly, so the director budgets
    /// requests per frame; a phone cannot afford twenty simultaneous
    /// searches.</item>
    /// <item><b>Flow field</b> for "everyone move towards the player". One
    /// Dijkstra pass gives every tile a direction that any number of AI read
    /// for free. This is what keeps a thirty-AI raid at 60 FPS.</item>
    /// </list>
    ///
    /// Kept instead of Unity's NavMesh on purpose: it is deterministic, it is
    /// budgetable per frame, and it shares the exact cost data the rest of the
    /// simulation uses.
    /// </remarks>
    public sealed class NavGrid
    {
        private const float Sqrt2 = 1.41421356237f;

        // Four cardinal neighbours first (cheaper), then four diagonals.
        private static readonly int[] NX = { 0, 1, 0, -1, 1, 1, -1, -1 };
        private static readonly int[] NY = { -1, 0, 1, 0, -1, 1, 1, -1 };
        private static readonly float[] NCost = { 1f, 1f, 1f, 1f, Sqrt2, Sqrt2, Sqrt2, Sqrt2 };

        public readonly int Width;
        public readonly int Height;
        private readonly TileMap _map;

        /// <summary>Per-tile traversal cost; infinity means blocked.</summary>
        private readonly float[] _cost;

        // A* working set, reused across searches and never reallocated.
        private readonly float[] _gScore;
        private readonly float[] _fScore;
        private readonly int[] _cameFrom;
        private readonly int[] _visitedStamp;

        /// <summary>
        /// Closed set, stamped like <c>_visitedStamp</c>.
        /// </summary>
        /// <remarks>
        /// Essential, not an optimisation. Decrease-key is implemented by
        /// re-pushing an improved node, so the heap holds stale duplicates whose
        /// position no longer matches their current fScore. Without closing a
        /// node when it is popped, those duplicates get expanded again and relax
        /// their neighbours again; the search thrashes until it exhausts its node
        /// budget and reports a perfectly reachable goal as unreachable. This was
        /// a real defect in the prototype and it silently degraded AI pathing
        /// across the whole map.
        ///
        /// The octile heuristic is consistent for our cost range - every walkable
        /// tile costs at least 1 - so closing on first pop is also optimal.
        /// </remarks>
        private readonly int[] _closedStamp;

        private int _stamp;

        private readonly int[] _heap;
        private int _heapSize;

        // Flow field.
        private readonly float[] _flowDist;
        private readonly sbyte[] _flowDir;
        private readonly int[] _bfsQueue;
        private int _flowTargetX = -1;
        private int _flowTargetY = -1;

        public NavGrid(TileMap map)
        {
            _map = map;
            Width = map.Width;
            Height = map.Height;
            int n = map.Width * map.Height;

            _cost = new float[n];
            _gScore = new float[n];
            _fScore = new float[n];
            _cameFrom = new int[n];
            _visitedStamp = new int[n];
            _closedStamp = new int[n];

            // The heap must hold duplicates: decrease-key is a re-push, so a node
            // can appear once per incoming edge. Eight-way movement bounds that
            // at 8n. Sizing it at n silently dropped pushes and corrupted the
            // search order.
            _heap = new int[n * 8];

            _flowDist = new float[n];
            _flowDir = new sbyte[n];
            _bfsQueue = new int[n];

            RebuildCosts();
        }

        /// <summary>Recomputes traversal costs. Call after doors change.</summary>
        public void RebuildCosts()
        {
            for (int y = 0; y < Height; y++)
            {
                for (int x = 0; x < Width; x++)
                {
                    int i = y * Width + x;
                    if (_map.IsSolid(x, y))
                    {
                        _cost[i] = float.PositiveInfinity;
                    }
                    else
                    {
                        // Water and rubble are passable but slow, so AI route
                        // around them unless the detour is long - which is how a
                        // person would move.
                        float c = _map.MoveCostOf(x, y);
                        if (_map.At(x, y) == Tile.Water) c *= 1.6f;
                        _cost[i] = c;
                    }
                }
            }

            // Soft-inflate near obstacles so AI stop hugging corners and
            // clipping shoulders on doorframes.
            var inflated = new float[_cost.Length];
            Array.Copy(_cost, inflated, _cost.Length);
            for (int y = 1; y < Height - 1; y++)
            {
                for (int x = 1; x < Width - 1; x++)
                {
                    int i = y * Width + x;
                    if (float.IsInfinity(_cost[i])) continue;
                    int walls = 0;
                    for (int k = 0; k < 8; k++)
                    {
                        if (float.IsInfinity(_cost[(y + NY[k]) * Width + (x + NX[k])])) walls++;
                    }
                    if (walls > 0) inflated[i] = _cost[i] + walls * 0.18f;
                }
            }
            Array.Copy(inflated, _cost, _cost.Length);
        }

        public bool IsWalkable(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height) return false;
            return !float.IsInfinity(_cost[y * Width + x]);
        }

        // ===================================================================
        // A*
        // ===================================================================

        /// <summary>
        /// Finds a path in tile space.
        /// </summary>
        /// <remarks>
        /// <paramref name="maxNodes"/> bounds the search so a hopeless request
        /// cannot stall a frame. On exhaustion the closest approach is returned
        /// with <c>Found = false</c>, which keeps the AI committing to a
        /// direction rather than freezing on the spot.
        /// </remarks>
        public PathResult FindPath(float sx, float sy, float tx, float ty, int maxNodes = 3000)
        {
            int startX = (int)Math.Floor(sx);
            int startY = (int)Math.Floor(sy);
            int goalX = (int)Math.Floor(tx);
            int goalY = (int)Math.Floor(ty);

            if (!IsWalkable(goalX, goalY))
            {
                if (!_map.NearestOpen(goalX, goalY, 6, out goalX, out goalY))
                {
                    return new PathResult { Points = new List<Vec2>(), Found = false };
                }
            }

            if (!IsWalkable(startX, startY))
            {
                if (!_map.NearestOpen(startX, startY, 6, out startX, out startY))
                {
                    return new PathResult { Points = new List<Vec2>(), Found = false };
                }
            }

            int startIdx = startY * Width + startX;
            int goalIdx = goalY * Width + goalX;
            if (startIdx == goalIdx)
            {
                return new PathResult { Points = new List<Vec2> { new Vec2(tx, ty) }, Found = true };
            }

            int stamp = ++_stamp;
            _heapSize = 0;
            _gScore[startIdx] = 0f;
            _fScore[startIdx] = Heuristic(startX, startY, goalX, goalY);
            _cameFrom[startIdx] = -1;
            _visitedStamp[startIdx] = stamp;
            HeapPush(startIdx);

            int expanded = 0;
            int bestIdx = startIdx;
            float bestH = _fScore[startIdx];

            while (_heapSize > 0 && expanded < maxNodes)
            {
                int current = HeapPop();

                // Stale duplicate from a decrease-key: already expanded.
                if (_closedStamp[current] == stamp) continue;
                _closedStamp[current] = stamp;

                if (current == goalIdx) return Reconstruct(current, tx, ty);
                expanded++;

                int cx = current % Width;
                int cy = current / Width;
                float g = _gScore[current];

                for (int k = 0; k < 8; k++)
                {
                    int nx = cx + NX[k];
                    int ny = cy + NY[k];
                    if (nx < 0 || ny < 0 || nx >= Width || ny >= Height) continue;

                    int ni = ny * Width + nx;
                    float tileCost = _cost[ni];
                    if (float.IsInfinity(tileCost)) continue;
                    if (_closedStamp[ni] == stamp) continue;

                    // No corner cutting: a diagonal is legal only when both
                    // orthogonal neighbours are open, otherwise AI slide
                    // through wall seams.
                    if (k >= 4)
                    {
                        if (float.IsInfinity(_cost[cy * Width + nx]) ||
                            float.IsInfinity(_cost[ny * Width + cx])) continue;
                    }

                    float tentative = g + NCost[k] * tileCost;
                    if (_visitedStamp[ni] != stamp || tentative < _gScore[ni])
                    {
                        _visitedStamp[ni] = stamp;
                        _gScore[ni] = tentative;
                        float h = Heuristic(nx, ny, goalX, goalY);
                        _fScore[ni] = tentative + h;
                        _cameFrom[ni] = current;
                        HeapPush(ni);

                        if (h < bestH)
                        {
                            bestH = h;
                            bestIdx = ni;
                        }
                    }
                }
            }

            if (bestIdx != startIdx)
            {
                PathResult partial = Reconstruct(bestIdx, bestIdx % Width + 0.5f, bestIdx / Width + 0.5f);
                partial.Found = false;
                return partial;
            }

            return new PathResult { Points = new List<Vec2>(), Found = false };
        }

        /// <summary>Octile distance - the admissible heuristic for 8-way movement.</summary>
        private static float Heuristic(int ax, int ay, int bx, int by)
        {
            float dx = Math.Abs(ax - bx);
            float dy = Math.Abs(ay - by);
            return dx > dy ? dx + (Sqrt2 - 1f) * dy : dy + (Sqrt2 - 1f) * dx;
        }

        private PathResult Reconstruct(int goalIdx, float exactX, float exactY)
        {
            var raw = new List<int>();
            int node = goalIdx;
            while (node != -1)
            {
                raw.Add(node);
                node = _cameFrom[node];
            }
            raw.Reverse();

            // String-pulling: drop waypoints we can walk to directly. Turns the
            // blocky grid path into a natural route and cuts steering jitter.
            var points = new List<Vec2> { TileCenter(raw[0]) };
            int anchor = 0;
            while (anchor < raw.Count - 1)
            {
                int farthest = anchor + 1;
                for (int probe = raw.Count - 1; probe > anchor; probe--)
                {
                    Vec2 a = TileCenter(raw[anchor]);
                    Vec2 b = TileCenter(raw[probe]);
                    if (HasClearWalk(a.X, a.Y, b.X, b.Y))
                    {
                        farthest = probe;
                        break;
                    }
                }
                points.Add(TileCenter(raw[farthest]));
                anchor = farthest;
            }

            points[points.Count - 1] = new Vec2(exactX, exactY);
            if (points.Count > 1) points.RemoveAt(0); // drop the tile we stand on

            return new PathResult { Points = points, Found = true };
        }

        private Vec2 TileCenter(int idx) => new Vec2(idx % Width + 0.5f, idx / Width + 0.5f);

        /// <summary>
        /// Conservative walkability test between two world points.
        /// </summary>
        /// <remarks>
        /// Samples the centre plus both shoulders, so path smoothing never
        /// routes an actor through a gap narrower than its own body.
        /// </remarks>
        public bool HasClearWalk(float ax, float ay, float bx, float by, float radius = 0.32f)
        {
            float dx = bx - ax;
            float dy = by - ay;
            float dist = (float)Math.Sqrt(dx * dx + dy * dy);
            if (dist < 1e-4f) return true;

            float nx = -dy / dist;
            float ny = dx / dist;
            int steps = (int)Math.Ceiling(dist * 3f);

            for (int i = 0; i <= steps; i++)
            {
                float t = (float)i / steps;
                float px = ax + dx * t;
                float py = ay + dy * t;
                if (_map.IsSolidAt(px, py)) return false;
                if (_map.IsSolidAt(px + nx * radius, py + ny * radius)) return false;
                if (_map.IsSolidAt(px - nx * radius, py - ny * radius)) return false;
            }
            return true;
        }

        // --- binary min-heap keyed on fScore --------------------------------

        private void HeapPush(int idx)
        {
            // Never write past the buffer: dropping a push degrades the path,
            // whereas an out-of-range write would corrupt the heap invariant.
            if (_heapSize >= _heap.Length) return;

            int i = _heapSize++;
            float f = _fScore[idx];
            while (i > 0)
            {
                int parent = (i - 1) >> 1;
                if (_fScore[_heap[parent]] <= f) break;
                _heap[i] = _heap[parent];
                i = parent;
            }
            _heap[i] = idx;
        }

        private int HeapPop()
        {
            int top = _heap[0];
            int last = _heap[--_heapSize];
            if (_heapSize > 0)
            {
                int i = 0;
                float f = _fScore[last];
                while (true)
                {
                    int l = 2 * i + 1;
                    if (l >= _heapSize) break;
                    int r = l + 1;
                    int child = r < _heapSize && _fScore[_heap[r]] < _fScore[_heap[l]] ? r : l;
                    if (_fScore[_heap[child]] >= f) break;
                    _heap[i] = _heap[child];
                    i = child;
                }
                _heap[i] = last;
            }
            return top;
        }

        // ===================================================================
        // Flow field
        // ===================================================================

        /// <summary>
        /// Rebuilds the shared flow field towards a target.
        /// </summary>
        /// <remarks>
        /// Skipped when the target has not changed tile since the last build, so
        /// a player standing still costs nothing at all.
        /// </remarks>
        public bool BuildFlowField(float tx, float ty, bool force = false)
        {
            int gx = (int)Math.Floor(tx);
            int gy = (int)Math.Floor(ty);
            if (!force && gx == _flowTargetX && gy == _flowTargetY) return false;

            if (!IsWalkable(gx, gy))
            {
                if (!_map.NearestOpen(gx, gy, 8, out gx, out gy)) return false;
            }
            return BuildFlowFieldAt(gx, gy);
        }

        private bool BuildFlowFieldAt(int gx, int gy)
        {
            _flowTargetX = gx;
            _flowTargetY = gy;

            for (int i = 0; i < _flowDist.Length; i++)
            {
                _flowDist[i] = float.PositiveInfinity;
                _flowDir[i] = -1;
            }

            int head = 0;
            int tail = 0;
            int start = gy * Width + gx;
            _flowDist[start] = 0f;
            _bfsQueue[tail++] = start;

            while (head < tail)
            {
                int current = _bfsQueue[head++];
                int cx = current % Width;
                int cy = current / Width;
                float d = _flowDist[current];

                for (int k = 0; k < 8; k++)
                {
                    int nx = cx + NX[k];
                    int ny = cy + NY[k];
                    if (nx < 0 || ny < 0 || nx >= Width || ny >= Height) continue;

                    int ni = ny * Width + nx;
                    float c = _cost[ni];
                    if (float.IsInfinity(c)) continue;
                    if (k >= 4)
                    {
                        if (float.IsInfinity(_cost[cy * Width + nx]) ||
                            float.IsInfinity(_cost[ny * Width + cx])) continue;
                    }

                    float nd = d + NCost[k] * c;
                    if (nd < _flowDist[ni] - 1e-4f)
                    {
                        _flowDist[ni] = nd;
                        // Store the direction pointing back towards the goal.
                        _flowDir[ni] = (sbyte)OppositeDir(k);
                        if (tail < _bfsQueue.Length) _bfsQueue[tail++] = ni;
                    }
                }
            }
            return true;
        }

        /// <summary>Reads the flow direction as a unit vector; false when unreachable.</summary>
        public bool SampleFlow(int x, int y, out float dx, out float dy)
        {
            dx = 0f;
            dy = 0f;
            if (x < 0 || y < 0 || x >= Width || y >= Height) return false;

            sbyte dir = _flowDir[y * Width + x];
            if (dir < 0) return false;

            float ox = NX[dir];
            float oy = NY[dir];
            float len = (float)Math.Sqrt(ox * ox + oy * oy);
            if (len <= 0f) len = 1f;
            dx = ox / len;
            dy = oy / len;
            return true;
        }

        /// <summary>Path cost from a tile to the flow target, or infinity.</summary>
        public float FlowCostAt(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height) return float.PositiveInfinity;
            return _flowDist[y * Width + x];
        }

        private static int OppositeDir(int k)
            // Cardinals 0..3 are N,E,S,W; diagonals 4..7 are NE,SE,SW,NW.
            => k < 4 ? (k + 2) % 4 : (k - 4 + 2) % 4 + 4;
    }

    /// <summary>
    /// Precomputed tactical value of every tile.
    /// </summary>
    /// <remarks>
    /// For each walkable tile we record which of the eight compass directions is
    /// protected by geometry, and how tall that protection is. Cover selection
    /// then becomes a lookup instead of a raycast storm every time someone takes
    /// fire - which is what makes cover behaviour affordable for a whole squad.
    /// </remarks>
    public sealed class CoverMap
    {
        private static readonly int[] NX = { 0, 1, 0, -1, 1, 1, -1, -1 };
        private static readonly int[] NY = { -1, 0, 1, 0, -1, 1, 1, -1 };

        public readonly int Width;
        public readonly int Height;

        /// <summary>Bit k set = direction k is covered to at least crouch height.</summary>
        private readonly byte[] _mask;
        /// <summary>Bit k set = that cover is full standing height.</summary>
        private readonly byte[] _fullMask;
        /// <summary>0..255 "how sheltered is this tile", for scoring and sorting.</summary>
        public readonly byte[] Score;

        public CoverMap(TileMap map)
        {
            Width = map.Width;
            Height = map.Height;
            int n = map.Width * map.Height;
            _mask = new byte[n];
            _fullMask = new byte[n];
            Score = new byte[n];
            Build(map);
        }

        private void Build(TileMap map)
        {
            for (int y = 0; y < Height; y++)
            {
                for (int x = 0; x < Width; x++)
                {
                    int i = y * Width + x;
                    if (map.IsSolid(x, y)) continue;

                    int m = 0;
                    int fm = 0;
                    int covered = 0;

                    for (int k = 0; k < 8; k++)
                    {
                        float h = map.HeightOf(x + NX[k], y + NY[k]);
                        if (h >= 0.9f)
                        {
                            m |= 1 << k;
                            covered++;
                            if (h >= 1.7f) fm |= 1 << k;
                        }
                    }

                    _mask[i] = (byte)m;
                    _fullMask[i] = (byte)fm;

                    // The best positions are covered on two to four sides:
                    // sheltered, but with an exit and a firing angle. A fully
                    // boxed-in tile scores poorly - that is a trap, not cover.
                    int ideal = covered == 0 ? 0 : (covered <= 4 ? covered * 60 : Math.Max(0, 300 - covered * 45));
                    Score[i] = (byte)Math.Min(255, ideal);
                }
            }
        }

        /// <summary>
        /// Does this tile shelter an actor from a threat on the given bearing?
        /// </summary>
        /// <param name="dirX">Points from the tile towards the threat.</param>
        /// <param name="dirY">Points from the tile towards the threat.</param>
        public bool CoversFrom(int x, int y, float dirX, float dirY, bool requireFull = false)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height) return false;

            int i = y * Width + x;
            int m = requireFull ? _fullMask[i] : _mask[i];
            if (m == 0) return false;

            // Accept the closest compass direction and its two neighbours: real
            // cover protects an arc, not a single ray.
            int k = DirToIndex(dirX, dirY);
            int kl = k < 4 ? (k + 3) % 4 : (k - 4 + 3) % 4 + 4;
            int kr = k < 4 ? (k + 1) % 4 : (k - 4 + 1) % 4 + 4;
            return (m & (1 << k)) != 0 || (m & (1 << kl)) != 0 || (m & (1 << kr)) != 0;
        }

        public byte ScoreAt(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height) return 0;
            return Score[y * Width + x];
        }

        /// <summary>Maps a direction onto the nearest of the eight neighbour indices.</summary>
        private static int DirToIndex(float dx, float dy)
        {
            double ang = Math.Atan2(dy, dx);
            int oct = (int)((Math.Round(ang / (Math.PI / 4.0)) + 8) % 8 + 8) % 8;
            // oct 0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE
            int[] table = { 1, 5, 2, 6, 3, 7, 0, 4 };
            return table[oct];
        }
    }
}
