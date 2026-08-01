/**
 * Pool - fixed-capacity object pool.
 *
 * Mobile GC pauses are the single biggest cause of frame spikes in a JS game.
 * Bullets, particles, decals, casings and sound events all come from pools with
 * a hard ceiling, so steady-state gameplay allocates nothing.
 */
export class Pool<T> {
  private readonly items: T[] = [];
  private readonly reset: (item: T) => void;
  private cursor = 0;

  constructor(factory: () => T, reset: (item: T) => void, capacity: number) {
    this.reset = reset;
    for (let i = 0; i < capacity; i++) this.items.push(factory());
  }

  /** Take an object, or undefined when exhausted. */
  acquire(): T | undefined {
    if (this.cursor >= this.items.length) return undefined;
    return this.items[this.cursor++];
  }

  /**
   * Take an object, recycling the oldest live one when exhausted.
   * Correct for purely cosmetic effects where dropping a particle is worse
   * than replacing the oldest.
   */
  acquireForced(): T {
    const item = this.acquire();
    if (item) return item;
    const recycled = this.items[0];
    this.reset(recycled);
    return recycled;
  }

  /**
   * Release by swapping with the last live element. O(1), but callers must
   * iterate live items backwards so the swap does not skip an entry.
   */
  releaseAt(index: number): void {
    const last = this.cursor - 1;
    if (index < 0 || index > last) return;
    const tmp = this.items[index];
    this.items[index] = this.items[last];
    this.items[last] = tmp;
    this.reset(tmp);
    this.cursor--;
  }

  releaseAll(): void {
    for (let i = 0; i < this.cursor; i++) this.reset(this.items[i]);
    this.cursor = 0;
  }

  /** Number of live objects. Iterate `0 .. active-1` via `get()`. */
  get active(): number {
    return this.cursor;
  }

  get capacity(): number {
    return this.items.length;
  }

  get(index: number): T {
    return this.items[index];
  }
}
