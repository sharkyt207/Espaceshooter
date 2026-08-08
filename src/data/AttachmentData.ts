import { defineItem, type AttachmentSlot, type ItemDef } from './ItemTypes';

/**
 * AttachmentData - weapon modification parts.
 *
 * Modding follows one principle: **every part is a trade**. A suppressor buys
 * silence and muzzle rise at the cost of weight and a slower swap. A magnified
 * optic buys reach at the cost of close-quarters awareness. A heavy stock buys
 * control at the cost of handling. Nothing here is a free upgrade, which is
 * what keeps loadout building interesting instead of solvable.
 *
 * Modifiers are multiplicative for ratios (recoil, accuracy, loudness) and
 * additive for absolute values (ergonomics seconds, velocity m/s).
 */

interface AttachSpec {
  id: string;
  name: string;
  short: string;
  slot: AttachmentSlot;
  fits?: string[];
  /**
   * Overall recoil multiplier, and how it splits between the two axes.
   *
   * `recoil` is the total; `axis` says which way it mostly works. A value of
   * -1 puts the whole benefit on vertical climb, +1 puts it on horizontal
   * wander, 0 splits it evenly.
   *
   * The split is what makes a grip and a stock feel like different parts
   * rather than two sizes of the same part. A vertical grip is the hand
   * fighting lateral whip; a stock is the shoulder absorbing rise. Collapsing
   * both into one number is exactly the "every attachment is a percentage"
   * flatness the brief calls out.
   */
  recoil?: number;
  axis?: number;
  accuracy?: number;
  ergo?: number;
  loudness?: number;
  zoom?: number;
  illuminated?: boolean;
  light?: number;
  velocity?: number;
  weight: number;
  price: number;
  rarity: ItemDef['rarity'];
  w: number;
  h: number;
  desc: string;
}

const SPECS: AttachSpec[] = [
  // --- muzzle devices -----------------------------------------------------
  {
    id: 'att_brake_std', axis: -0.7, name: 'Mündungsbremse M1', short: 'Bremse', slot: 'muzzle',
    recoil: 0.82, accuracy: 1.05, ergo: -0.02, loudness: 1.22, weight: 0.13,
    price: 8400, rarity: 'common', w: 1, h: 1,
    desc: 'Lenkt Gase seitlich ab. Deutlich weniger Hochschlag, dafür erheblich lauter.',
  },
  {
    id: 'att_comp_light', axis: -0.35, name: 'Kompensator L2', short: 'Komp.', slot: 'muzzle',
    recoil: 0.9, accuracy: 0.98, ergo: -0.01, loudness: 1.08, weight: 0.08,
    price: 5200, rarity: 'common', w: 1, h: 1,
    desc: 'Leichter Kompensator. Moderate Verbesserung ohne große Nachteile.',
  },
  {
    id: 'att_suppressor', axis: -0.4, name: 'Schalldämpfer SD-7', short: 'SD-7', slot: 'muzzle',
    recoil: 0.88, accuracy: 0.94, ergo: -0.09, loudness: 0.24, velocity: -18,
    weight: 0.46, price: 42000, rarity: 'rare', w: 2, h: 1,
    desc: 'Reduziert Mündungsknall und Feuerschein drastisch. Schwer und heizt sich auf.',
  },
  {
    id: 'att_suppressor_hv', axis: -0.45, name: 'Schalldämpfer SD-12 schwer', short: 'SD-12', slot: 'muzzle',
    recoil: 0.8, accuracy: 0.9, ergo: -0.16, loudness: 0.16, velocity: -8,
    weight: 0.72, price: 76000, rarity: 'epic', w: 2, h: 1,
    desc: 'Großvolumiger Dämpfer für Vollkaliber. Nahezu lautlos, aber kopflastig.',
  },

  // --- optics -------------------------------------------------------------
  {
    id: 'att_reddot', name: 'Reflexvisier RV-1', short: 'RV-1', slot: 'optic',
    zoom: 1.0, ergo: -0.01, accuracy: 0.97, illuminated: true, weight: 0.16,
    price: 12800, rarity: 'common', w: 1, h: 1,
    desc: 'Offenes Reflexvisier. Schnelle Zielaufnahme, funktioniert auch im Dunkeln.',
  },
  {
    id: 'att_holo', name: 'Holovisier HV-3', short: 'HV-3', slot: 'optic',
    zoom: 1.35, ergo: -0.03, accuracy: 0.94, illuminated: true, weight: 0.31,
    price: 26500, rarity: 'uncommon', w: 2, h: 1,
    desc: 'Holografisches Visier mit leichter Vergrößerung. Guter Allzweckkompromiss.',
  },
  {
    id: 'att_scope4', name: 'Zielfernrohr ZF-4', short: 'ZF-4', slot: 'optic',
    zoom: 3.2, ergo: -0.1, accuracy: 0.85, illuminated: false, weight: 0.58,
    price: 48000, rarity: 'rare', w: 2, h: 1,
    desc: 'Vierfache Vergrößerung. Beherrscht offene Flächen, blind auf kurze Distanz.',
  },
  {
    id: 'att_scope8', name: 'Zielfernrohr ZF-8 Nacht', short: 'ZF-8', slot: 'optic',
    zoom: 6.0, ergo: -0.2, accuracy: 0.78, illuminated: true, weight: 0.94,
    price: 118000, rarity: 'epic', w: 2, h: 1,
    desc: 'Starke Optik mit beleuchtetem Absehen. Für Schützen, die nicht gefunden werden wollen.',
  },

  // --- foregrips ----------------------------------------------------------
  {
    id: 'att_grip_vert', axis: 0.7, name: 'Vordergriff VG-2', short: 'VG-2', slot: 'foregrip',
    recoil: 0.9, ergo: 0.02, weight: 0.12, price: 6800, rarity: 'common', w: 1, h: 1,
    desc: 'Senkrechter Griff. Stabilisiert Dauerfeuer spürbar.',
  },
  {
    id: 'att_grip_angled', axis: 0.45, name: 'Schräggriff SG-1', short: 'SG-1', slot: 'foregrip',
    recoil: 0.95, ergo: 0.06, accuracy: 0.99, weight: 0.09, price: 9200, rarity: 'uncommon', w: 1, h: 1,
    desc: 'Schräger Griff. Weniger Rückstoßkontrolle, dafür schnelleres Anschlagen.',
  },
  {
    id: 'att_bipod', axis: 0.2, name: 'Zweibein ZB-4', short: 'ZB-4', slot: 'foregrip',
    recoil: 0.72, accuracy: 0.88, ergo: -0.14, weight: 0.44, price: 21000, rarity: 'rare', w: 2, h: 1,
    desc: 'Klappbares Zweibein. Enorme Stabilität im Liegen, hinderlich in Bewegung.',
  },

  // --- stocks -------------------------------------------------------------
  {
    id: 'att_stock_std', axis: -0.7, name: 'Standardschaft', short: 'Schaft', slot: 'stock',
    recoil: 0.88, ergo: -0.02, weight: 0.31, price: 7400, rarity: 'common', w: 2, h: 1,
    desc: 'Solider Festschaft. Bewährte Rückstoßdämpfung.',
  },
  {
    id: 'att_stock_heavy', axis: -0.8, name: 'Schwerer Schaft HS-9', short: 'HS-9', slot: 'stock',
    recoil: 0.76, accuracy: 0.96, ergo: -0.09, weight: 0.62, price: 24000, rarity: 'rare', w: 2, h: 1,
    desc: 'Gedämpfter Schwerschaft. Maximale Kontrolle, träges Handling.',
  },
  {
    id: 'att_stock_folding', axis: -0.5, name: 'Klappschaft KS-2', short: 'KS-2', slot: 'stock',
    recoil: 0.94, ergo: 0.08, weight: 0.18, price: 11500, rarity: 'uncommon', w: 1, h: 1,
    desc: 'Leichter Klappschaft. Schnell in Anschlag, weniger Kontrolle im Dauerfeuer.',
  },

  // --- tactical -----------------------------------------------------------
  {
    id: 'att_light', name: 'Waffenlampe WL-1', short: 'WL-1', slot: 'tactical',
    light: 10, ergo: -0.02, weight: 0.14, price: 8900, rarity: 'common', w: 1, h: 1,
    desc: 'Taktische Lampe, rund 20 m nutzbar. Zeigt dir den Raum - und dem Raum dich.',
  },
  {
    id: 'att_light_ir', name: 'Suchscheinwerfer WL-3', short: 'WL-3', slot: 'tactical',
    light: 17, ergo: -0.05, weight: 0.31, price: 26400, rarity: 'uncommon', w: 1, h: 1,
    desc: 'Doppelte Reichweite, doppelt so auffällig. Für Nachteinsätze auf offenem Gelände.',
  },
  {
    id: 'att_laser', name: 'Laserpointer LP-3', short: 'LP-3', slot: 'tactical',
    accuracy: 0.92, ergo: 0.03, weight: 0.08, price: 15600, rarity: 'uncommon', w: 1, h: 1,
    desc: 'Verbessert das Schießen aus der Hüfte deutlich. Der Punkt ist auch für andere sichtbar.',
  },
];

export const ATTACHMENT_ITEMS: ItemDef[] = SPECS.map((s) =>
  defineItem({
    id: s.id,
    name: s.name,
    shortName: s.short,
    category: 'attachment',
    rarity: s.rarity,
    width: s.w,
    height: s.h,
    weight: s.weight,
    basePrice: s.price,
    description: s.desc,
    color: '#7d8590',
    tags: ['attachment', s.slot],
    attachment: {
      slot: s.slot,
      fits: s.fits ?? [],
      recoilMultiplier: s.recoil ?? 1,
      recoilAxis: s.axis ?? 0,
      accuracyMultiplier: s.accuracy ?? 1,
      ergonomicsDelta: s.ergo ?? 0,
      loudnessMultiplier: s.loudness ?? 1,
      zoom: s.zoom ?? 1,
      illuminated: s.illuminated ?? false,
      lightRadius: s.light ?? 0,
      velocityDelta: s.velocity ?? 0,
    },
  }),
);
