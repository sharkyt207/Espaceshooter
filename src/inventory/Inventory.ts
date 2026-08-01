import { ItemDB } from '../data/ItemDatabase';
import type { BodyPart, EquipSlot, ItemDef } from '../data/ItemTypes';
import { GridContainer, containerFor, syncContainer } from './GridContainer';
import { defOf, forEachNested, stackWeight, type ItemStack } from './ItemStack';

/**
 * Inventory - a character's complete carried state.
 *
 * Layout mirrors how a real kit is organised, because that is what makes the
 * weight and access trade-offs legible:
 *
 *   pockets  - four cells, always reachable, survive nothing
 *   rig      - combat load: magazines and medical, reachable in a fight
 *   backpack - bulk loot, big and heavy, the first thing you drop
 *   secure   - the only container that survives death
 *
 * The class also derives the aggregate stats other systems read every tick:
 * total weight, armour coverage and the ergonomics penalty applied to weapon
 * handling. Those are cached and recomputed only when the loadout changes.
 */

export const EQUIP_SLOTS: readonly EquipSlot[] = [
  'primary', 'secondary', 'sidearm', 'armor', 'helmet', 'rig', 'backpack', 'secure',
];

export const EQUIP_SLOT_LABEL: Record<EquipSlot, string> = {
  primary: 'Primärwaffe',
  secondary: 'Sekundärwaffe',
  sidearm: 'Faustfeuerwaffe',
  armor: 'Schutzweste',
  helmet: 'Kopfschutz',
  rig: 'Trageweste',
  backpack: 'Rucksack',
  secure: 'Sicherheitsbehälter',
};

/** Which item categories may occupy each equipment slot. */
const SLOT_CATEGORIES: Record<EquipSlot, string[]> = {
  primary: ['weapon'],
  secondary: ['weapon'],
  sidearm: ['weapon'],
  armor: ['armor'],
  helmet: ['helmet'],
  rig: ['rig'],
  backpack: ['backpack'],
  secure: ['secure'],
};

export interface DerivedStats {
  /** Total carried mass in kg. */
  weight: number;
  /** Sum of ergonomics penalties from armour and rigs, in seconds. */
  ergonomicsPenalty: number;
  /** Multiplicative movement speed factor from worn gear. */
  speedFactor: number;
  /** Multiplicative turn speed factor. */
  turnFactor: number;
  /** Multiplier on hearing range; helmets muffle. */
  hearingFactor: number;
}

export class Inventory {
  /** Small always-available grid. Two rows of two, like chest pockets. */
  readonly pockets = new GridContainer(4, 1);

  readonly equipped: Partial<Record<EquipSlot, ItemStack>> = {};

  private statsDirty = true;
  private cachedStats: DerivedStats = {
    weight: 0, ergonomicsPenalty: 0, speedFactor: 1, turnFactor: 1, hearingFactor: 1,
  };

  /** Grid views over equipped containers, rebuilt when the slot changes. */
  private gridCache = new Map<EquipSlot, GridContainer>();

  markDirty(): void {
    this.statsDirty = true;
  }

  // --- equipping -----------------------------------------------------------

  canEquip(slot: EquipSlot, stack: ItemStack): boolean {
    const def = defOf(stack);
    const allowed = SLOT_CATEGORIES[slot];
    if (!allowed.includes(def.category)) return false;
    // A rig with integrated plates occupies the armour slot too - you cannot
    // wear a plate carrier under an armoured rig.
    if (slot === 'armor' && this.equipped.rig && defOf(this.equipped.rig).armor) return false;
    if (slot === 'rig' && def.armor && this.equipped.armor) return false;
    return true;
  }

  /** Equip into a slot, returning whatever was displaced. */
  equip(slot: EquipSlot, stack: ItemStack): ItemStack | null {
    const previous = this.equipped[slot] ?? null;
    this.equipped[slot] = stack;
    this.gridCache.delete(slot);
    this.statsDirty = true;
    return previous;
  }

  unequip(slot: EquipSlot): ItemStack | null {
    const stack = this.equipped[slot] ?? null;
    if (stack) {
      // Persist grid contents back onto the item before it leaves the slot.
      const grid = this.gridCache.get(slot);
      if (grid) syncContainer(stack, grid);
    }
    delete this.equipped[slot];
    this.gridCache.delete(slot);
    this.statsDirty = true;
    return stack;
  }

  /** Grid view of an equipped container slot, or null if nothing is worn. */
  gridFor(slot: EquipSlot): GridContainer | null {
    const cached = this.gridCache.get(slot);
    if (cached) return cached;
    const stack = this.equipped[slot];
    if (!stack) return null;
    const grid = containerFor(stack);
    if (!grid) return null;
    this.gridCache.set(slot, grid);
    return grid;
  }

  /** Flush every cached grid back onto its item. Call before saving. */
  syncAll(): void {
    for (const [slot, grid] of this.gridCache) {
      const stack = this.equipped[slot];
      if (stack) syncContainer(stack, grid);
    }
  }

  // --- storage -------------------------------------------------------------

  /**
   * Put an item wherever it fits, preferring the containers a player would
   * actually reach for: pockets for small items, then rig, then backpack.
   * Returns true when the whole stack was stored.
   */
  store(stack: ItemStack): boolean {
    const targets: (GridContainer | null)[] = [
      this.pockets,
      this.gridFor('rig'),
      this.gridFor('backpack'),
      this.gridFor('secure'),
    ];
    for (const grid of targets) {
      if (!grid) continue;
      if (grid.add(stack) === 0) {
        this.statsDirty = true;
        return true;
      }
    }
    return false;
  }

  /** Store specifically in the secure container - never lost on death. */
  storeSecure(stack: ItemStack): boolean {
    const grid = this.gridFor('secure');
    if (!grid) return false;
    const left = grid.add(stack);
    if (left === 0) {
      this.statsDirty = true;
      return true;
    }
    return false;
  }

  /** Every grid the character is carrying, in access order. */
  allGrids(): { slot: EquipSlot | 'pockets'; grid: GridContainer }[] {
    const out: { slot: EquipSlot | 'pockets'; grid: GridContainer }[] = [
      { slot: 'pockets', grid: this.pockets },
    ];
    for (const slot of ['rig', 'backpack', 'secure'] as EquipSlot[]) {
      const grid = this.gridFor(slot);
      if (grid) out.push({ slot, grid });
    }
    return out;
  }

  /** Count of a definition across pockets, rig and backpack (not secure). */
  countAvailable(defId: string): number {
    let n = this.pockets.countOf(defId);
    for (const slot of ['rig', 'backpack'] as EquipSlot[]) {
      const grid = this.gridFor(slot);
      if (grid) n += grid.countOf(defId);
    }
    return n;
  }

  /** Consume from the fastest-to-reach container first. */
  consume(defId: string, count: number): number {
    let taken = this.pockets.consume(defId, count);
    for (const slot of ['rig', 'backpack', 'secure'] as EquipSlot[]) {
      if (taken >= count) break;
      const grid = this.gridFor(slot);
      if (grid) taken += grid.consume(defId, count - taken);
    }
    if (taken > 0) this.statsDirty = true;
    return taken;
  }

  /**
   * Find the first stack matching a predicate anywhere on the character,
   * including nested items. Used by quests and by the "do I have a bandage"
   * check that drives the quick-heal button.
   */
  findStack(predicate: (stack: ItemStack, def: ItemDef) => boolean): ItemStack | null {
    let found: ItemStack | null = null;
    const visit = (stack: ItemStack): void => {
      if (found) return;
      forEachNested(stack, (s) => {
        if (found) return;
        if (predicate(s, defOf(s))) found = s;
      });
    };
    for (const slot of EQUIP_SLOTS) {
      const equipped = this.equipped[slot];
      if (equipped) visit(equipped);
      if (found) return found;
    }
    for (const { grid } of this.allGrids()) {
      for (const stack of grid.items()) {
        visit(stack);
        if (found) return found;
      }
    }
    return found;
  }

  /** Remove a stack by id from wherever it lives on the character. */
  removeStack(stackId: number): ItemStack | null {
    const direct = this.pockets.remove(stackId);
    if (direct) {
      this.statsDirty = true;
      return direct;
    }
    for (const slot of ['rig', 'backpack', 'secure'] as EquipSlot[]) {
      const grid = this.gridFor(slot);
      const removed = grid?.remove(stackId);
      if (removed) {
        this.statsDirty = true;
        return removed;
      }
    }
    for (const slot of EQUIP_SLOTS) {
      if (this.equipped[slot]?.id === stackId) return this.unequip(slot);
    }
    return null;
  }

  // --- derived stats -------------------------------------------------------

  get stats(): DerivedStats {
    if (this.statsDirty) this.recomputeStats();
    return this.cachedStats;
  }

  private recomputeStats(): void {
    let weight = 0;
    let ergo = 0;
    let speed = 1;
    let turn = 1;
    let hearing = 1;

    weight += this.pockets.weight();

    for (const slot of EQUIP_SLOTS) {
      const stack = this.equipped[slot];
      if (!stack) continue;
      const def = defOf(stack);
      // Containers are weighed through their live grid so an item picked up
      // this frame counts immediately.
      const grid = this.gridCache.get(slot);
      weight += grid ? def.weight + grid.weight() : stackWeight(stack);

      const armor = def.armor;
      if (armor) {
        ergo += armor.ergonomicsPenalty;
        speed *= armor.speedPenalty;
        turn *= armor.turnPenalty;
        hearing *= armor.hearingPenalty;
      }
    }

    this.cachedStats.weight = weight;
    this.cachedStats.ergonomicsPenalty = ergo;
    this.cachedStats.speedFactor = speed;
    this.cachedStats.turnFactor = turn;
    this.cachedStats.hearingFactor = hearing;
    this.statsDirty = false;
  }

  /**
   * The armour piece protecting a body part, if any.
   * Checked on every hit, so it walks a fixed three-slot list rather than
   * searching the whole loadout.
   */
  armorFor(part: BodyPart): { stack: ItemStack; def: ItemDef } | null {
    const candidates: EquipSlot[] = part === 'head' ? ['helmet'] : ['armor', 'rig'];
    for (const slot of candidates) {
      const stack = this.equipped[slot];
      if (!stack) continue;
      const def = defOf(stack);
      if (!def.armor) continue;
      if (!def.armor.covers.includes(part)) continue;
      // Fully destroyed plates stop protecting.
      if ((stack.durability ?? 0) <= 0) continue;
      return { stack, def };
    }
    return null;
  }

  /** Everything that would be lost on death (i.e. not in the secure container). */
  losableItems(): ItemStack[] {
    const out: ItemStack[] = [];
    for (const slot of EQUIP_SLOTS) {
      if (slot === 'secure') continue;
      const stack = this.equipped[slot];
      if (stack) out.push(stack);
    }
    out.push(...this.pockets.items());
    return out;
  }

  /** Drop everything except the secure container - the death penalty. */
  stripOnDeath(): ItemStack[] {
    const lost = this.losableItems();
    for (const slot of EQUIP_SLOTS) {
      if (slot === 'secure') continue;
      this.unequip(slot);
    }
    this.pockets.clear();
    this.statsDirty = true;
    return lost;
  }

  /** Total trader value of everything carried - shown on the results screen. */
  totalWeight(): number {
    return this.stats.weight;
  }

  /** Convenience: currently held primary/secondary/sidearm in cycle order. */
  weapons(): { slot: EquipSlot; stack: ItemStack }[] {
    const out: { slot: EquipSlot; stack: ItemStack }[] = [];
    for (const slot of ['primary', 'secondary', 'sidearm'] as EquipSlot[]) {
      const stack = this.equipped[slot];
      if (stack && ItemDB.get(stack.defId).weapon) out.push({ slot, stack });
    }
    return out;
  }
}
