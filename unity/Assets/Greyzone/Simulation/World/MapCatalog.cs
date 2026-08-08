using System.Collections.Generic;

namespace Greyzone.Simulation.World
{
    /// <summary>
    /// The raid locations.
    /// </summary>
    /// <remarks>
    /// A blueprint describes a location's <i>character</i>, not its layout: how
    /// built up it is, how much cover litters the open ground, how long the raid
    /// runs, how many hostiles hold it. The generator turns that plus a seed into
    /// a concrete map, so every deployment to the same location is recognisably
    /// the same place with a different arrangement - which keeps route knowledge
    /// valuable without the map being memorised after three runs.
    ///
    /// Kept as plain C# rather than ScriptableObjects so the simulation assembly
    /// stays free of UnityEngine and testable headlessly. A ScriptableObject
    /// wrapper that feeds these values in belongs in the presentation layer.
    /// </remarks>
    public static class MapCatalog
    {
        public static readonly MapBlueprint[] Blueprints =
        {
            new MapBlueprint
            {
                Id = "harbour",
                DisplayName = "Hafenbecken 7",
                Width = 96,
                Height = 96,
                Buildings = 5,
                ContainerYards = 3,
                Clutter = 0.9f,
                Water = true,
                Ambient = 0.66f,
                RaidSeconds = 25 * 60,
                AiCount = 22,
                HasBoss = true,
                BossName = "Kommandant Vasska",
            },
            new MapBlueprint
            {
                Id = "depot",
                DisplayName = "Umschlagdepot Nord",
                Width = 78,
                Height = 78,
                Buildings = 4,
                ContainerYards = 4,
                Clutter = 1.1f,
                Water = false,
                Ambient = 0.52f,
                RaidSeconds = 18 * 60,
                AiCount = 18,
                HasBoss = false,
                BossName = "",
            },
            new MapBlueprint
            {
                Id = "works",
                DisplayName = "Kesselhaus West",
                Width = 66,
                Height = 66,
                Buildings = 3,
                ContainerYards = 2,
                Clutter = 0.7f,
                Water = false,
                Ambient = 0.38f,
                RaidSeconds = 14 * 60,
                AiCount = 14,
                HasBoss = false,
                BossName = "",
            },
        };

        public static MapBlueprint ById(string id)
        {
            foreach (MapBlueprint b in Blueprints)
            {
                if (b.Id == id) return b;
            }
            return Blueprints[0];
        }

        /// <summary>Briefing text shown on the deployment screen.</summary>
        public static readonly Dictionary<string, string> Briefings = new Dictionary<string, string>
        {
            ["harbour"] =
                "Weitläufiges Hafengelände mit Lagerhallen, Containerreihen und einem Kanal im Süden. " +
                "Die zentrale Lagerhalle ist das Wertvollste und das Gefährlichste auf der Karte - " +
                "dort hält sich der Kommandant auf. Vier Ausgänge, zwei davon mit Bedingungen.",
            ["depot"] =
                "Enges Umschlaglager, fast vollständig aus Containergassen. Kurze Sichtachsen, " +
                "viele Ecken, kaum Deckung im Freien. Kämpfe entscheiden sich auf wenigen Metern.",
            ["works"] =
                "Altes Kesselhaus, dunkel und beengt. Wenig Beute im Freien, dafür lohnende Innenräume. " +
                "Ohne Licht am Lauf wirst du hier kaum etwas sehen - und mit Licht sieht man dich.",
        };
    }
}
