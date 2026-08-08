import { nextItemId } from '../core/Ids';
import { ItemDB } from '../data/ItemDatabase';
import type { AttachmentSlot, ItemDef } from '../data/ItemTypes';

/**
 * ItemStack - a concrete instance of an item in the world.
 *
 * Definitions are shared and immutable; stacks hold everything that varies per
 * instance. Composition is by nesting rather than by id references (a weapon
 * *contains* its magazine, a rig *contains* its grid) because that makes
 * moving, dropping, serialising and looting a single recursive operation - no
 * dangling references to reconcile when a player dies mid-transfer.
 */

export interface GridSlotState {
  stack: ItemStack;
  x: number;
  y: number;
  rotated: boolean;
}

export interface ItemStack {
  /** Unique instance handle. */
  id: number;
  defId: string;
  /** For stackable items; always 1 otherwise. */
  count: number;

  /**
   * Condition. Weapons use 0-100 (percent). Armour uses absolute durability
   * points from its definition. Undefined for items without durability.
   */
  durability?: number;

  /** Remaining uses for medical items. */
  charges?: number;

  /** Remaining uses for keys; -1 means unlimited. */
  keyUses?: number;

  // --- magazine -----------------------------------------------------------
  /**
   * Loaded rounds as ammo definition ids, index 0 = first to be fed.
   * Storing each round individually is what allows mixed loading (every fifth
   * round a tracer) and makes "unload one round" trivial.
   */
  rounds?: string[];

  // --- weapon -------------------------------------------------------------
  /** Round currently in the chamber, or null. */
  chamber?: string | null;
  /** Fitted magazine, or null. */
  magazine?: ItemStack | null;
  /** Fitted attachments by slot. */
  attachments?: Partial<Record<AttachmentSlot, ItemStack>>;
  /** Selected fire mode index into the weapon's fireModes. */
  fireModeIndex?: number;
  /** True when the action is fouled and needs clearing. */
  jammed?: boolean;

  // --- containers ---------------------------------------------------------
  /** Contents for rigs, backpacks and secure containers. */
  contents?: GridSlotState[];

  /** Marks loot the player has not yet seen, for the "new" badge in the UI. */
  fresh?: boolean;
}

/** Create a fresh instance of an item, fully initialised for its category. */
export function createStack(defId: string, count = 1): ItemStack {
  const def = ItemDB.get(defId);
  const stack: ItemStack = {
    id: nextItemId(),
    defId,
    count: def.stackable ? Math.min(count, def.maxStack) : 1,
  };

  if (def.hasDurability) {
    stack.durability = def.armor ? def.armor.maxDurability : 100;
  }
  if (def.med) stack.charges = def.med.maxCharges;
  if (def.key) stack.keyUses = def.key.uses;
  if (def.magazine) stack.rounds = [];
  if (def.weapon) {
    stack.chamber = null;
    stack.magazine = null;
    stack.attachments = {};
    stack.fireModeIndex = 0;
    stack.jammed = false;
  }
  if (def.container) stack.contents = [];

  return stack;
}

/** Definition for a stack. */
export function defOf(stack: ItemStack): ItemDef {
  return ItemDB.get(stack.defId);
}

/**
 * Total weight of a stack including everything nested inside it.
 * Called every frame by the movement system, so it is written to avoid
 * allocation and to short-circuit on simple items.
 */
export function stackWeight(stack: ItemStack): number {
  const def = ItemDB.get(stack.defId);
  let w = def.weight * stack.count;

  if (stack.rounds && stack.rounds.length > 0) {
    for (let i = 0; i < stack.rounds.length; i++) {
      const ammoDef = ItemDB.tryGet(stack.rounds[i]);
      if (ammoDef) w += ammoDef.weight;
    }
  }
  if (stack.chamber) {
    const ammoDef = ItemDB.tryGet(stack.chamber);
    if (ammoDef) w += ammoDef.weight;
  }
  if (stack.magazine) w += stackWeight(stack.magazine);
  if (stack.attachments) {
    for (const key of Object.keys(stack.attachments) as AttachmentSlot[]) {
      const att = stack.attachments[key];
      if (att) w += stackWeight(att);
    }
  }
  if (stack.contents) {
    for (let i = 0; i < stack.contents.length; i++) w += stackWeight(stack.contents[i].stack);
  }
  return w;
}

/**
 * Trader value of a stack, including contents and wear.
 * Worn gear is worth less; a loaded magazine is worth its rounds.
 */
export function stackValue(stack: ItemStack): number {
  const def = ItemDB.get(stack.defId);
  let value = def.basePrice * stack.count;

  if (def.hasDurability && stack.durability !== undefined) {
    const max = def.armor ? def.armor.maxDurability : 100;
    // Value falls off faster than condition: nobody pays full price for a
    // rifle at 40%, but a scratched one is nearly as good.
    const ratio = max > 0 ? stack.durability / max : 1;
    value *= 0.35 + 0.65 * ratio * ratio;
  }
  if (def.med && stack.charges !== undefined && def.med.maxCharges > 0) {
    value *= 0.2 + 0.8 * (stack.charges / def.med.maxCharges);
  }
  if (stack.rounds) {
    for (const r of stack.rounds) value += ItemDB.tryGet(r)?.basePrice ?? 0;
  }
  if (stack.chamber) value += ItemDB.tryGet(stack.chamber)?.basePrice ?? 0;
  if (stack.magazine) value += stackValue(stack.magazine);
  if (stack.attachments) {
    for (const key of Object.keys(stack.attachments) as AttachmentSlot[]) {
      const att = stack.attachments[key];
      if (att) value += stackValue(att);
    }
  }
  if (stack.contents) {
    for (const slot of stack.contents) value += stackValue(slot.stack);
  }
  return Math.round(value);
}

/** Footprint, honouring rotation. */
export function stackSize(stack: ItemStack, rotated: boolean): { w: number; h: number } {
  const def = ItemDB.get(stack.defId);
  return rotated ? { w: def.height, h: def.width } : { w: def.width, h: def.height };
}

/** True when `b` can merge into `a` (same def, both stackable, room left). */
export function canMerge(a: ItemStack, b: ItemStack): boolean {
  if (a.defId !== b.defId) return false;
  const def = ItemDB.get(a.defId);
  if (!def.stackable) return false;
  return a.count < def.maxStack;
}

/**
 * Merge `from` into `to` up to the stack limit.
 * Returns how many units moved; `from.count` is reduced accordingly.
 */
export function mergeStacks(to: ItemStack, from: ItemStack): number {
  if (!canMerge(to, from)) return 0;
  const def = ItemDB.get(to.defId);
  const room = def.maxStack - to.count;
  const moved = Math.min(room, from.count);
  to.count += moved;
  from.count -= moved;
  return moved;
}

/** Split `count` units off a stack into a new instance. */
export function splitStack(stack: ItemStack, count: number): ItemStack | null {
  if (count <= 0 || count >= stack.count) return null;
  const copy = createStack(stack.defId, count);
  stack.count -= count;
  return copy;
}

/** Deep clone - used when a trader sells, and when insurance returns gear. */
export function cloneStack(stack: ItemStack): ItemStack {
  const copy: ItemStack = {
    ...stack,
    id: nextItemId(),
    rounds: stack.rounds ? [...stack.rounds] : undefined,
    magazine: stack.magazine ? cloneStack(stack.magazine) : stack.magazine,
    attachments: undefined,
    contents: undefined,
  };
  if (stack.attachments) {
    copy.attachments = {};
    for (const key of Object.keys(stack.attachments) as AttachmentSlot[]) {
      const att = stack.attachments[key];
      if (att) copy.attachments[key] = cloneStack(att);
    }
  }
  if (stack.contents) {
    copy.contents = stack.contents.map((s) => ({
      stack: cloneStack(s.stack),
      x: s.x,
      y: s.y,
      rotated: s.rotated,
    }));
  }
  return copy;
}

/**
 * Walk a stack and everything nested inside it.
 * Used by quest checks ("do you have the sample anywhere?") and by the
 * insurance system when deciding what came back.
 */
export function forEachNested(stack: ItemStack, visit: (s: ItemStack, depth: number) => void, depth = 0): void {
  visit(stack, depth);
  if (stack.magazine) forEachNested(stack.magazine, visit, depth + 1);
  if (stack.attachments) {
    for (const key of Object.keys(stack.attachments) as AttachmentSlot[]) {
      const att = stack.attachments[key];
      if (att) forEachNested(att, visit, depth + 1);
    }
  }
  if (stack.contents) {
    for (const slot of stack.contents) forEachNested(slot.stack, visit, depth + 1);
  }
}

/** Human-readable condition label for the UI. */
export function conditionLabel(stack: ItemStack): string | null {
  const def = ItemDB.get(stack.defId);
  if (!def.hasDurability || stack.durability === undefined) return null;
  const max = def.armor ? def.armor.maxDurability : 100;
  const pct = max > 0 ? (stack.durability / max) * 100 : 100;
  if (pct >= 90) return 'Neuwertig';
  if (pct >= 70) return 'Gut';
  if (pct >= 45) return 'Gebraucht';
  if (pct >= 20) return 'Abgenutzt';
  return 'Defekt';
}
