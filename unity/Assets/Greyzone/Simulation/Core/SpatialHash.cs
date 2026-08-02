using System;
using System.Collections.Generic;

namespace Greyzone.Simulation.Core
{
    /// <summary>
    /// Uniform-grid broad phase for "what is near this point" queries.
    /// </summary>
    /// <remarks>
    /// Replaces the O(n^2) scan behind every explosion, bullet and sound event.
    ///
    /// It is rebuilt from scratch every tick rather than maintained
    /// incrementally. With a few hundred actors that is both cheaper and far
    /// more cache-friendly than tracking moves between buckets, and - the part
    /// that actually matters on a phone - it allocates nothing per frame: the
    /// layout is a counting sort over flat arrays sized once at map load.
    /// </remarks>
    public sealed class SpatialHash
    {
        private readonly float _invCellSize;
        private readonly int _cols;
        private readonly int _rows;

        // Counting-sort layout: cellStart[c] .. cellStart[c+1] indexes entries.
        private readonly int[] _cellCount;
        private readonly int[] _cellStart;
        private readonly int[] _entries;
        private readonly float[] _px;
        private readonly float[] _py;

        private readonly int[] _sortedIds;
        private readonly float[] _sortedX;
        private readonly float[] _sortedY;

        private int _count;

        public SpatialHash(int worldWidth, int worldHeight, float cellSize, int maxEntities)
        {
            _invCellSize = 1f / cellSize;
            CellSize = cellSize;
            _cols = Math.Max(1, (int)Math.Ceiling(worldWidth * _invCellSize));
            _rows = Math.Max(1, (int)Math.Ceiling(worldHeight * _invCellSize));

            int cells = _cols * _rows;
            _cellCount = new int[cells];
            _cellStart = new int[cells + 1];
            _entries = new int[maxEntities];
            _px = new float[maxEntities];
            _py = new float[maxEntities];
            _sortedIds = new int[maxEntities];
            _sortedX = new float[maxEntities];
            _sortedY = new float[maxEntities];
        }

        public float CellSize { get; }

        /// <summary>Begins a rebuild. Call once per tick before inserting.</summary>
        public void Begin()
        {
            _count = 0;
            Array.Clear(_cellCount, 0, _cellCount.Length);
        }

        /// <summary>Stages an entity. <paramref name="id"/> is any caller-defined handle.</summary>
        public void Insert(int id, float x, float y)
        {
            if (_count >= _entries.Length) return;
            int i = _count++;
            _entries[i] = id;
            _px[i] = x;
            _py[i] = y;
            _cellCount[CellIndex(x, y)]++;
        }

        /// <summary>Finalises the counting sort. Must run before any query.</summary>
        public void Build()
        {
            int running = 0;
            for (int c = 0; c < _cellCount.Length; c++)
            {
                _cellStart[c] = running;
                running += _cellCount[c];
            }
            _cellStart[_cellCount.Length] = running;

            // Reuse the count array as a per-cell write cursor.
            int[] cursor = _cellCount;
            for (int c = 0; c < cursor.Length; c++) cursor[c] = _cellStart[c];

            for (int i = 0; i < _count; i++)
            {
                int c = CellIndex(_px[i], _py[i]);
                int dst = cursor[c]++;
                _sortedIds[dst] = _entries[i];
                _sortedX[dst] = _px[i];
                _sortedY[dst] = _py[i];
            }

            Array.Copy(_sortedIds, _entries, _count);
            Array.Copy(_sortedX, _px, _count);
            Array.Copy(_sortedY, _py, _count);
        }

        /// <summary>
        /// Collects ids within <paramref name="radius"/> of a point. Results are
        /// appended to <paramref name="results"/>, which is cleared first.
        /// </summary>
        public int QueryRadius(float x, float y, float radius, List<int> results)
        {
            results.Clear();
            float r2 = radius * radius;

            int minCx = ClampCol((int)Math.Floor((x - radius) * _invCellSize));
            int maxCx = ClampCol((int)Math.Floor((x + radius) * _invCellSize));
            int minCy = ClampRow((int)Math.Floor((y - radius) * _invCellSize));
            int maxCy = ClampRow((int)Math.Floor((y + radius) * _invCellSize));

            for (int cy = minCy; cy <= maxCy; cy++)
            {
                int rowBase = cy * _cols;
                for (int cx = minCx; cx <= maxCx; cx++)
                {
                    int c = rowBase + cx;
                    int start = _cellStart[c];
                    int end = _cellStart[c + 1];
                    for (int i = start; i < end; i++)
                    {
                        if (Math2D.DistanceSq(x, y, _px[i], _py[i]) <= r2) results.Add(_entries[i]);
                    }
                }
            }
            return results.Count;
        }

        private int CellIndex(float x, float y)
        {
            int cx = ClampCol((int)Math.Floor(x * _invCellSize));
            int cy = ClampRow((int)Math.Floor(y * _invCellSize));
            return cy * _cols + cx;
        }

        private int ClampCol(int c) => c < 0 ? 0 : (c >= _cols ? _cols - 1 : c);

        private int ClampRow(int r) => r < 0 ? 0 : (r >= _rows ? _rows - 1 : r);
    }
}
