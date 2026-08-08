import type { MapBlueprint } from '../world/MapGenerator';

/**
 * MapData - the raid locations.
 *
 * A blueprint describes a location's *character*, not its layout: how built-up
 * it is, how much cover litters the open ground, how long the raid runs and how
 * many hostiles hold it. The generator turns that plus a seed into a concrete
 * map, so every deployment to the same location is recognisably the same place
 * with a different arrangement - which keeps route knowledge valuable without
 * making the map memorised after three runs.
 *
 * All locations are original to this project.
 */

export const MAP_BLUEPRINTS: MapBlueprint[] = [
  {
    id: 'harbour',
    displayName: 'Hafenbecken 7',
    width: 96,
    height: 96,
    buildings: 4,
    containerYards: 2,
    // A working dock: a few large sheds and a lot of bare concrete. Sightlines
    // run long, so crossing the open is the decision this map asks, and a
    // rifle earns its weight here.
    clutter: 0.25,
    structureScale: 1.25,
    water: true,
    ambient: 0.66,
    raidSeconds: 25 * 60,
    aiCount: 22,
    character:
      'Weite Betonflächen zwischen wenigen großen Hallen. Lange Schusslinien - ein Zielfernrohr trägt sein Gewicht.',
    hasBoss: true,
    bossName: 'Kommandant Vasska',
  },
  {
    id: 'depot',
    displayName: 'Umschlagdepot Nord',
    width: 78,
    height: 78,
    buildings: 4,
    containerYards: 4,
    // The middle ground, and the one that should read as ordinary: mixed
    // ranges, neither a shooting gallery nor a knife fight.
    clutter: 1.1,
    structureScale: 1,
    water: false,
    ambient: 0.52,
    raidSeconds: 18 * 60,
    aiCount: 18,
    character:
      'Gemischte Entfernungen, nichts davon extrem. Der Ort zum Herantasten.',
    hasBoss: false,
    bossName: '',
  },
  {
    id: 'works',
    displayName: 'Kesselhaus West',
    width: 66,
    height: 66,
    buildings: 9,
    containerYards: 6,
    // A boiler house packed into its plot: many small structures, heavy debris
    // between them, corners everywhere. Short weapons and sound discipline win
    // here, and a scope is dead weight.
    clutter: 3.2,
    structureScale: 0.8,
    water: false,
    ambient: 0.38,
    raidSeconds: 14 * 60,
    aiCount: 14,
    character:
      'Enge Gassen, Ecken überall. Kurze Waffen und Gehör entscheiden.',
    hasBoss: false,
    bossName: '',
  },
  {
    id: 'filter',
    displayName: 'Klaerwerk Ost',
    width: 62,
    height: 62,
    // Fourteen structures on a small plot: the location is fought *through*
    // buildings rather than across a yard. Roughly 37 % of the walkable floor
    // sits under a roof against 14 % at the harbour, which is the highest the
    // generator reaches - past about fourteen buildings the placer runs out of
    // room and further ones simply fail, so this is the ceiling rather than an
    // arbitrary number.
    buildings: 14,
    containerYards: 1,
    clutter: 0.8,
    structureScale: 1.1,
    water: true,
    // Dark. Indoors most of the time and overcast when outside, so the torch
    // stops being an option and becomes equipment - and every enemy who has
    // one announces themselves the same way.
    ambient: 0.24,
    raidSeconds: 16 * 60,
    aiCount: 16,
    character:
      'Wird drinnen ausgetragen und liegt im Dunkeln. Ohne Lampe sieht man nichts - mit Lampe sieht dich jeder.',
    hasBoss: false,
    bossName: '',
  },
  {
    id: 'yard',
    displayName: 'Verladehof 3',
    // The risk/reward extreme rather than a geometric one. Half the area of
    // the works with more hostiles in it - about 0.0074 per tile against
    // 0.0024 at the harbour, three times the pressure - and eight minutes to
    // do something about it. There is no version of this raid where the player
    // clears the map; the question is what they can reach and still get out
    // with, which is the whole loop stated in one location.
    width: 52,
    height: 52,
    buildings: 5,
    containerYards: 4,
    clutter: 1.4,
    structureScale: 0.9,
    water: false,
    ambient: 0.58,
    raidSeconds: 8 * 60,
    aiCount: 20,
    character:
      'Klein, überfüllt, acht Minuten. Aufräumen ist keine Option - nimm, was du erreichst, und verschwinde.',
    hasBoss: false,
    bossName: '',
  },
];

export function blueprintById(id: string): MapBlueprint {
  return MAP_BLUEPRINTS.find((b) => b.id === id) ?? MAP_BLUEPRINTS[0];
}

/** Short briefing text shown on the deployment screen. */
export const MAP_BRIEFINGS: Record<string, string> = {
  harbour:
    'Weitläufiges Hafengelände mit Lagerhallen, Containerreihen und einem Kanal im Süden. ' +
    'Die zentrale Lagerhalle ist das Wertvollste und das Gefährlichste auf der Karte - ' +
    'dort hält sich der Kommandant auf. Vier Ausgänge, zwei davon mit Bedingungen.',
  depot:
    'Enges Umschlaglager, fast vollständig aus Containergassen. Kurze Sichtachsen, ' +
    'viele Ecken, kaum Deckung im Freien. Kämpfe entscheiden sich auf wenigen Metern.',
  works:
    'Altes Kesselhaus, dunkel und beengt. Wenig Beute im Freien, dafür lohnende Innenräume. ' +
    'Ohne Licht am Lauf wirst du hier kaum etwas sehen - und mit Licht sieht man dich.',
};

/**
 * How each location reads under a dark sky. Shown on the deployment screen
 * once the player picks anything other than daylight, because "how bad is the
 * dark here" is location-specific and worth knowing before committing.
 */
export const MAP_NIGHT_NOTES: Record<string, string> = {
  harbour:
    'Die Kaianlage hat funktionierende Flutlichter. Beleuchtete Flächen sind schnell zu queren ' +
    'und machen dich zur Silhouette; der Rest des Geländes ist stockdunkel.',
  depot:
    'Kaum feste Beleuchtung. In den Containergassen entscheidet sich alles auf wenigen Metern - ' +
    'wer zuerst Licht macht, wird zuerst gesehen.',
  works:
    'Notbeleuchtung im Kesselhaus, sonst nichts. Nachts ist das die dunkelste Karte im Sektor.',
};
