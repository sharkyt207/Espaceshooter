import { Rng } from '../core/Random';
import { fbm } from '../core/Noise';
import { Tile, TileMap } from './TileMap';

/**
 * Roads - the reason the buildings stand where they do.
 *
 * Before this the ground between structures was one undifferentiated gravel
 * field with debris scattered on it. That is what made the maps read as a set
 * of boxes dropped on a plane rather than a site: there was nothing to explain
 * why anything was anywhere, and nothing to navigate by except the buildings
 * themselves, which all look alike from behind.
 *
 * Roads are laid *first*, and the building placer treats them as occupied. So
 * the road network is not decoration painted over a finished layout - it
 * carves the plots, and the buildings fill what is left. That ordering is the
 * whole trick: it produces frontages, back lots and irregular gaps for free,
 * where painting roads afterwards would have produced tarmac running through
 * warehouses.
 *
 * Shapes come from Chaikin-smoothed polylines rather than straight runs. A
 * dead-straight road across a map is the same tell as a dead-straight border:
 * it announces that a program drew it.
 */

export interface RoadPlan {
  /** Rectangles the building placer must stay out of. */
  corridors: { x0: number; y0: number; x1: number; y1: number }[];
  /** Points along the network, for anything that wants to follow a route. */
  spine: { x: number; y: number }[];
}

interface Pt {
  x: number;
  y: number;
}

/**
 * Chaikin corner cutting: each pass replaces every corner with two points a
 * quarter and three quarters along, which converges on a smooth curve. Two
 * passes is enough at tile resolution and keeps the point count low.
 */
function smooth(points: Pt[], passes: number): Pt[] {
  let out = points;
  for (let p = 0; p < passes; p++) {
    const next: Pt[] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i];
      const b = out[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/**
 * Resample a polyline so consecutive points are less than half a tile apart.
 *
 * Chaikin returns a shape, not a covering: across a 150-tile map its points
 * land about six tiles apart, and stamping a disc at each one paints a string
 * of beads rather than a road. This is the step that was missing when the
 * first render came back looking like a line of manhole covers.
 */
function resample(path: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

/**
 * Paint one road along a polyline.
 *
 * Surfacing is a floor material, not a tile: a road has to stay walkable, and
 * the tile layer is where solidity lives. Anything already solid on the line is
 * cleared, which only ever affects the border bands the road runs up to.
 */
function stamp(
  map: TileMap,
  rough: Pt[],
  halfWidth: number,
  corridors: RoadPlan['corridors'],
): void {
  const path = resample(rough);
  let lastCorridorAt = -99;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const cx = Math.round(p.x);
    const cy = Math.round(p.y);
    for (let dy = -halfWidth; dy <= halfWidth; dy++) {
      for (let dx = -halfWidth; dx <= halfWidth; dx++) {
        if (dx * dx + dy * dy > (halfWidth + 0.35) * (halfWidth + 0.35)) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!map.inBounds(x, y)) continue;
        // Never break the outermost ring: it is what the renderer draws the
        // edge of the world against.
        if (x < 2 || y < 2 || x >= map.width - 2 || y >= map.height - 2) continue;
        map.set(x, y, Tile.Floor);
        map.setFloor(x, y, Tile.Concrete);
      }
    }
    // One corridor rect every few points is enough to keep buildings off; a
    // rect per point would give the placer thousands to test against.
    if (i - lastCorridorAt >= halfWidth * 3 + 2) {
      lastCorridorAt = i;
      corridors.push({
        x0: cx - halfWidth, y0: cy - halfWidth,
        x1: cx + halfWidth, y1: cy + halfWidth,
      });
    }
  }
}

/** A rectangle of hardstanding beside a road: somewhere a lorry would stop. */
function parkingBay(map: TileMap, rng: Rng, at: Pt, corridors: RoadPlan['corridors']): void {
  const w = rng.int(4, 8);
  const h = rng.int(3, 6);
  const x0 = Math.round(at.x) - (w >> 1);
  const y0 = Math.round(at.y) - (h >> 1);
  for (let y = y0; y <= y0 + h; y++) {
    for (let x = x0; x <= x0 + w; x++) {
      if (!map.inBounds(x, y)) continue;
      if (x < 2 || y < 2 || x >= map.width - 2 || y >= map.height - 2) continue;
      map.set(x, y, Tile.Floor);
      map.setFloor(x, y, Tile.Concrete);
    }
  }
  corridors.push({ x0, y0, x1: x0 + w, y1: y0 + h });
}

/**
 * Lay the network.
 *
 * `bounds` is the area inside the border bands. Roads run right up to it, so
 * they meet the gaps carved through crossable borders and the site reads as
 * connected to somewhere else.
 */
export function carveRoads(
  map: TileMap,
  rng: Rng,
  bounds: { x0: number; y0: number; x1: number; y1: number },
  count: number,
): RoadPlan {
  const plan: RoadPlan = { corridors: [], spine: [] };
  // A location with no roads is a legitimate blueprint - a compound reached on
  // foot - and without this the branch loop indexes an empty array of
  // primaries and takes the whole generator down with it.
  if (count <= 0) return plan;
  const seed = rng.int(1, 1 << 28);
  const w = bounds.x1 - bounds.x0;
  const h = bounds.y1 - bounds.y0;

  const primaries: Pt[][] = [];
  for (let r = 0; r < count; r++) {
    // Alternate the dominant axis so the network actually crosses itself
    // rather than becoming a bundle of parallel lines.
    const horizontal = r % 2 === 0;
    const span = horizontal ? w : h;
    const across = horizontal ? h : w;
    const lane = (horizontal ? bounds.y0 : bounds.x0) + across * rng.range(0.18, 0.82);

    const control: Pt[] = [];
    // Eleven segments rather than five. Five control points can only really
    // bend once, and one bend across a hundred and sixty tiles is a straight
    // road with a kink in it; and the correction below needs somewhere to
    // live, because Chaikin damps anything shorter than its control spacing.
    const steps = 11;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const along = (horizontal ? bounds.x0 : bounds.y0) + span * t;
      // Noise displaces the lane sideways; the envelope pins both ends so a
      // road still arrives at the edge it set out for.
      //
      // The contrast stretch is not cosmetic. Value noise is an average of
      // corner samples and piles up around the middle of its range, so `fbm -
      // 0.5` yields about +/-0.15 rather than the +/-0.5 the amplitude below
      // reads as - which made every road wander a third as far as intended.
      // Measured before it was added: the depot carried a 72-tile dead
      // straight road across a 132-tile map, a 144-metre firing lane, on a
      // location whose entire character is that no range is extreme. The same
      // mistake, made independently, flattened the border bands.
      const raw = fbm(t * 3, r * 5.7, 8, 2, seed + r * 313);
      const n = Math.max(0, Math.min(1, (raw - 0.5) * 2.6 + 0.5));
      const envelope = Math.sin(Math.PI * t);

      // A second, shorter-wavelength term. The long bend alone is not enough:
      // a road two tiles either side of its centre only has to stay within two
      // tiles of a given row to fill that row for its whole length, and a
      // gentle curve does exactly that - the depot still carried a 53-tile
      // straight run with the long bend fixed. This keeps the centre moving,
      // at an amplitude small enough to read as a road following the ground
      // rather than as a wiggle.
      const detailRaw = fbm(t * 11, r * 3.1 + 40, 8, 2, seed + r * 751);
      const detail = Math.max(0, Math.min(1, (detailRaw - 0.5) * 2.6 + 0.5));

      const off = lane + ((n - 0.5) * 0.5 + (detail - 0.5) * 0.13) * across * envelope;
      control.push(horizontal ? { x: along, y: off } : { x: off, y: along });
    }

    const path = resample(smooth(control, 2));
    primaries.push(path);
    stamp(map, path, rng.chance(0.4) ? 2 : 1, plan.corridors);
    for (let i = 0; i < path.length; i += 24) plan.spine.push(path[i]);
  }

  // Branches. Half of them run until they meet another road; the rest stop
  // dead in a parking bay, because a site where every route goes somewhere is
  // a site with no bad decisions available.
  const branches = count + rng.int(1, 3);
  for (let b = 0; b < branches; b++) {
    const from = primaries[rng.int(0, primaries.length - 1)];
    const at = from[rng.int(Math.floor(from.length * 0.15), Math.floor(from.length * 0.85))];
    const angle = rng.range(0, Math.PI * 2);
    const length = rng.range(10, Math.min(w, h) * 0.45);

    const control: Pt[] = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const drift = (fbm(t * 2.5, b * 11.1, 8, 2, seed + b * 577) - 0.5) * length * 0.5;
      const a = angle + drift * 0.06;
      control.push({
        x: clampTo(at.x + Math.cos(a) * length * t, bounds.x0, bounds.x1),
        y: clampTo(at.y + Math.sin(a) * length * t, bounds.y0, bounds.y1),
      });
    }
    const path = resample(smooth(control, 2));
    stamp(map, path, 1, plan.corridors);
    if (b % 2 === 0) parkingBay(map, rng, path[path.length - 1], plan.corridors);
  }

  return plan;
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
