import { defineItem, type BodyPart, type ItemDef } from './ItemTypes';

/**
 * GearData - body armour, helmets, rigs, backpacks and the secure container.
 *
 * Armour is the other half of the ammunition equation: class 4 stops almost
 * everything cheap and almost nothing expensive. Because plates degrade, a
 * fight you win still costs you - which is the pressure that makes each raid's
 * gear decision meaningful.
 *
 * Carry capacity is deliberately split three ways:
 *   - rig: fast-access combat load (mags, meds) - available in a fight
 *   - backpack: bulk loot - big, heavy, and droppable
 *   - secure container: the only thing that survives your death
 */

interface ArmorSpec {
  id: string;
  name: string;
  short: string;
  category: 'armor' | 'helmet';
  cls: number;
  durability: number;
  material: number;
  covers: BodyPart[];
  speed: number;
  turn: number;
  ergo: number;
  hearing?: number;
  blocksFace?: boolean;
  weight: number;
  price: number;
  rarity: ItemDef['rarity'];
  w: number;
  h: number;
  desc: string;
}

const ARMOR_SPECS: ArmorSpec[] = [
  {
    id: 'arm_vest_soft', name: 'Weichballistikweste', short: 'Weich', category: 'armor',
    cls: 2, durability: 38, material: 1.35, covers: ['thorax', 'stomach'],
    speed: 0.99, turn: 0.99, ergo: 0.02, weight: 3.1, price: 12000, rarity: 'common', w: 2, h: 2,
    desc: 'Aramidgewebe ohne Platten. Hält Pistolenmunition auf, mehr nicht.',
  },
  {
    id: 'arm_plate_steel', name: 'Stahlplattenträger', short: 'Stahl', category: 'armor',
    cls: 4, durability: 62, material: 0.72, covers: ['thorax'],
    speed: 0.94, turn: 0.93, ergo: 0.09, weight: 9.4, price: 38000, rarity: 'uncommon', w: 2, h: 2,
    desc: 'Schwere Stahlplatten. Extrem haltbar, aber du wirst es bei jedem Schritt merken.',
  },
  {
    id: 'arm_plate_ceramic', name: 'Keramikplattenträger', short: 'Keramik', category: 'armor',
    cls: 5, durability: 44, material: 1.9, covers: ['thorax', 'stomach'],
    speed: 0.97, turn: 0.97, ergo: 0.05, weight: 5.8, price: 92000, rarity: 'rare', w: 2, h: 3,
    desc: 'Leichte Keramik mit hoher Schutzklasse. Zersplittert unter Beschuss schnell.',
  },
  {
    id: 'arm_plate_composite', name: 'Verbundplattenträger', short: 'Verbund', category: 'armor',
    cls: 6, durability: 58, material: 1.42, covers: ['thorax', 'stomach', 'leftArm', 'rightArm'],
    speed: 0.92, turn: 0.9, ergo: 0.14, weight: 11.2, price: 268000, rarity: 'legendary', w: 3, h: 3,
    desc: 'Militärischer Vollschutz mit Armpanzerung. Fast unbezahlbar, fast unaufhaltsam.',
  },
  {
    id: 'hlm_cap', name: 'Ballistische Kappe', short: 'Kappe', category: 'helmet',
    cls: 1, durability: 18, material: 1.2, covers: ['head'],
    speed: 1, turn: 1, ergo: 0, hearing: 1, weight: 0.7, price: 6800, rarity: 'common', w: 2, h: 2,
    desc: 'Leichte Kopfbedeckung mit Einlage. Besser als nichts - knapp.',
  },
  {
    id: 'hlm_std', name: 'Gefechtshelm GH-2', short: 'GH-2', category: 'helmet',
    cls: 3, durability: 32, material: 1.1, covers: ['head'],
    speed: 0.99, turn: 0.98, ergo: 0.03, hearing: 0.8, weight: 1.6, price: 28000, rarity: 'uncommon', w: 2, h: 2,
    desc: 'Standardhelm der Vertragstruppen. Stoppt Splitter und Pistolenmunition zuverlässig.',
  },
  {
    id: 'hlm_heavy', name: 'Schwerer Helm SH-5 mit Visier', short: 'SH-5', category: 'helmet',
    cls: 4, durability: 46, material: 0.95, covers: ['head'],
    speed: 0.97, turn: 0.94, ergo: 0.08, hearing: 0.5, blocksFace: true,
    weight: 3.4, price: 96000, rarity: 'epic', w: 2, h: 2,
    desc: 'Vollgeschlossener Helm mit Panzerglasvisier. Du hörst kaum noch, was hinter dir passiert.',
  },
];

export const ARMOR_ITEMS: ItemDef[] = ARMOR_SPECS.map((s) =>
  defineItem({
    id: s.id,
    name: s.name,
    shortName: s.short,
    category: s.category,
    rarity: s.rarity,
    width: s.w,
    height: s.h,
    weight: s.weight,
    basePrice: s.price,
    hasDurability: true,
    description: s.desc,
    color: '#5f6b5a',
    tags: ['armor', `class${s.cls}`],
    armor: {
      armorClass: s.cls,
      maxDurability: s.durability,
      materialFactor: s.material,
      covers: s.covers,
      speedPenalty: s.speed,
      turnPenalty: s.turn,
      ergonomicsPenalty: s.ergo,
      hearingPenalty: s.hearing ?? 1,
      blocksFace: s.blocksFace,
    },
  }),
);

// ---------------------------------------------------------------------------
// Carry containers
// ---------------------------------------------------------------------------

interface ContainerSpec {
  id: string;
  name: string;
  short: string;
  category: 'rig' | 'backpack' | 'secure';
  gw: number;
  gh: number;
  weight: number;
  price: number;
  rarity: ItemDef['rarity'];
  w: number;
  h: number;
  secure?: boolean;
  desc: string;
  /** Rigs with armour double as a chest plate. */
  armorClass?: number;
  durability?: number;
  speed?: number;
  ergo?: number;
}

const CONTAINER_SPECS: ContainerSpec[] = [
  {
    id: 'rig_light', name: 'Leichter Gurtträger', short: 'Gurt', category: 'rig',
    gw: 4, gh: 2, weight: 0.6, price: 8500, rarity: 'common', w: 2, h: 2,
    desc: 'Minimalistischer Träger mit acht Fächern. Schnell, leicht, schutzlos.',
  },
  {
    id: 'rig_chest', name: 'Sturmweste SW-4', short: 'SW-4', category: 'rig',
    gw: 5, gh: 3, weight: 1.4, price: 26000, rarity: 'uncommon', w: 3, h: 2,
    desc: 'Geräumige Weste mit fünfzehn Fächern. Standard für längere Einsätze.',
  },
  {
    id: 'rig_armored', name: 'Gepanzerte Trageweste', short: 'Panzerw.', category: 'rig',
    gw: 4, gh: 3, weight: 6.9, price: 74000, rarity: 'rare', w: 3, h: 3,
    armorClass: 4, durability: 48, speed: 0.95, ergo: 0.08,
    desc: 'Trageweste mit integrierten Platten. Ersetzt die Schutzweste vollständig.',
  },
  {
    id: 'bp_small', name: 'Einsatzrucksack 20L', short: 'RS 20', category: 'backpack',
    gw: 4, gh: 4, weight: 1.1, price: 14000, rarity: 'common', w: 3, h: 3,
    desc: 'Kompakter Rucksack. Genug für die Beute eines kurzen Laufs.',
  },
  {
    id: 'bp_medium', name: 'Tragerucksack 40L', short: 'RS 40', category: 'backpack',
    gw: 5, gh: 5, weight: 2.3, price: 42000, rarity: 'uncommon', w: 4, h: 4,
    desc: 'Solider Rucksack mit Rahmen. Der Standard für Beutezüge.',
  },
  {
    id: 'bp_large', name: 'Lastenrucksack 65L', short: 'RS 65', category: 'backpack',
    gw: 6, gh: 6, weight: 4.2, price: 128000, rarity: 'rare', w: 4, h: 5,
    desc: 'Riesiger Trägerrucksack. Wer ihn füllt, kommt nicht mehr schnell weg.',
  },
  {
    id: 'sec_small', name: 'Sicherheitsbehälter Alpha', short: 'Alpha', category: 'secure',
    gw: 2, gh: 2, weight: 0.4, price: 0, rarity: 'rare', w: 2, h: 2, secure: true,
    desc: 'Versiegelter Behälter. Der Inhalt überlebt deinen Tod - alles andere nicht.',
  },
  {
    id: 'sec_medium', name: 'Sicherheitsbehälter Beta', short: 'Beta', category: 'secure',
    gw: 3, gh: 2, weight: 0.6, price: 0, rarity: 'epic', w: 2, h: 3, secure: true,
    desc: 'Größerer versiegelter Behälter. Sechs Felder, die dir niemand nehmen kann.',
  },
];

export const CARRY_ITEMS: ItemDef[] = CONTAINER_SPECS.map((s) =>
  defineItem({
    id: s.id,
    name: s.name,
    shortName: s.short,
    category: s.category,
    rarity: s.rarity,
    width: s.w,
    height: s.h,
    weight: s.weight,
    basePrice: s.price,
    hasDurability: s.armorClass !== undefined,
    description: s.desc,
    color: s.secure ? '#8a6f3a' : '#4f5a4a',
    tags: [s.category],
    container: {
      gridWidth: s.gw,
      gridHeight: s.gh,
      secure: s.secure ?? false,
    },
    armor: s.armorClass
      ? {
          armorClass: s.armorClass,
          maxDurability: s.durability ?? 40,
          materialFactor: 1.2,
          covers: ['thorax', 'stomach'],
          speedPenalty: s.speed ?? 1,
          turnPenalty: s.speed ?? 1,
          ergonomicsPenalty: s.ergo ?? 0,
          hearingPenalty: 1,
        }
      : undefined,
  }),
);
