import { Rng } from '../core/Random';
import { Tile, TileMap } from './TileMap';
import { hasLineOfSight } from './Raycast';
import { applyConditions, defaultConditions } from './Conditions';

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
  /** Adds a water channel along one edge with a pier. */
  water: boolean;
  ambient: number;
  raidSeconds: number;
  /** AI population target for the location. */
  aiCount: number;
  /**
   * One line telling the player what kind of place this is.
   *
   * The locations carry real, measured differences - sightlines from 4.7 to
   * 14.1 tiles, roofed floor from 14 % to a third, hostile density varying
   * threefold - and none of that was visible before choosing. A player only
   * finds out what a place is by dying in it once, which is a poor way to
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

  // 1. Base terrain: open gravel yard inside a hard perimeter.
  map.tiles.fill(Tile.Floor);
  map.floor.fill(Tile.Floor);
  map.ceiling.fill(0);
  map.strokeRect(0, 0, bp.width - 1, bp.height - 1, Tile.Concrete);
  map.strokeRect(1, 1, bp.width - 2, bp.height - 2, Tile.Concrete);

  // 2. Optional water channel + pier along the south edge.
  if (bp.water) {
    const channelDepth = Math.max(4, Math.floor(bp.height * 0.09));
    map.fillRect(2, bp.height - 2 - channelDepth, bp.width - 3, bp.height - 3, Tile.Water);
    map.fillFloorRect(2, bp.height - 2 - channelDepth, bp.width - 3, bp.height - 3, Tile.Water);
    // Two piers so the waterfront is traversable and not a dead end.
    for (const px of [Math.floor(bp.width * 0.3), Math.floor(bp.width * 0.72)]) {
      map.fillRect(px - 1, bp.height - 2 - channelDepth, px + 1, bp.height - 3, Tile.Grate);
      map.fillFloorRect(px - 1, bp.height - 2 - channelDepth, px + 1, bp.height - 3, Tile.Grate);
    }
  }

  const occupied: Rect[] = [];
  const usableY1 = bp.water ? bp.height - 4 - Math.floor(bp.height * 0.09) : bp.height - 3;

  // 3. Buildings. Largest first so the anchor structures get the good ground.
  const buildings: Rect[] = [];
  // Footprints scale with the blueprint. Floored at a size that still fits a
  // partitioned interior with a doorway - below about seven tiles the BSP
  // split produces rooms nobody can walk into.
  const scaled = (n: number) => Math.max(7, Math.round(n * bp.structureScale));
  for (let i = 0; i < bp.buildings; i++) {
    const big = i === 0;
    const w = scaled(big ? rng.int(18, 24) : rng.int(9, 16));
    const h = scaled(big ? rng.int(14, 20) : rng.int(8, 14));
    const placed = tryPlace(rng, occupied, 3, 3, bp.width - 4, usableY1, w, h, 4);
    if (!placed) continue;
    occupied.push(placed);
    buildings.push(placed);
    carveBuilding(map, rng, placed, big, result);
  }

  // 4. Container yards - dense, low-visibility cover mazes between buildings.
  for (let i = 0; i < bp.containerYards; i++) {
    const w = scaled(rng.int(10, 16));
    const h = scaled(rng.int(9, 14));
    // Yards pack tighter than buildings - they are the claustrophobic part of
    // any location, whatever that location's overall character.
    const placed = tryPlace(rng, occupied, 3, 3, bp.width - 4, usableY1, w, h, 3);
    if (!placed) continue;
    occupied.push(placed);
    carveContainerYard(map, rng, placed, result);
  }

  // 5. Perimeter fencing subdividing the open yard, with gates so it stays open.
  carveFenceLines(map, rng, bp, occupied);

  // 6. Loose clutter for micro-cover in the open ground.
  scatterClutter(map, rng, bp, occupied);

  // 7. Zones - drives loot rarity, AI density and ambience.
  buildZones(map, buildings, bp);

  // 8. Extractions on opposing edges, at least one conditional.
  buildExtracts(map, rng, bp, result);

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
  placeLootAnchors(map, rng, bp, result, buildings, regions);

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

/** Rejection-sample a free rect. Returns null if we could not fit one. */
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
): Rect | null {
  for (let attempt = 0; attempt < 60; attempt++) {
    const x0 = rng.int(minX, Math.max(minX, maxX - w));
    const y0 = rng.int(minY, Math.max(minY, maxY - h));
    const r: Rect = { x0, y0, x1: x0 + w, y1: y0 + h };
    if (r.x1 > maxX || r.y1 > maxY) continue;
    let clash = false;
    for (const o of occupied) {
      if (rectsOverlap(r, o, padding)) {
        clash = true;
        break;
      }
    }
    if (!clash) return r;
  }
  return null;
}

/**
 * Carve an enclosed building: outer shell, BSP-partitioned rooms, doorways,
 * window bands and an interior ceiling so lighting knows it is indoors.
 */
function carveBuilding(map: TileMap, rng: Rng, r: Rect, isLarge: boolean, out: GeneratedMap): void {
  const wallMat = isLarge ? Tile.Concrete : rng.pick([Tile.Brick, Tile.Metal, Tile.Concrete]);
  const floorMat = isLarge ? Tile.Concrete : rng.pick([Tile.Concrete, Tile.Wood]);

  map.fillRect(r.x0, r.y0, r.x1, r.y1, Tile.Floor);
  map.fillFloorRect(r.x0, r.y0, r.x1, r.y1, floorMat);
  map.fillCeilingRect(r.x0, r.y0, r.x1, r.y1, wallMat);
  map.strokeRect(r.x0, r.y0, r.x1, r.y1, wallMat);

  // Interior partitioning. Large buildings get a warehouse hall + side rooms;
  // small ones get a simple two-or-three room split.
  const rooms: Rect[] = [];
  bspSplit(rng, { x0: r.x0 + 1, y0: r.y0 + 1, x1: r.x1 - 1, y1: r.y1 - 1 }, isLarge ? 6 : 4, rooms);

  const partitionMat = isLarge ? Tile.Brick : Tile.Wood;
  for (const room of rooms) {
    // Draw partition walls only on edges that are not the building shell.
    if (room.x0 > r.x0 + 1) for (let y = room.y0; y <= room.y1; y++) map.set(room.x0 - 1, y, partitionMat);
    if (room.y0 > r.y0 + 1) for (let x = room.x0; x <= room.x1; x++) map.set(x, room.y0 - 1, partitionMat);
  }

  // Doorways: punch two-tile gaps so rooms are never sealed.
  for (const room of rooms) {
    if (room.x0 > r.x0 + 1) {
      const dy = rng.int(room.y0, Math.max(room.y0, room.y1 - 1));
      map.set(room.x0 - 1, dy, Tile.Floor);
      map.set(room.x0 - 1, dy + 1, Tile.Floor);
    }
    if (room.y0 > r.y0 + 1) {
      const dx = rng.int(room.x0, Math.max(room.x0, room.x1 - 1));
      map.set(dx, room.y0 - 1, Tile.Floor);
      map.set(dx + 1, room.y0 - 1, Tile.Floor);
    }
  }

  // Exterior entrances: at least two, on different faces, so no building is a
  // single-entry death trap for either side.
  const faces = rng.shuffle([0, 1, 2, 3]);
  const entrances = isLarge ? 3 : 2;
  for (let i = 0; i < entrances; i++) {
    punchEntrance(map, rng, r, faces[i], isLarge ? 3 : 2);
  }

  // Window bands on the remaining faces - sightlines in and out.
  for (let i = entrances; i < 4; i++) {
    punchWindows(map, rng, r, faces[i]);
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
function punchEntrance(map: TileMap, rng: Rng, r: Rect, face: number, width: number): void {
  if (face === 0 || face === 2) {
    const y = face === 0 ? r.y0 : r.y1;
    const x = rng.int(r.x0 + 2, Math.max(r.x0 + 2, r.x1 - width - 1));
    for (let i = 0; i < width; i++) map.set(x + i, y, Tile.Floor);
  } else {
    const x = face === 1 ? r.x1 : r.x0;
    const y = rng.int(r.y0 + 2, Math.max(r.y0 + 2, r.y1 - width - 1));
    for (let i = 0; i < width; i++) map.set(x, y + i, Tile.Floor);
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
function carveFenceLines(map: TileMap, rng: Rng, bp: MapBlueprint, occupied: Rect[]): void {
  const lines = rng.int(2, 4);
  for (let i = 0; i < lines; i++) {
    const horizontal = rng.chance(0.5);
    if (horizontal) {
      const y = rng.int(6, bp.height - 7);
      for (let x = 3; x < bp.width - 3; x++) {
        if (isInsideAny(x, y, occupied, 1)) continue;
        map.set(x, y, Tile.Fence);
      }
      // Gates: two gaps guarantee a flank route.
      for (let g = 0; g < 2; g++) {
        const gx = rng.int(5, bp.width - 6);
        for (let k = -1; k <= 1; k++) map.set(gx + k, y, Tile.Floor);
      }
    } else {
      const x = rng.int(6, bp.width - 7);
      for (let y = 3; y < bp.height - 3; y++) {
        if (isInsideAny(x, y, occupied, 1)) continue;
        map.set(x, y, Tile.Fence);
      }
      for (let g = 0; g < 2; g++) {
        const gy = rng.int(5, bp.height - 6);
        for (let k = -1; k <= 1; k++) map.set(x, gy + k, Tile.Floor);
      }
    }
  }
}

function isInsideAny(x: number, y: number, rects: Rect[], padding: number): boolean {
  for (const r of rects) {
    if (x >= r.x0 - padding && x <= r.x1 + padding && y >= r.y0 - padding && y <= r.y1 + padding) return true;
  }
  return false;
}

function scatterClutter(map: TileMap, rng: Rng, bp: MapBlueprint, occupied: Rect[]): void {
  const attempts = Math.floor(bp.width * bp.height * 0.02 * bp.clutter * 4);
  for (let i = 0; i < attempts; i++) {
    const x = rng.int(3, bp.width - 4);
    const y = rng.int(3, bp.height - 4);
    if (map.at(x, y) !== Tile.Floor) continue;
    if (isInsideAny(x, y, occupied, 0)) continue;
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

function buildZones(map: TileMap, buildings: Rect[], bp: MapBlueprint): void {
  // Outer ring: low danger, low value - the "get your bearings" band.
  map.addZone({
    name: 'Außengelände',
    x0: 1, y0: 1, x1: bp.width - 2, y1: bp.height - 2,
    danger: 0.25, interior: false,
  });
  const names = ['Lagerhalle', 'Verwaltung', 'Werkhalle', 'Umschlagpunkt', 'Kesselhaus'];
  // The first (largest) building is the map's high-value contested space, and
  // the rest ramp up towards it without ever passing it.
  //
  // This used to read `0.5 + i * 0.05`, which is unbounded: the ninth building
  // scored 0.90 and the fourteenth 1.15, so on a dense location the *last*
  // structure placed outranked the anchor. Nothing caught it while no
  // blueprint asked for more than five buildings. Adding one that asks for
  // fourteen inverted the map's risk gradient - hostiles thinned out on the
  // valuable ground instead of crowding it - which is the one relationship the
  // whole loop is built on, so it failed the risk/reward test rather than
  // shipping quietly.
  //
  // Expressed as a fraction of the count now, so it holds at any density.
  const secondaryCount = Math.max(1, buildings.length - 1);
  buildings.forEach((b, i) => {
    map.addZone({
      name: names[i % names.length],
      x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1,
      danger: i === 0 ? 0.9 : 0.35 + (i / secondaryCount) * 0.35,
      interior: true,
    });
  });
}

function buildExtracts(map: TileMap, rng: Rng, bp: MapBlueprint, out: GeneratedMap): void {
  // Corner-biased candidates on opposite sides of the map.
  const margin = 5;
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
  regions: RegionMap,
): void {
  // Interior anchors: the reward for entering contested indoor space.
  for (let bi = 0; bi < buildings.length; bi++) {
    const b = buildings[bi];
    const count = Math.floor((rectW(b) * rectH(b)) / 26) + 2;
    for (let i = 0; i < count; i++) {
      const spot = findFreeTile(map, rng, b.x0 + 1, b.y0 + 1, b.x1 - 1, b.y1 - 1, regions);
      if (!spot) continue;
      const primary = bi === 0;
      const containerId = rng.weighted(
        primary
          ? ['weapon_crate', 'med_cabinet', 'tool_chest', 'safe', 'supply_crate']
          : ['supply_crate', 'med_cabinet', 'tool_chest', 'filing_cabinet', 'weapon_crate'],
        primary ? [3, 2, 2, 2, 3] : [4, 2, 2, 3, 1],
      )!;
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
