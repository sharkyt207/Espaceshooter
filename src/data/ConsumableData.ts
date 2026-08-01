import { defineItem, type ItemDef, type MedEffect } from './ItemTypes';

/**
 * ConsumableData - medical items, food and drink.
 *
 * Medicine is a resource-management problem, not a heal button:
 *   - Bandages stop light bleeds; only a tourniquet stops a heavy one.
 *   - Splints fix fractures; nothing else does.
 *   - A first-aid kit restores health but cannot repair a blacked-out limb.
 *   - Only a surgical kit brings a destroyed limb back, and only partially.
 *
 * Because every item covers a *different* problem, a full medical loadout costs
 * real inventory space - which is exactly the tension we want when the player
 * decides what to bring versus what to loot.
 */

interface MedSpec {
  id: string;
  name: string;
  short: string;
  category: 'med' | 'food' | 'drink';
  useTime: number;
  charges: number;
  effects: MedEffect[];
  side?: MedEffect[];
  weight: number;
  price: number;
  rarity: ItemDef['rarity'];
  w: number;
  h: number;
  color: string;
  desc: string;
}

const SPECS: MedSpec[] = [
  // --- bleeding & trauma ---------------------------------------------------
  {
    id: 'med_bandage', name: 'Verbandpäckchen', short: 'Verband', category: 'med',
    useTime: 2.4, charges: 1, effects: [{ kind: 'stopBleed', heavy: false }],
    weight: 0.05, price: 1800, rarity: 'common', w: 1, h: 1, color: '#d8d4c8',
    desc: 'Steriler Druckverband. Stoppt leichte Blutungen zuverlässig.',
  },
  {
    id: 'med_tourniquet', name: 'Abbindesystem', short: 'Tourn.', category: 'med',
    useTime: 3.6, charges: 1,
    effects: [{ kind: 'stopBleed', heavy: true }, { kind: 'stopBleed', heavy: false }],
    weight: 0.08, price: 7200, rarity: 'uncommon', w: 1, h: 1, color: '#b04a3a',
    desc: 'Abbindesystem für starke Blutungen. Ohne das hier verblutest du in einer Minute.',
  },
  {
    id: 'med_splint', name: 'Schienenset', short: 'Schiene', category: 'med',
    useTime: 4.5, charges: 2, effects: [{ kind: 'fixFracture' }],
    weight: 0.22, price: 5400, rarity: 'common', w: 1, h: 2, color: '#9a8a5a',
    desc: 'Aluminiumschienen mit Fixierband. Das Einzige, was einen Bruch stabilisiert.',
  },

  // --- healing -------------------------------------------------------------
  {
    id: 'med_ifak', name: 'Erste-Hilfe-Set', short: 'EH-Set', category: 'med',
    useTime: 3.0, charges: 60,
    effects: [{ kind: 'heal', amount: 60, perPart: false }, { kind: 'stopBleed', heavy: false }],
    weight: 0.36, price: 16500, rarity: 'uncommon', w: 1, h: 1, color: '#4a8a5a',
    desc: 'Kompaktes Verbandset mit 60 Einheiten. Heilt und stoppt leichte Blutungen.',
  },
  {
    id: 'med_trauma', name: 'Traumakoffer', short: 'Trauma', category: 'med',
    useTime: 4.2, charges: 220,
    effects: [
      { kind: 'heal', amount: 220, perPart: false },
      { kind: 'stopBleed', heavy: true },
      { kind: 'stopBleed', heavy: false },
    ],
    weight: 1.4, price: 62000, rarity: 'rare', w: 2, h: 2, color: '#3a7a9a',
    desc: 'Vollausgestatteter Notfallkoffer. Behandelt praktisch jede Verletzung außer Brüchen.',
  },
  {
    id: 'med_surgery', name: 'Chirurgieset', short: 'Chirurg', category: 'med',
    useTime: 12.0, charges: 3, effects: [{ kind: 'surgery', restoreFraction: 0.42 }],
    weight: 0.9, price: 108000, rarity: 'epic', w: 2, h: 2, color: '#8a3a5a',
    desc: 'Feldchirurgisches Besteck. Stellt eine zerstörte Gliedmaße teilweise wieder her.',
  },

  // --- stimulants ----------------------------------------------------------
  {
    id: 'med_painkiller', name: 'Schmerzmittel', short: 'Schmerz', category: 'med',
    useTime: 1.8, charges: 8, effects: [{ kind: 'painkiller', durationSec: 180 }],
    side: [{ kind: 'hydration', amount: -12 }],
    weight: 0.06, price: 9800, rarity: 'uncommon', w: 1, h: 1, color: '#c8b45a',
    desc: 'Unterdrückt Schmerzen für drei Minuten. Du läufst wieder normal - der Bruch bleibt.',
  },
  {
    id: 'med_stim_combat', name: 'Kampfstimulanz KS-1', short: 'KS-1', category: 'med',
    useTime: 2.2, charges: 1,
    effects: [{ kind: 'stimulant', staminaRegen: 2.4, durationSec: 120 }, { kind: 'painkiller', durationSec: 120 }],
    side: [{ kind: 'energy', amount: -22 }, { kind: 'hydration', amount: -18 }],
    weight: 0.08, price: 34000, rarity: 'rare', w: 1, h: 1, color: '#c85a3a',
    desc: 'Injektor mit Aufputschmittel. Zwei Minuten unerschöpflich - danach der Absturz.',
  },
  {
    id: 'med_stim_regen', name: 'Regenerationsinjektor RI-2', short: 'RI-2', category: 'med',
    useTime: 2.6, charges: 1,
    effects: [{ kind: 'heal', amount: 90, perPart: true }],
    side: [{ kind: 'energy', amount: -30 }],
    weight: 0.09, price: 58000, rarity: 'epic', w: 1, h: 1, color: '#5ac8a0',
    desc: 'Beschleunigt die Wundheilung in allen Körperteilen. Zehrt massiv an den Reserven.',
  },

  // --- food & drink --------------------------------------------------------
  {
    id: 'food_ration', name: 'Feldration', short: 'Ration', category: 'food',
    useTime: 6.0, charges: 1, effects: [{ kind: 'energy', amount: 62 }, { kind: 'hydration', amount: -8 }],
    weight: 0.42, price: 4200, rarity: 'common', w: 1, h: 2, color: '#7a6a3a',
    desc: 'Militärische Tagesration. Sättigt gründlich, macht durstig.',
  },
  {
    id: 'food_bar', name: 'Energieriegel', short: 'Riegel', category: 'food',
    useTime: 2.4, charges: 1, effects: [{ kind: 'energy', amount: 24 }],
    weight: 0.08, price: 1400, rarity: 'common', w: 1, h: 1, color: '#8a7a4a',
    desc: 'Gepresster Riegel. Schnell gegessen, hält nicht lange vor.',
  },
  {
    id: 'food_canned', name: 'Konservendose', short: 'Konserve', category: 'food',
    useTime: 5.0, charges: 1, effects: [{ kind: 'energy', amount: 44 }, { kind: 'hydration', amount: 8 }],
    weight: 0.38, price: 2600, rarity: 'common', w: 1, h: 1, color: '#6a7a5a',
    desc: 'Eintopf in Blech. Unverwüstlich haltbar, geschmacklich fragwürdig.',
  },
  {
    id: 'drink_water', name: 'Wasserflasche', short: 'Wasser', category: 'drink',
    useTime: 3.0, charges: 3, effects: [{ kind: 'hydration', amount: 30 }],
    weight: 0.55, price: 2200, rarity: 'common', w: 1, h: 2, color: '#5a9ac8',
    desc: 'Gefilterte Wasserflasche mit drei Portionen.',
  },
  {
    id: 'drink_electro', name: 'Elektrolytgetränk', short: 'Elektro', category: 'drink',
    useTime: 2.6, charges: 2,
    effects: [{ kind: 'hydration', amount: 42 }, { kind: 'energy', amount: 14 }, { kind: 'stimulant', staminaRegen: 1.3, durationSec: 90 }],
    weight: 0.34, price: 8600, rarity: 'uncommon', w: 1, h: 1, color: '#c8a03a',
    desc: 'Mineralgetränk. Füllt Flüssigkeit auf und bringt die Ausdauer zurück.',
  },
];

export const CONSUMABLE_ITEMS: ItemDef[] = SPECS.map((s) =>
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
    description: s.desc,
    color: s.color,
    tags: [s.category, 'consumable'],
    med: {
      useTimeSec: s.useTime,
      maxCharges: s.charges,
      effects: s.effects,
      sideEffects: s.side,
    },
  }),
);
