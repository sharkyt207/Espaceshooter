using System;
using System.Collections.Generic;

namespace Greyzone.Simulation.World
{
    public enum TimeOfDay
    {
        Day,
        Dawn,
        Dusk,
        Night,
    }

    public enum Weather
    {
        Clear,
        Overcast,
        Fog,
        Rain,
        Storm,
    }

    /// <summary>Per-time-of-day constants.</summary>
    public struct TimeProfile
    {
        public TimeOfDay Id;
        public string Label;
        public string Blurb;
        /// <summary>Multiplies the blueprint's sky ambient.</summary>
        public float AmbientScale;
        /// <summary>Multiplies lamp contribution - street lighting is off by day.</summary>
        public float LampScale;
        /// <summary>Absolute floor on the lightmap so nothing is pure black.</summary>
        public byte MinLight;
        public int SkyTop;
        public int SkyHorizon;
        public int FogColor;
        public float SightScale;
        public float SoundScale;
        public float RewardScale;
    }

    /// <summary>Per-weather constants.</summary>
    public struct WeatherProfile
    {
        public Weather Id;
        public string Label;
        public string Blurb;
        public float FogDensityAdd;
        public int TintColor;
        public float Tint;
        public float AmbientScale;
        public float SightScale;
        public float SoundScale;
        public float RewardScale;
        public float Precipitation;
        public float Wind;
        public bool Thunder;
        public int Weight;
    }

    /// <summary>Resolved conditions for one raid.</summary>
    public struct RaidConditions
    {
        public TimeOfDay Time;
        public Weather Weather;
        public string Label;
        public float AmbientScale;
        public float LampScale;
        public byte MinLight;
        public float FogDensity;
        public int FogColor;
        public int SkyTop;
        public int SkyHorizon;
        public float SightScale;
        public float SoundScale;
        public float RewardScale;
        public float Precipitation;
        public float Wind;
        public bool Thunder;
        public bool DarkEnoughForLight;
    }

    /// <summary>
    /// The time of day and weather a raid runs under.
    /// </summary>
    /// <remarks>
    /// One table that every system reads, rather than five systems each
    /// inventing their own idea of "night". The same numbers drive the baked
    /// lightmap, fog and sky, how far AI can see, how far sound carries, and
    /// what the raid pays out.
    ///
    /// That last one is the point: a night raid in a storm is a genuinely harder
    /// deployment that pays genuinely better, and the only way to see in it is a
    /// weapon light that also tells every hostile on the map exactly where you
    /// are.
    ///
    /// Conditions never touch map layout, so the same seed produces the same
    /// ground under every sky.
    ///
    /// Values are kept identical to the TypeScript prototype
    /// (<c>src/world/Conditions.ts</c>) so balancing measurements transfer.
    /// </remarks>
    public static class Conditions
    {
        /// <summary>Baseline fog density; weather adds to it.</summary>
        public const float BaseFogDensity = 0.055f;

        public static readonly TimeProfile[] Times =
        {
            new TimeProfile
            {
                Id = TimeOfDay.Day, Label = "Tag",
                Blurb = "Volle Sicht in beide Richtungen. Sicherster Einsatz, geringster Ertrag.",
                AmbientScale = 1f, LampScale = 0.25f, MinLight = 0,
                SkyTop = 0x2c3442, SkyHorizon = 0x8c94a0, FogColor = 0x2a3038,
                SightScale = 1f, SoundScale = 1f, RewardScale = 1f,
            },
            new TimeProfile
            {
                Id = TimeOfDay.Dawn, Label = "Morgengrauen",
                Blurb = "Flaches Licht, lange Schatten. Ein guter Kompromiss.",
                AmbientScale = 0.44f, LampScale = 0.9f, MinLight = 16,
                SkyTop = 0x1c2436, SkyHorizon = 0x7a6248, FogColor = 0x3a3a42,
                SightScale = 0.8f, SoundScale = 1.05f, RewardScale = 1.12f,
            },
            new TimeProfile
            {
                Id = TimeOfDay.Dusk, Label = "Abenddämmerung",
                Blurb = "Das Licht bricht weg, während du noch draußen bist.",
                AmbientScale = 0.34f, LampScale = 1f, MinLight = 14,
                SkyTop = 0x171b2c, SkyHorizon = 0x6e412a, FogColor = 0x33303a,
                SightScale = 0.74f, SoundScale = 1.05f, RewardScale = 1.2f,
            },
            new TimeProfile
            {
                Id = TimeOfDay.Night, Label = "Nacht",
                Blurb = "Ohne Licht am Lauf siehst du nichts. Mit Licht sieht dich jeder.",
                AmbientScale = 0.16f, LampScale = 1.2f, MinLight = 10,
                SkyTop = 0x05070e, SkyHorizon = 0x141c2a, FogColor = 0x0d1118,
                SightScale = 0.5f, SoundScale = 1.15f, RewardScale = 1.45f,
            },
        };

        public static readonly WeatherProfile[] Weathers =
        {
            new WeatherProfile
            {
                Id = Weather.Clear, Label = "Klar", Blurb = "Freie Sicht.",
                FogDensityAdd = 0f, TintColor = 0x2a3038, Tint = 0f,
                AmbientScale = 1f, SightScale = 1f, SoundScale = 1f, RewardScale = 1f,
                Precipitation = 0f, Wind = 0.08f, Thunder = false, Weight = 30,
            },
            new WeatherProfile
            {
                Id = Weather.Overcast, Label = "Bedeckt",
                Blurb = "Geschlossene Wolkendecke, gedämpftes Licht.",
                FogDensityAdd = 0.012f, TintColor = 0x3c424a, Tint = 0.35f,
                AmbientScale = 0.82f, SightScale = 0.94f, SoundScale = 1f, RewardScale = 1.04f,
                Precipitation = 0f, Wind = 0.22f, Thunder = false, Weight = 28,
            },
            new WeatherProfile
            {
                Id = Weather.Fog, Label = "Nebel",
                Blurb = "Sichtweite unter 20 Metern. Beide Seiten sind blind.",
                FogDensityAdd = 0.08f, TintColor = 0x6a7079, Tint = 0.6f,
                AmbientScale = 0.78f, SightScale = 0.58f, SoundScale = 0.92f, RewardScale = 1.16f,
                Precipitation = 0f, Wind = 0.04f, Thunder = false, Weight = 12,
            },
            new WeatherProfile
            {
                Id = Weather.Rain, Label = "Regen",
                Blurb = "Regen übertönt Schritte - deine und ihre.",
                FogDensityAdd = 0.03f, TintColor = 0x39424c, Tint = 0.4f,
                AmbientScale = 0.72f, SightScale = 0.82f, SoundScale = 0.7f, RewardScale = 1.12f,
                Precipitation = 0.62f, Wind = 0.4f, Thunder = false, Weight = 20,
            },
            new WeatherProfile
            {
                Id = Weather.Storm, Label = "Sturm",
                Blurb = "Starkregen und Donner. Man hört nichts kommen.",
                FogDensityAdd = 0.05f, TintColor = 0x2f373f, Tint = 0.5f,
                AmbientScale = 0.55f, SightScale = 0.7f, SoundScale = 0.52f, RewardScale = 1.22f,
                Precipitation = 1f, Wind = 0.95f, Thunder = true, Weight = 10,
            },
        };

        public static TimeProfile TimeOf(TimeOfDay id)
        {
            foreach (TimeProfile t in Times)
            {
                if (t.Id == id) return t;
            }
            return Times[0];
        }

        public static WeatherProfile WeatherOf(Weather id)
        {
            foreach (WeatherProfile w in Weathers)
            {
                if (w.Id == id) return w;
            }
            return Weathers[0];
        }

        /// <summary>Linear blend between two packed 0xRRGGBB colours.</summary>
        public static int MixColor(int a, int b, float t)
        {
            float k = t < 0f ? 0f : t > 1f ? 1f : t;
            int ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
            int br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
            int r = (int)(ar + (br - ar) * k);
            int g = (int)(ag + (bg - ag) * k);
            int bl = (int)(ab + (bb - ab) * k);
            return (r << 16) | (g << 8) | bl;
        }

        /// <summary>
        /// Combine a time of day with a weather state. The multipliers compose
        /// rather than override, so "night" and "storm" stack into something
        /// genuinely punishing without either table knowing the other exists.
        /// </summary>
        public static RaidConditions Make(TimeOfDay time, Weather weather)
        {
            TimeProfile t = TimeOf(time);
            WeatherProfile w = WeatherOf(weather);

            float ambientScale = t.AmbientScale * w.AmbientScale;

            // Fog and cloud are only as bright as the light falling on them.
            // At full strength after dark the tint produced a luminous grey wall
            // at midnight - fog that glowed instead of a night you cannot see
            // through.
            float tint = w.Tint * (0.3f + 0.7f * t.AmbientScale);

            return new RaidConditions
            {
                Time = t.Id,
                Weather = w.Id,
                Label = w.Id == Weather.Clear ? t.Label : t.Label + " · " + w.Label,
                AmbientScale = ambientScale,
                LampScale = t.LampScale,
                MinLight = t.MinLight,
                FogDensity = BaseFogDensity + w.FogDensityAdd,
                FogColor = MixColor(t.FogColor, w.TintColor, tint),
                SkyTop = MixColor(t.SkyTop, w.TintColor, tint * 0.7f),
                SkyHorizon = MixColor(t.SkyHorizon, w.TintColor, tint * 0.7f),
                SightScale = t.SightScale * w.SightScale,
                SoundScale = t.SoundScale * w.SoundScale,
                RewardScale = t.RewardScale * w.RewardScale,
                Precipitation = w.Precipitation,
                Wind = w.Wind,
                Thunder = w.Thunder,
                // Below roughly a third of daylight, unlit interiors stop being
                // readable without a light.
                DarkEnoughForLight = ambientScale < 0.55f,
            };
        }

        public static RaidConditions Default() => Make(TimeOfDay.Day, Weather.Clear);

        /// <summary>
        /// Pick the weather for a raid from its seed. The player commits to a
        /// time of day and finds out what the sky is doing on arrival; deriving
        /// it from the seed keeps a deployment reproducible.
        /// </summary>
        public static Weather RollWeather(int roll)
        {
            int total = 0;
            foreach (WeatherProfile w in Weathers) total += w.Weight;
            int ticket = Math.Abs(roll) % total;
            foreach (WeatherProfile w in Weathers)
            {
                ticket -= w.Weight;
                if (ticket < 0) return w.Id;
            }
            return Weather.Clear;
        }

        /// <summary>
        /// Re-derive the lightmap for a set of conditions.
        /// </summary>
        /// <remarks>
        /// The generator bakes the lamp contribution (expensive - a line-of-sight
        /// test per lit tile); only the sky base depends on conditions, so this
        /// can run at any time without repeating the bake.
        ///
        /// Lamps are deliberately not scaled down at night. A floodlit yard under
        /// a black sky is the most dangerous ground on the map, and that only
        /// works if the floodlight stays bright while everything around it goes
        /// dark.
        /// </remarks>
        public static void Apply(TileMap map, float ambient, RaidConditions cond)
        {
            float skyLevel = ambient * 255f * cond.AmbientScale;
            float indoorBase = ambient * 62f * cond.AmbientScale;
            float lampScale = cond.LampScale;
            float floor = cond.MinLight;
            int n = map.Width * map.Height;

            for (int i = 0; i < n; i++)
            {
                float basis = map.Ceiling[i] != 0 ? indoorBase : skyLevel;
                float lit = basis + map.LampLight[i] * lampScale;
                float value = lit < floor ? floor : lit > 255f ? 255f : lit;
                map.Lightmap[i] = (byte)value;
            }
        }
    }
}
