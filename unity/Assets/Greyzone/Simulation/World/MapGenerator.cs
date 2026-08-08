using System;
using System.Collections.Generic;
using Greyzone.Simulation.Core;

namespace Greyzone.Simulation.World
{
    public enum SpawnTag { Player, Ai, Boss }

    public struct SpawnPoint
    {
        public float X;
        public float Y;
        /// <summary>Facing in radians.</summary>
        public float Angle;
        public SpawnTag Tag;
    }

    public enum ExtractConditionKind { Always, Item, Fee, TimeWindow }

    /// <summary>
    /// What it costs to use an exit.
    /// </summary>
    /// <remarks>
    /// Conditional exits are the genre's risk lever: a nearby route costs money
    /// or a key you had to find, a free one is far away, and one only opens
    /// late so camping the exit from minute one is not a strategy.
    /// </remarks>
    public struct ExtractCondition
    {
        public ExtractConditionKind Kind;
        public string ItemDefId;
        public int Amount;
        public float OpenAfterFraction;
        public float CloseAfterFraction;
        public string Label;

        public static ExtractCondition Always => new ExtractCondition { Kind = ExtractConditionKind.Always };
    }

    public struct ExtractDefinition
    {
        public string Id;
        public string Name;
        public float X;
        public float Y;
        public float Radius;
        /// <summary>Seconds the player must hold the zone without leaving.</summary>
        public float HoldSeconds;
        public ExtractCondition Condition;
    }

    public struct LootAnchor
    {
        public float X;
        public float Y;
        public string TableId;
        public string ContainerId;
    }

    public sealed class PatrolRoute
    {
        public int Id;
        public List<Vec2> Points = new List<Vec2>();
        public int ZoneId;
    }

    public struct LightSource
    {
        public float X;
        public float Y;
        /// <summary>Radius in tiles.</summary>
        public float Radius;
        public float Intensity;
        public int Color;
        /// <summary>Flicker reads as a damaged industrial site and costs nothing.</summary>
        public float Flicker;
    }

    /// <summary>Everything a raid needs, produced from a blueprint and a seed.</summary>
    public sealed class GeneratedMap
    {
        public TileMap Map;
        public uint Seed;
        public string BlueprintId;
        public string DisplayName;
        public List<SpawnPoint> PlayerSpawns = new List<SpawnPoint>();
        public List<SpawnPoint> AiSpawns = new List<SpawnPoint>();
        public SpawnPoint? BossSpawn;
        public List<ExtractDefinition> Extracts = new List<ExtractDefinition>();
        public List<LootAnchor> LootAnchors = new List<LootAnchor>();
        public List<PatrolRoute> PatrolRoutes = new List<PatrolRoute>();
        public List<LightSource> Lights = new List<LightSource>();
        /// <summary>Ambient sky light 0..1.</summary>
        public float Ambient;
        public float RaidSeconds;
    }

    /// <summary>Declarative description of a location's character.</summary>
    public sealed class MapBlueprint
    {
        public string Id;
        public string DisplayName;
        public int Width;
        public int Height;
        public int Buildings;
        public int ContainerYards;
        /// <summary>0..1 scatter density of loose cover in the open.</summary>
        public float Clutter;
        public bool Water;
        public float Ambient;
        public float RaidSeconds;
        public int AiCount;
        public bool HasBoss;
        public string BossName;
    }

    /// <summary>
    /// Seeded procedural construction of raid locations.
    /// </summary>
    /// <remarks>
    /// Maps are built from blueprints: a small description of the location's
    /// character, which plus a seed becomes a fully populated <see cref="TileMap"/>
    /// with spawns, extractions, loot anchors and patrol routes.
    ///
    /// Design intent: layouts must be readable and tactical, not maze-like.
    /// Districts connect by at least two routes so the player always has a flank
    /// option - and so does the AI. Extractions sit on opposing edges so "which
    /// way out" is a real decision under a running clock.
    ///
    /// In Unity this runs unchanged at raid start; a build step then instantiates
    /// prefabs from the tile data instead of drawing it.
    /// </remarks>
    public static class MapGenerator
    {
        private struct Rect
        {
            public int X0, Y0, X1, Y1;
            public int W => X1 - X0 + 1;
            public int H => Y1 - Y0 + 1;
            public float Cx => (X0 + X1) * 0.5f;
            public float Cy => (Y0 + Y1) * 0.5f;
        }

        public static GeneratedMap Generate(MapBlueprint bp, uint seed)
        {
            var rng = new Rng(seed);
            var map = new TileMap(bp.Width, bp.Height);

            var result = new GeneratedMap
            {
                Map = map,
                Seed = seed,
                BlueprintId = bp.Id,
                DisplayName = bp.DisplayName,
                Ambient = bp.Ambient,
                RaidSeconds = bp.RaidSeconds,
            };

            // 1. Base terrain: open gravel yard inside a hard perimeter.
            for (int i = 0; i < map.Tiles.Length; i++)
            {
                map.Tiles[i] = (byte)Tile.Floor;
                map.Floor[i] = (byte)Tile.Floor;
                map.Ceiling[i] = 0;
            }
            map.StrokeRect(0, 0, bp.Width - 1, bp.Height - 1, Tile.Concrete);
            map.StrokeRect(1, 1, bp.Width - 2, bp.Height - 2, Tile.Concrete);

            // 2. Optional water channel with piers.
            if (bp.Water)
            {
                int channelDepth = Math.Max(4, (int)(bp.Height * 0.09f));
                map.FillRect(2, bp.Height - 2 - channelDepth, bp.Width - 3, bp.Height - 3, Tile.Water);
                map.FillFloorRect(2, bp.Height - 2 - channelDepth, bp.Width - 3, bp.Height - 3, Tile.Water);

                // Two piers, so the waterfront is traversable and not a dead end.
                int[] piers = { (int)(bp.Width * 0.3f), (int)(bp.Width * 0.72f) };
                foreach (int px in piers)
                {
                    map.FillRect(px - 1, bp.Height - 2 - channelDepth, px + 1, bp.Height - 3, Tile.Grate);
                    map.FillFloorRect(px - 1, bp.Height - 2 - channelDepth, px + 1, bp.Height - 3, Tile.Grate);
                }
            }

            var occupied = new List<Rect>();
            int usableY1 = bp.Water ? bp.Height - 4 - (int)(bp.Height * 0.09f) : bp.Height - 3;

            // 3. Buildings, largest first so anchor structures get good ground.
            var buildings = new List<Rect>();
            for (int i = 0; i < bp.Buildings; i++)
            {
                bool big = i == 0;
                int w = big ? rng.Int(18, 24) : rng.Int(9, 16);
                int h = big ? rng.Int(14, 20) : rng.Int(8, 14);
                if (!TryPlace(rng, occupied, 3, 3, bp.Width - 4, usableY1, w, h, 4, out Rect placed)) continue;
                occupied.Add(placed);
                buildings.Add(placed);
                CarveBuilding(map, rng, placed, big, result);
            }

            // 4. Container yards - dense cover mazes between buildings.
            for (int i = 0; i < bp.ContainerYards; i++)
            {
                int w = rng.Int(10, 16);
                int h = rng.Int(9, 14);
                if (!TryPlace(rng, occupied, 3, 3, bp.Width - 4, usableY1, w, h, 3, out Rect placed)) continue;
                occupied.Add(placed);
                CarveContainerYard(map, rng, placed, result);
            }

            // 5. Fence lines with gates, shaping movement without sealing routes.
            CarveFenceLines(map, rng, bp, occupied);

            // 6. Loose clutter for micro-cover in the open.
            ScatterClutter(map, rng, bp, occupied);

            // 7. Zones drive loot rarity, AI density and ambience.
            BuildZones(map, buildings, bp);

            // 8. Extractions on opposing edges, at least one conditional.
            BuildExtracts(map, rng, bp, result);

            // 8b. Connectivity guarantee. Random fences, clutter and buildings
            // can combine to seal a corner off, which would make a raid
            // unwinnable. Rather than constrain the generator until that can
            // never happen - and lose the interesting layouts - detect it and
            // breach a way through afterwards.
            RegionMap regions = EnsureConnectivity(map, result);

            // 9. Spawns, restricted to the main region.
            BuildSpawns(map, rng, bp, result, buildings, regions);

            // 10. Patrol routes threading the ground and interiors.
            BuildPatrolRoutes(map, rng, result);

            // 11. Loot anchors, weighted towards interiors and the boss lair.
            PlaceLootAnchors(map, rng, bp, result, buildings, regions);

            // 12. Boss lair in the largest building.
            if (bp.HasBoss && buildings.Count > 0)
            {
                Rect lair = buildings[0];
                result.BossSpawn = new SpawnPoint
                {
                    X = lair.Cx,
                    Y = lair.Cy,
                    Angle = rng.Range(0f, Math2D.Tau),
                    Tag = SpawnTag.Boss,
                };
                Zone z = map.ZoneAt((int)lair.Cx, (int)lair.Cy);
                if (z != null) z.Danger = 1f;
            }

            // 13. Bake static lighting last, once geometry is final.
            BakeLighting(map, result, bp);

            return result;
        }

        // ===================================================================
        // Placement helpers
        // ===================================================================

        private static bool TryPlace(Rng rng, List<Rect> occupied, int minX, int minY, int maxX, int maxY,
            int w, int h, int padding, out Rect placed)
        {
            for (int attempt = 0; attempt < 60; attempt++)
            {
                int x0 = rng.Int(minX, Math.Max(minX, maxX - w));
                int y0 = rng.Int(minY, Math.Max(minY, maxY - h));
                var r = new Rect { X0 = x0, Y0 = y0, X1 = x0 + w, Y1 = y0 + h };
                if (r.X1 > maxX || r.Y1 > maxY) continue;

                bool clash = false;
                foreach (Rect o in occupied)
                {
                    if (RectsOverlap(r, o, padding))
                    {
                        clash = true;
                        break;
                    }
                }
                if (clash) continue;

                placed = r;
                return true;
            }

            placed = default;
            return false;
        }

        private static bool RectsOverlap(Rect a, Rect b, int padding)
            => !(a.X1 + padding < b.X0 || a.X0 - padding > b.X1 || a.Y1 + padding < b.Y0 || a.Y0 - padding > b.Y1);

        private static bool IsInsideAny(int x, int y, List<Rect> rects, int padding)
        {
            foreach (Rect r in rects)
            {
                if (x >= r.X0 - padding && x <= r.X1 + padding && y >= r.Y0 - padding && y <= r.Y1 + padding)
                    return true;
            }
            return false;
        }

        // ===================================================================
        // Buildings
        // ===================================================================

        /// <summary>
        /// Carves an enclosed building: shell, BSP-partitioned rooms, doorways,
        /// window bands and a ceiling so lighting knows it is indoors.
        /// </summary>
        private static void CarveBuilding(TileMap map, Rng rng, Rect r, bool isLarge, GeneratedMap outMap)
        {
            Tile wallMat = isLarge
                ? Tile.Concrete
                : rng.Pick(new[] { Tile.Brick, Tile.Metal, Tile.Concrete });
            Tile floorMat = isLarge ? Tile.Concrete : rng.Pick(new[] { Tile.Concrete, Tile.Wood });

            map.FillRect(r.X0, r.Y0, r.X1, r.Y1, Tile.Floor);
            map.FillFloorRect(r.X0, r.Y0, r.X1, r.Y1, floorMat);
            map.FillCeilingRect(r.X0, r.Y0, r.X1, r.Y1, (byte)wallMat);
            map.StrokeRect(r.X0, r.Y0, r.X1, r.Y1, wallMat);

            var rooms = new List<Rect>();
            BspSplit(rng, new Rect { X0 = r.X0 + 1, Y0 = r.Y0 + 1, X1 = r.X1 - 1, Y1 = r.Y1 - 1 },
                isLarge ? 6 : 4, rooms);

            Tile partitionMat = isLarge ? Tile.Brick : Tile.Wood;
            foreach (Rect room in rooms)
            {
                // Partition walls only on edges that are not the outer shell.
                if (room.X0 > r.X0 + 1)
                {
                    for (int y = room.Y0; y <= room.Y1; y++) map.Set(room.X0 - 1, y, partitionMat);
                }
                if (room.Y0 > r.Y0 + 1)
                {
                    for (int x = room.X0; x <= room.X1; x++) map.Set(x, room.Y0 - 1, partitionMat);
                }
            }

            // Doorways: two-tile gaps, so no room is ever sealed.
            foreach (Rect room in rooms)
            {
                if (room.X0 > r.X0 + 1)
                {
                    int dy = rng.Int(room.Y0, Math.Max(room.Y0, room.Y1 - 1));
                    map.Set(room.X0 - 1, dy, Tile.Floor);
                    map.Set(room.X0 - 1, dy + 1, Tile.Floor);
                }
                if (room.Y0 > r.Y0 + 1)
                {
                    int dx = rng.Int(room.X0, Math.Max(room.X0, room.X1 - 1));
                    map.Set(dx, room.Y0 - 1, Tile.Floor);
                    map.Set(dx + 1, room.Y0 - 1, Tile.Floor);
                }
            }

            // At least two entrances on different faces, so no building is a
            // single-entry death trap for either side.
            var faces = new List<int> { 0, 1, 2, 3 };
            rng.Shuffle(faces);
            int entrances = isLarge ? 3 : 2;
            for (int i = 0; i < entrances; i++) PunchEntrance(map, rng, r, faces[i], isLarge ? 3 : 2);

            // Window bands on the remaining faces: sightlines in and out.
            for (int i = entrances; i < 4; i++) PunchWindows(map, rng, r, faces[i]);

            foreach (Rect room in rooms)
            {
                if (!rng.Chance(0.75f)) continue;
                outMap.Lights.Add(new LightSource
                {
                    X = room.Cx + 0.5f,
                    Y = room.Cy + 0.5f,
                    Radius = rng.Range(4f, 7f),
                    Intensity = rng.Range(0.45f, 0.8f),
                    Color = rng.Chance(0.25f) ? 0xffd9a0 : 0xd8e4f0,
                    Flicker = rng.Chance(0.3f) ? rng.Range(0.1f, 0.4f) : 0f,
                });
            }
        }

        /// <summary>Recursive binary partition producing rooms with a minimum size.</summary>
        private static void BspSplit(Rng rng, Rect r, int depth, List<Rect> outRooms)
        {
            int w = r.W;
            int h = r.H;
            const int Min = 5;

            if (depth <= 0 || (w < Min * 2 + 1 && h < Min * 2 + 1))
            {
                if (w >= 2 && h >= 2) outRooms.Add(r);
                return;
            }

            // Split the longer axis; a little randomness avoids gridlike interiors.
            bool horizontal = h > w || (h == w && rng.Chance(0.5f));
            if (horizontal)
            {
                if (h < Min * 2 + 1)
                {
                    outRooms.Add(r);
                    return;
                }
                int cut = rng.Int(r.Y0 + Min, r.Y1 - Min);
                BspSplit(rng, new Rect { X0 = r.X0, Y0 = r.Y0, X1 = r.X1, Y1 = cut - 1 }, depth - 1, outRooms);
                BspSplit(rng, new Rect { X0 = r.X0, Y0 = cut + 1, X1 = r.X1, Y1 = r.Y1 }, depth - 1, outRooms);
            }
            else
            {
                if (w < Min * 2 + 1)
                {
                    outRooms.Add(r);
                    return;
                }
                int cut = rng.Int(r.X0 + Min, r.X1 - Min);
                BspSplit(rng, new Rect { X0 = r.X0, Y0 = r.Y0, X1 = cut - 1, Y1 = r.Y1 }, depth - 1, outRooms);
                BspSplit(rng, new Rect { X0 = cut + 1, Y0 = r.Y0, X1 = r.X1, Y1 = r.Y1 }, depth - 1, outRooms);
            }
        }

        /// <param name="face">0 = north, 1 = east, 2 = south, 3 = west.</param>
        private static void PunchEntrance(TileMap map, Rng rng, Rect r, int face, int width)
        {
            if (face == 0 || face == 2)
            {
                int y = face == 0 ? r.Y0 : r.Y1;
                int x = rng.Int(r.X0 + 2, Math.Max(r.X0 + 2, r.X1 - width - 1));
                for (int i = 0; i < width; i++) map.Set(x + i, y, Tile.Floor);
            }
            else
            {
                int x = face == 1 ? r.X1 : r.X0;
                int y = rng.Int(r.Y0 + 2, Math.Max(r.Y0 + 2, r.Y1 - width - 1));
                for (int i = 0; i < width; i++) map.Set(x, y + i, Tile.Floor);
            }
        }

        private static void PunchWindows(TileMap map, Rng rng, Rect r, int face)
        {
            const int Step = 3;
            if (face == 0 || face == 2)
            {
                int y = face == 0 ? r.Y0 : r.Y1;
                for (int x = r.X0 + 2; x <= r.X1 - 2; x += Step)
                {
                    if (rng.Chance(0.65f)) map.Set(x, y, Tile.Window);
                }
            }
            else
            {
                int x = face == 1 ? r.X1 : r.X0;
                for (int y = r.Y0 + 2; y <= r.Y1 - 2; y += Step)
                {
                    if (rng.Chance(0.65f)) map.Set(x, y, Tile.Window);
                }
            }
        }

        /// <summary>
        /// Rows of stacked shipping containers with alleys.
        /// </summary>
        /// <remarks>
        /// The highest-tension spaces on the map: short sightlines, many corners,
        /// and they reward sound discipline over reflexes.
        /// </remarks>
        private static void CarveContainerYard(TileMap map, Rng rng, Rect r, GeneratedMap outMap)
        {
            map.FillFloorRect(r.X0, r.Y0, r.X1, r.Y1, Tile.Concrete);

            const int RowStep = 3; // two tiles of container, one tile of alley
            for (int y = r.Y0; y <= r.Y1 - 1; y += RowStep)
            {
                int x = r.X0;
                while (x <= r.X1)
                {
                    int len = rng.Int(3, 6);
                    if (rng.Chance(0.78f))
                    {
                        for (int i = 0; i < len && x + i <= r.X1; i++)
                        {
                            map.Set(x + i, y, Tile.Container);
                            if (y + 1 <= r.Y1) map.Set(x + i, y + 1, Tile.Container);
                        }
                    }
                    // Gaps between runs create cross-alleys.
                    x += len + rng.Int(1, 3);
                }
            }

            // A lit yard is safer to cross but makes you a silhouette.
            outMap.Lights.Add(new LightSource
            {
                X = r.Cx,
                Y = r.Cy,
                Radius = rng.Range(8f, 12f),
                Intensity = 0.55f,
                Color = 0xfff0c8,
                Flicker = rng.Chance(0.35f) ? 0.25f : 0f,
            });
        }

        private static void CarveFenceLines(TileMap map, Rng rng, MapBlueprint bp, List<Rect> occupied)
        {
            int lines = rng.Int(2, 4);
            for (int i = 0; i < lines; i++)
            {
                bool horizontal = rng.Chance(0.5f);
                if (horizontal)
                {
                    int y = rng.Int(6, bp.Height - 7);
                    for (int x = 3; x < bp.Width - 3; x++)
                    {
                        if (IsInsideAny(x, y, occupied, 1)) continue;
                        map.Set(x, y, Tile.Fence);
                    }
                    // Two gates guarantee a flank route.
                    for (int g = 0; g < 2; g++)
                    {
                        int gx = rng.Int(5, bp.Width - 6);
                        for (int k = -1; k <= 1; k++) map.Set(gx + k, y, Tile.Floor);
                    }
                }
                else
                {
                    int x = rng.Int(6, bp.Width - 7);
                    for (int y = 3; y < bp.Height - 3; y++)
                    {
                        if (IsInsideAny(x, y, occupied, 1)) continue;
                        map.Set(x, y, Tile.Fence);
                    }
                    for (int g = 0; g < 2; g++)
                    {
                        int gy = rng.Int(5, bp.Height - 6);
                        for (int k = -1; k <= 1; k++) map.Set(x, gy + k, Tile.Floor);
                    }
                }
            }
        }

        private static void ScatterClutter(TileMap map, Rng rng, MapBlueprint bp, List<Rect> occupied)
        {
            int attempts = (int)(bp.Width * bp.Height * 0.02f * bp.Clutter * 4f);
            for (int i = 0; i < attempts; i++)
            {
                int x = rng.Int(3, bp.Width - 4);
                int y = rng.Int(3, bp.Height - 4);
                if (map.At(x, y) != Tile.Floor) continue;
                if (IsInsideAny(x, y, occupied, 0)) continue;

                float roll = rng.Float();
                if (roll < 0.45f)
                {
                    map.Set(x, y, Tile.Crate);
                    if (rng.Chance(0.4f) && map.At(x + 1, y) == Tile.Floor) map.Set(x + 1, y, Tile.Crate);
                }
                else if (roll < 0.7f) map.Set(x, y, Tile.Rubble);
                else if (roll < 0.88f) map.Set(x, y, Tile.Rock);
                else map.Set(x, y, Tile.Grate);
            }
        }

        private static void BuildZones(TileMap map, List<Rect> buildings, MapBlueprint bp)
        {
            // Outer ring: low danger, low value - the "get your bearings" band.
            map.AddZone("Außengelände", 1, 1, bp.Width - 2, bp.Height - 2, 0.25f, false);

            string[] names = { "Lagerhalle", "Verwaltung", "Werkhalle", "Umschlagpunkt", "Kesselhaus" };
            for (int i = 0; i < buildings.Count; i++)
            {
                Rect b = buildings[i];
                // The first (largest) building is the map's contested prize.
                float danger = i == 0 ? 0.9f : 0.5f + i * 0.05f;
                map.AddZone(names[i % names.Length], b.X0, b.Y0, b.X1, b.Y1, danger, true);
            }
        }

        private static void BuildExtracts(TileMap map, Rng rng, MapBlueprint bp, GeneratedMap outMap)
        {
            const int Margin = 5;
            var candidates = new List<(int X, int Y, string Name)>
            {
                (Margin, Margin, "Nordtor"),
                (bp.Width - Margin, Margin, "Bahnrampe"),
                (Margin, bp.Height - Margin, "Kanalsteg"),
                (bp.Width - Margin, bp.Height - Margin, "Südschleuse"),
                (bp.Width / 2, Margin, "Zollhaus"),
            };
            rng.Shuffle(candidates);

            for (int i = 0; i < 4 && i < candidates.Count; i++)
            {
                var c = candidates[i];
                if (!map.NearestOpen(c.X, c.Y, 14, out int ox, out int oy))
                {
                    ox = c.X;
                    oy = c.Y;
                }

                // Guarantee the pad is clear, so extraction cannot be blocked by
                // geometry that happened to land on it.
                map.FillRect(ox - 1, oy - 1, ox + 1, oy + 1, Tile.Floor);
                map.FillFloorRect(ox - 2, oy - 2, ox + 2, oy + 2, Tile.Grate);

                ExtractCondition condition = ExtractCondition.Always;
                if (i == 1)
                {
                    condition = new ExtractCondition
                    {
                        Kind = ExtractConditionKind.Fee,
                        Amount = 4500,
                        Label = "Schleusergebühr 4.500",
                    };
                }
                else if (i == 2)
                {
                    condition = new ExtractCondition
                    {
                        Kind = ExtractConditionKind.Item,
                        ItemDefId = "key_dock_gate",
                        Label = "Benötigt: Hafenschlüssel",
                    };
                }
                else if (i == 3)
                {
                    condition = new ExtractCondition
                    {
                        Kind = ExtractConditionKind.TimeWindow,
                        OpenAfterFraction = 0.45f,
                        CloseAfterFraction = 1f,
                        Label = "Öffnet nach Halbzeit",
                    };
                }

                outMap.Extracts.Add(new ExtractDefinition
                {
                    Id = $"ex_{i}",
                    Name = c.Name,
                    X = ox + 0.5f,
                    Y = oy + 0.5f,
                    Radius = 2.2f,
                    HoldSeconds = condition.Kind == ExtractConditionKind.Always ? 6f : 4f,
                    Condition = condition,
                });

                outMap.Lights.Add(new LightSource
                {
                    X = ox + 0.5f, Y = oy + 0.5f, Radius = 6f, Intensity = 0.5f, Color = 0x8effc0, Flicker = 0f,
                });
            }
        }

        // ===================================================================
        // Connectivity
        // ===================================================================

        /// <summary>
        /// Connected components of walkable tiles.
        /// </summary>
        /// <remarks>
        /// <c>MainId</c> is the largest component. Everything gameplay-facing is
        /// restricted to it, so a sealed pocket can never hold a spawn, a patrol
        /// or a container the player cannot reach.
        /// </remarks>
        private sealed class RegionMap
        {
            public int[] Ids;
            public int MainId;
            public int Width;
            public int Height;

            public bool IsMain(int x, int y)
            {
                if (x < 0 || y < 0 || x >= Width || y >= Height) return false;
                return Ids[y * Width + x] == MainId;
            }
        }

        /// <summary>
        /// Cost of breaching a tile when carving a repair path.
        /// </summary>
        /// <remarks>
        /// These encode a preference order rather than physics: cut a fence
        /// before a wooden shed, a shed before brick, and tunnel through concrete
        /// only as a last resort. Breaches therefore land where a real route
        /// would, instead of straight through the middle of a warehouse.
        /// </remarks>
        private static float BreachCost(Tile tile)
        {
            switch (tile)
            {
                case Tile.Fence: return 3f;
                case Tile.Crate: return 4f;
                case Tile.Window:
                case Tile.Glass: return 7f;
                case Tile.DoorClosed: return 2f;
                case Tile.Wood: return 12f;
                case Tile.Metal: return 16f;
                case Tile.Brick: return 20f;
                case Tile.Container: return 22f;
                case Tile.Rock: return 26f;
                case Tile.Concrete: return 42f;
                default: return 1f;
            }
        }

        private static RegionMap ComputeRegions(TileMap map)
        {
            int n = map.Width * map.Height;
            var ids = new int[n];
            for (int i = 0; i < n; i++) ids[i] = -1;

            var queue = new int[n];
            var sizes = new List<int>();

            for (int y = 0; y < map.Height; y++)
            {
                for (int x = 0; x < map.Width; x++)
                {
                    int start = y * map.Width + x;
                    if (ids[start] != -1 || map.IsSolid(x, y)) continue;

                    int id = sizes.Count;
                    int head = 0;
                    int tail = 0;
                    queue[tail++] = start;
                    ids[start] = id;
                    int size = 0;

                    while (head < tail)
                    {
                        int current = queue[head++];
                        size++;
                        int cx = current % map.Width;
                        int cy = current / map.Width;

                        // Four-way: a diagonal gap between two solid tiles is not
                        // walkable for a circle-shaped actor, so it must not
                        // count as connected.
                        for (int k = 0; k < 4; k++)
                        {
                            int nx = cx + FourX[k];
                            int ny = cy + FourY[k];
                            if (nx < 0 || ny < 0 || nx >= map.Width || ny >= map.Height) continue;
                            int ni = ny * map.Width + nx;
                            if (ids[ni] != -1 || map.IsSolid(nx, ny)) continue;
                            ids[ni] = id;
                            queue[tail++] = ni;
                        }
                    }
                    sizes.Add(size);
                }
            }

            int mainId = 0;
            for (int i = 1; i < sizes.Count; i++)
            {
                if (sizes[i] > sizes[mainId]) mainId = i;
            }

            return new RegionMap { Ids = ids, MainId = mainId, Width = map.Width, Height = map.Height };
        }

        private static readonly int[] FourX = { 0, 1, 0, -1 };
        private static readonly int[] FourY = { -1, 0, 1, 0 };

        private static RegionMap EnsureConnectivity(TileMap map, GeneratedMap outMap)
        {
            RegionMap regions = ComputeRegions(map);

            foreach (ExtractDefinition extract in outMap.Extracts)
            {
                int ex = (int)extract.X;
                int ey = (int)extract.Y;
                if (regions.IsMain(ex, ey)) continue;
                if (CarveBreach(map, ex, ey, regions))
                {
                    // Geometry changed; components must be recomputed.
                    regions = ComputeRegions(map);
                }
            }

            return regions;
        }

        /// <summary>
        /// Dijkstra to the nearest main-region tile, treating solid tiles as
        /// expensive rather than impassable, then clears whatever it crossed.
        /// </summary>
        private static bool CarveBreach(TileMap map, int startX, int startY, RegionMap regions)
        {
            int n = map.Width * map.Height;
            var dist = new float[n];
            var prev = new int[n];
            var visited = new bool[n];
            for (int i = 0; i < n; i++)
            {
                dist[i] = float.PositiveInfinity;
                prev[i] = -1;
            }

            int startIndex = startY * map.Width + startX;
            dist[startIndex] = 0f;

            // A binary heap, not a linear scan: on a 96x96 map the naive version
            // is roughly 85 million comparisons, which is a visible stall even at
            // generation time.
            var heap = new int[n * 4];
            int heapSize = 0;

            void Push(int node)
            {
                if (heapSize >= heap.Length) return;
                int i = heapSize++;
                float d = dist[node];
                while (i > 0)
                {
                    int parent = (i - 1) >> 1;
                    if (dist[heap[parent]] <= d) break;
                    heap[i] = heap[parent];
                    i = parent;
                }
                heap[i] = node;
            }

            int Pop()
            {
                int top = heap[0];
                int last = heap[--heapSize];
                if (heapSize > 0)
                {
                    int i = 0;
                    float d = dist[last];
                    while (true)
                    {
                        int l = 2 * i + 1;
                        if (l >= heapSize) break;
                        int r = l + 1;
                        int child = r < heapSize && dist[heap[r]] < dist[heap[l]] ? r : l;
                        if (dist[heap[child]] >= d) break;
                        heap[i] = heap[child];
                        i = child;
                    }
                    heap[i] = last;
                }
                return top;
            }

            Push(startIndex);
            int target = -1;

            while (heapSize > 0)
            {
                int current = Pop();
                if (visited[current]) continue;
                visited[current] = true;

                int cx = current % map.Width;
                int cy = current / map.Width;
                if (regions.IsMain(cx, cy))
                {
                    target = current;
                    break;
                }

                for (int k = 0; k < 4; k++)
                {
                    int nx = cx + FourX[k];
                    int ny = cy + FourY[k];
                    // Never breach the outer perimeter; the map stays enclosed.
                    if (nx < 2 || ny < 2 || nx >= map.Width - 2 || ny >= map.Height - 2) continue;

                    int ni = ny * map.Width + nx;
                    if (visited[ni]) continue;

                    float cost = BreachCost(map.At(nx, ny));
                    if (dist[current] + cost < dist[ni])
                    {
                        dist[ni] = dist[current] + cost;
                        prev[ni] = current;
                        Push(ni);
                    }
                }
            }

            if (target == -1) return false;

            bool carved = false;
            int node = target;
            while (node != -1)
            {
                int x = node % map.Width;
                int y = node / map.Width;
                if (map.IsSolid(x, y))
                {
                    map.Set(x, y, Tile.Floor);
                    carved = true;
                }
                node = prev[node];
            }
            return carved;
        }

        // ===================================================================
        // Population
        // ===================================================================

        private static void BuildSpawns(TileMap map, Rng rng, MapBlueprint bp, GeneratedMap outMap,
            List<Rect> buildings, RegionMap regions)
        {
            // Player spawns: prefer positions far from every extraction so
            // getting out is always a journey, and away from the boss lair.
            var scored = new List<(SpawnPoint P, float Score)>();
            for (int i = 0; i < 200; i++)
            {
                int x = rng.Int(4, bp.Width - 5);
                int y = rng.Int(4, bp.Height - 5);
                if (map.IsSolid(x, y) || map.At(x, y) == Tile.Water) continue;
                if (!regions.IsMain(x, y)) continue;
                if (IsInsideAny(x, y, buildings, 1)) continue;

                float minExtract = float.MaxValue;
                foreach (ExtractDefinition e in outMap.Extracts)
                {
                    float d = Math2D.Distance(e.X, e.Y, x, y);
                    if (d < minExtract) minExtract = d;
                }

                float edgePenalty = Math.Min(Math.Min(x, y), Math.Min(bp.Width - x, bp.Height - y)) < 6 ? -12f : 0f;
                scored.Add((new SpawnPoint
                {
                    X = x + 0.5f, Y = y + 0.5f, Angle = rng.Range(0f, Math2D.Tau), Tag = SpawnTag.Player,
                }, minExtract + edgePenalty));
            }

            scored.Sort((a, b) => b.Score.CompareTo(a.Score));
            for (int i = 0; i < Math.Min(6, scored.Count); i++) outMap.PlayerSpawns.Add(scored[i].P);

            if (outMap.PlayerSpawns.Count == 0 &&
                map.NearestOpen(bp.Width / 2, bp.Height / 2, 30, out int fx, out int fy))
            {
                outMap.PlayerSpawns.Add(new SpawnPoint
                {
                    X = fx + 0.5f, Y = fy + 0.5f, Angle = 0f, Tag = SpawnTag.Player,
                });
            }

            // AI spread across the map; density scales with zone danger.
            int guard = 0;
            while (outMap.AiSpawns.Count < bp.AiCount && guard++ < bp.AiCount * 60)
            {
                int x = rng.Int(3, bp.Width - 4);
                int y = rng.Int(3, bp.Height - 4);
                if (map.IsSolid(x, y) || map.At(x, y) == Tile.Water) continue;
                if (!regions.IsMain(x, y)) continue;

                // Never spawn on top of the player's arrival area.
                bool tooClose = false;
                foreach (SpawnPoint ps in outMap.PlayerSpawns)
                {
                    if (Math2D.Distance(ps.X, ps.Y, x, y) < 14f)
                    {
                        tooClose = true;
                        break;
                    }
                }
                if (tooClose) continue;

                Zone zone = map.ZoneAt(x, y);
                float danger = zone?.Danger ?? 0.25f;
                // Rejection sampling against danger, so hot areas get more contacts.
                if (!rng.Chance(0.35f + danger * 0.65f)) continue;

                outMap.AiSpawns.Add(new SpawnPoint
                {
                    X = x + 0.5f, Y = y + 0.5f, Angle = rng.Range(0f, Math2D.Tau), Tag = SpawnTag.Ai,
                });
            }
        }

        private static void BuildPatrolRoutes(TileMap map, Rng rng, GeneratedMap outMap)
        {
            const int RouteCount = 8;
            for (int i = 0; i < RouteCount; i++)
            {
                var points = new List<Vec2>();
                int legs = rng.Int(3, 5);
                bool haveCursor = false;
                int cursorX = 0, cursorY = 0;

                for (int l = 0; l < legs; l++)
                {
                    bool found = false;
                    float px = 0f, py = 0f;

                    for (int attempt = 0; attempt < 40; attempt++)
                    {
                        int x = rng.Int(3, map.Width - 4);
                        int y = rng.Int(3, map.Height - 4);
                        if (map.IsSolid(x, y) || map.At(x, y) == Tile.Water) continue;

                        // Sensible leg lengths with line of sight, so patrols read
                        // as deliberate rounds rather than random wandering.
                        if (haveCursor)
                        {
                            float d = Math2D.Distance(cursorX, cursorY, x, y);
                            if (d < 6f || d > 26f) continue;
                            if (!Raycast.HasLineOfSight(map, cursorX + 0.5f, cursorY + 0.5f, x + 0.5f, y + 0.5f))
                                continue;
                        }

                        px = x + 0.5f;
                        py = y + 0.5f;
                        cursorX = x;
                        cursorY = y;
                        haveCursor = true;
                        found = true;
                        break;
                    }

                    if (!found) break;
                    points.Add(new Vec2(px, py));
                }

                if (points.Count >= 2)
                {
                    Zone z = map.ZoneAt((int)points[0].X, (int)points[0].Y);
                    outMap.PatrolRoutes.Add(new PatrolRoute { Id = i, Points = points, ZoneId = z?.Id ?? 0 });
                }
            }
        }

        private static void PlaceLootAnchors(TileMap map, Rng rng, MapBlueprint bp, GeneratedMap outMap,
            List<Rect> buildings, RegionMap regions)
        {
            var primaryTables = new[] { "weapon_crate", "med_cabinet", "tool_chest", "safe", "supply_crate" };
            var primaryWeights = new[] { 3f, 2f, 2f, 2f, 3f };
            var secondaryTables = new[] { "supply_crate", "med_cabinet", "tool_chest", "filing_cabinet", "weapon_crate" };
            var secondaryWeights = new[] { 4f, 2f, 2f, 3f, 1f };

            // Interior anchors: the reward for entering contested indoor space.
            for (int bi = 0; bi < buildings.Count; bi++)
            {
                Rect b = buildings[bi];
                int count = b.W * b.H / 26 + 2;
                for (int i = 0; i < count; i++)
                {
                    if (!FindFreeTile(map, rng, b.X0 + 1, b.Y0 + 1, b.X1 - 1, b.Y1 - 1, regions,
                            out int sx, out int sy)) continue;

                    bool primary = bi == 0;
                    string containerId = rng.Weighted(
                        primary ? primaryTables : secondaryTables,
                        primary ? primaryWeights : secondaryWeights);

                    outMap.LootAnchors.Add(new LootAnchor
                    {
                        X = sx + 0.5f, Y = sy + 0.5f, TableId = containerId, ContainerId = containerId,
                    });
                }
            }

            // Exterior anchors: fewer and cheaper, but safe to grab in passing.
            var outdoorTables = new[] { "supply_crate", "barrel", "toolbox", "duffel" };
            var outdoorWeights = new[] { 4f, 3f, 2f, 1f };
            int outdoor = (int)(bp.Width * bp.Height * 0.0025f);

            for (int i = 0; i < outdoor; i++)
            {
                if (!FindFreeTile(map, rng, 3, 3, bp.Width - 4, bp.Height - 4, regions, out int sx, out int sy))
                    continue;
                if (IsInsideAny(sx, sy, buildings, 0)) continue;

                string containerId = rng.Weighted(outdoorTables, outdoorWeights);
                outMap.LootAnchors.Add(new LootAnchor
                {
                    X = sx + 0.5f, Y = sy + 0.5f, TableId = containerId, ContainerId = containerId,
                });
            }
        }

        private static bool FindFreeTile(TileMap map, Rng rng, int x0, int y0, int x1, int y1,
            RegionMap regions, out int outX, out int outY)
        {
            for (int i = 0; i < 50; i++)
            {
                int x = rng.Int(x0, x1);
                int y = rng.Int(y0, y1);
                if (map.IsSolid(x, y) || map.At(x, y) == Tile.Water) continue;
                // Loot the player cannot walk to is loot that does not exist.
                if (regions != null && !regions.IsMain(x, y)) continue;
                outX = x;
                outY = y;
                return true;
            }

            outX = 0;
            outY = 0;
            return false;
        }

        /// <summary>
        /// Bakes static lighting into the tilemap.
        /// </summary>
        /// <remarks>
        /// Lamps accumulate into their own layer with a line-of-sight test, so
        /// light does not bleed through walls. The sky is not baked in: it is
        /// folded on top by <see cref="Conditions.Apply"/>, which lets the time of
        /// day change without repeating this pass - the expensive part is the
        /// visibility test, and that does not depend on how bright the sky is.
        ///
        /// Baking costs a few milliseconds once per raid and turns per-frame
        /// lighting into a single array read - and the AI's visibility model reads
        /// the same array, so shadows are real cover rather than a cosmetic effect.
        /// </remarks>
        private static void BakeLighting(TileMap map, GeneratedMap gen, MapBlueprint bp)
        {
            Array.Clear(map.LampLight, 0, map.LampLight.Length);

            foreach (LightSource light in gen.Lights)
            {
                int r = (int)Math.Ceiling(light.Radius);
                int lx = (int)light.X;
                int ly = (int)light.Y;
                int x0 = Math.Max(0, lx - r);
                int x1 = Math.Min(map.Width - 1, lx + r);
                int y0 = Math.Max(0, ly - r);
                int y1 = Math.Min(map.Height - 1, ly + r);

                for (int y = y0; y <= y1; y++)
                {
                    for (int x = x0; x <= x1; x++)
                    {
                        float d = Math2D.Distance(x + 0.5f, y + 0.5f, light.X, light.Y);
                        if (d > light.Radius) continue;

                        // Softened falloff, so lights read as area sources.
                        float falloff = 1f - d / light.Radius;
                        float contribution = falloff * falloff * light.Intensity * 255f;
                        if (contribution < 2f) continue;
                        if (!Raycast.HasLineOfSight(map, light.X, light.Y, x + 0.5f, y + 0.5f)) continue;

                        int i = y * map.Width + x;
                        map.LampLight[i] = (byte)Math.Min(255, map.LampLight[i] + contribution);
                    }
                }
            }

            // Daylight by default, so a map is usable the moment it is generated.
            Conditions.Apply(map, bp.Ambient, Conditions.Default());
        }
    }
}
