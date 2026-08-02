using System;
using System.Collections.Generic;

namespace Greyzone.Simulation.Core
{
    /// <summary>
    /// Seeded, deterministic PRNG (xoshiro128**).
    /// </summary>
    /// <remarks>
    /// Every system that needs randomness takes an <see cref="Rng"/> rather than
    /// calling <c>UnityEngine.Random</c>. That buys two things:
    ///
    /// <list type="bullet">
    /// <item>Reproducible raids from a seed, which is what makes a bug report
    /// actionable and a balance change measurable.</item>
    /// <item>Independent streams, so spawning more particles can never desync a
    /// loot roll.</item>
    /// </list>
    ///
    /// The arithmetic is deliberately bit-identical to the TypeScript prototype:
    /// the same seed produces the same map, the same loot and the same enemy
    /// loadouts in both, which is how the port is checked against the original.
    /// </remarks>
    public sealed class Rng
    {
        private uint _s0, _s1, _s2, _s3;

        public Rng(int seed) => Reseed(unchecked((uint)seed));

        public Rng(uint seed) => Reseed(seed);

        public Rng(string seed) => Reseed(HashString(seed));

        public void Reseed(uint seed)
        {
            // SplitMix32 expansion, so a small seed still fills all four words.
            uint h = seed != 0 ? seed : 1u;
            _s0 = h = SplitMix32(h);
            _s1 = h = SplitMix32(h);
            _s2 = h = SplitMix32(h);
            _s3 = SplitMix32(h);

            // Discard the first outputs to escape low-entropy start states.
            for (int i = 0; i < 8; i++) Next();
            _hasSpare = false;
        }

        /// <summary>Raw 32-bit output.</summary>
        public uint Next()
        {
            uint result = unchecked(Rotl(unchecked(_s1 * 5u), 7) * 9u);
            uint t = _s1 << 9;
            _s2 ^= _s0;
            _s3 ^= _s1;
            _s1 ^= _s2;
            _s0 ^= _s3;
            _s2 ^= t;
            _s3 = Rotl(_s3, 11);
            return result;
        }

        /// <summary>Uniform value in [0, 1).</summary>
        public float Float() => (float)(Next() / 4294967296.0);

        /// <summary>Uniform value in [min, max).</summary>
        public float Range(float min, float max) => min + Float() * (max - min);

        /// <summary>Uniform integer in [min, max], inclusive.</summary>
        public int Int(int min, int max) => min + (int)(Float() * (max - min + 1));

        /// <summary>True with the given probability.</summary>
        public bool Chance(float p) => Float() < p;

        public T Pick<T>(IReadOnlyList<T> items) => items[(int)(Float() * items.Count)];

        /// <summary>
        /// Weighted pick. Weights need not sum to one; returns
        /// <c>default</c> only when every weight is non-positive.
        /// </summary>
        public T Weighted<T>(IReadOnlyList<T> items, IReadOnlyList<float> weights)
        {
            float total = 0f;
            for (int i = 0; i < items.Count; i++)
            {
                float w = i < weights.Count ? weights[i] : 0f;
                if (w > 0f) total += w;
            }
            if (total <= 0f) return default;

            float roll = Float() * total;
            for (int i = 0; i < items.Count; i++)
            {
                float w = i < weights.Count ? weights[i] : 0f;
                if (w > 0f) roll -= w;
                if (roll <= 0f) return items[i];
            }
            return items[items.Count - 1];
        }

        /// <summary>Fisher-Yates shuffle in place.</summary>
        public IList<T> Shuffle<T>(IList<T> list)
        {
            for (int i = list.Count - 1; i > 0; i--)
            {
                int j = (int)(Float() * (i + 1));
                T tmp = list[i];
                list[i] = list[j];
                list[j] = tmp;
            }
            return list;
        }

        private bool _hasSpare;
        private float _spare;

        /// <summary>
        /// Standard-normal sample (Box-Muller with a cached pair).
        /// </summary>
        /// <remarks>
        /// Used for recoil, dispersion and AI aim error. A bell curve reads as
        /// "mostly near point of aim, occasionally a flyer", which feels like
        /// bad luck; a flat roll feels like the game is cheating.
        /// </remarks>
        public float Gaussian(float mean = 0f, float stdDev = 1f)
        {
            if (_hasSpare)
            {
                _hasSpare = false;
                return mean + _spare * stdDev;
            }

            float u, v, s;
            do
            {
                u = Float() * 2f - 1f;
                v = Float() * 2f - 1f;
                s = u * u + v * v;
            }
            while (s >= 1f || s == 0f);

            float mul = (float)Math.Sqrt(-2.0 * Math.Log(s) / s);
            _spare = v * mul;
            _hasSpare = true;
            return mean + u * mul * stdDev;
        }

        /// <summary>Gaussian truncated to +/- <paramref name="sigmas"/>.</summary>
        /// <remarks>Keeps a rare extreme sample from producing a shot that
        /// misses by an amount the player would read as a bug.</remarks>
        public float GaussianClamped(float mean, float stdDev, float sigmas = 2.5f)
        {
            float raw = Gaussian(0f, 1f);
            float c = raw < -sigmas ? -sigmas : (raw > sigmas ? sigmas : raw);
            return mean + c * stdDev;
        }

        /// <summary>Random unit-circle direction.</summary>
        public void Direction(out float x, out float y)
        {
            float a = Float() * Math2D.Tau;
            x = (float)Math.Cos(a);
            y = (float)Math.Sin(a);
        }

        private static uint Rotl(uint x, int k) => (x << k) | (x >> (32 - k));

        private static uint SplitMix32(uint a)
        {
            unchecked
            {
                a += 0x9e3779b9u;
                uint t = a ^ (a >> 16);
                t *= 0x21f0aaadu;
                t ^= t >> 15;
                t *= 0x735a2d97u;
                return t ^ (t >> 15);
            }
        }

        /// <summary>FNV-1a, so a string seed is stable across runs and platforms.</summary>
        public static uint HashString(string s)
        {
            unchecked
            {
                uint h = 2166136261u;
                for (int i = 0; i < s.Length; i++)
                {
                    h ^= s[i];
                    h *= 16777619u;
                }
                return h != 0 ? h : 1u;
            }
        }
    }
}
