using System;
using System.Collections.Generic;

namespace Greyzone.Simulation.World
{
    /// <summary>Tile identifiers. Values are stable and persisted in saves.</summary>
    public enum Tile : byte
    {
        Floor = 0,
        Concrete = 1,
        Brick = 2,
        Metal = 3,
        Wood = 4,
        Container = 5,
        Fence = 6,
        Window = 7,
        DoorClosed = 8,
        DoorOpen = 9,
        Rubble = 10,
        Crate = 11,
        Rock = 12,
        Water = 13,
        Grate = 14,
        Glass = 15,
    }

    /// <summary>
    /// Static, gameplay-relevant properties of a material.
    /// </summary>
    /// <remarks>
    /// This table is the single source of truth for cover. The renderer, the
    /// ballistics solver, the AI's hearing model and navigation all read it, so
    /// the wall you see, the wall that stops a round and the wall that muffles
    /// a footstep are guaranteed to be the same wall.
    ///
    /// <see cref="Penetration"/> is the material's resistance in the same units
    /// as ammunition penetration power. A round above it punches through and
    /// loses energy; below it, the round stops. That is what makes concrete
    /// real cover and a wooden shed a death trap.
    /// </remarks>
    public readonly struct TileDef
    {
        public readonly Tile Id;
        public readonly string Name;
        /// <summary>Blocks actor movement.</summary>
        public readonly bool Solid;
        /// <summary>Blocks line of sight.</summary>
        public readonly bool Opaque;
        /// <summary>Presents a wall surface (may still be see-through, e.g. a fence).</summary>
        public readonly bool Wall;
        /// <summary>Height in metres. 0 floor, ~1.0 crouch cover, >1.8 full cover.</summary>
        public readonly float Height;
        /// <summary>Resistance to penetration.</summary>
        public readonly float Penetration;
        /// <summary>Fraction of a projectile's energy lost passing through.</summary>
        public readonly float EnergyLoss;
        /// <summary>Sound occlusion 0..1 applied per tile crossed.</summary>
        public readonly float SoundDamping;
        /// <summary>Movement cost multiplier for navigation.</summary>
        public readonly float MoveCost;
        /// <summary>Footstep loudness multiplier - metal grating gives you away.</summary>
        public readonly float FootstepLoudness;

        public TileDef(Tile id, string name, bool solid = false, bool opaque = false, bool wall = false,
            float height = 0f, float penetration = 0f, float energyLoss = 0f, float soundDamping = 0f,
            float moveCost = 1f, float footstepLoudness = 1f)
        {
            Id = id;
            Name = name;
            Solid = solid;
            Opaque = opaque;
            Wall = wall;
            Height = height;
            Penetration = penetration;
            EnergyLoss = energyLoss;
            SoundDamping = soundDamping;
            MoveCost = moveCost;
            FootstepLoudness = footstepLoudness;
        }
    }

    public static class Tiles
    {
        /// <summary>One tile edge in metres; a 96x96 map is a ~190 m compound.</summary>
        public const float MetersPerTile = 2.0f;

        public const int Count = 16;

        public static readonly TileDef[] Defs =
        {
            new TileDef(Tile.Floor, "Boden"),
            new TileDef(Tile.Concrete, "Beton", solid: true, opaque: true, wall: true, height: 3f,
                penetration: 65f, energyLoss: 0.75f, soundDamping: 0.55f),
            new TileDef(Tile.Brick, "Ziegel", solid: true, opaque: true, wall: true, height: 3f,
                penetration: 42f, energyLoss: 0.6f, soundDamping: 0.45f),
            new TileDef(Tile.Metal, "Stahlblech", solid: true, opaque: true, wall: true, height: 3f,
                penetration: 30f, energyLoss: 0.45f, soundDamping: 0.3f),
            new TileDef(Tile.Wood, "Holzwand", solid: true, opaque: true, wall: true, height: 3f,
                penetration: 14f, energyLoss: 0.3f, soundDamping: 0.2f),
            new TileDef(Tile.Container, "Seecontainer", solid: true, opaque: true, wall: true, height: 2.6f,
                penetration: 34f, energyLoss: 0.5f, soundDamping: 0.35f),
            // Fences block movement but not sight: readable sightlines, no free cover.
            new TileDef(Tile.Fence, "Maschendraht", solid: true, opaque: false, wall: true, height: 2.2f,
                penetration: 4f, energyLoss: 0.05f, soundDamping: 0.02f),
            // Window band: see and shoot through it, but you cannot walk through
            // it. Cheap glass makes windows lethal cover, which is the point.
            new TileDef(Tile.Window, "Fensterband", solid: true, opaque: false, wall: true, height: 3f,
                penetration: 3f, energyLoss: 0.04f, soundDamping: 0.05f),
            new TileDef(Tile.DoorClosed, "Tür", solid: true, opaque: true, wall: true, height: 2.4f,
                penetration: 12f, energyLoss: 0.25f, soundDamping: 0.4f, moveCost: 1.6f),
            new TileDef(Tile.DoorOpen, "Tür (offen)"),
            new TileDef(Tile.Rubble, "Schutt", height: 0.5f, moveCost: 1.9f, footstepLoudness: 1.5f),
            // Crates: chest-high cover you can shoot over but not easily through.
            new TileDef(Tile.Crate, "Kiste", solid: true, opaque: false, wall: true, height: 1.2f,
                penetration: 16f, energyLoss: 0.35f, soundDamping: 0.15f),
            new TileDef(Tile.Rock, "Fels", solid: true, opaque: true, wall: true, height: 2.8f,
                penetration: 90f, energyLoss: 0.85f, soundDamping: 0.6f),
            new TileDef(Tile.Water, "Wasser", moveCost: 2.6f, footstepLoudness: 2.2f),
            new TileDef(Tile.Grate, "Gitterrost", footstepLoudness: 2.4f),
            new TileDef(Tile.Glass, "Glasfront", solid: true, opaque: false, wall: true, height: 3f,
                penetration: 2f, energyLoss: 0.03f, soundDamping: 0.05f),
        };

        // Flat lookup tables: the hot loops index these instead of the struct
        // array, which keeps the inner loop free of bounds-checked field reads.
        internal static readonly bool[] SolidTable = new bool[Count];
        internal static readonly bool[] OpaqueTable = new bool[Count];
        internal static readonly bool[] WallTable = new bool[Count];
        internal static readonly float[] PenetrationTable = new float[Count];
        internal static readonly float[] EnergyLossTable = new float[Count];
        internal static readonly float[] SoundDampTable = new float[Count];
        internal static readonly float[] MoveCostTable = new float[Count];
        internal static readonly float[] HeightTable = new float[Count];

        static Tiles()
        {
            foreach (TileDef d in Defs)
            {
                int i = (int)d.Id;
                SolidTable[i] = d.Solid;
                OpaqueTable[i] = d.Opaque;
                WallTable[i] = d.Wall;
                PenetrationTable[i] = d.Penetration;
                EnergyLossTable[i] = d.EnergyLoss;
                SoundDampTable[i] = d.SoundDamping;
                MoveCostTable[i] = d.MoveCost;
                HeightTable[i] = d.Height;
            }
        }
    }

    /// <summary>Named region driving spawning, loot density and AI assignment.</summary>
    public sealed class Zone
    {
        public int Id;
        public string Name;
        public int X0, Y0, X1, Y1;
        /// <summary>0..1 - weights loot rarity and AI density.</summary>
        public float Danger;
        /// <summary>Interior zones are darker and muffle sound.</summary>
        public bool Interior;
    }

    /// <summary>
    /// The authoritative world representation: a uniform grid of materials.
    /// </summary>
    /// <remarks>
    /// All per-tile data lives in parallel flat arrays rather than an array of
    /// objects. These are what navigation, lighting and every line-of-sight
    /// query sample, and flat arrays keep those loops cache-friendly.
    ///
    /// In Unity this stays the source of truth for gameplay. Prefabs are
    /// instantiated <i>from</i> it for presentation; replacing it with colliders
    /// would give up the guarantee that sight, fire and sound agree.
    /// </remarks>
    public sealed class TileMap
    {
        public readonly int Width;
        public readonly int Height;

        /// <summary>Wall and obstacle layer.</summary>
        public readonly byte[] Tiles;
        /// <summary>Ground material beneath the wall layer.</summary>
        public readonly byte[] Floor;
        /// <summary>0 = open sky, otherwise a ceiling material index.</summary>
        public readonly byte[] Ceiling;
        /// <summary>Baked static light, 0..255.</summary>
        public readonly byte[] Lightmap;
        /// <summary>
        /// Lamp contribution only, without the sky. Kept separate so the time of
        /// day can be changed by recombining the two instead of repeating the
        /// bake, which costs a line-of-sight test per lit tile.
        /// </summary>
        public readonly byte[] LampLight;
        /// <summary>Zone id per tile, 0 = none.</summary>
        public readonly byte[] ZoneGrid;

        public readonly List<Zone> Zones = new List<Zone>();

        public TileMap(int width, int height)
        {
            Width = width;
            Height = height;
            int n = width * height;
            Tiles = new byte[n];
            Floor = new byte[n];
            Ceiling = new byte[n];
            Lightmap = new byte[n];
            LampLight = new byte[n];
            ZoneGrid = new byte[n];
            for (int i = 0; i < n; i++) Lightmap[i] = 180;
        }

        public int Index(int x, int y) => y * Width + x;

        public bool InBounds(int x, int y) => x >= 0 && y >= 0 && x < Width && y < Height;

        /// <summary>Tile at integer coordinates; out of bounds reads as concrete.</summary>
        public Tile At(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height) return Tile.Concrete;
            return (Tile)Tiles[y * Width + x];
        }

        public void Set(int x, int y, Tile t)
        {
            if (!InBounds(x, y)) return;
            Tiles[y * Width + x] = (byte)t;
        }

        /// <summary>Blocks movement. Out of bounds is solid.</summary>
        public bool IsSolid(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height) return true;
            return Tiles.Length > 0 && World.Tiles.SolidTable[Tiles[y * Width + x]];
        }

        /// <summary>Blocks line of sight.</summary>
        public bool IsOpaque(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height) return true;
            return World.Tiles.OpaqueTable[Tiles[y * Width + x]];
        }

        /// <summary>Presents a wall surface. May still be see-through.</summary>
        public bool IsWall(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Width || y >= Height) return true;
            return World.Tiles.WallTable[Tiles[y * Width + x]];
        }

        /// <summary>Continuous-coordinate solidity test.</summary>
        public bool IsSolidAt(float wx, float wy)
            => IsSolid((int)Math.Floor(wx), (int)Math.Floor(wy));

        public float PenetrationOf(int x, int y) => World.Tiles.PenetrationTable[(int)At(x, y)];

        public float EnergyLossOf(int x, int y) => World.Tiles.EnergyLossTable[(int)At(x, y)];

        public float SoundDampingOf(int x, int y) => World.Tiles.SoundDampTable[(int)At(x, y)];

        public float MoveCostOf(int x, int y) => World.Tiles.MoveCostTable[(int)At(x, y)];

        public float HeightOf(int x, int y) => World.Tiles.HeightTable[(int)At(x, y)];

        public bool IsIndoors(int x, int y) => InBounds(x, y) && Ceiling[y * Width + x] != 0;

        public byte LightAt(int x, int y) => InBounds(x, y) ? Lightmap[y * Width + x] : (byte)0;

        public Zone ZoneAt(int x, int y)
        {
            if (!InBounds(x, y)) return null;
            int id = ZoneGrid[y * Width + x];
            if (id == 0) return null;
            for (int i = 0; i < Zones.Count; i++)
            {
                if (Zones[i].Id == id) return Zones[i];
            }
            return null;
        }

        public Zone AddZone(string name, int x0, int y0, int x1, int y1, float danger, bool interior)
        {
            var z = new Zone
            {
                Id = Zones.Count + 1,
                Name = name,
                X0 = x0, Y0 = y0, X1 = x1, Y1 = y1,
                Danger = danger,
                Interior = interior,
            };
            Zones.Add(z);
            for (int y = z.Y0; y <= z.Y1; y++)
            {
                for (int x = z.X0; x <= z.X1; x++)
                {
                    if (InBounds(x, y)) ZoneGrid[y * Width + x] = (byte)z.Id;
                }
            }
            return z;
        }

        public void FillRect(int x0, int y0, int x1, int y1, Tile t)
        {
            for (int y = Math.Max(0, y0); y <= Math.Min(Height - 1, y1); y++)
            {
                int row = y * Width;
                for (int x = Math.Max(0, x0); x <= Math.Min(Width - 1, x1); x++) Tiles[row + x] = (byte)t;
            }
        }

        public void StrokeRect(int x0, int y0, int x1, int y1, Tile t)
        {
            for (int x = x0; x <= x1; x++)
            {
                Set(x, y0, t);
                Set(x, y1, t);
            }
            for (int y = y0; y <= y1; y++)
            {
                Set(x0, y, t);
                Set(x1, y, t);
            }
        }

        public void FillFloorRect(int x0, int y0, int x1, int y1, Tile material)
        {
            for (int y = Math.Max(0, y0); y <= Math.Min(Height - 1, y1); y++)
            {
                int row = y * Width;
                for (int x = Math.Max(0, x0); x <= Math.Min(Width - 1, x1); x++) Floor[row + x] = (byte)material;
            }
        }

        public void FillCeilingRect(int x0, int y0, int x1, int y1, byte material)
        {
            for (int y = Math.Max(0, y0); y <= Math.Min(Height - 1, y1); y++)
            {
                int row = y * Width;
                for (int x = Math.Max(0, x0); x <= Math.Min(Width - 1, x1); x++) Ceiling[row + x] = material;
            }
        }

        /// <summary>
        /// Nearest walkable tile, used to rescue a placement that landed in
        /// geometry. Returns false when nothing is open within the radius.
        /// </summary>
        public bool NearestOpen(int x, int y, int maxRadius, out int outX, out int outY)
        {
            if (!IsSolid(x, y))
            {
                outX = x;
                outY = y;
                return true;
            }

            for (int r = 1; r <= maxRadius; r++)
            {
                for (int dy = -r; dy <= r; dy++)
                {
                    for (int dx = -r; dx <= r; dx++)
                    {
                        // Only the ring perimeter, so nearer rings win.
                        if (Math.Abs(dx) != r && Math.Abs(dy) != r) continue;
                        int nx = x + dx;
                        int ny = y + dy;
                        if (InBounds(nx, ny) && !IsSolid(nx, ny))
                        {
                            outX = nx;
                            outY = ny;
                            return true;
                        }
                    }
                }
            }

            outX = x;
            outY = y;
            return false;
        }
    }
}
