using System.Collections.Generic;
using Greyzone.Simulation.Core;
using Greyzone.Simulation.World;
using UnityEngine;

namespace Greyzone.Runtime
{
    /// <summary>
    /// Builds a generated raid map out of primitives so the layout can be
    /// walked and judged before any art exists.
    /// </summary>
    /// <remarks>
    /// This is the boundary between the ported simulation and Unity: the
    /// simulation produces a <see cref="GeneratedMap"/>, this reads it and
    /// instantiates geometry. Nothing here feeds back into the simulation.
    ///
    /// It is intentionally a throwaway visualiser. When real art arrives, the
    /// tile switch is replaced by prefab lookups and everything else stays -
    /// including the crucial property that the <see cref="TileMap"/> remains the
    /// authority for cover, line of sight and sound. Building colliders and then
    /// trusting <c>Physics.Raycast</c> instead would give up the guarantee that
    /// what you see, what stops a bullet and what muffles a footstep agree.
    ///
    /// Put it on an empty GameObject and press Play, or use the context menu to
    /// rebuild in the Editor.
    /// </remarks>
    [ExecuteAlways]
    public sealed class MapPreview : MonoBehaviour
    {
        [Header("Generation")]
        [Tooltip("Blueprint id from MapCatalog: harbour, depot or works.")]
        public string BlueprintId = "harbour";

        [Tooltip("Same seed produces exactly the same map, in Unity and in the web prototype.")]
        public int Seed = 12345;

        [Tooltip("Regenerate whenever a value changes in the inspector.")]
        public bool RebuildOnValidate = true;

        [Header("Presentation")]
        [Tooltip("World units per tile. One tile is two metres in the simulation.")]
        public float TileScale = 2f;

        [Tooltip("Draw extraction, spawn and patrol markers.")]
        public bool ShowMarkers = true;

        /// <summary>The generated map, exposed so other systems can read it.</summary>
        public GeneratedMap Generated { get; private set; }

        private Transform _root;
        private readonly List<Vector3> _gizmoExtracts = new List<Vector3>();
        private readonly List<Vector3> _gizmoPlayerSpawns = new List<Vector3>();
        private readonly List<Vector3> _gizmoAiSpawns = new List<Vector3>();

        private void OnEnable() => Rebuild();

        private void OnValidate()
        {
            if (RebuildOnValidate && isActiveAndEnabled) Rebuild();
        }

        [ContextMenu("Rebuild")]
        public void Rebuild()
        {
            Clear();

            MapBlueprint blueprint = MapCatalog.ById(BlueprintId);
            Generated = MapGenerator.Generate(blueprint, unchecked((uint)Seed));

            _root = new GameObject("GeneratedMap").transform;
            _root.SetParent(transform, false);
            _root.gameObject.hideFlags = HideFlags.DontSave;

            BuildGeometry(Generated.Map);
            CollectMarkers(Generated);
        }

        [ContextMenu("Randomise seed")]
        public void RandomiseSeed()
        {
            Seed = Random.Range(int.MinValue, int.MaxValue);
            Rebuild();
        }

        private void Clear()
        {
            _gizmoExtracts.Clear();
            _gizmoPlayerSpawns.Clear();
            _gizmoAiSpawns.Clear();

            // Children accumulate across domain reloads and inspector edits, so
            // clear by walking backwards over a snapshot rather than trusting
            // the live child list to stay stable while we destroy from it.
            var doomed = new List<GameObject>();
            for (int i = 0; i < transform.childCount; i++) doomed.Add(transform.GetChild(i).gameObject);
            foreach (GameObject go in doomed)
            {
                if (Application.isPlaying) Destroy(go);
                else DestroyImmediate(go);
            }
            _root = null;
        }

        /// <summary>
        /// Emits one box per wall tile plus a ground plane.
        /// </summary>
        /// <remarks>
        /// Deliberately unoptimised - no batching, no mesh merging. A 96x96 map
        /// is a few thousand primitives, which the Editor handles fine, and the
        /// point of this component is to read the layout, not to ship it.
        /// </remarks>
        private void BuildGeometry(TileMap map)
        {
            Material wallMaterial = MakeMaterial(new Color(0.62f, 0.62f, 0.60f));
            Material seeThroughMaterial = MakeMaterial(new Color(0.55f, 0.60f, 0.62f));
            Material lowMaterial = MakeMaterial(new Color(0.55f, 0.44f, 0.26f));
            Material floorMaterial = MakeMaterial(new Color(0.26f, 0.25f, 0.23f));
            Material waterMaterial = MakeMaterial(new Color(0.15f, 0.26f, 0.32f));

            // Ground plane, sized to the map.
            var ground = GameObject.CreatePrimitive(PrimitiveType.Cube);
            ground.name = "Ground";
            ground.transform.SetParent(_root, false);
            ground.transform.localScale = new Vector3(map.Width * TileScale, 0.2f, map.Height * TileScale);
            ground.transform.localPosition = new Vector3(
                map.Width * TileScale * 0.5f, -0.1f, map.Height * TileScale * 0.5f);
            ground.GetComponent<Renderer>().sharedMaterial = floorMaterial;

            for (int y = 0; y < map.Height; y++)
            {
                for (int x = 0; x < map.Width; x++)
                {
                    Tile tile = map.At(x, y);

                    if (tile == Tile.Water)
                    {
                        SpawnBox(x, y, 0.06f, waterMaterial, "Water");
                        continue;
                    }

                    TileDef def = Tiles.Defs[(int)tile];
                    if (!def.Wall) continue;

                    Material mat = def.Height < 1.5f
                        ? lowMaterial
                        : (def.Opaque ? wallMaterial : seeThroughMaterial);
                    SpawnBox(x, y, def.Height, mat, def.Name);
                }
            }
        }

        private void SpawnBox(int x, int y, float heightMetres, Material material, string label)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = $"{label} {x},{y}";
            go.transform.SetParent(_root, false);
            go.transform.localScale = new Vector3(TileScale, heightMetres, TileScale);
            go.transform.localPosition = new Vector3(
                (x + 0.5f) * TileScale, heightMetres * 0.5f, (y + 0.5f) * TileScale);
            go.GetComponent<Renderer>().sharedMaterial = material;
        }

        private static Material MakeMaterial(Color color)
        {
            // Whichever pipeline the project uses, one of these shaders exists.
            Shader shader = Shader.Find("Universal Render Pipeline/Lit")
                            ?? Shader.Find("Standard")
                            ?? Shader.Find("Sprites/Default");
            var material = new Material(shader) { hideFlags = HideFlags.DontSave };
            material.color = color;
            return material;
        }

        private void CollectMarkers(GeneratedMap gen)
        {
            foreach (ExtractDefinition e in gen.Extracts)
            {
                _gizmoExtracts.Add(new Vector3(e.X * TileScale, 1.5f, e.Y * TileScale));
            }
            foreach (SpawnPoint s in gen.PlayerSpawns)
            {
                _gizmoPlayerSpawns.Add(new Vector3(s.X * TileScale, 1f, s.Y * TileScale));
            }
            foreach (SpawnPoint s in gen.AiSpawns)
            {
                _gizmoAiSpawns.Add(new Vector3(s.X * TileScale, 1f, s.Y * TileScale));
            }
        }

        private void OnDrawGizmos()
        {
            if (!ShowMarkers || Generated == null) return;

            Gizmos.color = new Color(0.45f, 0.9f, 0.65f);
            foreach (Vector3 p in _gizmoExtracts)
            {
                Gizmos.DrawWireSphere(transform.TransformPoint(p), TileScale * 1.2f);
                Gizmos.DrawLine(transform.TransformPoint(p),
                    transform.TransformPoint(p + Vector3.up * 6f));
            }

            Gizmos.color = new Color(0.85f, 0.62f, 0.25f);
            foreach (Vector3 p in _gizmoPlayerSpawns)
            {
                Gizmos.DrawWireCube(transform.TransformPoint(p), Vector3.one * TileScale);
            }

            Gizmos.color = new Color(0.78f, 0.30f, 0.25f);
            foreach (Vector3 p in _gizmoAiSpawns)
            {
                Gizmos.DrawWireSphere(transform.TransformPoint(p), TileScale * 0.4f);
            }

            // Patrol routes, so the AI's intended rounds are visible.
            Gizmos.color = new Color(0.4f, 0.55f, 0.8f, 0.7f);
            foreach (PatrolRoute route in Generated.PatrolRoutes)
            {
                for (int i = 0; i < route.Points.Count; i++)
                {
                    Vec2 a = route.Points[i];
                    Vec2 b = route.Points[(i + 1) % route.Points.Count];
                    Gizmos.DrawLine(
                        transform.TransformPoint(new Vector3(a.X * TileScale, 0.6f, a.Y * TileScale)),
                        transform.TransformPoint(new Vector3(b.X * TileScale, 0.6f, b.Y * TileScale)));
                }
            }
        }
    }
}
