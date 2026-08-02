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
    buildings: 5,
    containerYards: 3,
    clutter: 0.9,
    water: true,
    ambient: 0.66,
    raidSeconds: 25 * 60,
    aiCount: 22,
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
    clutter: 1.1,
    water: false,
    ambient: 0.52,
    raidSeconds: 18 * 60,
    aiCount: 18,
    hasBoss: false,
    bossName: '',
  },
  {
    id: 'works',
    displayName: 'Kesselhaus West',
    width: 66,
    height: 66,
    buildings: 3,
    containerYards: 2,
    clutter: 0.7,
    water: false,
    ambient: 0.38,
    raidSeconds: 14 * 60,
    aiCount: 14,
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
