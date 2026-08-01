import { ItemDB } from '../data/ItemDatabase';
import type { ItemCategory } from '../data/ItemTypes';
import {
  canMerge,
  mergeStacks,
  stackSize,
  stackWeight,
  type GridSlotState,
  type ItemStack,
} from './ItemStack';

/**
 * GridContainer - Tetris-style spatial inventory.
 *
 * Grid inventory is not decoration: it is the mechanism that forces the core
 * risk/reward decision of the genre. A rifle takes eight cells; so do four
 * valuables. Every "do I take this?" moment on the way out of a raid comes from
 * this class.
 *
 * Occupancy is a flat Int32Array of `slotIndex + 1` (0 = free) so overlap tests
 * are O(area) with no allocation, which matters when the player is dragging an
 * item and we re-test placement every touch-move event.
 */
export class GridContainer {
  readonly width: number;
  readonly height: number;
  /** Restricts what may be stored (secure containers, ammo pouches). */
  readonly allowed?: ItemCategory[];

  readonly slots: GridSlotState[] = [];
  private occupancy: Int32Array;

  constructor(width: number, height: number, allowed?: ItemCategory[]) {
    this.width = width;
    this.height = height;
    this.allowed = allowed;
    this.occupancy = new Int32Array(width * height);
  }

  /** Rebuild the occupancy map from `slots`. Used after loading a save. */
  reindex(): void {
    this.occupancy.fill(0);
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const { w, h } = stackSize(s.stack, s.rotated);
      for (let y = s.y; y < s.y + h; y++) {
        for (let x = s.x; x < s.x + w; x++) {
          if (x < this.width && y < this.height) this.occupancy[y * this.width + x] = i + 1;
        }
      }
    }
  }

  accepts(stack: ItemStack): boolean {
    if (!this.allowed) return true;
    return this.allowed.includes(ItemDB.get(stack.defId).category);
  }

  /** Can this stack sit at (x, y) with the given rotation? */
  canPlace(stack: ItemStack, x: number, y: number, rotated: boolean, ignoreSlotIndex = -1): boolean {
    if (!this.accepts(stack)) return false;
    const { w, h } = stackSize(stack, rotated);
    if (x < 0 || y < 0 || x + w > this.width || y + h > this.height) return false;
    for (let cy = y; cy < y + h; cy++) {
      for (let cx = x; cx < x + w; cx++) {
        const occ = this.occupancy[cy * this.width + cx];
        if (occ !== 0 && occ - 1 !== ignoreSlotIndex) return false;
      }
    }
    return true;
  }

  /** Place at an explicit position. Returns false when it does not fit. */
  place(stack: ItemStack, x: number, y: number, rotated = false): boolean {
    if (!this.canPlace(stack, x, y, rotated)) return false;
    const slot: GridSlotState = { stack, x, y, rotated };
    this.slots.push(slot);
    const index = this.slots.length;
    const { w, h } = stackSize(stack, rotated);
    for (let cy = y; cy < y + h; cy++) {
      for (let cx = x; cx < x + w; cx++) {
        this.occupancy[cy * this.width + cx] = index;
      }
    }
    return true;
  }

  /**
   * First free position for a stack, trying both rotations.
   * Scans row-major so items pack towards the top-left, which reads as tidy
   * and keeps large free regions contiguous at the bottom.
   */
  findSpot(stack: ItemStack): { x: number; y: number; rotated: boolean } | null {
    const def = ItemDB.get(stack.defId);
    const rotations = def.width === def.height ? [false] : [false, true];
    for (const rotated of rotations) {
      const { w, h } = stackSize(stack, rotated);
      for (let y = 0; y + h <= this.height; y++) {
        for (let x = 0; x + w <= this.width; x++) {
          if (this.canPlace(stack, x, y, rotated)) return { x, y, rotated };
        }
      }
    }
    return null;
  }

  /**
   * Add a stack, merging into partial stacks first and then finding a free
   * spot. Returns the number of units that could NOT be stored.
   */
  add(stack: ItemStack): number {
    if (!this.accepts(stack)) return stack.count;

    const def = ItemDB.get(stack.defId);
    if (def.stackable) {
      for (const slot of this.slots) {
        if (canMerge(slot.stack, stack)) {
          mergeStacks(slot.stack, stack);
          if (stack.count === 0) return 0;
        }
      }
    }
    const spot = this.findSpot(stack);
    if (!spot) return stack.count;
    this.place(stack, spot.x, spot.y, spot.rotated);
    return 0;
  }

  /** Remove by instance id; returns the removed stack. */
  remove(stackId: number): ItemStack | null {
    const index = this.slots.findIndex((s) => s.stack.id === stackId);
    if (index < 0) return null;
    const [slot] = this.slots.splice(index, 1);
    this.reindex();
    return slot.stack;
  }

  /** The slot occupying a cell, if any. */
  slotAt(x: number, y: number): GridSlotState | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const occ = this.occupancy[y * this.width + x];
    return occ === 0 ? null : this.slots[occ - 1] ?? null;
  }

  find(stackId: number): GridSlotState | null {
    return this.slots.find((s) => s.stack.id === stackId) ?? null;
  }

  /** Total count of a definition across all slots (ignores nesting). */
  countOf(defId: string): number {
    let n = 0;
    for (const slot of this.slots) {
      if (slot.stack.defId === defId) n += slot.stack.count;
    }
    return n;
  }

  /** Consume up to `count` units of a definition. Returns how many were taken. */
  consume(defId: string, count: number): number {
    let remaining = count;
    for (let i = this.slots.length - 1; i >= 0 && remaining > 0; i--) {
      const slot = this.slots[i];
      if (slot.stack.defId !== defId) continue;
      const take = Math.min(slot.stack.count, remaining);
      slot.stack.count -= take;
      remaining -= take;
      if (slot.stack.count <= 0) this.slots.splice(i, 1);
    }
    if (remaining < count) this.reindex();
    return count - remaining;
  }

  weight(): number {
    let w = 0;
    for (const slot of this.slots) w += stackWeight(slot.stack);
    return w;
  }

  get usedCells(): number {
    let n = 0;
    for (const slot of this.slots) {
      const { w, h } = stackSize(slot.stack, slot.rotated);
      n += w * h;
    }
    return n;
  }

  get totalCells(): number {
    return this.width * this.height;
  }

  clear(): void {
    this.slots.length = 0;
    this.occupancy.fill(0);
  }

  /** Every stack in the container, ordered by placement. */
  items(): ItemStack[] {
    return this.slots.map((s) => s.stack);
  }
}

/** Build a GridContainer from a container item's definition and contents. */
export function containerFor(stack: ItemStack): GridContainer | null {
  const def = ItemDB.get(stack.defId);
  if (!def.container) return null;
  const grid = new GridContainer(def.container.gridWidth, def.container.gridHeight, def.container.allowedCategories);
  if (stack.contents) {
    // Rehydrate placements straight into the slot list, then rebuild the map.
    for (const s of stack.contents) grid.slots.push(s);
    grid.reindex();
  }
  return grid;
}

/** Write a grid's placements back onto the owning item stack. */
export function syncContainer(stack: ItemStack, grid: GridContainer): void {
  stack.contents = grid.slots;
}
