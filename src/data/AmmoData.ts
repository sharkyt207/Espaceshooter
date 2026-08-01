import { defineItem, type ItemDef } from './ItemTypes';

/**
 * AmmoData - cartridge definitions.
 *
 * Ammunition is the deepest balance lever in the genre: the same rifle is a
 * different weapon depending on what is in the magazine. The rule we follow is
 * the realistic one - you trade *damage* for *penetration*. Soft-point rounds
 * wreck an unarmoured target and stop dead on a plate; armour-piercing punches
 * through but leaves a smaller wound channel.
 *
 * Calibre designations are the standard international ones (a 9x19 mm case is
 * 9 mm wide and 19 mm long); all product names are original to this project.
 */

export const CALIBERS = {
  P9: '9x19mm',
  P45: '11.43x23mm',
  R545: '5.45x39mm',
  R556: '5.56x45mm',
  R762S: '7.62x39mm',
  R762N: '7.62x51mm',
  SUB9: '9x39mm',
  SG12: '12/70',
} as const;

export const CALIBER_LABEL: Record<string, string> = {
  [CALIBERS.P9]: '9x19 mm',
  [CALIBERS.P45]: '11,43x23 mm',
  [CALIBERS.R545]: '5,45x39 mm',
  [CALIBERS.R556]: '5,56x45 mm',
  [CALIBERS.R762S]: '7,62x39 mm',
  [CALIBERS.R762N]: '7,62x51 mm',
  [CALIBERS.SUB9]: '9x39 mm',
  [CALIBERS.SG12]: 'Kaliber 12/70',
};

interface AmmoSpec {
  id: string;
  name: string;
  short: string;
  caliber: string;
  damage: number;
  penetration: number;
  armorDamage: number;
  fragmentation: number;
  velocity: number;
  bc: number;
  price: number;
  rarity: ItemDef['rarity'];
  projectiles?: number;
  spreadMoa?: number;
  recoilMod?: number;
  accuracyMod?: number;
  tracer?: number;
  malfunction?: number;
  weight?: number;
  desc: string;
}

const SPECS: AmmoSpec[] = [
  // --- 9x19 pistol -------------------------------------------------------
  {
    id: 'ammo_9_fmj', name: '9x19 Vollmantel', short: '9 VM', caliber: CALIBERS.P9,
    damage: 56, penetration: 11, armorDamage: 26, fragmentation: 0.05,
    velocity: 380, bc: 0.14, price: 24, rarity: 'common',
    desc: 'Standard-Vollmantelgeschoss. Billig, reichlich vorhanden, gegen Platten wirkungslos.',
  },
  {
    id: 'ammo_9_hp', name: '9x19 Hohlspitz', short: '9 HP', caliber: CALIBERS.P9,
    damage: 78, penetration: 6, armorDamage: 14, fragmentation: 0.35,
    velocity: 365, bc: 0.12, price: 52, rarity: 'uncommon', recoilMod: 1.04,
    desc: 'Deformiert im Ziel. Verheerend gegen ungeschützte Gegner, nutzlos gegen Schutzwesten.',
  },
  {
    id: 'ammo_9_ap', name: '9x19 Hartkern', short: '9 AP', caliber: CALIBERS.P9,
    damage: 44, penetration: 29, armorDamage: 48, fragmentation: 0,
    velocity: 445, bc: 0.16, price: 138, rarity: 'rare', recoilMod: 1.12,
    desc: 'Stahlkern-Geschoss. Durchschlägt leichte Schutzklassen, wenig Wundwirkung.',
  },

  // --- 11.43x23 -----------------------------------------------------------
  {
    id: 'ammo_45_fmj', name: '11,43 Vollmantel', short: '45 VM', caliber: CALIBERS.P45,
    damage: 74, penetration: 17, armorDamage: 30, fragmentation: 0.08,
    velocity: 260, bc: 0.19, price: 46, rarity: 'common', weight: 0.021,
    desc: 'Schweres, langsames Geschoss. Hoher Energieübertrag auf kurze Distanz.',
  },
  {
    id: 'ammo_45_ap', name: '11,43 Hartkern', short: '45 AP', caliber: CALIBERS.P45,
    damage: 58, penetration: 33, armorDamage: 52, fragmentation: 0,
    velocity: 300, bc: 0.21, price: 210, rarity: 'rare', weight: 0.022,
    desc: 'Seltene Spezialladung. Verbindet Masse mit brauchbarer Durchschlagsleistung.',
  },

  // --- 5.45x39 ------------------------------------------------------------
  {
    id: 'ammo_545_ps', name: '5,45 Standard', short: '545 PS', caliber: CALIBERS.R545,
    damage: 45, penetration: 31, armorDamage: 38, fragmentation: 0.12,
    velocity: 880, bc: 0.29, price: 58, rarity: 'common', weight: 0.011,
    desc: 'Massenware mit Stahlkern. Solide Allzweckmunition ohne Spitzenwerte.',
  },
  {
    id: 'ammo_545_hp', name: '5,45 Weichkern', short: '545 HP', caliber: CALIBERS.R545,
    damage: 66, penetration: 12, armorDamage: 18, fragmentation: 0.62,
    velocity: 890, bc: 0.26, price: 74, rarity: 'uncommon', weight: 0.011, recoilMod: 0.96,
    desc: 'Zersplittert im Ziel. Gegen ungepanzerte Ziele extrem effektiv.',
  },
  {
    id: 'ammo_545_bp', name: '5,45 Panzerbrechend', short: '545 BP', caliber: CALIBERS.R545,
    damage: 44, penetration: 44, armorDamage: 56, fragmentation: 0.08,
    velocity: 905, bc: 0.31, price: 246, rarity: 'epic', weight: 0.012,
    desc: 'Gehärteter Wolframkern. Bewährte Wahl gegen mittlere Schutzklassen.',
  },

  // --- 5.56x45 ------------------------------------------------------------
  {
    id: 'ammo_556_fmj', name: '5,56 Vollmantel', short: '556 VM', caliber: CALIBERS.R556,
    damage: 49, penetration: 22, armorDamage: 32, fragmentation: 0.28,
    velocity: 920, bc: 0.3, price: 62, rarity: 'common', weight: 0.012,
    desc: 'Standardpatrone der Vertragstruppen. Gut verfügbar, mittelmäßig gegen Panzerung.',
  },
  {
    id: 'ammo_556_pen', name: '5,56 Stahlspitze', short: '556 SS', caliber: CALIBERS.R556,
    damage: 47, penetration: 37, armorDamage: 44, fragmentation: 0.16,
    velocity: 940, bc: 0.32, price: 148, rarity: 'rare', weight: 0.012,
    desc: 'Stahlpenetrator vor dem Bleikern. Der vernünftige Kompromiss.',
  },
  {
    id: 'ammo_556_ap', name: '5,56 Wolframkern', short: '556 AP', caliber: CALIBERS.R556,
    damage: 42, penetration: 55, armorDamage: 66, fragmentation: 0,
    velocity: 960, bc: 0.34, price: 480, rarity: 'legendary', weight: 0.013, recoilMod: 1.06,
    desc: 'Militärische Sonderausstattung. Durchschlägt praktisch jede tragbare Platte.',
  },

  // --- 7.62x39 ------------------------------------------------------------
  {
    id: 'ammo_762s_ps', name: '7,62 kurz Standard', short: '762k PS', caliber: CALIBERS.R762S,
    damage: 60, penetration: 33, armorDamage: 40, fragmentation: 0.1,
    velocity: 715, bc: 0.27, price: 68, rarity: 'common', weight: 0.016,
    desc: 'Kräftige Kurzpatrone. Deutlich mehr Wirkung als Kleinkaliber, dafür mehr Rückstoß.',
  },
  {
    id: 'ammo_762s_hp', name: '7,62 kurz Hohlspitz', short: '762k HP', caliber: CALIBERS.R762S,
    damage: 84, penetration: 15, armorDamage: 20, fragmentation: 0.5,
    velocity: 700, bc: 0.24, price: 88, rarity: 'uncommon', weight: 0.016,
    desc: 'Reißt große Wundkanäle. Gegen Plattenträger reine Verschwendung.',
  },
  {
    id: 'ammo_762s_bp', name: '7,62 kurz Panzerbrechend', short: '762k BP', caliber: CALIBERS.R762S,
    damage: 57, penetration: 48, armorDamage: 60, fragmentation: 0.05,
    velocity: 745, bc: 0.29, price: 285, rarity: 'epic', weight: 0.017,
    desc: 'Schwerer Stahlkern. Beliebteste Wahl unter erfahrenen Läufern.',
  },

  // --- 7.62x51 ------------------------------------------------------------
  {
    id: 'ammo_762n_fmj', name: '7,62 lang Vollmantel', short: '762l VM', caliber: CALIBERS.R762N,
    damage: 82, penetration: 42, armorDamage: 52, fragmentation: 0.14,
    velocity: 840, bc: 0.4, price: 152, rarity: 'uncommon', weight: 0.024,
    desc: 'Gewehrpatrone mit hoher Energie. Ein Treffer entscheidet die meisten Duelle.',
  },
  {
    id: 'ammo_762n_ap', name: '7,62 lang Hartkern', short: '762l AP', caliber: CALIBERS.R762N,
    damage: 74, penetration: 63, armorDamage: 74, fragmentation: 0,
    velocity: 875, bc: 0.44, price: 620, rarity: 'legendary', weight: 0.025, recoilMod: 1.08,
    desc: 'Durchdringt schwere Schutzklassen und die Wand dahinter. Extrem teuer.',
  },

  // --- 9x39 subsonic ------------------------------------------------------
  {
    id: 'ammo_939_sp', name: '9x39 Unterschall', short: '939 SP', caliber: CALIBERS.SUB9,
    damage: 72, penetration: 34, armorDamage: 42, fragmentation: 0.2,
    velocity: 295, bc: 0.35, price: 190, rarity: 'rare', weight: 0.019,
    desc: 'Schwer und langsam - bleibt unter der Schallgrenze. Für lautlose Arbeit gebaut.',
  },
  {
    id: 'ammo_939_ap', name: '9x39 Hartkern', short: '939 AP', caliber: CALIBERS.SUB9,
    damage: 60, penetration: 47, armorDamage: 58, fragmentation: 0.04,
    velocity: 300, bc: 0.37, price: 395, rarity: 'epic', weight: 0.02,
    desc: 'Leise und panzerbrechend. Die teuerste Art, jemanden nicht kommen zu hören.',
  },

  // --- 12/70 shotgun ------------------------------------------------------
  {
    id: 'ammo_12_buck', name: '12/70 Schrot', short: '12 SCH', caliber: CALIBERS.SG12,
    damage: 42, penetration: 4, armorDamage: 10, fragmentation: 0,
    velocity: 385, bc: 0.06, price: 58, rarity: 'common', projectiles: 8, spreadMoa: 210,
    weight: 0.045, desc: 'Acht Posten pro Schuss. Auf kurze Distanz vernichtend, sonst nutzlos.',
  },
  {
    id: 'ammo_12_slug', name: '12/70 Flintenlaufgeschoss', short: '12 FLG', caliber: CALIBERS.SG12,
    damage: 178, penetration: 21, armorDamage: 46, fragmentation: 0,
    velocity: 440, bc: 0.11, price: 122, rarity: 'uncommon', spreadMoa: 24, recoilMod: 1.25,
    weight: 0.048, desc: 'Einzelgeschoss mit brutaler Energie. Bricht Knochen auch durch Weste.',
  },
  {
    id: 'ammo_12_ap', name: '12/70 Stahlpfeil', short: '12 STP', caliber: CALIBERS.SG12,
    damage: 96, penetration: 38, armorDamage: 54, fragmentation: 0,
    velocity: 520, bc: 0.15, price: 340, rarity: 'epic', projectiles: 3, spreadMoa: 90,
    weight: 0.05, recoilMod: 1.2,
    desc: 'Drei gehärtete Pfeilgeschosse. Seltene Spezialladung gegen Plattenträger.',
  },
];

/** All ammunition item definitions, keyed by id. */
export const AMMO_ITEMS: ItemDef[] = SPECS.map((s) =>
  defineItem({
    id: s.id,
    name: s.name,
    shortName: s.short,
    category: 'ammo',
    rarity: s.rarity,
    width: 1,
    height: 1,
    weight: s.weight ?? 0.012,
    basePrice: s.price,
    stackable: true,
    maxStack: 60,
    description: s.desc,
    color: '#b8925a',
    tags: ['ammo', s.caliber],
    ammo: {
      caliber: s.caliber,
      damage: s.damage,
      penetration: s.penetration,
      armorDamage: s.armorDamage,
      fragmentation: s.fragmentation,
      muzzleVelocity: s.velocity,
      ballisticCoefficient: s.bc,
      projectiles: s.projectiles ?? 1,
      spreadMoa: s.spreadMoa ?? 0,
      recoilModifier: s.recoilMod ?? 1,
      accuracyModifier: s.accuracyMod ?? 1,
      tracerFraction: s.tracer ?? (s.caliber === CALIBERS.SG12 ? 0 : 0.2),
      malfunctionModifier: s.malfunction ?? 1,
    },
  }),
);

/** Ammo ids available for a calibre, cheapest first. */
export function ammoForCaliber(caliber: string): ItemDef[] {
  return AMMO_ITEMS.filter((a) => a.ammo?.caliber === caliber).sort((a, b) => a.basePrice - b.basePrice);
}
