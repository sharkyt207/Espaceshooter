import { defineItem, type AttachmentSlot, type FireMode, type ItemDef } from './ItemTypes';
import { CALIBERS } from './AmmoData';

/**
 * WeaponData - firearms and magazines.
 *
 * Every weapon is defined by handling numbers, not by damage: damage lives in
 * the ammunition. A weapon's identity here is its recoil impulse, recovery
 * rate, mechanical accuracy, ergonomics and reload times. That is what makes
 * choosing between a fast-handling carbine and a heavy battle rifle a real
 * decision rather than a straight upgrade path.
 *
 * All names and designations are original to this project.
 */

/**
 * Handling family, which decides the weapon's recoil pattern.
 *
 * Separate from calibre and from the item's category, because it answers a
 * different question: not what the weapon shoots or where it is filed in the
 * inventory, but how it behaves in the air across a burst. A suppressed
 * subsonic carbine and a service rifle share a calibre and handle nothing
 * alike.
 */
export type WeaponClass =
  | 'pistol' | 'smg' | 'carbine' | 'rifle' | 'battle'
  | 'dmr' | 'sniper' | 'shotgun' | 'lmg';

interface WeaponSpec {
  id: string;
  cls: WeaponClass;
  name: string;
  short: string;
  caliber: string;
  modes: FireMode[];
  rpm: number;
  recoilV: number;
  recoilH: number;
  recovery: number;
  moa: number;
  ergo: number;
  reloadTac: number;
  reloadEmpty: number;
  mag: string;
  slots: AttachmentSlot[];
  barrel: number;
  loudness: number;
  weight: number;
  price: number;
  rarity: ItemDef['rarity'];
  w: number;
  h: number;
  burst?: number;
  ironZoom?: number;
  desc: string;
}

const SPECS: WeaponSpec[] = [
  // --- sidearms ----------------------------------------------------------
  {
    id: 'wp_pw9', cls: 'pistol', name: 'PW-9 Wächter', short: 'PW-9', caliber: CALIBERS.P9,
    modes: ['single'], rpm: 380, recoilV: 1.35, recoilH: 0.55, recovery: 13,
    moa: 5.2, ergo: 0.28, reloadTac: 1.9, reloadEmpty: 2.5, mag: 'mag_pw9_17',
    slots: ['muzzle', 'optic', 'tactical'], barrel: 0.11, loudness: 22,
    weight: 0.82, price: 9800, rarity: 'common', w: 2, h: 1,
    desc: 'Zuverlässige Dienstpistole. Letzte Rettung, wenn das Magazin leer ist.',
  },
  {
    id: 'wp_tk45', cls: 'pistol', name: 'TK-45 Zunder', short: 'TK-45', caliber: CALIBERS.P45,
    modes: ['single'], rpm: 300, recoilV: 2.1, recoilH: 0.85, recovery: 10.5,
    moa: 5.8, ergo: 0.31, reloadTac: 2.1, reloadEmpty: 2.8, mag: 'mag_tk45_8',
    slots: ['muzzle', 'optic', 'tactical'], barrel: 0.12, loudness: 25,
    weight: 1.06, price: 14500, rarity: 'uncommon', w: 2, h: 1,
    desc: 'Schwere Pistole im großen Kaliber. Wenig Schuss, viel Wirkung.',
  },

  // --- submachine guns ----------------------------------------------------
  {
    id: 'wp_mpn9', cls: 'smg', name: 'MP-N9 Nadel', short: 'MP-N9', caliber: CALIBERS.P9,
    modes: ['single', 'auto'], rpm: 900, recoilV: 1.05, recoilH: 0.62, recovery: 15,
    moa: 6.5, ergo: 0.33, reloadTac: 2.3, reloadEmpty: 3.0, mag: 'mag_9_30',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.2,
    loudness: 26, weight: 2.6, price: 26000, rarity: 'uncommon', w: 3, h: 2,
    desc: 'Hohe Kadenz, kaum Rückstoß. In engen Gängen kaum zu schlagen.',
  },
  {
    id: 'wp_ks45', cls: 'smg', name: 'KS-45 Klamm', short: 'KS-45', caliber: CALIBERS.P45,
    modes: ['single', 'burst', 'auto'], rpm: 680, recoilV: 1.5, recoilH: 0.8, recovery: 13,
    moa: 6.0, ergo: 0.38, reloadTac: 2.4, reloadEmpty: 3.1, mag: 'mag_45_25',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.22,
    loudness: 29, weight: 3.1, price: 34000, rarity: 'rare', w: 3, h: 2, burst: 3,
    desc: 'Schwerer Maschinenpistole im Großkaliber. Träge, aber durchschlagend.',
  },

  // --- assault rifles -----------------------------------------------------
  {
    id: 'wp_sg545', cls: 'rifle', name: 'SG-545 Ranke', short: 'SG-545', caliber: CALIBERS.R545,
    modes: ['single', 'auto'], rpm: 650, recoilV: 2.4, recoilH: 1.05, recovery: 11,
    moa: 3.4, ergo: 0.5, reloadTac: 2.6, reloadEmpty: 3.4, mag: 'mag_545_30',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.41,
    loudness: 42, weight: 3.4, price: 41000, rarity: 'common', w: 4, h: 2,
    desc: 'Robustes Sturmgewehr. Verzeiht Vernachlässigung und schlechte Wartung.',
  },
  {
    id: 'wp_ar556', cls: 'rifle', name: 'AR-556 Falke', short: 'AR-556', caliber: CALIBERS.R556,
    modes: ['single', 'burst', 'auto'], rpm: 780, recoilV: 2.05, recoilH: 0.88, recovery: 13.5,
    moa: 2.4, ergo: 0.48, reloadTac: 2.3, reloadEmpty: 3.0, mag: 'mag_556_30',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.37,
    loudness: 43, weight: 3.2, price: 58000, rarity: 'uncommon', w: 4, h: 2, burst: 3,
    desc: 'Modulares Sturmgewehr mit ausgezeichneter Präzision. Empfindlich gegen Schmutz.',
  },
  {
    id: 'wp_sk762', cls: 'battle', name: 'SK-762 Amboss', short: 'SK-762', caliber: CALIBERS.R762S,
    modes: ['single', 'auto'], rpm: 600, recoilV: 3.3, recoilH: 1.5, recovery: 9.5,
    moa: 4.1, ergo: 0.60, reloadTac: 2.7, reloadEmpty: 3.6, mag: 'mag_762s_30',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.41,
    loudness: 48, weight: 3.8, price: 47000, rarity: 'uncommon', w: 4, h: 2,
    desc: 'Grobschlächtig und laut. Wer damit trifft, braucht keinen zweiten Schuss.',
  },

  // --- marksman / battle --------------------------------------------------
  {
    id: 'wp_dm762', cls: 'dmr', name: 'DM-762 Specht', short: 'DM-762', caliber: CALIBERS.R762N,
    modes: ['single'], rpm: 420, recoilV: 3.9, recoilH: 1.1, recovery: 10,
    moa: 1.2, ergo: 0.72, reloadTac: 2.9, reloadEmpty: 3.8, mag: 'mag_762n_20',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.61,
    loudness: 58, weight: 4.6, price: 96000, rarity: 'rare', w: 5, h: 2, ironZoom: 1.4,
    desc: 'Halbautomatisches Präzisionsgewehr. Beherrscht offene Sichtachsen vollständig.',
  },
  {
    id: 'wp_br762', cls: 'battle', name: 'BR-762 Grimm', short: 'BR-762', caliber: CALIBERS.R762N,
    modes: ['single', 'auto'], rpm: 660, recoilV: 4.6, recoilH: 2.0, recovery: 8,
    moa: 2.6, ergo: 0.8, reloadTac: 3.0, reloadEmpty: 3.9, mag: 'mag_762n_20',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.51,
    loudness: 60, weight: 4.9, price: 128000, rarity: 'epic', w: 5, h: 2,
    desc: 'Vollautomatisches Schlachtgewehr. Kaum zu kontrollieren, kaum zu überleben.',
  },

  // --- shotguns -----------------------------------------------------------
  {
    id: 'wp_fs12', cls: 'shotgun', name: 'FS-12 Bruch', short: 'FS-12', caliber: CALIBERS.SG12,
    modes: ['single'], rpm: 75, recoilV: 6.2, recoilH: 1.4, recovery: 7,
    moa: 9, ergo: 0.6, reloadTac: 0.75, reloadEmpty: 0.75, mag: 'mag_12_tube6',
    slots: ['muzzle', 'optic', 'stock', 'tactical'], barrel: 0.51,
    loudness: 62, weight: 3.6, price: 22000, rarity: 'common', w: 4, h: 2,
    desc: 'Vorderschaftrepetierer. Wird Patrone für Patrone geladen - Zeit, die man selten hat.',
  },
  {
    id: 'wp_sa12', cls: 'shotgun', name: 'SA-12 Sturmflut', short: 'SA-12', caliber: CALIBERS.SG12,
    modes: ['single'], rpm: 240, recoilV: 5.4, recoilH: 1.6, recovery: 8.5,
    moa: 8, ergo: 0.66, reloadTac: 2.8, reloadEmpty: 3.5, mag: 'mag_12_8',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.47,
    loudness: 63, weight: 4.2, price: 74000, rarity: 'rare', w: 4, h: 2,
    desc: 'Halbautomatische Schrotflinte mit Kastenmagazin. Räumt Räume in Sekunden.',
  },

  // --- specialist ---------------------------------------------------------
  {
    id: 'wp_vs939', cls: 'smg', name: 'VS-939 Schatten', short: 'VS-939', caliber: CALIBERS.SUB9,
    modes: ['single', 'auto'], rpm: 700, recoilV: 1.8, recoilH: 0.7, recovery: 14,
    moa: 3.0, ergo: 0.40, reloadTac: 2.5, reloadEmpty: 3.2, mag: 'mag_939_20',
    slots: ['optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.36,
    loudness: 13, weight: 3.4, price: 148000, rarity: 'epic', w: 4, h: 2,
    desc: 'Integral schallgedämpft. Unterschallmunition, kein Mündungsfeuer, kein Warnsignal.',
  },
  {
    id: 'wp_lm556', cls: 'lmg', name: 'LM-556 Dornbusch', short: 'LM-556', caliber: CALIBERS.R556,
    modes: ['auto'], rpm: 820, recoilV: 2.6, recoilH: 1.3, recovery: 10,
    moa: 5.5, ergo: 1.15, reloadTac: 6.5, reloadEmpty: 7.2, mag: 'mag_556_100',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'tactical'], barrel: 0.46,
    loudness: 50, weight: 7.8, price: 165000, rarity: 'epic', w: 5, h: 2,
    desc: 'Leichtes Maschinengewehr mit Gurtkasten. Sehr schwer, sehr laut, sehr endgültig.',
  },

  // --- carbines -----------------------------------------------------------
  //
  // The gap between an SMG and a full rifle. Short barrel, rifle cartridge:
  // handles almost like a submachine gun indoors and still reaches past one
  // outside. The trade is muzzle blast and a shorter sight radius, which is
  // why they are loud and less accurate than their parent rifles rather than
  // simply worse.
  {
    id: 'wp_kb545', cls: 'carbine', name: 'KB-545 Distel', short: 'KB-545', caliber: CALIBERS.R545,
    modes: ['single', 'auto'], rpm: 720, recoilV: 2.6, recoilH: 1.15, recovery: 12.5,
    moa: 4.6, ergo: 0.44, reloadTac: 2.2, reloadEmpty: 2.9, mag: 'mag_545_30',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.31,
    loudness: 46, weight: 2.9, price: 61000, rarity: 'uncommon', w: 4, h: 2,
    desc: 'Kurzlauf-Karabiner. Dreht sich im Treppenhaus wie eine MP und trägt trotzdem über den Hof.',
  },
  {
    id: 'wp_kb556', cls: 'carbine', name: 'KB-556 Kiebitz', short: 'KB-556', caliber: CALIBERS.R556,
    modes: ['single', 'burst', 'auto'], burst: 3, rpm: 800, recoilV: 2.35, recoilH: 0.95, recovery: 13.5,
    moa: 4.0, ergo: 0.41, reloadTac: 2.0, reloadEmpty: 2.7, mag: 'mag_556_30',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine', 'tactical'], barrel: 0.29,
    loudness: 48, weight: 2.7, price: 72000, rarity: 'rare', w: 4, h: 2,
    desc: 'Leichter Karabiner mit Feuerstoß. Schnell im Anschlag, laut wie ein Schlag ins Gesicht.',
  },

  // --- bolt action --------------------------------------------------------
  //
  // The one weapon in the game that cannot correct a miss. Every shot works
  // the bolt, which is a second and a half of standing still - so it rewards
  // patience and position over reflexes, and it is the only reason to carry a
  // sidearm you actually intend to use.
  {
    id: 'wp_zr762', cls: 'sniper', name: 'ZR-762 Distanz', short: 'ZR-762', caliber: CALIBERS.R762N,
    modes: ['single'], rpm: 42, recoilV: 7.2, recoilH: 1.1, recovery: 7,
    moa: 0.7, ergo: 0.95, reloadTac: 3.4, reloadEmpty: 4.4, mag: 'mag_762n_20',
    slots: ['muzzle', 'optic', 'foregrip', 'stock', 'magazine'], barrel: 0.66,
    loudness: 78, weight: 5.6, price: 186000, rarity: 'epic', w: 5, h: 2,
    ironZoom: 1.05,
    desc: 'Repetierer mit schwerem Lauf. Ein Schuss, dann Kammer öffnen - und in dieser Sekunde bist du nichts als ein Geräusch.',
  },
];

export const WEAPON_ITEMS: ItemDef[] = SPECS.map((s) =>
  defineItem({
    id: s.id,
    name: s.name,
    shortName: s.short,
    category: 'weapon',
    rarity: s.rarity,
    width: s.w,
    height: s.h,
    weight: s.weight,
    basePrice: s.price,
    hasDurability: true,
    description: s.desc,
    color: '#6f7a86',
    tags: ['weapon', s.caliber],
    weapon: {
      caliber: s.caliber,
      fireModes: s.modes,
      rpm: s.rpm,
      burstCount: s.burst ?? 3,
      recoilVertical: s.recoilV,
      recoilHorizontal: s.recoilH,
      recoilRecovery: s.recovery,
      accuracyMoa: s.moa,
      ergonomics: s.ergo,
      reloadTactical: s.reloadTac,
      reloadEmpty: s.reloadEmpty,
      defaultMagazine: s.mag,
      slots: s.slots,
      barrelLength: s.barrel,
      loudness: s.loudness,
      ironSightZoom: s.ironZoom ?? 1.15,
      weaponClass: s.cls,
    },
  }),
);

// ---------------------------------------------------------------------------
// Magazines
// ---------------------------------------------------------------------------

interface MagSpec {
  id: string;
  name: string;
  short: string;
  caliber: string;
  capacity: number;
  reloadMod: number;
  ergoPenalty: number;
  weight: number;
  price: number;
  rarity: ItemDef['rarity'];
  w: number;
  h: number;
  desc: string;
}

const MAG_SPECS: MagSpec[] = [
  { id: 'mag_pw9_17', name: 'PW-9 Magazin (17)', short: 'PW9 17', caliber: CALIBERS.P9, capacity: 17, reloadMod: 1, ergoPenalty: 0, weight: 0.09, price: 1900, rarity: 'common', w: 1, h: 1, desc: 'Standardmagazin der PW-9.' },
  { id: 'mag_tk45_8', name: 'TK-45 Magazin (8)', short: 'TK45 8', caliber: CALIBERS.P45, capacity: 8, reloadMod: 0.95, ergoPenalty: 0, weight: 0.11, price: 2400, rarity: 'common', w: 1, h: 1, desc: 'Einreihiges Magazin, schnell gewechselt.' },
  { id: 'mag_9_30', name: 'Stangenmagazin 9mm (30)', short: '9mm 30', caliber: CALIBERS.P9, capacity: 30, reloadMod: 1, ergoPenalty: 0.02, weight: 0.16, price: 4200, rarity: 'common', w: 1, h: 2, desc: 'Gerades Stangenmagazin für Maschinenpistolen.' },
  { id: 'mag_9_50', name: 'Trommelmagazin 9mm (50)', short: '9mm 50', caliber: CALIBERS.P9, capacity: 50, reloadMod: 1.45, ergoPenalty: 0.12, weight: 0.52, price: 16800, rarity: 'rare', w: 2, h: 2, desc: 'Trommel mit hoher Kapazität. Schwer, sperrig, langsam zu wechseln.' },
  { id: 'mag_45_25', name: 'KS-45 Magazin (25)', short: 'KS45 25', caliber: CALIBERS.P45, capacity: 25, reloadMod: 1.05, ergoPenalty: 0.04, weight: 0.24, price: 5600, rarity: 'uncommon', w: 1, h: 2, desc: 'Gebogenes Großkalibermagazin.' },
  { id: 'mag_545_30', name: 'Standardmagazin 5,45 (30)', short: '545 30', caliber: CALIBERS.R545, capacity: 30, reloadMod: 1, ergoPenalty: 0.03, weight: 0.21, price: 3800, rarity: 'common', w: 1, h: 2, desc: 'Polymermagazin, überall zu finden.' },
  { id: 'mag_545_45', name: 'Langmagazin 5,45 (45)', short: '545 45', caliber: CALIBERS.R545, capacity: 45, reloadMod: 1.18, ergoPenalty: 0.09, weight: 0.34, price: 12500, rarity: 'rare', w: 1, h: 2, desc: 'Verlängertes Magazin. Mehr Schuss, schlechteres Handling.' },
  { id: 'mag_556_30', name: 'Standardmagazin 5,56 (30)', short: '556 30', caliber: CALIBERS.R556, capacity: 30, reloadMod: 0.94, ergoPenalty: 0.02, weight: 0.19, price: 4400, rarity: 'common', w: 1, h: 2, desc: 'Leichtes Magazin mit gutem Wechselverhalten.' },
  { id: 'mag_556_100', name: 'Gurtkasten 5,56 (100)', short: '556 100', caliber: CALIBERS.R556, capacity: 100, reloadMod: 2.4, ergoPenalty: 0.26, weight: 1.9, price: 28000, rarity: 'epic', w: 2, h: 2, desc: 'Gurtkasten für Maschinengewehre. Nachladen dauert eine Ewigkeit.' },
  { id: 'mag_762s_30', name: 'Standardmagazin 7,62k (30)', short: '762k 30', caliber: CALIBERS.R762S, capacity: 30, reloadMod: 1.06, ergoPenalty: 0.05, weight: 0.33, price: 4900, rarity: 'common', w: 1, h: 2, desc: 'Stahlmagazin, praktisch unzerstörbar.' },
  { id: 'mag_762n_20', name: 'Kastenmagazin 7,62l (20)', short: '762l 20', caliber: CALIBERS.R762N, capacity: 20, reloadMod: 1.1, ergoPenalty: 0.08, weight: 0.42, price: 8900, rarity: 'uncommon', w: 1, h: 2, desc: 'Schweres Magazin für Vollkaliberpatronen.' },
  { id: 'mag_939_20', name: 'VS-939 Magazin (20)', short: '939 20', caliber: CALIBERS.SUB9, capacity: 20, reloadMod: 1, ergoPenalty: 0.04, weight: 0.28, price: 11200, rarity: 'rare', w: 1, h: 2, desc: 'Spezialmagazin für Unterschallmunition.' },
  { id: 'mag_12_8', name: 'Schrotmagazin (8)', short: '12 8', caliber: CALIBERS.SG12, capacity: 8, reloadMod: 1.15, ergoPenalty: 0.1, weight: 0.46, price: 9400, rarity: 'uncommon', w: 1, h: 2, desc: 'Kastenmagazin für Schrotpatronen.' },
  { id: 'mag_12_tube6', name: 'Röhrenmagazin (6)', short: '12 R6', caliber: CALIBERS.SG12, capacity: 6, reloadMod: 1, ergoPenalty: 0, weight: 0.0, price: 0, rarity: 'common', w: 1, h: 1, desc: 'Fest verbautes Röhrenmagazin. Wird einzeln geladen.' },
];

export const MAGAZINE_ITEMS: ItemDef[] = MAG_SPECS.map((s) =>
  defineItem({
    id: s.id,
    name: s.name,
    shortName: s.short,
    category: 'magazine',
    rarity: s.rarity,
    width: s.w,
    height: s.h,
    weight: s.weight,
    basePrice: s.price,
    description: s.desc,
    color: '#5c6470',
    tags: ['magazine', s.caliber],
    magazine: {
      caliber: s.caliber,
      capacity: s.capacity,
      reloadModifier: s.reloadMod,
      ergonomicsPenalty: s.ergoPenalty,
    },
  }),
);

/** Tube-fed weapons load one shell at a time instead of swapping magazines. */
export const TUBE_MAGAZINES = new Set(['mag_12_tube6']);
