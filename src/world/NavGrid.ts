import { TileMap, Tile } from './TileMap';

/**
 * NavGrid - navigation for every AI on the map.
 *
 * Two complementary tools, because they solve different problems:
 *
 *  - **A\*** for individual, arbitrary destinations (go to that cover, go
 *    investigate that noise). Costly, so requests are queued and budgeted per
 *    tick - a phone cannot afford twenty simultaneous searches.
 *  - **Flow field** for "everyone move towards the player". One breadth-first
 *    pass produces a direction for every tile on the map, which any number of
 *    AI can then read for free. This is what keeps a 30-AI raid at 60 FPS.
 *
 * Everything is backed by typed arrays sized once at map load.
 */

const SQRT2 = Math.SQRT2;

/** Neighbour offsets: 4 cardinal first (cheaper), then 4 diagonal. */
const NX = [0, 1, 0, -1, 1, 1, -1, -1];
const NY = [-1, 0, 1, 0, -1, 1, 1, -1];
const NCOST = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];

export interface PathResult {
  /** World-space waypoints, already smoothed. Empty when unreachable. */
  points: { x: number; y: number }[];
  found: boolean;
}

export class NavGrid {
  readonly width: number;
  readonly height: number;
  private readonly map: TileMap;

  /** Per-tile traversal cost; Infinity means blocked. */
  private readonly cost: Float32Array;

  // --- A* working set (reused across searches, never reallocated) ----------
  private readonly gScore: Float32Array;
  private readonly fScore: Float32Array;
  private readonly cameFrom: Int32Array;
  /** Search generation stamp, avoids clearing the arrays between searches. */
  private readonly visitedStamp: Int32Array;
  /**
   * Closed set, stamped the same way.
   *
   * Essential, not an optimisation: decrease-key is implemented by re-pushing,
   * so the heap holds stale duplicates whose ordering no longer matches their
   * current fScore. Without closing nodes on pop, those duplicates get
   * re-expanded and can relax their neighbours again, and the search thrashes
   * until it exhausts its node budget - reporting a perfectly reachable goal
   * as unreachable. The octile heuristic is consistent for our cost range
   * (every tile costs at least 1), so closing on first pop is also optimal.
   */
  private readonly closedStamp: Int32Array;
  private stamp = 0;
  private readonly heap: Int32Array;
  private heapSize = 0;

  // --- Flow field ---------------------------------------------------------
  private readonly flowDist: Float32Array;
  private readonly flowDir: Int8Array;
  private readonly bfsQueue: Int32Array;
  private flowTargetX = -1;
  private flowTargetY = -1;

  constructor(map: TileMap) {
    this.map = map;
    this.width = map.width;
    this.height = map.height;
    const n = map.width * map.height;
    this.cost = new Float32Array(n);
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.visitedStamp = new Int32Array(n);
    this.closedStamp = new Int32Array(n);
    // The heap must hold duplicates: this A* implements decrease-key by
    // re-pushing an improved node rather than repositioning it, so a node can
    // appear once per incoming edge. Eight-way movement bounds that at 8n.
    // Sizing it at n silently dropped pushes on a typed array and corrupted
    // the search, which showed up as unreachable-but-actually-connected goals.
    this.heap = new Int32Array(n * 8);
    this.flowDist = new Float32Array(n);
    this.flowDir = new Int8Array(n);
    this.bfsQueue = new Int32Array(n);
    this.rebuildCosts();
  }

  /** Recompute traversal costs from the tilemap. Call after doors change. */
  rebuildCosts(): void {
    const { map } = this;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        if (map.isSolid(x, y)) {
          this.cost[i] = Infinity;
        } else {
          // Water and rubble are passable but slow, so AI routes around them
          // unless the detour is long - exactly how a human would move.
          let c = map.moveCostOf(x, y);
          if (map.at(x, y) === Tile.Water) c *= 1.6;
          this.cost[i] = c;
        }
      }
    }
    // Soft-inflate obstacles: add cost next to walls so AI stops hugging
    // corners and clipping shoulders on doorframes.
    const inflated = new Float32Array(this.cost);
    for (let y = 1; y < this.height - 1; y++) {
      for (let x = 1; x < this.width - 1; x++) {
        const i = y * this.width + x;
        if (!isFinite(this.cost[i])) continue;
        let walls = 0;
        for (let k = 0; k < 8; k++) {
          if (!isFinite(this.cost[(y + NY[k]) * this.width + (x + NX[k])])) walls++;
        }
        if (walls > 0) inflated[i] = this.cost[i] + walls * 0.18;
      }
    }
    this.cost.set(inflated);
  }

  isWalkable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return isFinite(this.cost[y * this.width + x]);
  }

  // ========================================================================
  // A*
  // ========================================================================

  /**
   * Find a path in tile space. `maxNodes` bounds the search so a hopeless
   * request cannot stall a frame; on budget exhaustion we return the best
   * partial path found, which keeps AI moving in roughly the right direction.
   */
  findPath(sx: number, sy: number, tx: number, ty: number, maxNodes = 3000): PathResult {
    const startX = Math.floor(sx);
    const startY = Math.floor(sy);
    let goalX = Math.floor(tx);
    let goalY = Math.floor(ty);

    if (!this.isWalkable(goalX, goalY)) {
      const open = this.map.nearestOpen(goalX, goalY, 6);
      if (!open) return { points: [], found: false };
      goalX = open.x;
      goalY = open.y;
    }
    if (!this.isWalkable(startX, startY)) {
      const open = this.map.nearestOpen(startX, startY, 6);
      if (!open) return { points: [], found: false };
    }

    const startIdx = startY * this.width + startX;
    const goalIdx = goalY * this.width + goalX;
    if (startIdx === goalIdx) return { points: [{ x: tx, y: ty }], found: true };

    const stamp = ++this.stamp;
    this.heapSize = 0;
    this.gScore[startIdx] = 0;
    this.fScore[startIdx] = this.heuristic(startX, startY, goalX, goalY);
    this.cameFrom[startIdx] = -1;
    this.visitedStamp[startIdx] = stamp;
    this.heapPush(startIdx);

    let expanded = 0;
    let bestIdx = startIdx;
    let bestH = this.fScore[startIdx];

    while (this.heapSize > 0 && expanded < maxNodes) {
      const current = this.heapPop();
      // Stale duplicate left over from a decrease-key: already expanded.
      if (this.closedStamp[current] === stamp) continue;
      this.closedStamp[current] = stamp;

      if (current === goalIdx) return this.reconstruct(current, tx, ty);
      expanded++;

      const cx = current % this.width;
      const cy = (current / this.width) | 0;
      const g = this.gScore[current];

      for (let k = 0; k < 8; k++) {
        const nx = cx + NX[k];
        const ny = cy + NY[k];
        if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
        const ni = ny * this.width + nx;
        const tileCost = this.cost[ni];
        if (!isFinite(tileCost)) continue;
        if (this.closedStamp[ni] === stamp) continue;
        // No corner-cutting: a diagonal is only legal when both orthogonal
        // neighbours are open, otherwise AI slides through wall seams.
        if (k >= 4) {
          if (!isFinite(this.cost[cy * this.width + nx]) || !isFinite(this.cost[ny * this.width + cx])) continue;
        }

        const tentative = g + NCOST[k] * tileCost;
        if (this.visitedStamp[ni] !== stamp || tentative < this.gScore[ni]) {
          this.visitedStamp[ni] = stamp;
          this.gScore[ni] = tentative;
          const h = this.heuristic(nx, ny, goalX, goalY);
          this.fScore[ni] = tentative + h;
          this.cameFrom[ni] = current;
          this.heapPush(ni);
          if (h < bestH) {
            bestH = h;
            bestIdx = ni;
          }
        }
      }
    }

    // Budget exhausted or unreachable: hand back the closest approach so the
    // AI still commits to a direction instead of freezing.
    if (bestIdx !== startIdx) {
      const partial = this.reconstruct(bestIdx, (bestIdx % this.width) + 0.5, ((bestIdx / this.width) | 0) + 0.5);
      partial.found = false;
      return partial;
    }
    return { points: [], found: false };
  }

  /** Octile distance - the admissible heuristic for 8-way movement. */
  private heuristic(ax: number, ay: number, bx: number, by: number): number {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx;
  }

  private reconstruct(goalIdx: number, exactX: number, exactY: number): PathResult {
    const raw: number[] = [];
    let node = goalIdx;
    while (node !== -1) {
      raw.push(node);
      node = this.cameFrom[node];
    }
    raw.reverse();

    // String-pulling: drop waypoints we can walk to directly. Turns the blocky
    // grid path into a natural-looking route and cuts steering jitter.
    const points: { x: number; y: number }[] = [];
    let anchor = 0;
    points.push(this.tileCenter(raw[0]));
    while (anchor < raw.length - 1) {
      let farthest = anchor + 1;
      for (let probe = raw.length - 1; probe > anchor; probe--) {
        const a = this.tileCenter(raw[anchor]);
        const b = this.tileCenter(raw[probe]);
        if (this.hasClearWalk(a.x, a.y, b.x, b.y)) {
          farthest = probe;
          break;
        }
      }
      points.push(this.tileCenter(raw[farthest]));
      anchor = farthest;
    }
    // Replace the final waypoint with the caller's exact target.
    points[points.length - 1] = { x: exactX, y: exactY };
    if (points.length > 1) points.shift(); // drop the tile we are standing on
    return { points, found: true };
  }

  private tileCenter(idx: number): { x: number; y: number } {
    return { x: (idx % this.width) + 0.5, y: ((idx / this.width) | 0) + 0.5 };
  }

  /**
   * Conservative walkability test between two world points. Samples along the
   * segment with a body-radius offset so we never smooth a path through a gap
   * narrower than an actor.
   */
  hasClearWalk(ax: number, ay: number, bx: number, by: number, radius = 0.32): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-4) return true;
    const nx = -dy / dist;
    const ny = dx / dist;
    const steps = Math.ceil(dist * 3);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = ax + dx * t;
      const py = ay + dy * t;
      // Centre plus both shoulders.
      if (this.map.isSolidAt(px, py)) return false;
      if (this.map.isSolidAt(px + nx * radius, py + ny * radius)) return false;
      if (this.map.isSolidAt(px - nx * radius, py - ny * radius)) return false;
    }
    return true;
  }

  // --- binary min-heap keyed on fScore ------------------------------------

  private heapPush(idx: number): void {
    // Defensive: never write past the buffer. Dropping a push degrades the
    // search to a worse path, whereas an out-of-range write on a typed array
    // is a no-op that corrupts the heap invariant.
    if (this.heapSize >= this.heap.length) return;
    let i = this.heapSize++;
    this.heap[i] = idx;
    const f = this.fScore[idx];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.fScore[this.heap[parent]] <= f) break;
      this.heap[i] = this.heap[parent];
      i = parent;
    }
    this.heap[i] = idx;
  }

  private heapPop(): number {
    const top = this.heap[0];
    const last = this.heap[--this.heapSize];
    if (this.heapSize > 0) {
      let i = 0;
      const f = this.fScore[last];
      for (;;) {
        const l = 2 * i + 1;
        if (l >= this.heapSize) break;
        const r = l + 1;
        const child = r < this.heapSize && this.fScore[this.heap[r]] < this.fScore[this.heap[l]] ? r : l;
        if (this.fScore[this.heap[child]] >= f) break;
        this.heap[i] = this.heap[child];
        i = child;
      }
      this.heap[i] = last;
    }
    return top;
  }

  // ========================================================================
  // Flow field
  // ========================================================================

  /**
   * Rebuild the shared flow field towards (tx, ty) using Dijkstra on the cost
   * grid. Skipped when the target has not moved a tile since the last build -
   * a player standing still costs nothing.
   */
  buildFlowField(tx: number, ty: number, force = false): boolean {
    const gx = Math.floor(tx);
    const gy = Math.floor(ty);
    if (!force && gx === this.flowTargetX && gy === this.flowTargetY) return false;
    if (!this.isWalkable(gx, gy)) {
      const open = this.map.nearestOpen(gx, gy, 8);
      if (!open) return false;
      return this.buildFlowFieldAt(open.x, open.y);
    }
    return this.buildFlowFieldAt(gx, gy);
  }

  private buildFlowFieldAt(gx: number, gy: number): boolean {
    this.flowTargetX = gx;
    this.flowTargetY = gy;
    this.flowDist.fill(Infinity);
    this.flowDir.fill(-1);

    // Cost-aware BFS. With integer-ish costs a simple queue with relaxation
    // converges quickly and avoids a second heap allocation.
    let head = 0;
    let tail = 0;
    const start = gy * this.width + gx;
    this.flowDist[start] = 0;
    this.bfsQueue[tail++] = start;

    while (head < tail) {
      const current = this.bfsQueue[head++];
      const cx = current % this.width;
      const cy = (current / this.width) | 0;
      const d = this.flowDist[current];

      for (let k = 0; k < 8; k++) {
        const nx = cx + NX[k];
        const ny = cy + NY[k];
        if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
        const ni = ny * this.width + nx;
        const c = this.cost[ni];
        if (!isFinite(c)) continue;
        if (k >= 4) {
          if (!isFinite(this.cost[cy * this.width + nx]) || !isFinite(this.cost[ny * this.width + cx])) continue;
        }
        const nd = d + NCOST[k] * c;
        if (nd < this.flowDist[ni] - 1e-4) {
          this.flowDist[ni] = nd;
          // Store the direction that points back towards the goal.
          this.flowDir[ni] = oppositeDir(k);
          if (tail < this.bfsQueue.length) this.bfsQueue[tail++] = ni;
        }
      }
    }
    return true;
  }

  /**
   * Read the flow direction at a tile into `out` as a unit vector.
   * Returns false when the tile is unreachable from the flow target.
   */
  sampleFlow(x: number, y: number, out: { x: number; y: number }): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    const dir = this.flowDir[ty * this.width + tx];
    if (dir < 0) return false;
    const dx = NX[dir];
    const dy = NY[dir];
    const len = Math.hypot(dx, dy) || 1;
    out.x = dx / len;
    out.y = dy / len;
    return true;
  }

  /** Path cost from a tile to the current flow target, or Infinity. */
  flowCostAt(x: number, y: number): number {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return Infinity;
    return this.flowDist[ty * this.width + tx];
  }
}

function oppositeDir(k: number): number {
  // cardinals 0..3 are N,E,S,W; diagonals 4..7 are NE,SE,SW,NW.
  return k < 4 ? (k + 2) % 4 : ((k - 4 + 2) % 4) + 4;
}

/**
 * CoverMap - precomputed tactical value of every tile.
 *
 * For each walkable tile we record which of the eight compass directions is
 * protected by geometry, and how tall that protection is. AI cover selection
 * then becomes a cheap lookup ("is this tile protected from the threat
 * bearing?") instead of a raycast storm every time someone takes fire.
 */
export class CoverMap {
  readonly width: number;
  readonly height: number;
  /** Bit k set = direction k is covered by something at least crouch height. */
  private readonly mask: Uint8Array;
  /** Bit k set = that cover is full standing height. */
  private readonly fullMask: Uint8Array;
  /** 0..255 general "how sheltered is this tile" score, for scoring/sorting. */
  readonly score: Uint8Array;

  constructor(map: TileMap) {
    this.width = map.width;
    this.height = map.height;
    const n = map.width * map.height;
    this.mask = new Uint8Array(n);
    this.fullMask = new Uint8Array(n);
    this.score = new Uint8Array(n);
    this.build(map);
  }

  private build(map: TileMap): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        if (map.isSolid(x, y)) continue;
        let m = 0;
        let fm = 0;
        let covered = 0;
        for (let k = 0; k < 8; k++) {
          const h = map.heightOf(x + NX[k], y + NY[k]);
          if (h >= 0.9) {
            m |= 1 << k;
            covered++;
            if (h >= 1.7) fm |= 1 << k;
          }
        }
        this.mask[i] = m;
        this.fullMask[i] = fm;
        // Best tiles are covered on 2-4 sides: sheltered, but with an exit and
        // a firing angle. Fully boxed-in tiles score poorly - that is a trap.
        const ideal = covered === 0 ? 0 : covered <= 4 ? covered * 60 : Math.max(0, 300 - covered * 45);
        this.score[i] = Math.min(255, ideal);
      }
    }
  }

  /**
   * Does the tile shelter an actor from a threat at the given bearing?
   * `dirX/dirY` points *from the tile towards the threat*.
   */
  coversFrom(x: number, y: number, dirX: number, dirY: number, requireFull = false): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    const i = y * this.width + x;
    const m = requireFull ? this.fullMask[i] : this.mask[i];
    if (m === 0) return false;
    // Accept the closest compass direction and its two neighbours: real cover
    // protects an arc, not a single ray.
    const k = dirToIndex(dirX, dirY);
    const kl = k < 4 ? (k + 3) % 4 : ((k - 4 + 3) % 4) + 4;
    const kr = k < 4 ? (k + 1) % 4 : ((k - 4 + 1) % 4) + 4;
    return (m & (1 << k)) !== 0 || (m & (1 << kl)) !== 0 || (m & (1 << kr)) !== 0;
  }

  scoreAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.score[y * this.width + x];
  }
}

/** Maps a direction vector onto the nearest of the eight neighbour indices. */
function dirToIndex(dx: number, dy: number): number {
  const ang = Math.atan2(dy, dx);
  // Neighbour order is N,E,S,W,NE,SE,SW,NW - resolve via octant then remap.
  const oct = ((Math.round((ang / (Math.PI / 4)) + 8) % 8) + 8) % 8;
  // oct 0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE
  const table = [1, 5, 2, 6, 3, 7, 0, 4];
  return table[oct];
}
