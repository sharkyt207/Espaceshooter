using System;
using System.Runtime.CompilerServices;

namespace Greyzone.Simulation.Core
{
    /// <summary>
    /// Allocation-free 2D maths shared by the whole simulation.
    /// </summary>
    /// <remarks>
    /// The simulation runs on a flat plane with a separate scalar height used
    /// only for bullet and eye elevation. Our (x, y) is Unity's (x, z), so a
    /// world position converts with <c>new Vector3(p.X, height, p.Y)</c> and
    /// nothing here needs to know that.
    ///
    /// Every method is pure and allocation-free: ballistics and AI call these
    /// thousands of times per tick.
    /// </remarks>
    public static class Math2D
    {
        public const float Tau = (float)(Math.PI * 2.0);
        public const float Deg2Rad = (float)(Math.PI / 180.0);
        public const float Rad2Deg = (float)(180.0 / Math.PI);
        public const float Pi = (float)Math.PI;

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Clamp(float v, float min, float max) => v < min ? min : (v > max ? max : v);

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static int Clamp(int v, int min, int max) => v < min ? min : (v > max ? max : v);

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Clamp01(float v) => v < 0f ? 0f : (v > 1f ? 1f : v);

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Lerp(float a, float b, float t) => a + (b - a) * t;

        public static float InverseLerp(float a, float b, float v)
            => a == b ? 0f : Clamp01((v - a) / (b - a));

        /// <summary>
        /// Frame-rate independent exponential smoothing: <paramref name="rate"/>
        /// is the fraction of the remaining gap closed per second.
        /// </summary>
        /// <remarks>
        /// Using this instead of a raw <c>Lerp(current, target, 0.1f)</c> is what
        /// keeps camera and aim smoothing identical at 60 and 120 FPS.
        /// </remarks>
        public static float Damp(float current, float target, float rate, float dt)
            => Lerp(current, target, 1f - (float)Math.Exp(-rate * dt));

        public static float MoveTowards(float current, float target, float maxDelta)
        {
            float d = target - current;
            if (Math.Abs(d) <= maxDelta) return target;
            return current + Math.Sign(d) * maxDelta;
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float Distance(float ax, float ay, float bx, float by)
        {
            float dx = bx - ax;
            float dy = by - ay;
            return (float)Math.Sqrt(dx * dx + dy * dy);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static float DistanceSq(float ax, float ay, float bx, float by)
        {
            float dx = bx - ax;
            float dy = by - ay;
            return dx * dx + dy * dy;
        }

        /// <summary>Wraps an angle into (-PI, PI].</summary>
        public static float WrapAngle(float a)
        {
            a = (a + Pi) % Tau;
            if (a < 0f) a += Tau;
            return a - Pi;
        }

        /// <summary>Shortest signed delta from one heading to another, in radians.</summary>
        public static float AngleDelta(float from, float to) => WrapAngle(to - from);

        /// <summary>Rotates towards a heading by at most <paramref name="maxDelta"/> radians.</summary>
        public static float RotateTowards(float current, float target, float maxDelta)
        {
            float d = AngleDelta(current, target);
            if (Math.Abs(d) <= maxDelta) return WrapAngle(target);
            return WrapAngle(current + Math.Sign(d) * maxDelta);
        }

        public static float AngleLerp(float a, float b, float t) => WrapAngle(a + AngleDelta(a, b) * t);

        /// <summary>Smooth Hermite interpolation, used for falloff curves.</summary>
        public static float Smoothstep(float edge0, float edge1, float x)
        {
            float t = Clamp01((x - edge0) / (edge1 - edge0));
            return t * t * (3f - 2f * t);
        }

        public static float Remap(float v, float inMin, float inMax, float outMin, float outMax)
            => Lerp(outMin, outMax, InverseLerp(inMin, inMax, v));

        public static bool CirclesOverlap(float ax, float ay, float ar, float bx, float by, float br)
        {
            float r = ar + br;
            return DistanceSq(ax, ay, bx, by) <= r * r;
        }

        /// <summary>
        /// Squared distance from a point to a segment.
        /// </summary>
        /// <remarks>
        /// This is the hot path for bullet-versus-actor tests: a round's travel
        /// over one tick is a segment, and "did it pass within body radius" is
        /// exactly this comparison. Clamping to the segment (rather than the
        /// infinite line) is what stops a shot from registering behind you.
        /// </remarks>
        public static float PointSegmentDistSq(float px, float py, float ax, float ay, float bx, float by)
        {
            float abx = bx - ax;
            float aby = by - ay;
            float apx = px - ax;
            float apy = py - ay;
            float lenSq = abx * abx + aby * aby;
            float t = lenSq > 0f ? Clamp01((apx * abx + apy * aby) / lenSq) : 0f;
            float cx = ax + abx * t;
            float cy = ay + aby * t;
            return DistanceSq(px, py, cx, cy);
        }

        /// <summary>Normalises in place and returns the original length.</summary>
        public static float Normalize(ref float x, ref float y)
        {
            float len = (float)Math.Sqrt(x * x + y * y);
            if (len > 1e-6f)
            {
                x /= len;
                y /= len;
            }
            return len;
        }

        /// <summary>Clamps a vector's magnitude in place.</summary>
        public static void ClampMagnitude(ref float x, ref float y, float max)
        {
            float lenSq = x * x + y * y;
            if (lenSq > max * max)
            {
                float s = max / (float)Math.Sqrt(lenSq);
                x *= s;
                y *= s;
            }
        }
    }

    /// <summary>
    /// Plain 2D point on the simulation plane.
    /// </summary>
    /// <remarks>
    /// A struct rather than a class so paths, waypoints and spawn lists do not
    /// each become a few hundred heap allocations per raid.
    /// </remarks>
    public readonly struct Vec2 : IEquatable<Vec2>
    {
        public readonly float X;
        public readonly float Y;

        public Vec2(float x, float y)
        {
            X = x;
            Y = y;
        }

        public static Vec2 operator +(Vec2 a, Vec2 b) => new Vec2(a.X + b.X, a.Y + b.Y);
        public static Vec2 operator -(Vec2 a, Vec2 b) => new Vec2(a.X - b.X, a.Y - b.Y);
        public static Vec2 operator *(Vec2 a, float s) => new Vec2(a.X * s, a.Y * s);

        public float Length => (float)Math.Sqrt(X * X + Y * Y);

        public bool Equals(Vec2 other) => X.Equals(other.X) && Y.Equals(other.Y);

        public override bool Equals(object obj) => obj is Vec2 other && Equals(other);

        public override int GetHashCode()
        {
            unchecked
            {
                return (X.GetHashCode() * 397) ^ Y.GetHashCode();
            }
        }

        public override string ToString() => $"({X:0.##}, {Y:0.##})";
    }
}
