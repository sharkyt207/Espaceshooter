import type { ItemCategory, ItemDef, Rarity } from './ItemTypes';
import { AMMO_ITEMS } from './AmmoData';
import { MAGAZINE_ITEMS, WEAPON_ITEMS } from './WeaponData';
import { ATTACHMENT_ITEMS } from './AttachmentData';
import { ARMOR_ITEMS, CARRY_ITEMS } from './GearData';
import { CONSUMABLE_ITEMS } from './ConsumableData';
import { MISC_ITEMS } from './MiscData';

/**
 * ItemDatabase - the single registry every system resolves item ids through.
 *
 * Built once at boot from the individual data modules and then treated as
 * immutable. Lookups are Map-based; the by-category and by-tag indexes exist so
 * loot tables, traders and crafting can ask questions like "give me every rare
 * valuable" without scanning the whole catalogue every time.
 */

class Database {
  private readonly byId = new Map<string, ItemDef>();
  private readonly byCategory = new Map<ItemCategory, ItemDef[]>();
  private readonly byTag = new Map<string, ItemDef[]>();

  readonly all: ItemDef[] = [];

  register(defs: ItemDef[]): void {
    for (const def of defs) {
      if (this.byId.has(def.id)) {
        console.warn(`[ItemDatabase] duplicate item id "${def.id}" - keeping the first`);
        continue;
      }
      this.byId.set(def.id, def);
      this.all.push(def);

      let cat = this.byCategory.get(def.category);
      if (!cat) {
        cat = [];
        this.byCategory.set(def.category, cat);
      }
      cat.push(def);

      for (const tag of def.tags ?? []) {
        let list = this.byTag.get(tag);
        if (!list) {
          list = [];
          this.byTag.set(tag, list);
        }
        list.push(def);
      }
    }
  }

  /** Throws on unknown ids: a missing definition is always a content bug. */
  get(id: string): ItemDef {
    const def = this.byId.get(id);
    if (!def) throw new Error(`[ItemDatabase] unknown item id "${id}"`);
    return def;
  }

  /** Non-throwing lookup for save migration, where ids may be stale. */
  tryGet(id: string): ItemDef | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  ofCategory(category: ItemCategory): readonly ItemDef[] {
    return this.byCategory.get(category) ?? [];
  }

  withTag(tag: string): readonly ItemDef[] {
    return this.byTag.get(tag) ?? [];
  }

  ofRarity(rarity: Rarity): ItemDef[] {
    return this.all.filter((d) => d.rarity === rarity);
  }

  /** Every item whose price falls inside a band - used by trader restocking. */
  inPriceRange(min: number, max: number): ItemDef[] {
    return this.all.filter((d) => d.basePrice >= min && d.basePrice <= max);
  }
}

export const ItemDB = new Database();

ItemDB.register(WEAPON_ITEMS);
ItemDB.register(MAGAZINE_ITEMS);
ItemDB.register(AMMO_ITEMS);
ItemDB.register(ATTACHMENT_ITEMS);
ItemDB.register(ARMOR_ITEMS);
ItemDB.register(CARRY_ITEMS);
ItemDB.register(CONSUMABLE_ITEMS);
ItemDB.register(MISC_ITEMS);
