import { Rng } from '../core/Random';
import { ItemDB } from '../data/ItemDatabase';
import type { ItemCategory, ItemDef } from '../data/ItemTypes';
import { createStack, stackValue, type ItemStack } from '../inventory/ItemStack';

/**
 * Traders - the economy's four faces, each with a personality and a niche.
 *
 * Traders exist to make money *directional*. Selling a rifle to the medic pays
 * badly; selling it to the armourer pays well. Reputation rises when you deal
 * with someone and unlocks their better stock, so the player naturally
 * specialises - and specialising creates the pressure to run raids for the
 * specific things a specific trader wants.
 *
 * All four are original characters written for this project.
 */

export type TraderId = 'kessler' | 'marek' | 'zoellner' | 'sana';

export interface TraderDef {
  id: TraderId;
  name: string;
  role: string;
  /** Flavour shown on the trader screen. */
  greeting: string;
  /** Categories this trader deals in, with a price multiplier when selling to them. */
  buys: Partial<Record<ItemCategory, number>>;
  /** Categories that appear in their stock. */
  sells: ItemCategory[];
  /** Markup applied to their asking prices. */
  markup: number;
  /** Reputation needed per stock tier (index = tier). */
  reputationTiers: number[];
  /** Accent colour for the UI. */
  color: string;
}

export const TRADERS: Record<TraderId, TraderDef> = {
  kessler: {
    id: 'kessler',
    name: 'Frau Kessler',
    role: 'Waffenhandel',
    greeting: 'Zeig mir, was du hast. Und fass die Vitrine nicht an.',
    buys: { weapon: 1.0, magazine: 0.95, ammo: 0.9, attachment: 1.0, armor: 0.75, helmet: 0.75 },
    sells: ['weapon', 'magazine', 'ammo', 'attachment'],
    markup: 1.35,
    reputationTiers: [0, 900, 2600, 6200],
    color: '#c07a3a',
  },
  marek: {
    id: 'marek',
    name: 'Doktor Marek',
    role: 'Medizin und Versorgung',
    greeting: 'Setz dich. Und blute nicht auf den Tisch.',
    buys: { med: 1.1, food: 1.05, drink: 1.05, material: 0.8 },
    sells: ['med', 'food', 'drink'],
    markup: 1.28,
    reputationTiers: [0, 700, 2100, 5200],
    color: '#4a9a7a',
  },
  zoellner: {
    id: 'zoellner',
    name: 'Der Zöllner',
    role: 'Hehlerei',
    greeting: 'Alles hat einen Preis. Deiner ist wahrscheinlich niedriger, als du denkst.',
    buys: { valuable: 1.25, key: 1.1, quest: 0.5, material: 0.9, tool: 0.95 },
    sells: ['valuable', 'key', 'tool', 'material'],
    markup: 1.5,
    reputationTiers: [0, 1200, 3400, 7800],
    color: '#b8a03a',
  },
  sana: {
    id: 'sana',
    name: 'Sana',
    role: 'Ausrüstung und Versicherung',
    greeting: 'Versichert kommt fast alles zurück. Fast.',
    buys: { armor: 1.05, helmet: 1.05, rig: 1.1, backpack: 1.1, secure: 0.6, tool: 0.9 },
    sells: ['armor', 'helmet', 'rig', 'backpack', 'secure'],
    markup: 1.3,
    reputationTiers: [0, 800, 2400, 5800],
    color: '#6a7ac0',
  },
};

export interface TraderOffer {
  stack: ItemStack;
  price: number;
  /** Restocks are limited - a trader is not an infinite vending machine. */
  quantity: number;
}

export interface TraderState {
  reputation: number;
  /** Cumulative currency spent with this trader. */
  spent: number;
  offers: TraderOffer[];
  /** Seconds until the next restock. */
  restockIn: number;
}

/** Seconds between restocks. Long enough that stock feels finite. */
export const RESTOCK_SECONDS = 900;

export class TraderSystem {
  readonly states: Record<TraderId, TraderState>;
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0x7ade);
    this.states = {} as Record<TraderId, TraderState>;
    for (const id of Object.keys(TRADERS) as TraderId[]) {
      this.states[id] = { reputation: 0, spent: 0, offers: [], restockIn: 0 };
    }
  }

  /** Stock tier unlocked by the player's reputation with a trader. */
  tierFor(id: TraderId): number {
    const def = TRADERS[id];
    const rep = this.states[id].reputation;
    let tier = 0;
    for (let i = 0; i < def.reputationTiers.length; i++) {
      if (rep >= def.reputationTiers[i]) tier = i;
    }
    return tier;
  }

  /** What a trader pays for an item. Zero means they will not take it. */
  sellPrice(id: TraderId, stack: ItemStack): number {
    const def = TRADERS[id];
    const itemDef = ItemDB.get(stack.defId);
    const multiplier = def.buys[itemDef.category];
    if (multiplier === undefined) return 0;
    // Traders always buy below reference value; reputation narrows the gap.
    const repBonus = 1 + Math.min(0.18, this.states[id].reputation / 40000);
    return Math.round(stackValue(stack) * multiplier * 0.62 * repBonus);
  }

  /** Best trader for an item, used by the "sell all" convenience action. */
  bestBuyer(stack: ItemStack): { id: TraderId; price: number } | null {
    let best: { id: TraderId; price: number } | null = null;
    for (const id of Object.keys(TRADERS) as TraderId[]) {
      const price = this.sellPrice(id, stack);
      if (price > 0 && (!best || price > best.price)) best = { id, price };
    }
    return best;
  }

  /** Complete a sale: returns the payout and accrues reputation. */
  sell(id: TraderId, stack: ItemStack): number {
    const price = this.sellPrice(id, stack);
    if (price <= 0) return 0;
    const state = this.states[id];
    // Reputation from selling is deliberately small - buying is the loyalty
    // signal, selling is just business.
    state.reputation += Math.round(price / 240);
    return price;
  }

  /** Complete a purchase. Returns false when the offer is exhausted. */
  buy(id: TraderId, offerIndex: number): ItemStack | null {
    const state = this.states[id];
    const offer = state.offers[offerIndex];
    if (!offer || offer.quantity <= 0) return null;
    offer.quantity--;
    state.spent += offer.price;
    state.reputation += Math.round(offer.price / 90);
    const bought = createStack(offer.stack.defId, 1);
    // Copy the offer's condition so a "used" listing really is used.
    if (offer.stack.durability !== undefined) bought.durability = offer.stack.durability;
    if (offer.stack.rounds) bought.rounds = [...offer.stack.rounds];
    if (offer.quantity <= 0) state.offers.splice(offerIndex, 1);
    return bought;
  }

  /** Price a trader asks for a listed item. */
  private askingPrice(def: TraderDef, item: ItemDef): number {
    return Math.round(item.basePrice * def.markup);
  }

  /** Rebuild a trader's stock. Called at boot and on the restock timer. */
  restock(id: TraderId, playerLevel: number): void {
    const def = TRADERS[id];
    const state = this.states[id];
    const tier = this.tierFor(id);
    state.offers = [];
    state.restockIn = RESTOCK_SECONDS;

    // Price ceiling rises with both reputation tier and character level, so
    // early stock is genuinely affordable and late stock is genuinely rare.
    const ceiling = 9000 + tier * 46000 + playerLevel * 5200;

    const pool: ItemDef[] = [];
    for (const category of def.sells) {
      for (const item of ItemDB.ofCategory(category)) {
        if (item.basePrice > ceiling) continue;
        if (item.basePrice <= 0) continue;
        if (item.category === 'quest') continue;
        pool.push(item);
      }
    }
    if (pool.length === 0) return;

    // Weight towards the cheaper end so the stock list reads as a shop, not a
    // catalogue of everything the trader could theoretically obtain.
    const weights = pool.map((p) => Math.max(0.5, 12 - Math.log10(Math.max(10, p.basePrice)) * 2.4));
    const listingCount = Math.min(pool.length, 10 + tier * 4);
    const chosen = new Set<string>();

    for (let i = 0; i < listingCount * 3 && chosen.size < listingCount; i++) {
      const pick = this.rng.weighted(pool, weights);
      if (!pick || chosen.has(pick.id)) continue;
      chosen.add(pick.id);

      const stack = createStack(pick.id, pick.stackable ? Math.min(pick.maxStack, 30) : 1);
      if (pick.hasDurability && stack.durability !== undefined) {
        // Traders sell serviceable, not pristine, gear.
        const max = pick.armor ? pick.armor.maxDurability : 100;
        stack.durability = Math.round(max * this.rng.range(0.7, 1) * 10) / 10;
      }
      const quantity = pick.stackable ? this.rng.int(3, 9) : this.rng.int(1, 3);
      state.offers.push({ stack, price: this.askingPrice(def, pick), quantity });
    }

    state.offers.sort((a, b) => a.price - b.price);
  }

  /** Advance restock timers; called from the hideout screen's clock. */
  update(dtSeconds: number, playerLevel: number): void {
    for (const id of Object.keys(TRADERS) as TraderId[]) {
      const state = this.states[id];
      state.restockIn -= dtSeconds;
      if (state.restockIn <= 0 || state.offers.length === 0) this.restock(id, playerLevel);
    }
  }

  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const id of Object.keys(TRADERS) as TraderId[]) {
      out[id] = {
        reputation: this.states[id].reputation,
        spent: this.states[id].spent,
        restockIn: this.states[id].restockIn,
      };
    }
    return out;
  }

  restore(data: Record<string, { reputation?: number; spent?: number; restockIn?: number }>): void {
    for (const id of Object.keys(TRADERS) as TraderId[]) {
      const src = data?.[id];
      if (!src) continue;
      this.states[id].reputation = src.reputation ?? 0;
      this.states[id].spent = src.spent ?? 0;
      // Force a restock on load rather than persisting offers - stock is
      // cheap to regenerate and it avoids a whole class of save-migration bugs.
      this.states[id].restockIn = 0;
    }
  }
}
