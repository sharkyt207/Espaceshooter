import { Rng } from '../core/Random';
import { fbm } from '../core/Noise';
import { Tile, TileMap } from './TileMap';
import type { MapBlueprint } from './MapGenerator';

/**
 * Borders - where a location stops, and why.
 *
 * Every map used to end the same way: two concrete rings stroked around the
 * outside, which is a fence around a football pitch. It reads as a playfield
 * boundary rather than a place, and it announces the edge of the simulation
 * from anywhere on the map, because a perfectly straight three-metre wall does
 * not occur in an industrial landscape.
 *
 * What replaces it:
 *
 *   - The hard stop is free. Every out-of-bounds query already answers solid
 *     and opaque, so nothing needs a wall to be impassable. The outermost ring
 *     only has to give the renderer a surface, which means it can be made of
 *     whatever the *place* is made of.
 *   - The boundary the player can walk to is ragged. Each edge's depth varies
 *     along its length with noise, so the playable outline is organic rather
 *     than rectangular - and it is the *walkable* boundary that varies, not
 *     just the texture on it. That distinction cost me a rewrite: the first
 *     version filled the band with rubble, which is walkable, so the outline
 *     stayed a perfect rectangle one tile in and only the floor colour moved.
 *   - Each edge has a reason. Water, a rock cutting, a rail embankment, stacked
 *     containers, the back walls of the next block along. A player who walks
 *     into one should be able to say what stopped them without saying "wall".
 *
 * Border bands eat playable area, and the locations were grown on purpose, so
 * depth is capped at a tenth of the shorter side: six tiles on the smallest
 * map, sixteen on the largest.
 */

export type BorderKind = 'water' | 'cliff' | 'rail' | 'stacks' | 'block';

/** North, east, south, west - the order used everywhere below. */
export type EdgeIndex = 0 | 1 | 2 | 3;

interface BorderStyle {
  /** The body of the band. This is what actually stops the player. */
  body: Tile;
  /** Mixed into the body so a band is never one flat material. */
  speckle: Tile;
  speckleChance: number;
  /**
   * The innermost row: what the player meets first, placed with gaps so the
   * band never presents a drawn line.
   */
  lip: Tile;
  lipChance: number;
  /**
   * Rows at the very outside made of something else - the far bank across a
   * channel, the retaining wall behind a track bed.
   */
  bank?: { tile: Tile; depth: number };
  /** Depth in tiles: the range the noise moves between. */
  minDepth: number;
  maxDepth: number;
  /** Floor material inside the band, where it differs from the tile. */
  floor?: Tile;
  /**
   * True when a person could cross this band. Crossable borders get gaps
   * carved in them, which turns the edge of the map into ground worth holding
   * rather than somewhere nobody goes.
   */
  crossable: boolean;
}

const STYLES: Record<BorderKind, BorderStyle> = {
  // A channel with the far bank beyond it. Water is walkable but slow and
  // loud, so this border is crossable and punishes crossing - which is a
  // better boundary than one that simply refuses.
  water: {
    body: Tile.Water, speckle: Tile.Rubble, speckleChance: 0.06,
    lip: Tile.Rubble, lipChance: 0.35,
    bank: { tile: Tile.Rock, depth: 2 },
    minDepth: 5, maxDepth: 13, floor: Tile.Water, crossable: true,
  },
  // A cut face with fallen rock at the foot.
  cliff: {
    body: Tile.Rock, speckle: Tile.Rubble, speckleChance: 0.1,
    lip: Tile.Rubble, lipChance: 0.5,
    minDepth: 4, maxDepth: 14, crossable: false,
  },
  // A rail cutting: retaining wall, gravel bed, fenced off from the yard.
  rail: {
    body: Tile.Concrete, speckle: Tile.Metal, speckleChance: 0.18,
    lip: Tile.Fence, lipChance: 0.7,
    bank: { tile: Tile.Concrete, depth: 1 },
    minDepth: 3, maxDepth: 9, crossable: true,
  },
  // Containers stacked along the boundary - the most ordinary way an
  // industrial yard ends, and the one that reads least like level geometry.
  stacks: {
    body: Tile.Container, speckle: Tile.Crate, speckleChance: 0.22,
    lip: Tile.Fence, lipChance: 0.45,
    minDepth: 3, maxDepth: 10, crossable: true,
  },
  // The next block along. Back walls, service gaps, nothing to see.
  block: {
    body: Tile.Brick, speckle: Tile.Concrete, speckleChance: 0.3,
    lip: Tile.Crate, lipChance: 0.25,
    minDepth: 4, maxDepth: 12, crossable: false,
  },
};

export interface BorderPlan {
  kinds: [BorderKind, BorderKind, BorderKind, BorderKind];
  /** Deepest the band can reach on each edge; placement stays clear of this. */
  insets: [number, number, number, number];
}

/**
 * Choose what each edge is made of.
 *
 * Water maps get their channel on the south, where the blueprint has always
 * put it and where the piers already are. Beyond that the only rule is that no
 * two adjacent edges match, because the corners are where a repeated border
 * gives itself away.
 */
export function planBorders(rng: Rng, bp: MapBlueprint): BorderPlan {
  const pool: BorderKind[] = ['cliff', 'rail', 'stacks', 'block'];
  const kinds: BorderKind[] = [];
  for (let e = 0; e < 4; e++) {
    if (e === 2 && bp.water) {
      kinds.push('water');
      continue;
    }
    const choices = pool.filter((k) => k !== kinds[e - 1]);
    kinds.push(choices[rng.int(0, choices.length - 1)]);
  }
  // The last edge also touches the first.
  if (kinds[3] === kinds[0]) {
    const choices = pool.filter((k) => k !== kinds[0] && k !== kinds[2]);
    if (choices.length > 0) kinds[3] = choices[rng.int(0, choices.length - 1)];
  }

  const cap = Math.max(3, Math.floor(Math.min(bp.width, bp.height) * 0.1));
  return {
    kinds: kinds as BorderPlan['kinds'],
    insets: kinds.map((k) => Math.min(cap, STYLES[k].maxDepth)) as BorderPlan['insets'],
  };
}

/**
 * Carve the four bands.
 *
 * Every tile in the border region belongs to whichever edge it is nearest,
 * so the corners resolve on the diagonal and two different materials meet
 * along it. A rock face running into a rail cutting looks like somewhere; two
 * identical walls meeting at a right angle looks like a level boundary.
 */
export function carveBorders(map: TileMap, rng: Rng, bp: MapBlueprint, plan: BorderPlan): void {
  const w = bp.width;
  const h = bp.height;
  const seed = rng.int(1, 1 << 28);

  /** How deep this edge reaches at position `t` along it, in tiles. */
  const depthAt = (edge: EdgeIndex, t: number): number => {
    const style = STYLES[plan.kinds[edge]];
    // Two things had to be got right here, and the first version got neither,
    // which is why the border came back looking like a picture frame.
    //
    // Frequency: the wavelength has to fit several times along an edge. At
    // 0.055 units per tile against a period of 16, a 160-tile edge sampled
    // barely half a cycle, so the "varying" depth was one slow ramp.
    //
    // Contrast: value noise is an average of corner samples and piles up
    // around the middle of its range, so feeding it straight into a depth
    // between 3 and 9 lands almost everything on 6. Stretching it about the
    // midpoint and clamping restores the headlands and the bays; without it
    // the noise is real and invisible, which is the worst kind.
    const raw = fbm(t * 0.13, edge * 17.3, 8, 2, seed + edge * 977);
    const n = Math.max(0, Math.min(1, (raw - 0.5) * 2.4 + 0.5));
    const cap = plan.insets[edge];
    const min = Math.min(style.minDepth, cap);
    return Math.round(min + (cap - min) * n);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = [y, w - 1 - x, h - 1 - y, x];
      let edge: EdgeIndex = 0;
      for (let e = 1; e < 4; e++) if (d[e] < d[edge]) edge = e as EdgeIndex;

      const along = edge === 0 || edge === 2 ? x : y;
      const band = depthAt(edge, along);
      const depth = d[edge];
      if (depth >= band) continue;

      const style = STYLES[plan.kinds[edge]];
      let tile: Tile;
      if (style.bank && depth < style.bank.depth) {
        tile = style.bank.tile;
      } else if (depth === 0) {
        // The outermost row is never varied. Both the scree at a cliff foot
        // and the debris against a fence are walkable tiles, and a single one
        // of them landing on the outside ring is a hole in the world - the
        // player walks up to the edge of the map and looks out of it. Measured
        // at ten to nineteen such holes per map before this line existed, on
        // every location and every seed.
        tile = style.body;
      } else if (depth === band - 1 && rng.chance(style.lipChance)) {
        tile = style.lip;
      } else if (rng.chance(style.speckleChance)) {
        tile = style.speckle;
      } else {
        tile = style.body;
      }
      map.set(x, y, tile);
      map.setFloor(x, y, style.floor ?? Tile.Floor);
      map.setCeiling(x, y, 0);
    }
  }

  // Ways in, where the border is something a person could get through.
  //
  // A band that is uniformly impassable is a wall with better texture on it.
  // A hole in the wire, a gap between two container stacks, a level crossing -
  // these give the edge of the map somewhere to fight over, and they are dead
  // ends by design, which is what the brief asked roads to have too.
  //
  // The outermost two rows are never cut. A gap that reaches the map edge
  // would show the player the end of the world through it.
  for (let e = 0; e < 4; e++) {
    const edge = e as EdgeIndex;
    if (!STYLES[plan.kinds[edge]].crossable) continue;
    const span = edge === 0 || edge === 2 ? w : h;
    const gaps = 1 + rng.int(0, 1);
    for (let g = 0; g < gaps; g++) {
      const at = rng.int(Math.floor(span * 0.2), Math.floor(span * 0.8));
      const halfWidth = rng.int(1, 3);
      for (let i = -halfWidth; i <= halfWidth; i++) {
        const along = at + i;
        if (along < 1 || along >= span - 1) continue;
        for (let depth = 2; depth < plan.insets[edge]; depth++) {
          const x = edge === 0 || edge === 2 ? along : edge === 1 ? w - 1 - depth : depth;
          const y = edge === 0 ? depth : edge === 2 ? h - 1 - depth : along;
          if (!map.inBounds(x, y)) continue;
          if (!map.isSolid(x, y)) continue; // already open - a channel, say
          map.set(x, y, Tile.Floor);
          map.setFloor(x, y, Tile.Rubble);
        }
      }
    }
  }
}
