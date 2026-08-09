/**
 * TileMap - the authoritative world representation.
 *
 * The world is a uniform grid. One tile is `METERS_PER_TILE` metres across;
 * gameplay maths (speeds, ranges) is expressed in tiles, while ballistics
 * converts to metres so real-world ammo data stays readable.
 *
 * All per-tile data lives in parallel typed arrays rather than an array of
 * objects: it is what the raycaster, navigation and lighting all sample every
 * frame, and flat arrays keep those inner loops cache-friendly.
 *
 * Unity port note: this maps directly onto a ScriptableObject holding the same
 * typed arrays, with the renderer replaced by real geometry built at import.
 */

/** One tile edge in metres. Chosen so a 96x96 map is a ~190 m compound. */
export const METERS_PER_TILE = 2.0;

/**
 * Tile ids.
 *
 * A plain const object rather than a TypeScript enum: enums need a runtime
 * transform, which rules out type-stripping runtimes (and Node's built-in
 * test runner). This form is erasable, tree-shakes cleanly, and still gives
 * us `Tile.Concrete` at the call site and a `Tile` union as a type.
 */
export const Tile = {
  Floor: 0,
  Concrete: 1,
  Brick: 2,
  Metal: 3,
  Wood: 4,
  Container: 5,
  Fence: 6,
  Window: 7,
  DoorClosed: 8,
  DoorOpen: 9,
  Rubble: 10,
  Crate: 11,
  Rock: 12,
  Water: 13,
  Grate: 14,
  Glass: 15,
} as const;

export type Tile = (typeof Tile)[keyof typeof Tile];

export const TILE_COUNT = 16;

/**
 * Static properties of each tile type.
 *
 * `penetration` is the material's resistance in armour-equivalent points; a
 * round with penetration power above it punches through, losing energy. This is
 * what makes concrete real cover and a wooden shed a death trap.
 */
export interface TileDef {
  readonly id: Tile;
  readonly name: string;
  /** Blocks actor movement. */
  readonly solid: boolean;
  /** Blocks line of sight (and therefore rendering as a wall). */
  readonly opaque: boolean;
  /**
   * The *material* can be seen through, whatever its height.
   *
   * Split out from `opaque` because that one flag was carrying two unrelated
   * meanings: "you can see through this stuff" (chain-link, glass) and "this
   * is short enough to see over" (a crate). Both ended up as `opaque: false`,
   * so nothing in the game could tell them apart - and the consequence was
   * that lying down behind a solid wooden crate hid you from bullets but not
   * from eyes, because sight was tested flat while ballistics was tested in
   * three dimensions. Height decides whether you see *over* something; this
   * decides whether you see *through* it.
   */
  readonly seeThrough: boolean;
  /** Renders as a full-height wall surface. */
  readonly wall: boolean;
  /**
   * Height in metres for cover evaluation. 0 = floor, 1.0 = crouch cover,
   * >1.8 = full cover.
   */
  readonly height: number;
  /** Material resistance to penetration; Infinity = impenetrable. */
  readonly penetration: number;
  /** Fraction of a projectile's energy lost when passing through. */
  readonly energyLoss: number;
  /** Sound occlusion factor 0..1 applied per tile crossed. */
  readonly soundDamping: number;
  /** Texture index into the procedural atlas. */
  readonly texture: number;
  /** Base albedo used to tint the procedural texture. */
  readonly tint: number;
  /** Movement cost multiplier for navigation (1 = normal). */
  readonly moveCost: number;
  /** Extra footstep loudness multiplier - metal grates give you away. */
  readonly footstepLoudness: number;
}

function def(
  id: Tile,
  name: string,
  o: Partial<Omit<TileDef, 'id' | 'name'>>,
): TileDef {
  return {
    id,
    name,
    solid: false,
    opaque: false,
    seeThrough: false,
    wall: false,
    height: 0,
    penetration: 0,
    energyLoss: 0,
    soundDamping: 0,
    texture: 0,
    tint: 0x8a8a8a,
    moveCost: 1,
    footstepLoudness: 1,
    ...o,
  };
}

export const TILE_DEFS: readonly TileDef[] = [
  def(Tile.Floor, 'Boden', { texture: 0, tint: 0x6b6a63 }),
  def(Tile.Concrete, 'Beton', {
    solid: true, opaque: true, wall: true, height: 3, penetration: 65,
    energyLoss: 0.75, soundDamping: 0.55, texture: 1, tint: 0x9a9a94,
  }),
  def(Tile.Brick, 'Ziegel', {
    solid: true, opaque: true, wall: true, height: 3, penetration: 42,
    energyLoss: 0.6, soundDamping: 0.45, texture: 2, tint: 0x8f5f4a,
  }),
  def(Tile.Metal, 'Stahlblech', {
    solid: true, opaque: true, wall: true, height: 3, penetration: 30,
    energyLoss: 0.45, soundDamping: 0.3, texture: 3, tint: 0x6f7a80,
  }),
  def(Tile.Wood, 'Holzwand', {
    solid: true, opaque: true, wall: true, height: 3, penetration: 14,
    energyLoss: 0.3, soundDamping: 0.2, texture: 4, tint: 0x8a6a42,
  }),
  def(Tile.Container, 'Seecontainer', {
    solid: true, opaque: true, wall: true, height: 2.6, penetration: 34,
    energyLoss: 0.5, soundDamping: 0.35, texture: 5, tint: 0x9c5a3c,
  }),
  // Fences block movement but not sight - readable sightlines, no free cover.
  def(Tile.Fence, 'Maschendraht', {
    solid: true, opaque: false, seeThrough: true, wall: true, height: 2.2, penetration: 4,
    energyLoss: 0.05, soundDamping: 0.02, texture: 6, tint: 0x5c6060,
  }),
  // Window band: see through it and shoot through it, but you cannot walk
  // through it. Cheap glass means windows are lethal cover, which is the point.
  def(Tile.Window, 'Fensterband', {
    solid: true, opaque: false, seeThrough: true, wall: true, height: 3, penetration: 3,
    energyLoss: 0.04, soundDamping: 0.05, texture: 7, tint: 0x7fa8b0,
  }),
  def(Tile.DoorClosed, 'Tür', {
    solid: true, opaque: true, wall: true, height: 2.4, penetration: 12,
    energyLoss: 0.25, soundDamping: 0.4, texture: 8, tint: 0x7a5a3a, moveCost: 1.6,
  }),
  def(Tile.DoorOpen, 'Tür (offen)', { texture: 0, tint: 0x6b6a63, moveCost: 1 }),
  def(Tile.Rubble, 'Schutt', {
    height: 0.5, moveCost: 1.9, texture: 9, tint: 0x74706a, footstepLoudness: 1.5,
  }),
  // Crates: chest-high cover you can shoot over but not through easily.
  def(Tile.Crate, 'Kiste', {
    solid: true, opaque: false, wall: true, height: 1.2, penetration: 16,
    energyLoss: 0.35, soundDamping: 0.15, texture: 10, tint: 0x8a7448,
  }),
  def(Tile.Rock, 'Fels', {
    solid: true, opaque: true, wall: true, height: 2.8, penetration: 90,
    energyLoss: 0.85, soundDamping: 0.6, texture: 11, tint: 0x6a6a68,
  }),
  def(Tile.Water, 'Wasser', { moveCost: 2.6, texture: 12, tint: 0x2f4a58, footstepLoudness: 2.2 }),
  def(Tile.Grate, 'Gitterrost', { texture: 13, tint: 0x5a5e60, footstepLoudness: 2.4 }),
  def(Tile.Glass, 'Glasfront', {
    solid: true, opaque: false, seeThrough: true, wall: true, height: 3, penetration: 2,
    energyLoss: 0.03, soundDamping: 0.05, texture: 14, tint: 0x8fc4cc,
  }),
];

/** Fast lookup tables - hot loops index these instead of the object array. */
const SOLID = new Uint8Array(TILE_COUNT);
const OPAQUE = new Uint8Array(TILE_COUNT);
const SEE_THROUGH = new Uint8Array(TILE_COUNT);
const WALL = new Uint8Array(TILE_COUNT);
const PENETRATION = new Float32Array(TILE_COUNT);
const ENERGY_LOSS = new Float32Array(TILE_COUNT);
const SOUND_DAMP = new Float32Array(TILE_COUNT);
const MOVE_COST = new Float32Array(TILE_COUNT);
const HEIGHT = new Float32Array(TILE_COUNT);
for (const d of TILE_DEFS) {
  SOLID[d.id] = d.solid ? 1 : 0;
  OPAQUE[d.id] = d.opaque ? 1 : 0;
  SEE_THROUGH[d.id] = d.seeThrough ? 1 : 0;
  WALL[d.id] = d.wall ? 1 : 0;
  PENETRATION[d.id] = d.penetration;
  ENERGY_LOSS[d.id] = d.energyLoss;
  SOUND_DAMP[d.id] = d.soundDamping;
  MOVE_COST[d.id] = d.moveCost;
  HEIGHT[d.id] = d.height;
}

/** Named regions used by spawning, loot density and AI patrol assignment. */
export interface Zone {
  id: number;
  name: string;
  /** Tile-space bounds, inclusive. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 0..1 - drives loot rarity weighting and AI density. */
  danger: number;
  /** Interior zones are dark and muffle sound; exterior gets sky lighting. */
  interior: boolean;
}

export class TileMap {
  readonly width: number;
  readonly height: number;

  /** Wall/obstacle layer. */
  readonly tiles: Uint8Array;
  /** Ground material under the wall layer (visible where tile is walkable). */
  readonly floor: Uint8Array;
  /** 0 = open sky (outdoors), otherwise a ceiling material index. */
  readonly ceiling: Uint8Array;
  /** Baked static light 0..255, sampled per column by the renderer. */
  readonly lightmap: Uint8Array;
  /**
   * Lamp contribution only, without the sky. Kept separate so the time of day
   * can be changed by recombining the two instead of repeating the bake, which
   * costs a line-of-sight test per lit tile.
   */
  readonly lampLight: Uint8Array;
  /** Zone id per tile, 0 = none. */
  readonly zoneGrid: Uint8Array;

  readonly zones: Zone[] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.tiles = new Uint8Array(n);
    this.floor = new Uint8Array(n);
    this.ceiling = new Uint8Array(n);
    this.lightmap = new Uint8Array(n).fill(180);
    this.lampLight = new Uint8Array(n);
    this.zoneGrid = new Uint8Array(n);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Tile at integer coords; out-of-bounds reads as solid concrete. */
  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return Tile.Concrete;
    return this.tiles[y * this.width + x];
  }

  set(x: number, y: number, t: Tile): void {
    if (!this.inBounds(x, y)) return;
    this.tiles[y * this.width + x] = t;
  }

  /** Blocks movement. Out of bounds is solid. */
  isSolid(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return true;
    return SOLID[this.tiles[y * this.width + x]] === 1;
  }

  /** Blocks line of sight. */
  isOpaque(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return true;
    return OPAQUE[this.tiles[y * this.width + x]] === 1;
  }

  /**
   * Does this tile block a sight ray passing over it at `z` metres?
   *
   * The three-dimensional counterpart of `isOpaque`, and the test the AI now
   * uses. Chain-link and glass never block, whatever their height. Everything
   * else blocks only what passes below its top edge, which is what makes going
   * prone behind a crate mean something: the round is stopped by the same edge,
   * so what an enemy can see and what it can hit finally agree.
   */
  blocksSightAt(x: number, y: number, z: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return true;
    const t = this.tiles[y * this.width + x];
    if (WALL[t] === 0 || SEE_THROUGH[t] === 1) return false;
    return z <= HEIGHT[t];
  }

  /** Renders as a wall surface (may still be see-through, e.g. fences/glass). */
  isWall(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return true;
    return WALL[this.tiles[y * this.width + x]] === 1;
  }

  /** Continuous-coordinate solidity test. */
  isSolidAt(wx: number, wy: number): boolean {
    return this.isSolid(Math.floor(wx), Math.floor(wy));
  }

  penetrationOf(x: number, y: number): number {
    return PENETRATION[this.at(x, y)];
  }

  energyLossOf(x: number, y: number): number {
    return ENERGY_LOSS[this.at(x, y)];
  }

  soundDampingOf(x: number, y: number): number {
    return SOUND_DAMP[this.at(x, y)];
  }

  moveCostOf(x: number, y: number): number {
    return MOVE_COST[this.at(x, y)];
  }

  heightOf(x: number, y: number): number {
    return HEIGHT[this.at(x, y)];
  }

  isIndoors(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.ceiling[y * this.width + x] !== 0;
  }

  lightAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.lightmap[y * this.width + x];
  }

  zoneAt(x: number, y: number): Zone | undefined {
    if (!this.inBounds(x, y)) return undefined;
    const id = this.zoneGrid[y * this.width + x];
    return id === 0 ? undefined : this.zones.find((z) => z.id === id);
  }

  addZone(zone: Omit<Zone, 'id'>): Zone {
    const z: Zone = { ...zone, id: this.zones.length + 1 };
    this.zones.push(z);
    for (let y = z.y0; y <= z.y1; y++) {
      for (let x = z.x0; x <= z.x1; x++) {
        if (this.inBounds(x, y)) this.zoneGrid[y * this.width + x] = z.id;
      }
    }
    return z;
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, t: Tile): void {
    for (let y = Math.max(0, y0); y <= Math.min(this.height - 1, y1); y++) {
      const row = y * this.width;
      for (let x = Math.max(0, x0); x <= Math.min(this.width - 1, x1); x++) {
        this.tiles[row + x] = t;
      }
    }
  }

  strokeRect(x0: number, y0: number, x1: number, y1: number, t: Tile): void {
    for (let x = x0; x <= x1; x++) {
      this.set(x, y0, t);
      this.set(x, y1, t);
    }
    for (let y = y0; y <= y1; y++) {
      this.set(x0, y, t);
      this.set(x1, y, t);
    }
  }

  /** Single-tile floor material. The rect form covers everything laid out in blocks. */
  setFloor(x: number, y: number, material: Tile): void {
    if (!this.inBounds(x, y)) return;
    this.floor[y * this.width + x] = material;
  }

  /** Single-tile ceiling material; 0 means open sky. */
  setCeiling(x: number, y: number, material: number): void {
    if (!this.inBounds(x, y)) return;
    this.ceiling[y * this.width + x] = material;
  }

  fillFloorRect(x0: number, y0: number, x1: number, y1: number, material: Tile): void {
    for (let y = Math.max(0, y0); y <= Math.min(this.height - 1, y1); y++) {
      const row = y * this.width;
      for (let x = Math.max(0, x0); x <= Math.min(this.width - 1, x1); x++) {
        this.floor[row + x] = material;
      }
    }
  }

  fillCeilingRect(x0: number, y0: number, x1: number, y1: number, material: number): void {
    for (let y = Math.max(0, y0); y <= Math.min(this.height - 1, y1); y++) {
      const row = y * this.width;
      for (let x = Math.max(0, x0); x <= Math.min(this.width - 1, x1); x++) {
        this.ceiling[row + x] = material;
      }
    }
  }

  /** Find the nearest walkable tile to (x, y) - used to rescue bad spawns. */
  nearestOpen(x: number, y: number, maxRadius = 12): { x: number; y: number } | null {
    if (!this.isSolid(x, y)) return { x, y };
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // Only test the ring perimeter.
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (this.inBounds(nx, ny) && !this.isSolid(nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }
}
