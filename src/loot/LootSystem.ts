import { nextContainerId } from '../core/Ids';
import { Rng } from '../core/Random';
import { ItemDB } from '../data/ItemDatabase';
import type { ItemDef, Rarity } from '../data/ItemTypes';
import { RARITY_ORDER } from '../data/ItemTypes';
import { GridContainer } from '../inventory/GridContainer';
import { createStack, type ItemStack } from '../inventory/ItemStack';
import { loadMagazine } from '../weapons/WeaponRuntime';
import type { LootAnchor } from '../world/MapGenerator';
import type { TileMap } from '../world/TileMap';
import { LOOT_TABLES, rarityWeightsForDanger, type LootEntry, type LootTableDef } from './LootTables';

/**
 * LootSystem - populates the world with searchable containers.
 *
 * Two rules shape everything here:
 *
 *   1. **Contents are rolled at raid start, not on open.** Two players in the
 *      same seeded raid see identical loot, and a container's value is fixed
 *      the moment the raid begins - so save-scumming an open is meaningless
 *      and the seed reproduces bugs exactly.
 *
 *   2. **Weapons spawn as complete, plausible kits.** A rifle found in a
 *      weapon crate comes with a partly-loaded magazine, sometimes an optic,
 *      and worn condition. Finding a gun should feel like finding *someone's*
 *      gun, not a catalogue entry.
 */

export interface LootContainer {
  readonly id: number;
  readonly tableId: string;
  /** Display name; dynamic events retitle containers they create. */
  name: string;
  x: number;
  y: number;
  /** Sprite archetype for the world billboard. */
  sprite: string;
  grid: GridContainer;
  /** Seconds required to search. */
  searchSeconds: number;
  /** True once the player has opened it - drives the world marker. */
  searched: boolean;
  /** Corpse containers are removed once emptied. */
  isCorpse: boolean;
  /** Locked containers need a key. */
  requiresKey?: string;
}

export class LootSystem {
  readonly containers: LootContainer[] = [];
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0x10071);
  }

  clear(): void {
    this.containers.length = 0;
  }

  /** Spawn every container described by the generated map. */
  populate(anchors: LootAnchor[], map: TileMap): void {
    for (const anchor of anchors) {
      const table = LOOT_TABLES[anchor.tableId];
      if (!table) continue;
      const zone = map.zoneAt(Math.floor(anchor.x), Math.floor(anchor.y));
      const danger = zone?.danger ?? 0.25;
      this.containers.push(this.createContainer(table, anchor.x, anchor.y, danger));
    }
  }

  /** Build a container and roll its contents. */
  createContainer(table: LootTableDef, x: number, y: number, danger: number): LootContainer {
    const grid = new GridContainer(table.gridWidth, table.gridHeight);
    const container: LootContainer = {
      id: nextContainerId(),
      tableId: table.id,
      name: table.name,
      x,
      y,
      sprite: table.sprite,
      grid,
      searchSeconds: table.searchSeconds,
      searched: false,
      isCorpse: table.id === 'corpse',
    };

    if (!this.rng.chance(table.emptyChance)) {
      const rolls = this.rng.int(table.minRolls, table.maxRolls);
      for (let i = 0; i < rolls; i++) {
        const stack = this.rollEntry(table.entries, danger);
        if (stack) grid.add(stack);
      }
    }
    return container;
  }

  /** Wrap an existing inventory (a killed actor's gear) as a lootable corpse. */
  createCorpse(x: number, y: number, name: string, items: ItemStack[]): LootContainer {
    const table = LOOT_TABLES.corpse;
    const grid = new GridContainer(table.gridWidth, table.gridHeight);
    for (const item of items) grid.add(item);
    const container: LootContainer = {
      id: nextContainerId(),
      tableId: table.id,
      name,
      x,
      y,
      sprite: 'corpse',
      grid,
      searchSeconds: table.searchSeconds,
      searched: false,
      isCorpse: true,
    };
    this.containers.push(container);
    return container;
  }

  /** Nearest unsearched container within `radius` tiles. */
  findNearest(x: number, y: number, radius: number): LootContainer | null {
    let best: LootContainer | null = null;
    let bestDistSq = radius * radius;
    for (const c of this.containers) {
      const dx = c.x - x;
      const dy = c.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        best = c;
      }
    }
    return best;
  }

  byId(id: number): LootContainer | undefined {
    return this.containers.find((c) => c.id === id);
  }

  /** Drop empty corpses so the world does not fill with empty markers. */
  prune(): void {
    for (let i = this.containers.length - 1; i >= 0; i--) {
      const c = this.containers[i];
      if (c.isCorpse && c.searched && c.grid.slots.length === 0) this.containers.splice(i, 1);
    }
  }

  // =========================================================================
  // Rolling
  // =========================================================================

  private rollEntry(entries: LootEntry[], danger: number): ItemStack | null {
    if (entries.length === 0) return null;
    const weights = entries.map((e) => e.weight);
    const entry = this.rng.weighted(entries, weights);
    if (!entry) return null;

    let def: ItemDef | undefined;
    if (entry.defId) {
      def = ItemDB.tryGet(entry.defId);
    } else if (entry.tag) {
      def = this.pickByTag(entry.tag, danger, entry.maxRarity);
    }
    if (!def) return null;

    const count = def.stackable
      ? this.rng.int(entry.min ?? 1, Math.min(def.maxStack, entry.max ?? entry.min ?? 1))
      : 1;

    return this.instantiate(def, count, danger);
  }

  /**
   * Pick an item carrying a tag, weighting by rarity band. Bands with no
   * members are skipped, so a tag with only common items still resolves.
   */
  private pickByTag(tag: string, danger: number, maxRarity?: Rarity): ItemDef | undefined {
    const pool = ItemDB.withTag(tag);
    if (pool.length === 0) return undefined;

    const cap = maxRarity ? RARITY_ORDER.indexOf(maxRarity) : RARITY_ORDER.length - 1;
    const rarityWeights = rarityWeightsForDanger(danger);

    const byRarity = new Map<Rarity, ItemDef[]>();
    for (const def of pool) {
      if (RARITY_ORDER.indexOf(def.rarity) > cap) continue;
      let list = byRarity.get(def.rarity);
      if (!list) {
        list = [];
        byRarity.set(def.rarity, list);
      }
      list.push(def);
    }
    if (byRarity.size === 0) return undefined;

    const bands = [...byRarity.keys()];
    const weights = bands.map((r) => rarityWeights[r]);
    const band = this.rng.weighted(bands, weights);
    if (!band) return undefined;
    return this.rng.pick(byRarity.get(band)!);
  }

  /**
   * Turn a definition into a believable instance: worn condition, partly
   * loaded magazines, occasional fitted attachments.
   */
  instantiate(def: ItemDef, count: number, danger: number): ItemStack {
    const stack = createStack(def.id, count);

    // Found gear is used gear. Higher-danger zones hold better-kept kit.
    if (def.hasDurability && stack.durability !== undefined) {
      const max = def.armor ? def.armor.maxDurability : 100;
      const floor = 0.32 + danger * 0.28;
      stack.durability = Math.round(max * this.rng.range(floor, 0.97) * 100) / 100;
    }

    if (def.med && stack.charges !== undefined && def.med.maxCharges > 1) {
      // Partly-used medical supplies - a full trauma kit is a real find.
      stack.charges = this.rng.int(Math.ceil(def.med.maxCharges * 0.3), def.med.maxCharges);
    }

    if (def.magazine) {
      // Loose magazines are usually partly loaded.
      if (this.rng.chance(0.62)) {
        const ammo = this.pickAmmoFor(def.magazine.caliber, danger);
        if (ammo) {
          const fill = this.rng.int(1, def.magazine.capacity);
          loadMagazine(stack, ammo.id, fill);
        }
      }
    }

    if (def.weapon) {
      this.dressWeapon(stack, def, danger);
    }

    stack.fresh = true;
    return stack;
  }

  /** Fit a found weapon with a magazine, some rounds and maybe attachments. */
  private dressWeapon(stack: ItemStack, def: ItemDef, danger: number): void {
    const w = def.weapon!;
    const mag = createStack(w.defaultMagazine);
    const ammo = this.pickAmmoFor(w.caliber, danger);
    if (ammo) {
      const magDef = ItemDB.get(mag.defId).magazine!;
      const fill = this.rng.int(0, magDef.capacity);
      loadMagazine(mag, ammo.id, fill);
      if (fill > 0 && this.rng.chance(0.7)) stack.chamber = ammo.id;
    }
    stack.magazine = mag;

    // Attachment chance rises with zone danger: the good kit is in the middle.
    const attachmentChance = 0.18 + danger * 0.45;
    stack.attachments = {};
    for (const slot of w.slots) {
      if (!this.rng.chance(attachmentChance)) continue;
      const candidates = ItemDB.ofCategory('attachment').filter((a) => {
        const att = a.attachment!;
        if (att.slot !== slot) return false;
        if (att.fits.length > 0 && !att.fits.includes(def.id)) return false;
        // Keep legendary optics off common rifles found in a barrel.
        return RARITY_ORDER.indexOf(a.rarity) <= (danger > 0.7 ? 4 : danger > 0.4 ? 3 : 1);
      });
      if (candidates.length === 0) continue;
      const pick = this.rng.pick(candidates);
      stack.attachments[pick.attachment!.slot] = createStack(pick.id);
    }
  }

  /** Ammunition appropriate to a calibre and the local danger level. */
  private pickAmmoFor(caliber: string, danger: number): ItemDef | undefined {
    const pool = ItemDB.ofCategory('ammo').filter((a) => a.ammo?.caliber === caliber);
    if (pool.length === 0) return undefined;
    const weights = pool.map((a) => {
      const tier = RARITY_ORDER.indexOf(a.rarity);
      // Common ammunition is the default everywhere; the good stuff is rare
      // and concentrates where the fighting is.
      return Math.max(0.4, 10 - tier * 3 + danger * tier * 3.6);
    });
    return this.rng.weighted(pool, weights);
  }

  /** Total trader value still sitting in the world - used for raid summaries. */
  remainingValue(): number {
    let total = 0;
    for (const c of this.containers) total += c.grid.weight();
    return total;
  }
}
