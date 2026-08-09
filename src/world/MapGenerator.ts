import { Rng } from '../core/Random';
import { Tile, TileMap } from './TileMap';
import { hasLineOfSight } from './Raycast';
import { carveBorders, planBorders } from './Borders';
import { carveRoads } from './Roads';
import { applyConditions, defaultConditions } from './Conditions';
import { TIER_DANGER, districtById, type DistrictKind, type FootprintKind } from './Districts';

/**
 * MapGenerator - seeded procedural construction of raid locations.
 *
 * Maps are built from *blueprints*: a small declarative description of the
 * location's character (size, districts, building density, water, boss lair).
 * The generator turns a blueprint plus a seed into a fully populated TileMap
 * with spawns, extractions, loot anchors and patrol routes.
 *
 * Design intent: layouts must be readable and tactical, not maze-like. Every
 * district is connected by at least two routes so the player always has a
 * flank option and AI always has one too. Extractions sit on opposite edges so
 * "which way out" is a real decision under a running raid timer.
 *
 * Unity port note: `GeneratedMap` is a plain data object. In Unity the same
 * generator runs at raid start and drives prefab placement instead of tiles.
 */

export interface SpawnPoint {
  x: number;
  y: number;
  /** Facing in radians the actor starts with. */
  angle: number;
  /** Tag used to keep player and AI spawns apart. */
  tag: 'player' | 'ai' | 'boss';
}

export interface ExtractDefinition {
  id: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  /** Seconds the player must stand inside without leaving. */
  holdSeconds: number;
  /**
   * Conditional extracts are the risk/reward lever: cheaper routes cost
   * something (an item, a fee) or are only open part of the raid.
   */
  condition?: ExtractCondition;
}

export type ExtractCondition =
  | { kind: 'always' }
  | { kind: 'item'; itemDefId: string; label: string }
  | { kind: 'fee'; amount: number; label: string }
  /** Only open during a window of the raid, expressed as fraction of time left. */
  | { kind: 'timeWindow'; openAfterFraction: number; closeAfterFraction: number; label: string };

export interface LootAnchor {
  x: number;
  y: number;
  /** Which loot table drives contents. */
  tableId: string;
  /** Container archetype id (see LootContainer definitions). */
  containerId: string;
}

export interface PatrolRoute {
  id: number;
  points: { x: number; y: number }[];
  /** Zone this route belongs to, for assigning appropriate AI. */
  zoneId: number;
}

export interface LightSource {
  x: number;
  y: number;
  /** Radius in tiles. */
  radius: number;
  /** 0..1 */
  intensity: number;
  color: number;
  /** Flickering lights read as "damaged industrial site" and cost nothing. */
  flicker: number;
}

export interface GeneratedMap {
  map: TileMap;
  seed: number;
  blueprintId: string;
  displayName: string;
  playerSpawns: SpawnPoint[];
  aiSpawns: SpawnPoint[];
  bossSpawn: SpawnPoint | null;
  extracts: ExtractDefinition[];
  lootAnchors: LootAnchor[];
  patrolRoutes: PatrolRoute[];
  lights: LightSource[];
  /** Ambient sky light 0..1, drives the outdoor exposure. */
  ambient: number;
  /** Raid duration in seconds. */
  raidSeconds: number;
}

export interface MapBlueprint {
  id: string;
  displayName: string;
  width: number;
  height: number;
  /** Number of enclosed buildings to attempt. */
  buildings: number;
  /** Number of shipping-container clusters. */
  containerYards: number;
  /** 0..1 scatter density of loose cover in the open. */
  clutter: number;
  /**
   * Multiplies every structure's footprint. 1 is the original scale.
   *
   * Added because measurement said the blueprints were barely doing anything.
   * Three "different locations" came out at 25.8-29.2 % solid ground and a
   * mean sightline of 8.3-10.8 tiles - and two seeds of the *same* blueprint
   * varied by as much. Locations differed in size and item count, not in
   * character, so a fourth entry in the table would only have produced more
   * of the same.
   *
   * Building and yard dimensions used to be hard-coded ranges, so a bigger map
   * got more structures of identical size rather than a different kind of
   * place. This is the lever that separates a hall you fight across from a
   * warren you fight through.
   */
  structureScale: number;
  // A `structureSpacing` field lived here briefly. I added it expecting the
  // gap between structures to be the dominant term for how far a player can
  // see, and then measured it: sweeping it from 2 to 12 tiles moved the mean
  // outdoor sightline from 7.3 to 8.3. Fourteen per cent, for a knob that
  // reads as though it reshapes the map. `clutter` moves the same number from
  // 11.1 to 4.6 across its range, so that is the lever the blueprints use.
  // Recorded rather than quietly dropped, because the plausible-but-inert
  // parameter is the exact failure this codebase has produced four times.
  /**
   * How many through-roads the site has.
   *
   * A blueprint lever rather than a function of size, because road density is
   * character: a haulage dock is organised around vehicles and wants a network,
   * a process plant is a compound of buildings joined by service walkways and
   * wants almost none. Derived from size alone it flattened the locations - a
   * road network costs about a sixth of a map's area, and giving every location
   * the same one took the same sixth out of each, which collapsed the interior
   * share of all five into a four-point band where nothing owned anything.
   */
  roads: number;
  /** Adds a water channel along one edge with a pier. */
  water: boolean;
  ambient: number;
  raidSeconds: number;
  /** AI population target for the location. */
  aiCount: number;
  /**
   * Which kinds of building this location is made of, most characteristic
   * first, and which one anchors it.
   *
   * Buildings used to be anonymous rectangles differing only in size, so a
   * workshop and an office held the same things and there was no reason to
   * prefer either. A district mix is what turns "a building" into "the
   * medical store", which is the difference between a map you navigate and a
   * map you *know*.
   *
   * `anchor` is the map's centrepiece: placed first, given the best ground,
   * and always its most dangerous and most valuable address.
   */
  anchor: string;
  districts: string[];
  /**
   * One line telling the player what kind of place this is.
   *
   * The locations carry real, measured differences - mean outdoor sightlines
   * from 9.0 to 16.5 tiles, roofed floor from 13 % to 23 %, hostile density
   * varying threefold - and none of that was visible before choosing. A player
   * only finds out what a place is by dying in it once, which is a poor way to
   * learn that their scope is dead weight.
   */
  character: string;
  hasBoss: boolean;
  bossName: string;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const rectW = (r: Rect) => r.x1 - r.x0 + 1;
const rectH = (r: Rect) => r.y1 - r.y0 + 1;
const rectCx = (r: Rect) => (r.x0 + r.x1) * 0.5;
const rectCy = (r: Rect) => (r.y0 + r.y1) * 0.5;

function rectsOverlap(a: Rect, b: Rect, padding = 0): boolean {
  return !(
    a.x1 + padding < b.x0 ||
    a.x0 - padding > b.x1 ||
    a.y1 + padding < b.y0 ||
    a.y0 - padding > b.y1
  );
}

export function generateMap(bp: MapBlueprint, seed: number): GeneratedMap {
  const rng = new Rng(seed);
  const map = new TileMap(bp.width, bp.height);

  const result: GeneratedMap = {
    map,
    seed,
    blueprintId: bp.id,
    displayName: bp.displayName,
    playerSpawns: [],
    aiSpawns: [],
    bossSpawn: null,
    extracts: [],
    lootAnchors: [],
    patrolRoutes: [],
    lights: [],
    ambient: bp.ambient,
    raidSeconds: bp.raidSeconds,
  };

  // 1. Base terrain: open gravel yard.
  map.tiles.fill(Tile.Floor);
  map.floor.fill(Tile.Floor);
  map.ceiling.fill(0);

  // 2. The edges of the world, made of something. See Borders.ts - the short
  // version is that out-of-bounds is already solid and opaque, so the boundary
  // never needed to be a wall and can be terrain with a ragged inner edge
  // instead of two stroked rectangles.
  const borders = planBorders(rng, bp);
  carveBorders(map, rng, bp, borders);

  if (bp.water) {
    // Piers reaching into the channel, so the waterfront is a place to fight
    // over rather than the back of the map.
    const reach = borders.insets[2] + 2;
    for (const px of [Math.floor(bp.width * 0.3), Math.floor(bp.width * 0.72)]) {
      map.fillRect(px - 1, bp.height - 1 - reach, px + 1, bp.height - 3, Tile.Grate);
      map.fillFloorRect(px - 1, bp.height - 1 - reach, px + 1, bp.height - 3, Tile.Grate);
    }
  }

  const occupied: Rect[] = [];
  // Everything placed from here on stays clear of the border bands. The bands
  // are ragged inside this bound, so the gap between the last building and the
  // edge of the world varies rather than being a uniform corridor.
  const usableX0 = borders.insets[3] + 1;
  const usableY0 = borders.insets[0] + 1;
  const usableX1 = bp.width - 2 - borders.insets[1];
  const usableY1 = bp.height - 2 - borders.insets[2];

  // 2b. Roads, before anything is built. They carve the plots rather than
  // being painted between finished buildings - see Roads.ts.
  const roads = carveRoads(
    map,
    rng,
    { x0: usableX0, y0: usableY0, x1: usableX1, y1: usableY1 },
    bp.roads,
  );


  // 3. Buildings. Largest first so the anchor structures get the good ground.
  const buildings: Rect[] = [];
  /** Which district each placed building belongs to, by the same index. */
  const buildingKinds: DistrictKind[] = [];
  // Footprints scale with the blueprint. Floored at a size that still fits a
  // partitioned interior with a doorway - below about seven tiles the BSP
  // split produces rooms nobody can walk into.
  const scaled = (n: number) => Math.max(7, Math.round(n * bp.structureScale));

  for (let i = 0; i < bp.buildings; i++) {
    const big = i === 0;
    // The anchor first, then the mix cycled so every district in the list
    // appears before any repeats - a location with four kinds listed gets all
    // four rather than four rolls of the same die.
    const kind = big
      ? districtById(bp.anchor)
      : districtById(bp.districts[(i - 1) % Math.max(1, bp.districts.length)]);

    const w = scaled(rng.int(kind.size.min, kind.size.max));
    // Depth used to be sampled at 0.80-0.85 of the width range, which made
    // every structure a shallow oblong - and a shallow oblong has no room to
    // be an L or a U, so the footprint shapes fell back to plain rectangles
    // four times in five. Squarer plots are also what an industrial building
    // usually is.
    const h = scaled(rng.int(Math.round(kind.size.min * 0.9), Math.round(kind.size.max * 0.95)));
    const placed = tryPlace(rng, occupied, usableX0, usableY0, usableX1, usableY1, w, h, 4, roads.corridors);
    if (!placed) continue;
    occupied.push(placed);
    buildings.push(placed);
    buildingKinds.push(kind);
    carveBuilding(map, rng, placed, big, result, kind);
  }

  // 4. Container yards - dense, low-visibility cover mazes between buildings.
  for (let i = 0; i < bp.containerYards; i++) {
    const w = scaled(rng.int(10, 16));
    const h = scaled(rng.int(9, 14));
    // Yards pack tighter than buildings - they are the claustrophobic part of
    // any location, whatever that location's overall character.
    const placed = tryPlace(rng, occupied, usableX0, usableY0, usableX1, usableY1, w, h, 3, roads.corridors);
    if (!placed) continue;
    occupied.push(placed);
    carveContainerYard(map, rng, placed, result);
  }

  // 5. Perimeter fencing subdividing the open yard, with gates so it stays open.
  carveFenceLines(map, rng, bp, occupied);

  // 6. Cover. Deliberate first - long open runs get something to move between
  // - then loose clutter fills the rest at the blueprint's density.
  placeCoverOnOpenLanes(map, rng, bp, occupied);
  scatterClutter(map, rng, bp, occupied);

  // 7. Zones - drives loot rarity, AI density and ambience.
  buildZones(map, buildings, buildingKinds, bp);

  // 8. Extractions on opposing edges, at least one conditional.
  buildExtracts(map, rng, bp, result, borders.insets);

  // 8b. Connectivity guarantee. Random fence lines, clutter and buildings can
  // combine to seal a corner off, which would make a raid unwinnable. Rather
  // than constrain the generator until that can never happen (and lose the
  // interesting layouts), we detect it and breach a way through afterwards.
  const regions = ensureConnectivity(map, result);

  // 9. Spawns: player far from extracts, AI distributed across zones. Both are
  // restricted to the main region so nothing spawns in a sealed pocket.
  buildSpawns(map, rng, bp, result, buildings, regions);

  // 10. Patrol routes threading the open ground and building interiors.
  buildPatrolRoutes(map, rng, result);

  // 11. Loot anchors weighted towards interiors and the boss lair.
  placeLootAnchors(map, rng, bp, result, buildings, buildingKinds, regions);

  // 12. Boss lair in the largest building, if the blueprint has one.
  if (bp.hasBoss && buildings.length > 0) {
    const lair = buildings[0];
    result.bossSpawn = {
      x: rectCx(lair),
      y: rectCy(lair),
      angle: rng.range(0, Math.PI * 2),
      tag: 'boss',
    };
    const z = map.zoneAt(Math.floor(rectCx(lair)), Math.floor(rectCy(lair)));
    if (z) z.danger = 1;
  }

  // 13. Bake static lighting last, once geometry is final.
  bakeLighting(map, result, bp);

  return result;
}

/**
 * Rejection-sample a free rect. Returns null if we could not fit one.
 *
 * `noGo` is kept apart from `occupied` because the two want different
 * clearances. Buildings need space between them - a gap you can walk and fight
 * down. Roads want the opposite: a building should stand *on* the road, and
 * giving road corridors the same four-tile clearance turned every three-tile
 * lane into an eleven-tile open strip. Measured after roads went in with one
 * shared padding: the harbour's mean outdoor sightline went from 10.7 tiles to
 * 26.4, which is a different location than the one the blueprint describes.
 */
function tryPlace(
  rng: Rng,
  occupied: Rect[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  w: number,
  h: number,
  padding: number,
  noGo: Rect[] = [],
  noGoPadding = 1,
): Rect | null {
  // Give ground before giving up.
  //
  // A single pass at the full clearance quietly threw away half of every
  // blueprint's building list once roads were carving the plots: the Klaerwerk
  // asks for twenty-two and was placing seven, which cost it the one property
  // it is built around - being the location with the most interior. A site
  // where buildings stand shoulder to shoulder in places is also what a real
  // industrial plot looks like, so relaxing the gap is not a compromise.
  for (let relax = 0; relax <= 2; relax++) {
    const pad = Math.max(1, padding - relax);
    for (let attempt = 0; attempt < 90; attempt++) {
      const x0 = rng.int(minX, Math.max(minX, maxX - w));
      const y0 = rng.int(minY, Math.max(minY, maxY - h));
      const r: Rect = { x0, y0, x1: x0 + w, y1: y0 + h };
      if (r.x1 > maxX || r.y1 > maxY) continue;
      let clash = false;
      for (const o of occupied) {
        if (rectsOverlap(r, o, pad)) {
          clash = true;
          break;
        }
      }
      if (!clash) {
        // The road clearance never relaxes: a building standing in the
        // carriageway is a different kind of wrong from two standing close.
        for (const o of noGo) {
          if (rectsOverlap(r, o, noGoPadding)) {
            clash = true;
            break;
          }
        }
      }
      if (!clash) return r;
    }
  }
  return null;
}

/**
 * Carve an enclosed building: outer shell, BSP-partitioned rooms, doorways,
 * window bands and an interior ceiling so lighting knows it is indoors.
 */
/**
 * Break a building's plot into the wings that make up its footprint.
 *
 * Wings deliberately *share* their party wall - the second wing's `x0` is the
 * first's `x1`, not one past it - so stroking both draws a single wall between
 * them, and opening a doorway is a matter of clearing a few tiles of it. The
 * alternative, abutting wings with two walls back to back, produces a
 * double-thick partition that reads as two buildings pushed together.
 *
 * Any shape whose wings would come out too small to hold a room falls back to
 * a hall, which is why this returns an array rather than a shape name: the
 * caller does not need to know which case it got.
 */
function decomposeFootprint(rng: Rng, r: Rect, kind: FootprintKind): Rect[] {
  const w = rectW(r);
  const h = rectH(r);
  // Below this a wing has no usable interior once its shell is drawn: six
  // tiles across leaves a four-tile room, which is a room. Seven looked safer
  // and cost most of the feature - at seven, a wing needs fourteen tiles to
  // split off, and most structures on these maps are twelve to twenty, so four
  // buildings in five fell back to being a plain rectangle.
  const MIN = 5;
  const canSplit = (a: number) => a >= MIN * 2 + 1;

  /** A cut position that leaves at least MIN on both sides. */
  const cut = (lo: number, span: number) => lo + rng.int(MIN - 1, span - MIN);

  if (kind === 'annex' && canSplit(h)) {
    // Main span plus a smaller wing along one face, inset from both corners.
    const ym = cut(r.y0, h);
    const inset = Math.max(1, Math.floor(w * rng.range(0.15, 0.3)));
    const wing: Rect = { x0: r.x0 + inset, y0: ym, x1: r.x1 - (rng.chance(0.5) ? inset : 0), y1: r.y1 };
    if (rectW(wing) >= MIN) return [{ x0: r.x0, y0: r.y0, x1: r.x1, y1: ym }, wing];
  }

  if (kind === 'ell' && canSplit(w) && canSplit(h)) {
    const xm = cut(r.x0, w);
    const ym = cut(r.y0, h);
    // Which corner is missing is chosen per building, or every L on the map
    // points the same way.
    return rng.chance(0.5)
      ? [{ x0: r.x0, y0: r.y0, x1: xm, y1: r.y1 }, { x0: xm, y0: ym, x1: r.x1, y1: r.y1 }]
      : [{ x0: r.x0, y0: r.y0, x1: xm, y1: r.y1 }, { x0: xm, y0: r.y0, x1: r.x1, y1: ym }];
  }

  if (kind === 'u' && w >= MIN * 3 && canSplit(h)) {
    const xm1 = r.x0 + MIN - 1 + rng.int(0, 2);
    const xm2 = r.x1 - MIN + 1 - rng.int(0, 2);
    const ym = cut(r.y0, h);
    if (xm2 - xm1 >= 3) {
      // Two side wings and a back wing; the yard between them opens north.
      return [
        { x0: r.x0, y0: r.y0, x1: xm1, y1: r.y1 },
        { x0: xm2, y0: r.y0, x1: r.x1, y1: r.y1 },
        { x0: xm1, y0: ym, x1: xm2, y1: r.y1 },
      ];
    }
  }

  if (kind === 'courtyard' && w >= MIN * 2 + 4 && h >= MIN * 2 + 4) {
    // A ring of four wings around an enclosed yard, open to the sky.
    const bw = MIN - 1 + rng.int(0, 2);
    const bh = MIN - 1 + rng.int(0, 2);
    return [
      { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y0 + bh },
      { x0: r.x0, y0: r.y1 - bh, x1: r.x1, y1: r.y1 },
      { x0: r.x0, y0: r.y0 + bh, x1: r.x0 + bw, y1: r.y1 - bh },
      { x0: r.x1 - bw, y0: r.y0 + bh, x1: r.x1, y1: r.y1 - bh },
    ];
  }

  return [r];
}

/** True when the two wings share a wall along x, and where. */
function sharedWall(a: Rect, b: Rect): { vertical: boolean; at: number; from: number; to: number } | null {
  if (a.x1 === b.x0 || b.x1 === a.x0) {
    const at = a.x1 === b.x0 ? a.x1 : b.x1;
    const from = Math.max(a.y0, b.y0) + 1;
    const to = Math.min(a.y1, b.y1) - 1;
    if (to - from >= 1) return { vertical: true, at, from, to };
  }
  if (a.y1 === b.y0 || b.y1 === a.y0) {
    const at = a.y1 === b.y0 ? a.y1 : b.y1;
    const from = Math.max(a.x0, b.x0) + 1;
    const to = Math.min(a.x1, b.x1) - 1;
    if (to - from >= 1) return { vertical: false, at, from, to };
  }
  return null;
}

function carveBuilding(
  map: TileMap,
  rng: Rng,
  r: Rect,
  isLarge: boolean,
  out: GeneratedMap,
  district: DistrictKind,
): void {
  // Materials come from the district now, so a boiler house does not read as
  // an office block with different loot in it.
  const wallMat = district.wall;
  const floorMat = district.wall === Tile.Brick ? Tile.Wood : Tile.Concrete;

  // Shape. A building is a union of wings rather than one oblong - see
  // `decomposeFootprint`. Everything below runs per wing, so partitioning,
  // doors, windows and lighting never learn that the building is not a box.
  const shape = district.footprints[rng.int(0, district.footprints.length - 1)];
  const wings = decomposeFootprint(rng, r, shape);

  for (const wing of wings) {
    map.fillRect(wing.x0, wing.y0, wing.x1, wing.y1, Tile.Floor);
    map.fillFloorRect(wing.x0, wing.y0, wing.x1, wing.y1, floorMat);
    map.fillCeilingRect(wing.x0, wing.y0, wing.x1, wing.y1, wallMat);
    map.strokeRect(wing.x0, wing.y0, wing.x1, wing.y1, wallMat);
  }

  // Interior partitioning, per wing. Large buildings get a hall plus side
  // rooms; small ones a simple two-or-three room split. Interior grain is the
  // district's, not the building's size: a warehouse stays one hall however
  // big it is, an office is a warren however small.
  const rooms: Rect[] = [];
  for (const wing of wings) {
    const before = rooms.length;
    bspSplit(
      rng,
      { x0: wing.x0 + 1, y0: wing.y0 + 1, x1: wing.x1 - 1, y1: wing.y1 - 1 },
      district.subdivision + (isLarge ? 1 : 0),
      rooms,
    );

    const partitionMat = district.partition;
    for (let i = before; i < rooms.length; i++) {
      const room = rooms[i];
      // Draw partition walls only on edges that are not the wing's shell.
      if (room.x0 > wing.x0 + 1) for (let y = room.y0; y <= room.y1; y++) map.set(room.x0 - 1, y, partitionMat);
      if (room.y0 > wing.y0 + 1) for (let x = room.x0; x <= room.x1; x++) map.set(x, room.y0 - 1, partitionMat);
    }
  }

  // Openings in the party walls, so the wings are one building rather than
  // several that happen to touch.
  for (let i = 0; i < wings.length; i++) {
    for (let j = i + 1; j < wings.length; j++) {
      const shared = sharedWall(wings[i], wings[j]);
      if (!shared) continue;
      const span = Math.min(3, shared.to - shared.from + 1);
      const start = rng.int(shared.from, Math.max(shared.from, shared.to - span + 1));
      for (let k = 0; k < span; k++) {
        const x = shared.vertical ? shared.at : start + k;
        const y = shared.vertical ? start + k : shared.at;
        map.set(x, y, k === 0 && rng.chance(0.4) ? Tile.DoorClosed : Tile.Floor);
      }
    }
  }

  // Doorways: two-tile gaps so rooms are never sealed, and roughly half of
  // them carry an actual door.
  //
  // `Tile.DoorClosed` has existed in the tile set from the beginning - with
  // its own material, its own penetration value and a movement cost of 1.6 -
  // and the generator placed exactly zero of them on every map. Interiors were
  // rooms connected by holes.
  //
  // A door is worth having for three separate reasons: it costs time to pass,
  // so a route through a building is not free; it is thin cover that stops a
  // pistol round and not a rifle one; and it reads, so a player can tell a
  // doorway from a blown-out wall and knows which one an enemy is likely to
  // come through. The other half stay open, because a building where every
  // room costs a door to enter is tedious rather than tense.
  const doorway = (x: number, y: number): void => {
    map.set(x, y, rng.chance(0.5) ? Tile.DoorClosed : Tile.Floor);
  };
  for (const room of rooms) {
    if (room.x0 > r.x0 + 1) {
      const dy = rng.int(room.y0, Math.max(room.y0, room.y1 - 1));
      doorway(room.x0 - 1, dy);
      map.set(room.x0 - 1, dy + 1, Tile.Floor);
    }
    if (room.y0 > r.y0 + 1) {
      const dx = rng.int(room.x0, Math.max(room.x0, room.x1 - 1));
      doorway(dx, room.y0 - 1);
      map.set(dx + 1, room.y0 - 1, Tile.Floor);
    }
  }

  // Exterior entrances: at least two, on different faces, so no building is a
  // single-entry death trap for either side.
  //
  // Punched per wing rather than on the bounding rectangle. On a courtyard
  // block the bounding rectangle's south face runs through open sky, and a
  // door punched into it would be a hole in nothing; on an L it would cut the
  // missing corner. The largest wing carries the main entrances because that
  // is the face a person would walk up to.
  const byArea = [...wings].sort((a, b) => rectW(b) * rectH(b) - rectW(a) * rectH(a));
  const faces = rng.shuffle([0, 1, 2, 3]);
  const entrances = isLarge ? 3 : 2;
  for (let i = 0; i < entrances; i++) {
    punchEntrance(map, rng, byArea[i % byArea.length], faces[i], isLarge ? 3 : 2);
  }

  // Window bands on the remaining faces - sightlines in and out.
  for (let i = entrances; i < 4; i++) {
    punchWindows(map, rng, byArea[i % byArea.length], faces[i]);
  }

  // Interior lights, one per room, plus flickering emergency lighting.
  for (const room of rooms) {
    if (rng.chance(0.75)) {
      out.lights.push({
        x: rectCx(room) + 0.5,
        y: rectCy(room) + 0.5,
        radius: rng.range(4, 7),
        intensity: rng.range(0.45, 0.8),
        color: rng.chance(0.25) ? 0xffd9a0 : 0xd8e4f0,
        flicker: rng.chance(0.3) ? rng.range(0.1, 0.4) : 0,
      });
    }
  }
}

/** Recursive binary partition producing room rects with a minimum size. */
function bspSplit(rng: Rng, r: Rect, depth: number, out: Rect[]): void {
  const w = rectW(r);
  const h = rectH(r);
  const MIN = 5;
  if (depth <= 0 || (w < MIN * 2 + 1 && h < MIN * 2 + 1)) {
    if (w >= 2 && h >= 2) out.push(r);
    return;
  }
  // Split the longer axis; a little randomness avoids gridlike interiors.
  const horizontal = h > w ? true : w > h ? false : rng.chance(0.5);
  if (horizontal) {
    if (h < MIN * 2 + 1) {
      out.push(r);
      return;
    }
    const cut = rng.int(r.y0 + MIN, r.y1 - MIN);
    bspSplit(rng, { x0: r.x0, y0: r.y0, x1: r.x1, y1: cut - 1 }, depth - 1, out);
    bspSplit(rng, { x0: r.x0, y0: cut + 1, x1: r.x1, y1: r.y1 }, depth - 1, out);
  } else {
    if (w < MIN * 2 + 1) {
      out.push(r);
      return;
    }
    const cut = rng.int(r.x0 + MIN, r.x1 - MIN);
    bspSplit(rng, { x0: r.x0, y0: r.y0, x1: cut - 1, y1: r.y1 }, depth - 1, out);
    bspSplit(rng, { x0: cut + 1, y0: r.y0, x1: r.x1, y1: r.y1 }, depth - 1, out);
  }
}

/** face: 0=north 1=east 2=south 3=west */
/**
 * Cut an entrance in one face of a building.
 *
 * The opening is left clear except for one edge tile, which becomes a door.
 * That keeps every entrance passable at a run while still giving it a visible
 * threshold - a doorway a player can recognise from outside and choose,
 * rather than an anonymous gap in a wall.
 */
function punchEntrance(map: TileMap, rng: Rng, r: Rect, face: number, width: number): void {
  const doorAt = rng.int(0, width - 1);
  const tileFor = (i: number): Tile =>
    i === doorAt && width > 1 ? Tile.DoorClosed : Tile.Floor;

  if (face === 0 || face === 2) {
    const y = face === 0 ? r.y0 : r.y1;
    const x = rng.int(r.x0 + 2, Math.max(r.x0 + 2, r.x1 - width - 1));
    for (let i = 0; i < width; i++) map.set(x + i, y, tileFor(i));
  } else {
    const x = face === 1 ? r.x1 : r.x0;
    const y = rng.int(r.y0 + 2, Math.max(r.y0 + 2, r.y1 - width - 1));
    for (let i = 0; i < width; i++) map.set(x, y + i, tileFor(i));
  }
}

function punchWindows(map: TileMap, rng: Rng, r: Rect, face: number): void {
  const step = 3;
  if (face === 0 || face === 2) {
    const y = face === 0 ? r.y0 : r.y1;
    for (let x = r.x0 + 2; x <= r.x1 - 2; x += step) {
      if (rng.chance(0.65)) map.set(x, y, Tile.Window);
    }
  } else {
    const x = face === 1 ? r.x1 : r.x0;
    for (let y = r.y0 + 2; y <= r.y1 - 2; y += step) {
      if (rng.chance(0.65)) map.set(x, y, Tile.Window);
    }
  }
}

/**
 * Container yard: rows of stacked shipping containers with alleys.
 * These are the highest-tension spaces on the map - short sightlines, many
 * corners, and they reward sound discipline.
 */
function carveContainerYard(map: TileMap, rng: Rng, r: Rect, out: GeneratedMap): void {
  map.fillFloorRect(r.x0, r.y0, r.x1, r.y1, Tile.Concrete);
  const rowStep = 3; // 2 tiles of container, 1 tile alley
  for (let y = r.y0; y <= r.y1 - 1; y += rowStep) {
    let x = r.x0;
    while (x <= r.x1) {
      const len = rng.int(3, 6);
      if (rng.chance(0.78)) {
        for (let i = 0; i < len && x + i <= r.x1; i++) {
          map.set(x + i, y, Tile.Container);
          if (y + 1 <= r.y1) map.set(x + i, y + 1, Tile.Container);
        }
      }
      // Gap between container runs creates cross-alleys.
      x += len + rng.int(1, 3);
    }
  }
  // Yard floodlight - a lit yard is safer to cross but makes you a silhouette.
  out.lights.push({
    x: rectCx(r),
    y: rectCy(r),
    radius: rng.range(8, 12),
    intensity: 0.55,
    color: 0xfff0c8,
    flicker: rng.chance(0.35) ? 0.25 : 0,
  });
}

/** Long fence runs with gates - shapes movement without sealing routes. */
/**
 * Fence off compounds within the site.
 *
 * These used to be single straight runs from one side of the map to the other,
 * and on a top-down render they were the loudest remaining sign that a program
 * drew the level: three or four perfectly straight lines crossing everything,
 * ignoring the buildings, the roads and each other.
 *
 * A real yard is fenced in *compounds* - a rectangle of ground around some
 * plant, with a gate on the side the road comes in from. So each line is now a
 * bounded run with a jog in it, laid around a patch of open ground rather than
 * across the whole location, and it stops when it meets a structure instead of
 * stepping over it. Same purpose - subdivide the open ground and make the
 * player choose a gate - without the ruled-paper look.
 */
function carveFenceLines(map: TileMap, rng: Rng, bp: MapBlueprint, occupied: Rect[]): void {
  const lines = rng.int(3, 6);
  const span = Math.round(Math.min(bp.width, bp.height) * 0.55);

  for (let i = 0; i < lines; i++) {
    const horizontal = rng.chance(0.5);
    const length = rng.int(Math.round(span * 0.45), span);
    // Where the run steps sideways by a tile or two, so it is not one line.
    const jogAt = rng.int(Math.round(length * 0.3), Math.round(length * 0.7));
    const jog = rng.int(1, 3) * (rng.chance(0.5) ? 1 : -1);

    const startAlong = rng.int(4, (horizontal ? bp.width : bp.height) - 4 - length);
    let across = rng.int(6, (horizontal ? bp.height : bp.width) - 7);

    const gates = new Set<number>();
    for (let g = 0; g < 2; g++) gates.add(rng.int(2, length - 3));

    for (let k = 0; k < length; k++) {
      if (k === jogAt) across += jog;
      const x = horizontal ? startAlong + k : across;
      const y = horizontal ? across : startAlong + k;
      if (!map.inBounds(x, y)) continue;
      // Stop at anything already built rather than running over it.
      if (isInsideAny(x, y, occupied, 1)) continue;
      if (map.at(x, y) !== Tile.Floor) continue;
      // Gates are two tiles wide so they read as a way through, and the jog
      // itself leaves a diagonal step that is never sealed.
      if (gates.has(k) || gates.has(k - 1)) continue;
      map.set(x, y, Tile.Fence);
    }
  }
}

function isInsideAny(x: number, y: number, rects: Rect[], padding: number): boolean {
  for (const r of rects) {
    if (x >= r.x0 - padding && x <= r.x1 + padding && y >= r.y0 - padding && y <= r.y1 + padding) return true;
  }
  return false;
}

/**
 * Break up the longest open sightlines with deliberate cover.
 *
 * `scatterClutter` below spreads cover evenly, which fills a map without
 * deciding anything: the places that most need something to hide behind are
 * exactly the long open runs, and an even scatter under-serves them by
 * construction. A player crossing eighty tiles of bare concrete has the same
 * choice at every step, which is no choice.
 *
 * So this runs first and works the other way round. It walks a coarse grid of
 * horizontal and vertical lanes, measures how far each one runs unobstructed,
 * and for any lane longer than the threshold drops staggered cover into it at
 * intervals - offset from the lane's centre so the result is something to move
 * *between* rather than a wall across it.
 *
 * The material is chosen for what it does rather than for looks:
 *
 *   - **Container** (2.6 m, opaque): breaks the sightline outright. The anchor
 *     of a crossing.
 *   - **Crate** (1.2 m, *not* opaque): crouch cover you can shoot over, which
 *     is the piece that makes a crossing a fight rather than a sprint.
 *   - **Rubble** (0.5 m, walkable, 1.9x movement cost): no protection, but it
 *     slows and it is noisy - a route that costs something.
 *
 * Long lanes stay long: this thins them into a series of decisions instead of
 * removing them, because a location whose identity is open ground has to keep
 * its open ground.
 */
function placeCoverOnOpenLanes(
  map: TileMap,
  rng: Rng,
  bp: MapBlueprint,
  occupied: Rect[],
): void {
  /**
   * Where "a long sightline" becomes "a shooting gallery" - and it is not the
   * same number on every map.
   *
   * A fixed threshold with dense placement flattened everything: the harbour's
   * mean outdoor sightline fell from 10.7 to 5.6 tiles, which is barely above
   * the boiler house and destroys the one location built around long shots.
   * Breaking up open ground and *having* open ground are the same lever pulled
   * in opposite directions, so the threshold has to follow the blueprint's own
   * intent rather than override it.
   *
   * `clutter` already states that intent - it is how broken up the location is
   * meant to be - so the threshold reads it. An open dock (0.3) tolerates runs
   * up to about 36 tiles; a packed plant (3.2) breaks them at 21.
   */
  const LONG = Math.round(Math.max(18, Math.min(36, 38 - bp.clutter * 6)));
  // Every second lane. Cover is dropped with a one-tile offset, so a piece
  // placed while scanning lane y also serves y-1 and y+1 - at step 2 every
  // lane on the map is within reach of one, with none scanned twice.
  //
  // Step 3 left gaps, and the gaps were the whole problem: the harbour kept a
  // 156-tile run straight across the map, which is precisely the shooting
  // gallery this function exists to prevent.
  const LANE_STEP = 2;

  const openAt = (x: number, y: number): boolean =>
    map.inBounds(x, y) && map.at(x, y) === Tile.Floor && !isInsideAny(x, y, occupied, 0);

  /**
   * Drop one piece of cover, spanning the scanned lane and its neighbour.
   *
   * The span is what makes the coverage guarantee work. A single tile only
   * breaks the lane it sits in, so with a random offset the lanes between
   * scans were served only by luck - and the harbour kept a full-width run
   * because of it. Two tiles across, at step 2, means every lane on the map is
   * broken by something.
   */
  const drop = (x: number, y: number, horizontal: boolean): void => {
    // Perpendicular to the lane, so the piece spans two lanes rather than
    // lying along one.
    const bx = horizontal ? x : x + 1;
    const by = horizontal ? y + 1 : y;
    if (!openAt(x, y)) return;

    const roll = rng.float();
    const material = roll < 0.34 ? Tile.Container : roll < 0.78 ? Tile.Crate : Tile.Rubble;
    map.set(x, y, material);
    if (openAt(bx, by)) map.set(bx, by, material);
  };

  /** Walk one lane, and break every long open run inside it. */
  const scanLane = (
    length: number,
    at: (i: number) => { x: number; y: number },
    horizontal: boolean,
  ): void => {
    let runStart = -1;
    for (let i = 0; i <= length; i++) {
      const p = i < length ? at(i) : null;
      const open = p ? openAt(p.x, p.y) : false;

      if (open && runStart < 0) runStart = i;
      if (!open && runStart >= 0) {
        const runLength = i - runStart;
        if (runLength > LONG) {
          // One piece every eight to twelve tiles: enough to break the run,
          // sparse enough that the ground still reads as open.
          // Spaced at roughly the threshold itself: enough to cap the run
          // near LONG, sparse enough that the ground still reads as open.
          for (let k = runStart + Math.floor(LONG * 0.55); k < i - 4; k += LONG) {
            const q = at(k);
            drop(q.x, q.y, horizontal);
          }
        }
        runStart = -1;
      }
    }
  };

  // From 2, not 4. The double perimeter wall sits at 0 and 1, so rows 2 and 3
  // are open ground - and starting at 4 left a ring road running the entire
  // way around the map with nothing in it. That was the 156-tile run.
  for (let y = 2; y < bp.height - 2; y += LANE_STEP) {
    scanLane(bp.width, (i) => ({ x: i, y }), true);
  }
  for (let x = 2; x < bp.width - 2; x += LANE_STEP) {
    scanLane(bp.height, (i) => ({ x, y: i }), false);
  }
}

function scatterClutter(map: TileMap, rng: Rng, bp: MapBlueprint, occupied: Rect[]): void {
  const attempts = Math.floor(bp.width * bp.height * 0.02 * bp.clutter * 4);
  for (let i = 0; i < attempts; i++) {
    const x = rng.int(3, bp.width - 4);
    const y = rng.int(3, bp.height - 4);
    if (map.at(x, y) !== Tile.Floor) continue;
    if (isInsideAny(x, y, occupied, 0)) continue;
    // Roads stay swept. Debris is scattered by tile, so on a dense location it
    // buried the road network completely - the boiler house came back as one
    // undifferentiated field of rubble with no route through it visible at
    // all. A road nobody can see is not a landmark, and landmarks are the only
    // thing a player has to navigate by out here. The lane-cover pass still
    // parks the occasional container across one, which is what stops a road
    // from becoming a firing lane.
    if (map.floor[y * map.width + x] === Tile.Concrete) continue;
    const roll = rng.float();
    if (roll < 0.45) {
      map.set(x, y, Tile.Crate);
      if (rng.chance(0.4) && map.at(x + 1, y) === Tile.Floor) map.set(x + 1, y, Tile.Crate);
    } else if (roll < 0.7) {
      map.set(x, y, Tile.Rubble);
    } else if (roll < 0.88) {
      map.set(x, y, Tile.Rock);
    } else {
      map.set(x, y, Tile.Grate);
    }
  }
}

function buildZones(
  map: TileMap,
  buildings: Rect[],
  kinds: DistrictKind[],
  bp: MapBlueprint,
): void {
  // Outer ring: low danger, low value - the "get your bearings" band.
  map.addZone({
    name: 'Außengelände',
    x0: 1, y0: 1, x1: bp.width - 2, y1: bp.height - 2,
    danger: 0.25, interior: false,
  });

  // Districts name themselves and rank by tier. This replaced a positional
  // ramp - `0.5 + i * 0.05`, unbounded, so on a dense location the last
  // building placed outranked the anchor and the map's risk gradient
  // inverted. Danger is now a property of what a place *is*, which is both
  // correct and stable at any building count.
  //
  // Repeated kinds get numbered, because "Lagerhalle" three times over is not
  // a landmark a player can navigate by.
  const seen = new Map<string, number>();
  buildings.forEach((b, i) => {
    const kind = kinds[i] ?? districtById(bp.anchor);
    const n = (seen.get(kind.id) ?? 0) + 1;
    seen.set(kind.id, n);
    const repeats = kinds.filter((k) => k.id === kind.id).length;

    map.addZone({
      name: repeats > 1 ? `${kind.label} ${n}` : kind.label,
      x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1,
      // The anchor is always the map's most contested address, whatever it is
      // made of; everything else takes its tier's value.
      danger: i === 0 ? 0.9 : TIER_DANGER[kind.tier],
      interior: true,
    });
  });
}

function buildExtracts(
  map: TileMap,
  rng: Rng,
  bp: MapBlueprint,
  out: GeneratedMap,
  insets: readonly number[],
): void {
  // Corner-biased candidates on opposite sides of the map, pushed inside the
  // border bands - an exit carved into a rock face is not an exit.
  const margin = Math.max(...insets) + 4;
  const candidates: { x: number; y: number; name: string }[] = [
    { x: margin, y: margin, name: 'Nordtor' },
    { x: bp.width - margin, y: margin, name: 'Bahnrampe' },
    { x: margin, y: bp.height - margin, name: 'Kanalsteg' },
    { x: bp.width - margin, y: bp.height - margin, name: 'Südschleuse' },
    { x: Math.floor(bp.width / 2), y: margin, name: 'Zollhaus' },
  ];
  rng.shuffle(candidates);

  const chosen = candidates.slice(0, 4);
  chosen.forEach((c, i) => {
    const open = map.nearestOpen(Math.floor(c.x), Math.floor(c.y), 14) ?? { x: c.x, y: c.y };
    // Guarantee the pad itself is clear so extraction cannot be geometry-blocked.
    map.fillRect(open.x - 1, open.y - 1, open.x + 1, open.y + 1, Tile.Floor);
    map.fillFloorRect(open.x - 2, open.y - 2, open.x + 2, open.y + 2, Tile.Grate);

    let condition: ExtractCondition = { kind: 'always' };
    if (i === 1) {
      // A paid extract: always available, but it costs you.
      condition = { kind: 'fee', amount: 4500, label: 'Schleusergebuehr 4.500' };
    } else if (i === 2) {
      // Item-gated: rewards players who looted the right thing.
      condition = { kind: 'item', itemDefId: 'key_dock_gate', label: 'Benoetigt: Hafenschluessel' };
    } else if (i === 3) {
      // Late-raid only: pushes players to commit rather than camp the exit.
      condition = { kind: 'timeWindow', openAfterFraction: 0.45, closeAfterFraction: 1, label: 'Oeffnet nach Halbzeit' };
    }

    out.extracts.push({
      id: `ex_${i}`,
      name: c.name,
      x: open.x + 0.5,
      y: open.y + 0.5,
      radius: 2.2,
      holdSeconds: condition.kind === 'always' ? 6 : 4,
      condition,
    });
    out.lights.push({ x: open.x + 0.5, y: open.y + 0.5, radius: 6, intensity: 0.5, color: 0x8effc0, flicker: 0 });
  });
}

/**
 * RegionMap - connected components of walkable tiles.
 *
 * `mainId` is the largest component, which is what everything gameplay-facing
 * is restricted to. Anything the generator wants to place is checked against
 * `isMain()` first, so a sealed pocket can never hold a spawn, a patrol or a
 * container the player cannot reach.
 */
interface RegionMap {
  ids: Int32Array;
  mainId: number;
  width: number;
  isMain(x: number, y: number): boolean;
}

/**
 * Cost of breaching a tile when carving a repair path.
 *
 * The numbers encode a preference order rather than physics: cut a fence
 * before a wooden shed, a shed before brick, and only tunnel through concrete
 * as a last resort. Breaches therefore land where a real route would.
 */
function breachCost(tile: number): number {
  switch (tile) {
    case Tile.Fence:
      return 3;
    case Tile.Crate:
      return 4;
    case Tile.Window:
    case Tile.Glass:
      return 7;
    case Tile.DoorClosed:
      return 2;
    case Tile.Wood:
      return 12;
    case Tile.Metal:
      return 16;
    case Tile.Brick:
      return 20;
    case Tile.Container:
      return 22;
    case Tile.Rock:
      return 26;
    case Tile.Concrete:
      return 42;
    default:
      return 1;
  }
}

/** Flood-fill walkable tiles into connected components. */
function computeRegions(map: TileMap): RegionMap {
  const ids = new Int32Array(map.width * map.height).fill(-1);
  const queue = new Int32Array(map.width * map.height);
  const sizes: number[] = [];

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const start = y * map.width + x;
      if (ids[start] !== -1 || map.isSolid(x, y)) continue;

      const id = sizes.length;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      ids[start] = id;
      let size = 0;

      while (head < tail) {
        const current = queue[head++];
        size++;
        const cx = current % map.width;
        const cy = (current / map.width) | 0;
        // Four-way: a diagonal gap between two solid tiles is not walkable
        // for a circle-shaped actor, so it must not count as connected.
        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
          const ni = ny * map.width + nx;
          if (ids[ni] !== -1 || map.isSolid(nx, ny)) continue;
          ids[ni] = id;
          queue[tail++] = ni;
        }
      }
      sizes.push(size);
    }
  }

  let mainId = 0;
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] > sizes[mainId]) mainId = i;
  }

  return {
    ids,
    mainId,
    width: map.width,
    isMain(x: number, y: number): boolean {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
      return ids[y * map.width + x] === mainId;
    },
  };
}

/**
 * Make every extraction reachable from the map's main region, breaching
 * geometry where necessary. Returns the region map after repairs.
 */
function ensureConnectivity(map: TileMap, out: GeneratedMap): RegionMap {
  let regions = computeRegions(map);

  for (const extract of out.extracts) {
    const ex = Math.floor(extract.x);
    const ey = Math.floor(extract.y);
    if (regions.isMain(ex, ey)) continue;
    if (carveBreach(map, ex, ey, regions)) {
      // Geometry changed - components must be recomputed before the next test.
      regions = computeRegions(map);
    }
  }

  return regions;
}

/**
 * Dijkstra from a point to the nearest main-region tile, treating solid tiles
 * as expensive rather than impassable, then clear whatever it had to cross.
 */
function carveBreach(map: TileMap, startX: number, startY: number, regions: RegionMap): boolean {
  const n = map.width * map.height;
  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);

  const startIndex = startY * map.width + startX;
  dist[startIndex] = 0;

  // Binary min-heap keyed on distance. A linear scan would be O(n^2) - roughly
  // 85 million comparisons on a 96x96 map, which is a visible stall even at
  // generation time.
  const heap = new Int32Array(n * 4);
  let heapSize = 0;

  const push = (node: number): void => {
    if (heapSize >= heap.length) return;
    let i = heapSize++;
    const d = dist[node];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (dist[heap[parent]] <= d) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = node;
  };

  const pop = (): number => {
    const top = heap[0];
    const last = heap[--heapSize];
    if (heapSize > 0) {
      let i = 0;
      const d = dist[last];
      for (;;) {
        const l = 2 * i + 1;
        if (l >= heapSize) break;
        const r = l + 1;
        const child = r < heapSize && dist[heap[r]] < dist[heap[l]] ? r : l;
        if (dist[heap[child]] >= d) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return top;
  };

  push(startIndex);

  let target = -1;
  while (heapSize > 0) {
    const current = pop();
    if (visited[current]) continue;
    visited[current] = 1;

    const cx = current % map.width;
    const cy = (current / map.width) | 0;
    if (regions.isMain(cx, cy)) {
      target = current;
      break;
    }

    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      // Never breach the outer perimeter - the map must stay enclosed.
      if (nx < 2 || ny < 2 || nx >= map.width - 2 || ny >= map.height - 2) continue;
      const ni = ny * map.width + nx;
      if (visited[ni]) continue;
      const cost = breachCost(map.at(nx, ny));
      if (dist[current] + cost < dist[ni]) {
        dist[ni] = dist[current] + cost;
        prev[ni] = current;
        push(ni);
      }
    }
  }

  if (target === -1) return false;

  // Walk the path back, clearing anything solid into open floor.
  let node = target;
  let carved = false;
  while (node !== -1) {
    const x = node % map.width;
    const y = (node / map.width) | 0;
    if (map.isSolid(x, y)) {
      map.set(x, y, Tile.Floor);
      carved = true;
    }
    node = prev[node];
  }
  return carved;
}

function buildSpawns(
  map: TileMap,
  rng: Rng,
  bp: MapBlueprint,
  out: GeneratedMap,
  buildings: Rect[],
  regions: RegionMap,
): void {
  // Player spawns: prefer positions far from every extract so extraction is
  // always a journey, and away from the boss lair.
  const tries = 200;
  const scored: { p: SpawnPoint; score: number }[] = [];
  for (let i = 0; i < tries; i++) {
    const x = rng.int(4, bp.width - 5);
    const y = rng.int(4, bp.height - 5);
    if (map.isSolid(x, y) || map.at(x, y) === Tile.Water) continue;
    if (!regions.isMain(x, y)) continue;
    if (isInsideAny(x, y, buildings, 1)) continue;
    let minExtract = Infinity;
    for (const e of out.extracts) {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < minExtract) minExtract = d;
    }
    // Reward distance from extracts, penalise the very edge of the map.
    const edgePenalty = Math.min(x, y, bp.width - x, bp.height - y) < 6 ? -12 : 0;
    scored.push({ p: { x: x + 0.5, y: y + 0.5, angle: rng.range(0, Math.PI * 2), tag: 'player' }, score: minExtract + edgePenalty });
  }
  scored.sort((a, b) => b.score - a.score);
  out.playerSpawns = scored.slice(0, 6).map((s) => s.p);
  if (out.playerSpawns.length === 0) {
    const fallback = map.nearestOpen(Math.floor(bp.width / 2), Math.floor(bp.height / 2), 30);
    if (fallback) {
      out.playerSpawns.push({ x: fallback.x + 0.5, y: fallback.y + 0.5, angle: 0, tag: 'player' });
    }
  }

  // AI spawns spread across the whole map; density scales with zone danger.
  const wanted = bp.aiCount;
  let guard = 0;
  while (out.aiSpawns.length < wanted && guard++ < wanted * 60) {
    const x = rng.int(3, bp.width - 4);
    const y = rng.int(3, bp.height - 4);
    if (map.isSolid(x, y) || map.at(x, y) === Tile.Water) continue;
    if (!regions.isMain(x, y)) continue;
    // Never spawn AI on top of the player's arrival area.
    let tooClose = false;
    for (const ps of out.playerSpawns) {
      if (Math.hypot(ps.x - x, ps.y - y) < 14) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    const zone = map.zoneAt(x, y);
    // Rejection-sample against zone danger so hot areas get more contacts.
    //
    // Squared, and starting from a low floor. The linear version was
    // `0.35 + danger * 0.65`, which spans 0.51 to 0.94 - a 1.8x preference,
    // and measurement said that was not enough to survive everything else
    // competing for these samples. Pooled over eight seeds, the top-value zone
    // was taking 0.67x and 0.83x of its fair share of hostiles on two of the
    // five locations: the map's most valuable ground was its *emptiest*, which
    // inverts the one relationship the whole loop rests on.
    //
    // Squaring pulls the low end down without touching the top, giving about a
    // 4x preference, which measures through.
    const danger = zone?.danger ?? 0.25;
    if (!rng.chance(0.15 + danger * danger * 0.85)) continue;
    out.aiSpawns.push({ x: x + 0.5, y: y + 0.5, angle: rng.range(0, Math.PI * 2), tag: 'ai' });
  }
}

function buildPatrolRoutes(map: TileMap, rng: Rng, out: GeneratedMap): void {
  const routeCount = 8;
  for (let i = 0; i < routeCount; i++) {
    const points: { x: number; y: number }[] = [];
    const legs = rng.int(3, 5);
    let cursor: { x: number; y: number } | null = null;
    for (let l = 0; l < legs; l++) {
      let found: { x: number; y: number } | null = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        const x = rng.int(3, map.width - 4);
        const y = rng.int(3, map.height - 4);
        if (map.isSolid(x, y) || map.at(x, y) === Tile.Water) continue;
        // Keep legs a sensible length and roughly line-of-sight connected so
        // patrols read as deliberate rounds rather than random wandering.
        if (cursor) {
          const d = Math.hypot(cursor.x - x, cursor.y - y);
          if (d < 6 || d > 26) continue;
          if (!hasLineOfSight(map, cursor.x + 0.5, cursor.y + 0.5, x + 0.5, y + 0.5)) continue;
        }
        found = { x: x + 0.5, y: y + 0.5 };
        break;
      }
      if (!found) break;
      points.push(found);
      cursor = { x: Math.floor(found.x), y: Math.floor(found.y) };
    }
    if (points.length >= 2) {
      const z = map.zoneAt(Math.floor(points[0].x), Math.floor(points[0].y));
      out.patrolRoutes.push({ id: i, points, zoneId: z?.id ?? 0 });
    }
  }
}

function placeLootAnchors(
  map: TileMap,
  rng: Rng,
  bp: MapBlueprint,
  out: GeneratedMap,
  buildings: Rect[],
  kinds: DistrictKind[],
  regions: RegionMap,
): void {
  // Interior anchors: the reward for entering contested indoor space, and now
  // the reason to prefer one interior over another.
  //
  // Every building used to draw from the same weighted list of five container
  // types, split only into "the first building" and "all the others". A
  // workshop and a medical store therefore held the same things, which makes
  // "which building do I go to" a question with no answer and reduces a map to
  // its geometry. Contents come from the district now: the Werkstatt has tool
  // chests in it, the Sanitätsstation has medicine, the Waffenkammer has
  // weapons. That is what makes a location learnable.
  for (let bi = 0; bi < buildings.length; bi++) {
    const b = buildings[bi];
    const kind = kinds[bi] ?? districtById(bp.anchor);
    const ids = kind.containers.map((c) => c.id);
    const weights = kind.containers.map((c) => c.weight);
    const count = Math.floor((rectW(b) * rectH(b)) / 26) + 2;

    for (let i = 0; i < count; i++) {
      const spot = findFreeTile(map, rng, b.x0 + 1, b.y0 + 1, b.x1 - 1, b.y1 - 1, regions);
      if (!spot) continue;
      // The anchor building gets one guaranteed high-value container on top of
      // its district's mix, so the map's centrepiece is worth the walk
      // whatever it happens to be made of.
      const containerId = bi === 0 && i === 0
        ? 'safe'
        : rng.weighted(ids, weights)!;
      out.lootAnchors.push({ x: spot.x + 0.5, y: spot.y + 0.5, tableId: containerId, containerId });
    }
  }

  // Exterior anchors: fewer, cheaper, but safe to grab on the way through.
  const outdoor = Math.floor(bp.width * bp.height * 0.0025);
  for (let i = 0; i < outdoor; i++) {
    const spot = findFreeTile(map, rng, 3, 3, bp.width - 4, bp.height - 4, regions);
    if (!spot) continue;
    if (isInsideAny(spot.x, spot.y, buildings, 0)) continue;
    const containerId = rng.weighted(
      ['supply_crate', 'barrel', 'toolbox', 'duffel'],
      [4, 3, 2, 1],
    )!;
    out.lootAnchors.push({ x: spot.x + 0.5, y: spot.y + 0.5, tableId: containerId, containerId });
  }
}

function findFreeTile(
  map: TileMap,
  rng: Rng,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  regions?: RegionMap,
): { x: number; y: number } | null {
  for (let i = 0; i < 50; i++) {
    const x = rng.int(x0, x1);
    const y = rng.int(y0, y1);
    if (map.isSolid(x, y) || map.at(x, y) === Tile.Water) continue;
    // Loot the player cannot walk to is loot that does not exist.
    if (regions && !regions.isMain(x, y)) continue;
    return { x, y };
  }
  return null;
}

/**
 * Bake static lighting into the tilemap.
 *
 * Lamps are accumulated into their own layer with a line-of-sight test, so
 * light does not bleed through walls. The sky is *not* baked in: it is folded
 * on top by `applyConditions`, which lets the time of day change without
 * repeating this pass - the expensive part is the visibility test, and that
 * does not depend on how bright the sky is.
 *
 * Baking costs a few milliseconds once per raid and makes per-frame lighting a
 * single array read.
 */
function bakeLighting(map: TileMap, gen: GeneratedMap, bp: MapBlueprint): void {
  map.lampLight.fill(0);

  for (const light of gen.lights) {
    const r = Math.ceil(light.radius);
    const lx = Math.floor(light.x);
    const ly = Math.floor(light.y);
    const x0 = Math.max(0, lx - r);
    const x1 = Math.min(map.width - 1, lx + r);
    const y0 = Math.max(0, ly - r);
    const y1 = Math.min(map.height - 1, ly + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - light.x, y + 0.5 - light.y);
        if (d > light.radius) continue;
        // Inverse-square-ish falloff, softened so lights read as area sources.
        const falloff = 1 - d / light.radius;
        const contribution = falloff * falloff * light.intensity * 255;
        if (contribution < 2) continue;
        if (!hasLineOfSight(map, light.x, light.y, x + 0.5, y + 0.5)) continue;
        const i = y * map.width + x;
        map.lampLight[i] = Math.min(255, map.lampLight[i] + contribution);
      }
    }
  }

  // Daylight by default, so a map is usable the moment it is generated.
  applyConditions(map, bp.ambient, defaultConditions());
}
