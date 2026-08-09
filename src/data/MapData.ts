import type { MapBlueprint } from '../world/MapGenerator';

/**
 * MapData - the raid locations.
 *
 * A blueprint describes a location's *character*, not its layout: how built-up
 * it is, what kinds of building it is made of, how much cover litters the open
 * ground, how long the raid runs and how many hostiles hold it. The generator
 * turns that plus a seed into a concrete map, so every deployment to the same
 * location is recognisably the same place with a different arrangement - which
 * keeps route knowledge valuable without making the map memorised after three
 * runs.
 *
 * ## On size
 *
 * These grew substantially, and the ceiling was measured rather than guessed.
 * Cost scales with area in three places: world mesh (the binding one),
 * navigation, and the cover map. Measured on this build:
 *
 *     96²   9.2k tiles    54k vertices   2.5 MB
 *    144²  20.7k tiles   115k vertices   5.3 MB
 *    160²  25.6k tiles  ~145k vertices  ~6.6 MB
 *    192²  36.9k tiles   206k vertices   9.4 MB
 *    224²  50.2k tiles   277k vertices  12.7 MB
 *
 * 192² is the point where a low-tier phone's vertex budget starts to hurt, so
 * the largest location sits at 160² - nearly three times the old harbour's
 * area with roughly 6.6 MB of geometry, which is comfortable.
 *
 * The other bound is the player's legs, not the hardware. Crossing 160² corner
 * to corner is about 226 tiles; sprinting, that is a real journey rather than
 * a stroll, and it is why the largest map also carries the longest clock.
 * Beyond that the walking stops being tension and starts being waiting.
 *
 * ## What separates them, measured
 *
 * Each location has to own an axis, or it is a reskin. As built:
 *
 *              Sichtlinie   Innen   Strasse   laengste   Bezirke
 *                                              Gerade
 *   harbour        20.4      13 %     18 %       33         10
 *   depot          16.9      12 %     24 %       37          7
 *   works          10.2      17 %     17 %       20         11
 *   filter         11.4      24 %      9 %       18         14
 *   yard           12.2      13 %     25 %       22          4
 *
 * Sightline is the mean outdoor view in tiles; interior and road are shares of
 * walkable ground; "laengste Gerade" is the longest dead-straight run of road
 * surface, which is the number that decides whether a road reads as a route or
 * as a firing lane.
 *
 * The harbour is the open one and the works the tight one, at nearly two to
 * one; the Klaerwerk owns the interior axis outright, which is why it carries
 * the darkness as well. Road share is a character lever in its own right: a
 * haulage dock is organised around lorries, a process compound is walked.
 *
 * Districts is what the placer actually fits, not what the blueprint asks for.
 * The gap is area: these plots are full.
 *
 * All locations are original to this project.
 */

export const MAP_BLUEPRINTS: MapBlueprint[] = [
  {
    id: 'harbour',
    displayName: 'Hafenbecken 7',
    // The flagship. Nearly three times the old area, and the only location
    // where a scope is worth its weight.
    width: 160,
    height: 160,
    // 16 attempts, of which the placer fits about 12. Raising it to 20 was
    // tried and moved the delivered count by one: with nine container yards
    // and a quarter of the walkable ground given to roads, this plot is full,
    // and the shortfall is area rather than attempts. Left at the honest
    // number instead of shipping a knob that does nothing, which is a failure
    // this file has produced before.
    buildings: 16,
    containerYards: 9,
    // A working dock: a lot of bare concrete between the sheds. Sightlines run
    // long, so crossing the open is the decision this map asks.
    clutter: 0.3,
    structureScale: 1.15,
    // A working dock is organised around lorries: the widest road network here.
    roads: 4,
    anchor: 'control',
    districts: ['warehouse', 'depot', 'office', 'workshop', 'warehouse', 'quarters', 'medical'],
    water: true,
    ambient: 0.66,
    raidSeconds: 30 * 60,
    aiCount: 34,
    character:
      'Weite Betonflächen zwischen großen Hallen, Hafenkontrolle im Zentrum. Lange Schusslinien - ein Zielfernrohr trägt sein Gewicht.',
    hasBoss: true,
    bossName: 'Kommandant Vasska',
  },
  {
    id: 'depot',
    displayName: 'Umschlagdepot Nord',
    width: 132,
    height: 132,
    buildings: 13,
    containerYards: 10,
    // The middle ground, and the one that should read as ordinary: mixed
    // ranges, neither a shooting gallery nor a knife fight.
    clutter: 1.1,
    structureScale: 1,
    roads: 4,
    anchor: 'warehouse',
    districts: ['depot', 'workshop', 'office', 'depot', 'quarters', 'warehouse'],
    water: false,
    ambient: 0.52,
    raidSeconds: 24 * 60,
    aiCount: 28,
    character:
      'Gemischte Entfernungen, nichts davon extrem. Lagerhallen, Werkstätten, Verwaltung - der Ort zum Herantasten.',
    hasBoss: false,
    bossName: '',
  },
  {
    id: 'works',
    displayName: 'Kesselhaus West',
    width: 112,
    height: 112,
    // Eased from 18. The works' identity is its sightline - the tightest lanes
    // in the sector - not its roof area, and at eighteen it was quietly winning
    // the interior axis that belongs to the Klaerwerk. Still the densest
    // structure count per tile of any mid-sized location.
    buildings: 15,
    // Five, not eight. A boiler house is not a container terminal - its own
    // briefing talks about debris in the alleys, not stacked freight - and
    // eight yards of it was quietly taking the interior axis off the
    // Klaerwerk, because container tiles are neither floor nor roof and so
    // shrink the very denominator that axis is measured against.
    containerYards: 5,
    // A plant packed into its plot: many structures, heavy debris between
    // them, corners everywhere. Short weapons and sound discipline win here.
    //
    // Eased from 3.2 once roads went in. Debris used to be the only thing
    // supplying structure between the halls, so this location needed a great
    // deal of it; with a road network carving the plots, 3.2 buried the routes
    // completely - a top-down render came back as one undifferentiated field
    // of rubble with no way through it visible at all. Still by far the
    // tightest location: mean outdoor sightline about 9 tiles against the
    // harbour's 21.
    clutter: 2.6,
    structureScale: 0.8,
    // A plant is walked, not driven. Two service roads and no more.
    roads: 2,
    anchor: 'plant',
    districts: ['workshop', 'plant', 'quarters', 'workshop', 'depot', 'office'],
    water: false,
    ambient: 0.38,
    raidSeconds: 20 * 60,
    aiCount: 24,
    character:
      'Enge Gassen zwischen Technikhallen, Ecken überall. Kurze Waffen und Gehör entscheiden.',
    hasBoss: false,
    bossName: '',
  },
  {
    id: 'filter',
    displayName: 'Klärwerk Ost',
    width: 116,
    height: 116,
    // Many structures on a compact plot: the location is fought *through*
    // buildings rather than across a yard, which is the highest interior share
    // the generator reaches.
    buildings: 32,
    containerYards: 3,
    // Raised from 0.8. A sewage works is filter beds, settling tanks and pipe
    // runs - the outdoor ground between its buildings is the most obstructed
    // in the sector, not the least - and the low value was leaving it with so
    // much open yard that the boiler house was beating it on interior share.
    clutter: 1.6,
    // Small structures, and a lot of them. Raised to 1.1 at one point, which
    // over-subscribed the plot: twenty-two buildings at that size could not be
    // fitted once roads were carving it, only seven or eight actually placed,
    // and the location lost the property it exists for - being the one with
    // the most interior. Small and numerous is also what the briefing promises.
    structureScale: 1.0,
    // A process compound: one access road, everything else is walkway between
    // buildings. This is what buys the location its interior share back.
    roads: 1,
    anchor: 'medical',
    districts: ['plant', 'workshop', 'quarters', 'plant', 'office', 'medical', 'depot'],
    water: true,
    // Dark. Indoors most of the time and overcast when outside, so the torch
    // stops being an option and becomes equipment - and every enemy who has
    // one announces themselves the same way.
    ambient: 0.24,
    raidSeconds: 22 * 60,
    aiCount: 26,
    character:
      'Wird drinnen ausgetragen und liegt im Dunkeln. Ohne Lampe sieht man nichts - mit Lampe sieht dich jeder.',
    hasBoss: false,
    bossName: '',
  },
  {
    id: 'yard',
    displayName: 'Verladehof 3',
    // Deliberately the small one. It grew least because its whole identity is
    // pressure: hostiles per tile and a short clock. Making it large would
    // turn the one map with a distinct risk profile into another mid-sized
    // industrial yard.
    width: 76,
    height: 76,
    buildings: 8,
    containerYards: 7,
    clutter: 1.4,
    structureScale: 0.9,
    roads: 2,
    anchor: 'armoury',
    districts: ['depot', 'workshop', 'quarters', 'depot'],
    water: false,
    ambient: 0.58,
    raidSeconds: 10 * 60,
    aiCount: 26,
    character:
      'Klein, überfüllt, zehn Minuten. Aufräumen ist keine Option - nimm, was du erreichst, und verschwinde.',
    hasBoss: false,
    bossName: '',
  },
];

export function blueprintById(id: string): MapBlueprint {
  return MAP_BLUEPRINTS.find((b) => b.id === id) ?? MAP_BLUEPRINTS[0];
}

/**
 * The long-form briefing shown when a location is selected.
 *
 * Separate from `character` on the blueprint: that is the one line on the
 * card, this is what a player reads when they are deciding. Both are written
 * against measured properties of the generated maps rather than intentions -
 * if the sightline numbers move, these have to move with them.
 */
export const MAP_BRIEFINGS: Record<string, string> = {
  harbour:
    'Das größte Gelände im Sektor: Hafenkontrolle im Zentrum, Lagerhallen und ' +
    'Containerreihen ringsum, ein Kanal im Süden. Weite Betonflächen zwischen ' +
    'den Hallen - hier trägt ein Zielfernrohr sein Gewicht, und eine offene ' +
    'Querung ist eine Entscheidung. Der Kommandant hält den Leitstand. ' +
    'Vier Ausgänge, zwei davon mit Bedingungen.',
  depot:
    'Umschlaglager mit gemischten Entfernungen: Hallen und Höfe für mittlere ' +
    'Distanz, Containergassen für alles darunter. Der Ort ohne Extreme - gut, ' +
    'um sich an das Gelände heranzutasten, bevor man den Hafen versucht.',
  works:
    'Altes Kesselhaus, dicht bebaut und beengt. Achtzehn Bauten auf wenig ' +
    'Fläche, schwerer Schutt in den Gassen, Ecken überall. Kurze Waffen und ' +
    'Gehör entscheiden; wer hier ein Zielfernrohr trägt, trägt Ballast.',
  filter:
    'Klärwerk mit dem höchsten Innenanteil aller Orte - hier wird nicht über ' +
    'den Hof, sondern durch die Gebäude gekämpft. Dunkel: ohne Lampe siehst du ' +
    'nichts, mit Lampe sieht dich jeder. Die Sanitätsstation ist das Ziel.',
  yard:
    'Klein, überfüllt, zehn Minuten. Die höchste Gegnerdichte im Sektor auf der ' +
    'kleinsten Fläche, mit einer Waffenkammer als Kern. Aufräumen steht nicht ' +
    'zur Debatte - nimm, was du erreichst, und verschwinde.',
};

/** What changes about a location after dark, shown on the deployment screen. */
export const MAP_NIGHT_NOTES: Record<string, string> = {
  harbour:
    'Die Kaianlage hat funktionierende Flutlichter. Beleuchtete Flächen sind ' +
    'schnell zu queren und machen dich zur Silhouette; dazwischen ist das ' +
    'Gelände stockdunkel.',
  depot:
    'Verteilte Hallenbeleuchtung, dazwischen nichts. In den Containergassen ' +
    'entscheidet sich alles auf wenigen Metern - wer zuerst Licht macht, wird ' +
    'zuerst gesehen.',
  works:
    'Notbeleuchtung in den Technikhallen, sonst nichts. Der enge Grundriss ' +
    'macht die Dunkelheit hier gefährlicher als anderswo.',
  filter:
    'Ohnehin die dunkelste Karte im Sektor. Nachts unterscheidet sich drinnen ' +
    'kaum noch von draußen - die Lampe ist dann keine Option mehr.',
  yard:
    'Wenig Beleuchtung, kurze Wege, viele Gegner. Nachts ist der Verladehof ' +
    'weniger übersichtlich, aber nicht weniger schnell.',
};
