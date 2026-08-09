import { Tile } from './TileMap';

/**
 * Districts - what a building *is*, rather than merely where it stands.
 *
 * The generator used to place buildings as anonymous rectangles that differed
 * only in size and in a danger number. Everything downstream inherited that
 * blankness: a workshop and an office drew their contents from the same
 * weighted list of five container types, so there was no reason to prefer one
 * over the other and no way to learn a map beyond its geometry.
 *
 * A district carries the four things the rest of the game needs in order to
 * treat one place differently from another:
 *
 *   - **What it looks like.** Materials and interior grain, so a boiler house
 *     does not read as an office block with different loot in it.
 *   - **What is in it.** Weighted container types. A medical store holds
 *     medicine; an armoury holds weapons and ammunition. This is what makes
 *     "where do I go" a question with an answer.
 *   - **What it costs.** A risk value that drives both hostile density and
 *     loot quality, so the valuable ground is the guarded ground.
 *   - **What to call it.** The name the map screen and the compass show.
 *
 * Deliberately data rather than code: adding a district is a table entry, and
 * a blueprint picks the mix that suits it. The harbour wants container yards
 * and a customs office; the boiler house wants workshops and plant rooms.
 */

export type RiskTier = 'low' | 'medium' | 'high';

/**
 * The shape of a building's footprint, seen from above.
 *
 * Every structure used to be a stroked rectangle, which is why the maps read as
 * a box of boxes from the first screenshot. Real industrial buildings are
 * rarely one clean oblong: a hall gets an office wing bolted to one end, a
 * workshop wraps three sides of a service yard, an administration block encloses
 * a courtyard.
 *
 * The shapes are cheap because each is a small union of rectangles, so all the
 * existing machinery - partitioning, doorways, windows, lighting - runs per
 * wing without knowing the building is not a box.
 *
 *   hall       one span, for anything that needs an uninterrupted floor
 *   ell        two wings meeting at a corner
 *   u          three wings around a yard open on one side
 *   courtyard  four wings around an enclosed yard, open to the sky
 *   annex      a main span with a smaller wing on one face
 */
export type FootprintKind = 'hall' | 'ell' | 'u' | 'courtyard' | 'annex';

export interface DistrictKind {
  id: string;
  /** Shown on the map screen. Plural-free, it labels one building. */
  label: string;
  tier: RiskTier;
  /**
   * Container archetypes this district can hold, with weights.
   *
   * These are ids from `LOOT_TABLES`; the loot system reads the same key for
   * both the table and the container's appearance.
   */
  containers: { id: string; weight: number }[];
  /** Shell material. Concrete reads industrial, brick reads civil. */
  wall: Tile;
  /** Interior partition material - lighter than the shell by convention. */
  partition: Tile;
  /**
   * How finely the interior is subdivided. A warehouse is one hall with a
   * couple of side rooms; an office is a warren of small ones.
   *
   * Feeds the BSP depth directly, so this is the single number that decides
   * whether a place is fought across or fought through.
   */
  subdivision: number;
  /** Preferred footprint in tiles, before the blueprint's scale is applied. */
  size: { min: number; max: number };
  /**
   * Shapes this kind of building is allowed to take, picked at random.
   *
   * A warehouse needs its floor uninterrupted, so it stays a hall whatever
   * else is going on; an administration block is exactly the sort of thing
   * that gets built around a courtyard. This is what stops the shape variety
   * from being noise - the silhouette tells you what a building is before you
   * have read its sign.
   */
  footprints: FootprintKind[];
}

/**
 * Danger by tier.
 *
 * Kept as one small table rather than a field per district so the ordering is
 * visible at a glance and cannot drift apart. The generator's anchor building
 * is promoted above all of these, which is what keeps a map's centrepiece its
 * most contested ground however its districts are mixed.
 */
export const TIER_DANGER: Record<RiskTier, number> = {
  low: 0.35,
  medium: 0.55,
  high: 0.78,
};

export const DISTRICTS: Record<string, DistrictKind> = {
  warehouse: {
    id: 'warehouse',
    label: 'Lagerhalle',
    tier: 'medium',
    containers: [
      { id: 'supply_crate', weight: 5 },
      { id: 'barrel', weight: 3 },
      { id: 'toolbox', weight: 2 },
      { id: 'duffel', weight: 2 },
    ],
    wall: Tile.Concrete,
    partition: Tile.Metal,
    // One hall, a couple of side rooms. Long interior sightlines.
    subdivision: 2,
    size: { min: 18, max: 26 },
    footprints: ['hall', 'hall', 'annex'],
  },

  workshop: {
    id: 'workshop',
    label: 'Werkstatt',
    tier: 'medium',
    containers: [
      { id: 'tool_chest', weight: 6 },
      { id: 'toolbox', weight: 4 },
      { id: 'barrel', weight: 2 },
      { id: 'supply_crate', weight: 1 },
    ],
    wall: Tile.Metal,
    partition: Tile.Wood,
    subdivision: 3,
    size: { min: 12, max: 18 },
    footprints: ['ell', 'u', 'annex', 'hall'],
  },

  office: {
    id: 'office',
    label: 'Verwaltung',
    tier: 'medium',
    containers: [
      { id: 'filing_cabinet', weight: 6 },
      { id: 'safe', weight: 2 },
      { id: 'duffel', weight: 2 },
      { id: 'supply_crate', weight: 1 },
    ],
    wall: Tile.Brick,
    partition: Tile.Wood,
    // The warren. Corners everywhere, nothing to shoot across.
    subdivision: 5,
    size: { min: 12, max: 20 },
    footprints: ['courtyard', 'u', 'ell', 'annex'],
  },

  medical: {
    id: 'medical',
    label: 'Sanitätsstation',
    tier: 'medium',
    containers: [
      { id: 'med_cabinet', weight: 7 },
      { id: 'filing_cabinet', weight: 2 },
      { id: 'supply_crate', weight: 1 },
    ],
    wall: Tile.Brick,
    partition: Tile.Wood,
    subdivision: 4,
    size: { min: 10, max: 16 },
    footprints: ['ell', 'annex', 'hall'],
  },

  armoury: {
    id: 'armoury',
    label: 'Waffenkammer',
    tier: 'high',
    containers: [
      { id: 'weapon_crate', weight: 6 },
      { id: 'safe', weight: 3 },
      { id: 'supply_crate', weight: 2 },
    ],
    wall: Tile.Concrete,
    partition: Tile.Concrete,
    subdivision: 3,
    size: { min: 12, max: 18 },
    footprints: ['hall', 'annex'],
  },

  control: {
    id: 'control',
    label: 'Leitstand',
    tier: 'high',
    containers: [
      { id: 'safe', weight: 4 },
      { id: 'filing_cabinet', weight: 3 },
      { id: 'weapon_crate', weight: 2 },
      { id: 'med_cabinet', weight: 1 },
    ],
    wall: Tile.Concrete,
    partition: Tile.Brick,
    subdivision: 4,
    size: { min: 14, max: 22 },
    footprints: ['courtyard', 'u', 'annex'],
  },

  plant: {
    id: 'plant',
    label: 'Technikhalle',
    tier: 'low',
    containers: [
      { id: 'barrel', weight: 5 },
      { id: 'toolbox', weight: 3 },
      { id: 'tool_chest', weight: 2 },
    ],
    wall: Tile.Metal,
    partition: Tile.Metal,
    subdivision: 3,
    size: { min: 14, max: 20 },
    footprints: ['hall', 'annex', 'ell'],
  },

  quarters: {
    id: 'quarters',
    label: 'Unterkunft',
    tier: 'low',
    containers: [
      { id: 'duffel', weight: 5 },
      { id: 'supply_crate', weight: 3 },
      { id: 'med_cabinet', weight: 2 },
      { id: 'filing_cabinet', weight: 1 },
    ],
    wall: Tile.Brick,
    partition: Tile.Wood,
    subdivision: 5,
    size: { min: 10, max: 16 },
    footprints: ['u', 'courtyard', 'ell'],
  },

  depot: {
    id: 'depot',
    label: 'Umschlaglager',
    tier: 'low',
    containers: [
      { id: 'supply_crate', weight: 6 },
      { id: 'barrel', weight: 3 },
      { id: 'duffel', weight: 1 },
    ],
    wall: Tile.Metal,
    partition: Tile.Wood,
    subdivision: 2,
    size: { min: 14, max: 22 },
    footprints: ['hall', 'hall', 'ell'],
  },
};

/** Look up a district, falling back to the warehouse rather than throwing. */
export function districtById(id: string): DistrictKind {
  return DISTRICTS[id] ?? DISTRICTS.warehouse;
}
