using System;
using System.Collections.Generic;
using Greyzone.Simulation.Core;
using Greyzone.Simulation.World;
using NUnit.Framework;

namespace Greyzone.Simulation.Tests
{
    /// <summary>
    /// Simulation tests, mirroring the TypeScript prototype's assertions.
    /// </summary>
    /// <remarks>
    /// These are the same checks the prototype passes, which is how the port is
    /// held to being the <i>same</i> simulation rather than merely a compiling
    /// one. They run in two places from one source: headlessly via
    /// <c>dotnet test tools/csharp-verify</c>, and inside the Editor's Test
    /// Runner, because the simulation assembly has no UnityEngine references.
    /// </remarks>
    public class CoreTests
    {
        [Test]
        public void Rng_IsDeterministicForASeed()
        {
            var a = new Rng("seed-1");
            var b = new Rng("seed-1");
            for (int i = 0; i < 200; i++) Assert.AreEqual(a.Next(), b.Next());
        }

        [Test]
        public void Rng_DifferentSeedsDiverge()
        {
            var a = new Rng("seed-1");
            var b = new Rng("seed-2");
            int differences = 0;
            for (int i = 0; i < 50; i++)
            {
                if (a.Next() != b.Next()) differences++;
            }
            Assert.Greater(differences, 40, "streams should be independent");
        }

        [Test]
        public void Rng_FloatInRangeAndIntInclusive()
        {
            var rng = new Rng(42);
            for (int i = 0; i < 5000; i++)
            {
                float f = rng.Float();
                Assert.GreaterOrEqual(f, 0f);
                Assert.Less(f, 1f);

                int n = rng.Int(3, 5);
                Assert.GreaterOrEqual(n, 3);
                Assert.LessOrEqual(n, 5);
            }
        }

        [Test]
        public void Rng_WeightedRespectsZeroWeights()
        {
            var rng = new Rng(7);
            var items = new[] { "a", "b" };
            for (int i = 0; i < 500; i++)
            {
                Assert.AreEqual("b", rng.Weighted(items, new[] { 0f, 1f }));
            }
            Assert.IsNull(rng.Weighted(items, new[] { 0f, 0f }));
        }

        [Test]
        public void Rng_GaussianClampedStaysInsideItsBound()
        {
            var rng = new Rng(11);
            for (int i = 0; i < 2000; i++)
            {
                float v = rng.GaussianClamped(0f, 1f, 2f);
                Assert.LessOrEqual(Math.Abs(v), 2f + 1e-5f);
            }
        }

        /// <summary>
        /// The port must reproduce the prototype's stream exactly, or a seed
        /// stops meaning the same map in both implementations.
        /// </summary>
        [Test]
        public void Rng_MatchesTheReferenceImplementation()
        {
            // Captured from the TypeScript Rng seeded with "greyzone".
            var rng = new Rng("greyzone");
            uint[] expected = { 2575388871u, 2164918832u, 3748067760u, 3327867570u, 1554202402u };
            for (int i = 0; i < expected.Length; i++)
            {
                Assert.AreEqual(expected[i], rng.Next(), $"output {i} diverged from the reference stream");
            }
        }

        [Test]
        public void Math_WrapAngleMapsIntoRange()
        {
            for (int i = -20; i <= 20; i++)
            {
                float a = Math2D.WrapAngle(i * 1.1f);
                Assert.Greater(a, -Math2D.Pi - 1e-4f);
                Assert.LessOrEqual(a, Math2D.Pi + 1e-4f);
            }
        }

        [Test]
        public void Math_AngleDeltaTakesTheShortWayRound()
        {
            float d = Math2D.AngleDelta(0.1f, Math2D.Tau - 0.1f);
            Assert.Less(Math.Abs(d + 0.2f), 1e-4f);
        }

        [Test]
        public void Math_DampIsFrameRateIndependent()
        {
            // One half-second step and fifty hundredth-second steps must agree.
            float one = Math2D.Damp(0f, 100f, 4f, 0.5f);
            float many = 0f;
            for (int i = 0; i < 50; i++) many = Math2D.Damp(many, 100f, 4f, 0.01f);
            Assert.Less(Math.Abs(one - many), 1e-3f);
        }

        [Test]
        public void Math_PointSegmentDistanceClampsToTheSegment()
        {
            Assert.AreEqual(0f, Math2D.PointSegmentDistSq(0, 0, 0, 0, 10, 0), 1e-4f);
            Assert.AreEqual(9f, Math2D.PointSegmentDistSq(5, 3, 0, 0, 10, 0), 1e-4f);
            // Past the end clamps to the endpoint, not the infinite line.
            Assert.AreEqual(100f, Math2D.PointSegmentDistSq(20, 0, 0, 0, 10, 0), 1e-4f);
        }

        [Test]
        public void SpatialHash_FindsOnlyEntitiesInRadius()
        {
            var hash = new SpatialHash(64, 64, 4f, 128);
            hash.Begin();
            hash.Insert(1, 10f, 10f);
            hash.Insert(2, 10.5f, 10.5f);
            hash.Insert(3, 40f, 40f);
            hash.Build();

            var results = new List<int>();
            hash.QueryRadius(10f, 10f, 2f, results);
            results.Sort();
            CollectionAssert.AreEqual(new[] { 1, 2 }, results);

            hash.QueryRadius(40f, 40f, 1f, results);
            CollectionAssert.AreEqual(new[] { 3 }, results);

            hash.QueryRadius(0f, 0f, 1f, results);
            Assert.IsEmpty(results);
        }

        [Test]
        public void SpatialHash_HandlesTheFarEdgeOfTheGrid()
        {
            var hash = new SpatialHash(32, 32, 4f, 16);
            hash.Begin();
            hash.Insert(9, 31.9f, 31.9f);
            hash.Build();

            var results = new List<int>();
            hash.QueryRadius(31f, 31f, 3f, results);
            CollectionAssert.AreEqual(new[] { 9 }, results);
        }

        [Test]
        public void Pool_AcquiresToCapacityAndReleases()
        {
            var pool = new Pool<int[]>(() => new int[1], o => o[0] = -1, 3);
            pool.Acquire();
            pool.Acquire();
            pool.Acquire();
            Assert.AreEqual(3, pool.Active);
            Assert.IsNull(pool.Acquire());

            pool.ReleaseAt(0);
            Assert.AreEqual(2, pool.Active);
            pool.ReleaseAll();
            Assert.AreEqual(0, pool.Active);
        }

        [Test]
        public void EventBus_DeliversAndUnsubscribes()
        {
            var bus = new EventBus();
            int received = 0;
            Action off = bus.Subscribe<int>(v => received += v);

            bus.Publish(5);
            Assert.AreEqual(5, received);

            off();
            bus.Publish(5);
            Assert.AreEqual(5, received, "an unsubscribed handler must not fire");
        }

        [Test]
        public void EventBus_SurvivesAHandlerUnsubscribingDuringDispatch()
        {
            var bus = new EventBus();
            int calls = 0;
            Action off = null;
            off = bus.Subscribe<string>(_ =>
            {
                calls++;
                off();
            });
            bus.Subscribe<string>(_ => calls++);

            // Both handlers must still run even though the first removes itself.
            bus.Publish("go");
            Assert.AreEqual(2, calls);

            bus.Publish("again");
            Assert.AreEqual(3, calls);
        }
    }

    public class WorldTests
    {
        [Test]
        public void TileMap_TreatsOutOfBoundsAsSolidAndOpaque()
        {
            var map = new TileMap(8, 8);
            Assert.IsTrue(map.IsSolid(-1, 0));
            Assert.IsTrue(map.IsOpaque(99, 0));
            Assert.IsFalse(map.IsSolid(4, 4));
        }

        [Test]
        public void TileMap_MaterialsDrivePenetrationAndCoverHeight()
        {
            var map = new TileMap(8, 8);
            map.Set(2, 2, Tile.Concrete);
            map.Set(3, 2, Tile.Wood);
            Assert.Greater(map.PenetrationOf(2, 2), map.PenetrationOf(3, 2));
            Assert.AreEqual(3f, map.HeightOf(2, 2), 1e-4f);
        }

        [Test]
        public void TileMap_NearestOpenEscapesASolidTile()
        {
            var map = new TileMap(8, 8);
            map.FillRect(0, 0, 7, 7, Tile.Concrete);
            map.Set(5, 5, Tile.Floor);

            Assert.IsTrue(map.NearestOpen(4, 4, 4, out int x, out int y));
            Assert.AreEqual(5, x);
            Assert.AreEqual(5, y);
        }

        [Test]
        public void Raycast_LineOfSightIsBlockedByOpaqueTilesOnly()
        {
            var map = new TileMap(16, 16);
            Assert.IsTrue(Raycast.HasLineOfSight(map, 1.5f, 1.5f, 14.5f, 1.5f));

            map.Set(8, 1, Tile.Concrete);
            Assert.IsFalse(Raycast.HasLineOfSight(map, 1.5f, 1.5f, 14.5f, 1.5f));

            // A fence blocks movement but not vision, which is its whole purpose.
            map.Set(8, 1, Tile.Fence);
            Assert.IsTrue(Raycast.HasLineOfSight(map, 1.5f, 1.5f, 14.5f, 1.5f));
        }

        [Test]
        public void Raycast_WalkSegmentVisitsEveryTileInOrder()
        {
            var visited = new List<string>();
            Raycast.WalkSegment(0.5f, 0.5f, 4.5f, 0.5f, (x, y, _) =>
            {
                visited.Add($"{x},{y}");
                return true;
            });
            CollectionAssert.AreEqual(new[] { "0,0", "1,0", "2,0", "3,0", "4,0" }, visited);
        }

        [Test]
        public void Raycast_WalkSegmentStopsWhenTheVisitorReturnsFalse()
        {
            int count = 0;
            Raycast.WalkSegment(0.5f, 0.5f, 20.5f, 0.5f, (_, __, ___) =>
            {
                count++;
                return count < 3;
            });
            Assert.AreEqual(3, count);
        }

        [Test]
        public void Movement_CircleCannotOverlapASolidTile()
        {
            var map = new TileMap(8, 8);
            map.Set(4, 4, Tile.Concrete);
            Assert.IsFalse(Movement.CircleFits(map, 4.5f, 4.5f, 0.3f));
            Assert.IsTrue(Movement.CircleFits(map, 2.5f, 2.5f, 0.3f));
            // Just outside the tile edge, by less than the radius.
            Assert.IsFalse(Movement.CircleFits(map, 3.8f, 4.5f, 0.3f));
        }

        [Test]
        public void Movement_SlidesAlongAWallInsteadOfStoppingDead()
        {
            var map = new TileMap(8, 8);
            for (int y = 0; y < 8; y++) map.Set(4, y, Tile.Concrete);

            MoveResult result = Movement.MoveCircle(map, 3.5f, 3.5f, 0.5f, 0.5f, 0.3f);
            Assert.IsTrue(result.HitX, "x should be blocked by the wall");
            Assert.Greater(result.Y, 3.5f, "y should still resolve");
        }

        [Test]
        public void Movement_FastStepDoesNotTunnelThroughAThinWall()
        {
            var map = new TileMap(32, 8);
            for (int y = 0; y < 8; y++) map.Set(10, y, Tile.Concrete);

            MoveResult result = Movement.MoveCircle(map, 2.5f, 3.5f, 20f, 0f, 0.3f);
            Assert.Less(result.X, 10f, "expected to stop before the wall");
        }

        [Test]
        public void NavGrid_RoutesAroundAnObstacle()
        {
            var map = new TileMap(24, 24);
            // A wall with a single gap: the path must go through the gap.
            for (int y = 0; y < 24; y++) map.Set(12, y, Tile.Concrete);
            map.Set(12, 20, Tile.Floor);

            var nav = new NavGrid(map);
            PathResult path = nav.FindPath(3.5f, 3.5f, 20.5f, 3.5f);

            Assert.IsTrue(path.Found);
            Assert.IsNotEmpty(path.Points);

            Vec2 last = path.Points[path.Points.Count - 1];
            Assert.Less(Math.Abs(last.X - 20.5f), 1.5f);
            Assert.Less(Math.Abs(last.Y - 3.5f), 1.5f);
        }

        [Test]
        public void NavGrid_ReportsFailureWhenTheTargetIsWalledOff()
        {
            var map = new TileMap(16, 16);
            map.StrokeRect(8, 8, 11, 11, Tile.Concrete);

            var nav = new NavGrid(map);
            PathResult path = nav.FindPath(2.5f, 2.5f, 9.5f, 9.5f);
            Assert.IsFalse(path.Found);
        }

        /// <summary>
        /// Regression: without a closed set the search re-expands stale heap
        /// duplicates, burns its node budget and calls a reachable goal
        /// unreachable. This is the shape of map that exposed it.
        /// </summary>
        [Test]
        public void NavGrid_FindsLongPathsAcrossVaryingTerrain()
        {
            var map = new TileMap(64, 64);
            map.StrokeRect(0, 0, 63, 63, Tile.Concrete);

            // Broken walls and a large slow-terrain field, so real costs are far
            // above the heuristic's assumption of 1 per tile.
            for (int y = 4; y < 60; y += 9)
            {
                for (int x = 3; x < 61; x++)
                {
                    if (x % 17 != 0) map.Set(x, y, Tile.Fence);
                }
            }
            map.FillRect(20, 20, 44, 44, Tile.Water);

            var nav = new NavGrid(map);
            PathResult path = nav.FindPath(2.5f, 2.5f, 60.5f, 60.5f);
            Assert.IsTrue(path.Found, "a reachable goal must not be reported unreachable");
        }

        [Test]
        public void NavGrid_FlowFieldPointsDownhillTowardTheTarget()
        {
            var map = new TileMap(24, 24);
            var nav = new NavGrid(map);
            nav.BuildFlowField(20.5f, 20.5f, true);

            float near = nav.FlowCostAt(19, 19);
            float far = nav.FlowCostAt(3, 3);
            Assert.Greater(far, near, "cost must grow with distance from the target");

            Assert.IsTrue(nav.SampleFlow(3, 3, out float dx, out float dy));
            Assert.IsTrue(dx > 0f || dy > 0f, "should point towards the target");
        }

        [Test]
        public void CoverMap_MarksTheSideAWallProtects()
        {
            var map = new TileMap(16, 16);
            map.Set(5, 4, Tile.Concrete); // directly north of (5,5)

            var cover = new CoverMap(map);
            Assert.IsTrue(cover.CoversFrom(5, 5, 0f, -1f), "covered from the north");
            Assert.IsFalse(cover.CoversFrom(5, 5, 0f, 1f), "not covered from the south");
        }

        [Test]
        public void CoverMap_OpenGroundScoresZero()
        {
            var map = new TileMap(16, 16);
            var cover = new CoverMap(map);
            Assert.AreEqual(0, cover.ScoreAt(8, 8));
        }
    }

    public class MapGeneratorTests
    {
        [Test]
        public void IsDeterministicForASeed()
        {
            MapBlueprint bp = MapCatalog.Blueprints[0];
            GeneratedMap a = MapGenerator.Generate(bp, 12345);
            GeneratedMap b = MapGenerator.Generate(bp, 12345);

            CollectionAssert.AreEqual(a.Map.Tiles, b.Map.Tiles);
            Assert.AreEqual(a.Extracts.Count, b.Extracts.Count);
            Assert.AreEqual(a.AiSpawns.Count, b.AiSpawns.Count);
        }

        [Test]
        public void ProducesAPlayableLayout()
        {
            foreach (MapBlueprint bp in MapCatalog.Blueprints)
            {
                GeneratedMap gen = MapGenerator.Generate(bp, 777);

                Assert.IsNotEmpty(gen.PlayerSpawns, $"{bp.Id}: needs a player spawn");
                Assert.GreaterOrEqual(gen.Extracts.Count, 2, $"{bp.Id}: needs multiple exits");
                Assert.Greater(gen.LootAnchors.Count, 5, $"{bp.Id}: needs loot");
                Assert.Greater(gen.AiSpawns.Count, 5, $"{bp.Id}: needs hostiles");

                // At least one unconditional exit, or a raid could be unwinnable.
                int free = 0;
                foreach (ExtractDefinition e in gen.Extracts)
                {
                    if (e.Condition.Kind == ExtractConditionKind.Always) free++;
                }
                Assert.GreaterOrEqual(free, 1, $"{bp.Id}: needs an unconditional exit");

                foreach (SpawnPoint spawn in gen.PlayerSpawns)
                {
                    Assert.IsFalse(gen.Map.IsSolid((int)spawn.X, (int)spawn.Y),
                        $"{bp.Id}: spawns must be on walkable ground");
                }
            }
        }

        /// <summary>
        /// The whole point of the connectivity repair: fences, clutter and
        /// buildings can otherwise combine to seal an exit off entirely.
        /// </summary>
        [Test]
        public void EveryExtractionIsReachableFromTheSpawn()
        {
            foreach (uint seed in new uint[] { 4242, 777, 12345, 99 })
            {
                GeneratedMap gen = MapGenerator.Generate(MapCatalog.Blueprints[0], seed);
                var nav = new NavGrid(gen.Map);
                SpawnPoint spawn = gen.PlayerSpawns[0];

                foreach (ExtractDefinition extract in gen.Extracts)
                {
                    PathResult path = nav.FindPath(spawn.X, spawn.Y, extract.X, extract.Y, 20000);
                    Assert.IsTrue(path.Found, $"seed {seed}: {extract.Id} must be reachable");
                }
            }
        }

        [Test]
        public void AiNeverSpawnsOnTopOfThePlayer()
        {
            GeneratedMap gen = MapGenerator.Generate(MapCatalog.Blueprints[0], 31337);
            foreach (SpawnPoint ai in gen.AiSpawns)
            {
                foreach (SpawnPoint player in gen.PlayerSpawns)
                {
                    Assert.GreaterOrEqual(Math2D.Distance(ai.X, ai.Y, player.X, player.Y), 14f,
                        "AI must not spawn inside the player's arrival area");
                }
            }
        }
    }
}
