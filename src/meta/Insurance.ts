import type { GameBus } from '../core/GameEvents';
import { Rng } from '../core/Random';
import { ItemDB } from '../data/ItemDatabase';
import { cloneStack, stackValue, type ItemStack } from '../inventory/ItemStack';

/**
 * Insurance - the safety net that keeps the stakes high without being cruel.
 *
 * The problem it solves: in a game where death costs you everything, players
 * stop bringing good gear. They hoard it, run naked, and the fights get worse.
 * Insurance fixes that by making a *bad* raid survivable while keeping a *lost*
 * raid painful:
 *
 *   - You pay up front, per item, as a fraction of its value.
 *   - If you die, insured items *may* come back - the return rate is well
 *     below 100 %, and better gear returns less often.
 *   - Nothing comes back immediately. There is a real waiting period, so
 *     losing your primary means running the next raid with your backup.
 *   - Extract successfully and the premium is simply gone. Insurance you did
 *     not need is still insurance you paid for.
 *
 * Items looted off your corpse by AI are not recoverable, which is modelled by
 * the return roll rather than tracked explicitly.
 */

export interface InsuredEntry {
  /** A deep copy taken at the moment of insuring. */
  snapshot: ItemStack;
  /** Premium paid. */
  premium: number;
  /** Seconds until the item is eligible for return. */
  returnIn: number;
  /** Set once the roll has been made. */
  resolved: boolean;
  /** True when the roll succeeded and the item is waiting for collection. */
  returning: boolean;
}

/** Premium as a fraction of the item's value. */
const PREMIUM_RATE = 0.11;
/** Base seconds before an item can come back. */
const BASE_RETURN_SECONDS = 1800;

export class InsuranceSystem {
  readonly entries: InsuredEntry[] = [];
  /** Items that have come back and are waiting to be collected. */
  readonly pending: ItemStack[] = [];

  private readonly rng: Rng;

  constructor(private readonly bus: GameBus, seed: number) {
    this.rng = new Rng(seed ^ 0x1a5c);
  }

  /** Premium for a single item. */
  premiumFor(stack: ItemStack): number {
    return Math.max(200, Math.round(stackValue(stack) * PREMIUM_RATE));
  }

  /** Total premium for a set of items. */
  premiumForAll(stacks: ItemStack[]): number {
    let total = 0;
    for (const s of stacks) total += this.premiumFor(s);
    return total;
  }

  /** Is this item already covered for the coming raid? */
  isInsured(stackId: number): boolean {
    return this.entries.some((e) => e.snapshot.id === stackId && !e.resolved);
  }

  /**
   * Take out cover on an item. The caller deducts the premium.
   * The snapshot is what comes back, so modifications made after insuring are
   * not covered - which is realistic and keeps the bookkeeping simple.
   */
  insure(stack: ItemStack, speedMultiplier: number): InsuredEntry {
    const entry: InsuredEntry = {
      snapshot: cloneStack(stack),
      premium: this.premiumFor(stack),
      returnIn: BASE_RETURN_SECONDS * speedMultiplier,
      resolved: false,
      returning: false,
    };
    // Track the original instance id so we can tell whether it came home.
    entry.snapshot.id = stack.id;
    this.entries.push(entry);
    return entry;
  }

  /**
   * Resolve cover after a raid.
   *
   * @param survived      true when the player extracted
   * @param keptItemIds   instance ids the player still has (extracted with)
   * @param returnBonus   additive bonus to the return rate from the hideout
   */
  resolveRaid(survived: boolean, keptItemIds: Set<number>, returnBonus: number): void {
    let returningCount = 0;

    for (const entry of this.entries) {
      if (entry.resolved) continue;
      entry.resolved = true;

      // Extracted with the item: cover lapses, premium is spent.
      if (survived && keptItemIds.has(entry.snapshot.id)) continue;
      // Item was dropped or traded away mid-raid but the player lived: no claim.
      if (survived) continue;

      const def = ItemDB.tryGet(entry.snapshot.defId);
      if (!def) continue;

      // Return chance falls with value: cheap kit almost always comes back,
      // a top-tier plate carrier usually does not. That is what stops
      // insurance from removing risk at the high end.
      const value = stackValue(entry.snapshot);
      const valuePenalty = Math.min(0.55, value / 420000);
      const chance = Math.min(0.95, 0.72 - valuePenalty + returnBonus);

      if (this.rng.chance(chance)) {
        entry.returning = true;
        returningCount++;
      }
    }

    if (returningCount > 0) {
      this.bus.emit('ui:notify', {
        text: `${returningCount} VERSICHERTE GEGENSTÄNDE WERDEN ZURÜCKGESCHICKT`,
        tone: 'info',
        duration: 6,
      });
    }
  }

  /** Advance return timers; items that mature move into `pending`. */
  update(dtSeconds: number): void {
    let arrived = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (!entry.resolved) continue;
      if (!entry.returning) {
        // Nothing coming back - drop the record.
        this.entries.splice(i, 1);
        continue;
      }
      entry.returnIn -= dtSeconds;
      if (entry.returnIn <= 0) {
        this.pending.push(cloneStack(entry.snapshot));
        this.entries.splice(i, 1);
        arrived++;
      }
    }
    if (arrived > 0) this.bus.emit('insurance:returned', { count: arrived });
  }

  /** Take everything waiting for collection. */
  collect(): ItemStack[] {
    const items = [...this.pending];
    this.pending.length = 0;
    return items;
  }

  /** Entries still in transit, for the hideout screen. */
  get inTransit(): InsuredEntry[] {
    return this.entries.filter((e) => e.resolved && e.returning);
  }

  /** Entries covering the upcoming raid. */
  get activeCover(): InsuredEntry[] {
    return this.entries.filter((e) => !e.resolved);
  }

  serialize(): Record<string, unknown> {
    return {
      entries: this.entries,
      pending: this.pending,
    };
  }

  restore(data: { entries?: InsuredEntry[]; pending?: ItemStack[] }): void {
    this.entries.length = 0;
    this.pending.length = 0;
    for (const e of data?.entries ?? []) {
      if (ItemDB.has(e.snapshot?.defId ?? '')) this.entries.push(e);
    }
    for (const p of data?.pending ?? []) {
      if (ItemDB.has(p.defId)) this.pending.push(p);
    }
  }
}
