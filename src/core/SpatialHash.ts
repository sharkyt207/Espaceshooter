import { distanceSq } from './Math2D';

/**
 * SpatialHash - uniform grid broad-phase for entity queries.
 *
 * Used for "which actors are near this explosion / bullet / sound", replacing
 * O(n^2) scans. Backed by flat typed arrays and rebuilt each tick: with a few
 * hundred actors, rebuilding is cheaper and far more cache-friendly than
 * incremental bucket maintenance, and it allocates nothing per frame.
 */
export class SpatialHash {
  private readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly originX: number;
  private readonly originY: number;

  /** cellStart[c] .. cellStart[c+1] indexes into `entries`. Counting sort layout. */
  private readonly cellCount: Int32Array;
  private readonly cellStart: Int32Array;
  private readonly entries: Int32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;

  private count = 0;

  constructor(worldWidth: number, worldHeight: number, cellSize: number, maxEntities: number) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
    this.originX = 0;
    this.originY = 0;
    this.cols = Math.max(1, Math.ceil(worldWidth * this.invCellSize));
    this.rows = Math.max(1, Math.ceil(worldHeight * this.invCellSize));
    const cells = this.cols * this.rows;
    this.cellCount = new Int32Array(cells);
    this.cellStart = new Int32Array(cells + 1);
    this.entries = new Int32Array(maxEntities);
    this.px = new Float32Array(maxEntities);
    this.py = new Float32Array(maxEntities);
  }

  /** Begin a rebuild. Call once per tick before inserting. */
  begin(): void {
    this.count = 0;
    this.cellCount.fill(0);
  }

  /** Stage an entity. `id` is any caller-defined integer handle. */
  insert(id: number, x: number, y: number): void {
    if (this.count >= this.entries.length) return;
    const i = this.count++;
    this.entries[i] = id;
    this.px[i] = x;
    this.py[i] = y;
    this.cellCount[this.cellIndex(x, y)]++;
  }

  /** Finalize the counting sort. Must be called before querying. */
  build(): void {
    // Prefix sum -> bucket offsets.
    let running = 0;
    for (let c = 0; c < this.cellCount.length; c++) {
      this.cellStart[c] = running;
      running += this.cellCount[c];
    }
    this.cellStart[this.cellCount.length] = running;

    // Scatter into sorted order using a temp cursor per cell (reuse cellCount).
    const cursor = this.cellCount;
    const sortedIds = this.scratchIds ?? (this.scratchIds = new Int32Array(this.entries.length));
    const sortedX = this.scratchX ?? (this.scratchX = new Float32Array(this.entries.length));
    const sortedY = this.scratchY ?? (this.scratchY = new Float32Array(this.entries.length));
    for (let c = 0; c < cursor.length; c++) cursor[c] = this.cellStart[c];
    for (let i = 0; i < this.count; i++) {
      const c = this.cellIndex(this.px[i], this.py[i]);
      const dst = cursor[c]++;
      sortedIds[dst] = this.entries[i];
      sortedX[dst] = this.px[i];
      sortedY[dst] = this.py[i];
    }
    this.entries.set(sortedIds.subarray(0, this.count));
    this.px.set(sortedX.subarray(0, this.count));
    this.py.set(sortedY.subarray(0, this.count));
  }

  private scratchIds: Int32Array | null = null;
  private scratchX: Float32Array | null = null;
  private scratchY: Float32Array | null = null;

  /**
   * Collect entity ids whose stored position lies within `radius` of (x, y).
   * Results are appended to `out` (cleared first); returns the count.
   */
  queryRadius(x: number, y: number, radius: number, out: number[]): number {
    out.length = 0;
    const r2 = radius * radius;
    const minCx = this.clampCol(Math.floor((x - radius - this.originX) * this.invCellSize));
    const maxCx = this.clampCol(Math.floor((x + radius - this.originX) * this.invCellSize));
    const minCy = this.clampRow(Math.floor((y - radius - this.originY) * this.invCellSize));
    const maxCy = this.clampRow(Math.floor((y + radius - this.originY) * this.invCellSize));

    for (let cy = minCy; cy <= maxCy; cy++) {
      const rowBase = cy * this.cols;
      for (let cx = minCx; cx <= maxCx; cx++) {
        const c = rowBase + cx;
        const start = this.cellStart[c];
        const end = this.cellStart[c + 1];
        for (let i = start; i < end; i++) {
          if (distanceSq(x, y, this.px[i], this.py[i]) <= r2) out.push(this.entries[i]);
        }
      }
    }
    return out.length;
  }

  private cellIndex(x: number, y: number): number {
    const cx = this.clampCol(Math.floor((x - this.originX) * this.invCellSize));
    const cy = this.clampRow(Math.floor((y - this.originY) * this.invCellSize));
    return cy * this.cols + cx;
  }

  private clampCol(c: number): number {
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private clampRow(r: number): number {
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  get cellSizeWorld(): number {
    return this.cellSize;
  }
}
