/**
 * LootTables - what spawns where, and how often.
 *
 * The economy is built on a simple contract with the player: **danger and
 * effort pay**. Open-air barrels hold consumables worth a few thousand; the
 * safe inside the contested central building can hold a legendary valuable.
 * Every table below is tuned so that the expected value of a container roughly
 * tracks how exposed you are while opening it, and how long the search takes.
 *
 * Entries can reference an exact item id or a tag, letting a table say "some
 * medical item" without enumerating the catalogue - so adding a new item
 * automatically joins the tables it belongs in.
 */

import type { Rarity } from '../data/ItemTypes';

export interface LootEntry {
  /** Exact item, or... */
  defId?: string;
  /** ...any item carrying this tag. */
  tag?: string;
  /** Relative weight within the table. */
  weight: number;
  /** Quantity range for stackable items. */
  min?: number;
  max?: number;
  /** Restrict a tag roll to a rarity band. */
  maxRarity?: Rarity;
}

export interface LootTableDef {
  id: string;
  /** Display name shown while searching. */
  name: string;
  /** Grid the contents are laid out in. */
  gridWidth: number;
  gridHeight: number;
  /** Seconds to search. Big payoffs take long enough to be dangerous. */
  searchSeconds: number;
  /** Sprite archetype used for the world billboard. */
  sprite: string;
  /** How many rolls against the entry list. */
  minRolls: number;
  maxRolls: number;
  /** Chance the container is empty - keeps looting from being automatic. */
  emptyChance: number;
  entries: LootEntry[];
}

export const LOOT_TABLES: Record<string, LootTableDef> = {
  // --- exterior, low risk --------------------------------------------------
  barrel: {
    id: 'barrel', name: 'Fass', gridWidth: 3, gridHeight: 3, searchSeconds: 2.2,
    sprite: 'barrel', minRolls: 1, maxRolls: 3, emptyChance: 0.22,
    entries: [
      { tag: 'material', weight: 30, min: 1, max: 3 },
      { tag: 'food', weight: 18 },
      { tag: 'drink', weight: 12 },
      { defId: 'mat_scrap', weight: 22, min: 1, max: 4 },
      { defId: 'val_cash', weight: 6, min: 1, max: 2 },
      { tag: 'ammo', weight: 10, min: 6, max: 22, maxRarity: 'uncommon' },
    ],
  },
  toolbox: {
    id: 'toolbox', name: 'Werkzeugkasten', gridWidth: 3, gridHeight: 2, searchSeconds: 2.6,
    sprite: 'toolbox', minRolls: 1, maxRolls: 3, emptyChance: 0.15,
    entries: [
      { defId: 'tool_multi', weight: 14 },
      { defId: 'mat_scrap', weight: 26, min: 1, max: 3 },
      { defId: 'mat_wire', weight: 22, min: 1, max: 3 },
      { defId: 'mat_circuit', weight: 10 },
      { defId: 'tool_kit_gun', weight: 7 },
      { defId: 'mat_steel', weight: 6 },
      { tag: 'attachment', weight: 8, maxRarity: 'uncommon' },
    ],
  },
  duffel: {
    id: 'duffel', name: 'Seesack', gridWidth: 4, gridHeight: 3, searchSeconds: 3.0,
    sprite: 'duffel', minRolls: 2, maxRolls: 4, emptyChance: 0.12,
    entries: [
      { tag: 'ammo', weight: 24, min: 10, max: 30 },
      { tag: 'magazine', weight: 14 },
      { tag: 'consumable', weight: 20 },
      { tag: 'material', weight: 16, min: 1, max: 2 },
      { defId: 'val_cash', weight: 10, min: 1, max: 3 },
      { tag: 'attachment', weight: 10 },
      { tag: 'weapon', weight: 5, maxRarity: 'uncommon' },
    ],
  },

  // --- interior, medium risk ----------------------------------------------
  supply_crate: {
    id: 'supply_crate', name: 'Versorgungskiste', gridWidth: 4, gridHeight: 4, searchSeconds: 3.4,
    sprite: 'supply_crate', minRolls: 2, maxRolls: 4, emptyChance: 0.1,
    entries: [
      { tag: 'food', weight: 20 },
      { tag: 'drink', weight: 16 },
      { tag: 'med', weight: 18 },
      { tag: 'ammo', weight: 18, min: 12, max: 34 },
      { tag: 'material', weight: 18, min: 1, max: 3 },
      { defId: 'val_cash', weight: 8, min: 1, max: 4 },
      { tag: 'rig', weight: 4, maxRarity: 'uncommon' },
    ],
  },
  filing_cabinet: {
    id: 'filing_cabinet', name: 'Aktenschrank', gridWidth: 3, gridHeight: 4, searchSeconds: 3.8,
    sprite: 'filing_cabinet', minRolls: 1, maxRolls: 3, emptyChance: 0.2,
    entries: [
      { defId: 'val_cash', weight: 24, min: 1, max: 5 },
      { defId: 'q_dossier', weight: 8 },
      { tag: 'key', weight: 9 },
      { defId: 'mat_circuit', weight: 14 },
      { defId: 'val_watch', weight: 5 },
      { tag: 'valuable', weight: 14, maxRarity: 'rare' },
      { tag: 'med', weight: 12 },
    ],
  },
  med_cabinet: {
    id: 'med_cabinet', name: 'Medizinschrank', gridWidth: 3, gridHeight: 4, searchSeconds: 3.2,
    sprite: 'med_cabinet', minRolls: 2, maxRolls: 4, emptyChance: 0.08,
    entries: [
      { defId: 'med_bandage', weight: 26, min: 1, max: 3 },
      { defId: 'med_splint', weight: 16 },
      { defId: 'med_tourniquet', weight: 15 },
      { defId: 'med_ifak', weight: 14 },
      { defId: 'med_painkiller', weight: 12 },
      { defId: 'med_trauma', weight: 6 },
      { defId: 'med_stim_combat', weight: 5 },
      { defId: 'med_surgery', weight: 3 },
      { defId: 'mat_cloth', weight: 14, min: 1, max: 3 },
      { defId: 'mat_chem', weight: 8 },
      { defId: 'q_sample', weight: 4 },
    ],
  },
  tool_chest: {
    id: 'tool_chest', name: 'Werkzeugtruhe', gridWidth: 4, gridHeight: 3, searchSeconds: 3.6,
    sprite: 'tool_chest', minRolls: 2, maxRolls: 3, emptyChance: 0.1,
    entries: [
      { defId: 'mat_scrap', weight: 22, min: 2, max: 5 },
      { defId: 'mat_wire', weight: 20, min: 1, max: 4 },
      { defId: 'mat_steel', weight: 14, min: 1, max: 2 },
      { defId: 'mat_battery', weight: 10 },
      { defId: 'tool_welder', weight: 7 },
      { defId: 'tool_solder', weight: 8 },
      { defId: 'tool_kit_armor', weight: 7 },
      { defId: 'tool_multi', weight: 12 },
    ],
  },

  // --- interior, high risk -------------------------------------------------
  weapon_crate: {
    id: 'weapon_crate', name: 'Waffenkiste', gridWidth: 5, gridHeight: 4, searchSeconds: 5.0,
    sprite: 'weapon_crate', minRolls: 2, maxRolls: 4, emptyChance: 0.06,
    entries: [
      { tag: 'weapon', weight: 24 },
      { tag: 'magazine', weight: 20 },
      { tag: 'ammo', weight: 22, min: 20, max: 55 },
      { tag: 'attachment', weight: 20 },
      { tag: 'armor', weight: 10 },
      { defId: 'mat_powder', weight: 8, min: 1, max: 3 },
    ],
  },
  safe: {
    id: 'safe', name: 'Tresor', gridWidth: 3, gridHeight: 3, searchSeconds: 7.5,
    sprite: 'safe', minRolls: 1, maxRolls: 3, emptyChance: 0.05,
    entries: [
      { tag: 'valuable', weight: 40 },
      { defId: 'val_cash', weight: 22, min: 3, max: 8 },
      { tag: 'key', weight: 14 },
      { defId: 'val_datacore', weight: 6 },
      { defId: 'val_watch', weight: 12 },
      { tag: 'ammo', weight: 8, min: 20, max: 40 },
    ],
  },

  // --- special -------------------------------------------------------------
  boss_cache: {
    id: 'boss_cache', name: 'Kommandantendepot', gridWidth: 5, gridHeight: 5, searchSeconds: 6.0,
    sprite: 'weapon_crate', minRolls: 4, maxRolls: 6, emptyChance: 0,
    entries: [
      { tag: 'valuable', weight: 26 },
      { tag: 'weapon', weight: 18 },
      { tag: 'armor', weight: 16 },
      { tag: 'attachment', weight: 16 },
      { tag: 'ammo', weight: 14, min: 30, max: 60 },
      { defId: 'val_datacore', weight: 6 },
      { defId: 'med_surgery', weight: 6 },
      { defId: 'sec_medium', weight: 3 },
    ],
  },
  corpse: {
    id: 'corpse', name: 'Leiche', gridWidth: 6, gridHeight: 5, searchSeconds: 1.2,
    sprite: 'corpse', minRolls: 0, maxRolls: 0, emptyChance: 0,
    entries: [],
  },
};

/**
 * Rarity weighting per zone danger.
 *
 * A tag roll first picks a rarity band using these weights, then picks
 * uniformly inside it. Tying the band to zone danger is what makes pushing the
 * central building worth the risk without needing separate tables per zone.
 */
export function rarityWeightsForDanger(danger: number): Record<Rarity, number> {
  const d = Math.max(0, Math.min(1, danger));
  return {
    common: 58 - d * 30,
    uncommon: 26 + d * 2,
    rare: 11 + d * 12,
    epic: 4 + d * 11,
    legendary: 1 + d * 5,
  };
}
