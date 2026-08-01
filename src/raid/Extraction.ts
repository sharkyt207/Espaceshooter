import type { GameBus } from '../core/GameEvents';
import { distance } from '../core/Math2D';
import type { ExtractDefinition } from '../world/MapGenerator';
import type { Inventory } from '../inventory/Inventory';
import { forEachNested } from '../inventory/ItemStack';

/**
 * ExtractionSystem - the exits, their conditions and the hold timer.
 *
 * Extraction is the genre's whole tension curve compressed into one mechanic:
 * everything you have picked up is only *yours* once you have stood still,
 * exposed, at a known location, for several seconds. The design choices here
 * all sharpen that:
 *
 *   - Conditions differ per exit. A free extract is far away; a nearby one
 *     costs a fee or needs a key you had to find. That turns "which way out"
 *     into a route-planning decision made under a timer.
 *   - Some exits only open in the second half of the raid, so camping the exit
 *     from minute one is not a strategy.
 *   - Leaving the zone cancels the hold entirely. No partial credit.
 */

export interface ExtractRuntime {
  def: ExtractDefinition;
  /** Whether the exit's condition is satisfied right now. */
  available: boolean;
  /** Human-readable reason it is unavailable, for the HUD. */
  blockedReason: string | null;
  /** Seconds the player has held the zone. */
  holdProgress: number;
  /** True once the player has been told about this exit. */
  discovered: boolean;
}

export interface ExtractionResult {
  extracted: boolean;
  extractId: string | null;
  extractName: string | null;
  /** Fee deducted on extraction, if any. */
  fee: number;
}

export class ExtractionSystem {
  readonly extracts: ExtractRuntime[] = [];

  /** The extract the player is currently standing in, if any. */
  activeExtract: ExtractRuntime | null = null;

  constructor(private readonly bus: GameBus) {}

  load(defs: ExtractDefinition[]): void {
    this.extracts.length = 0;
    for (const def of defs) {
      this.extracts.push({
        def,
        available: false,
        blockedReason: null,
        holdProgress: 0,
        discovered: false,
      });
    }
    this.activeExtract = null;
  }

  /**
   * Advance the extraction state.
   *
   * @param raidFraction 0..1 how much of the raid has elapsed
   * @returns the result when the player has fully extracted, otherwise null
   */
  update(
    dt: number,
    playerX: number,
    playerY: number,
    inventory: Inventory,
    money: number,
    raidFraction: number,
  ): ExtractionResult | null {
    let inside: ExtractRuntime | null = null;

    for (const ex of this.extracts) {
      this.evaluateCondition(ex, inventory, money, raidFraction);

      const dist = distance(playerX, playerY, ex.def.x, ex.def.y);
      // Reveal an exit once the player gets near it - exits are landmarks you
      // find, not map markers you are handed.
      if (!ex.discovered && dist < 14) {
        ex.discovered = true;
        this.bus.emit('raid:extractAvailable', { extractId: ex.def.id, name: ex.def.name });
      }

      if (dist <= ex.def.radius && ex.available) {
        inside = ex;
      } else if (ex.holdProgress > 0) {
        // Stepping out resets the hold completely.
        ex.holdProgress = 0;
        if (this.activeExtract === ex) {
          this.activeExtract = null;
          this.bus.emit('raid:extractCancelled', {});
        }
      }
    }

    if (!inside) {
      this.activeExtract = null;
      return null;
    }

    if (this.activeExtract !== inside) {
      this.activeExtract = inside;
    }

    inside.holdProgress += dt;
    const remaining = Math.max(0, inside.def.holdSeconds - inside.holdProgress);
    this.bus.emit('raid:extracting', { extractId: inside.def.id, secondsLeft: remaining });

    if (inside.holdProgress >= inside.def.holdSeconds) {
      const fee = inside.def.condition?.kind === 'fee' ? inside.def.condition.amount : 0;
      return {
        extracted: true,
        extractId: inside.def.id,
        extractName: inside.def.name,
        fee,
      };
    }
    return null;
  }

  /** Resolve whether an exit's condition is currently satisfied. */
  private evaluateCondition(
    ex: ExtractRuntime,
    inventory: Inventory,
    money: number,
    raidFraction: number,
  ): void {
    const condition = ex.def.condition ?? { kind: 'always' as const };
    switch (condition.kind) {
      case 'always':
        ex.available = true;
        ex.blockedReason = null;
        break;

      case 'fee':
        ex.available = money >= condition.amount;
        ex.blockedReason = ex.available ? null : condition.label;
        break;

      case 'item': {
        const has = this.carriesItem(inventory, condition.itemDefId);
        ex.available = has;
        ex.blockedReason = has ? null : condition.label;
        break;
      }

      case 'timeWindow': {
        const open = raidFraction >= condition.openAfterFraction && raidFraction <= condition.closeAfterFraction;
        ex.available = open;
        ex.blockedReason = open ? null : condition.label;
        break;
      }

      default:
        ex.available = true;
        ex.blockedReason = null;
        break;
    }
  }

  /** Does the player carry this item anywhere, including nested containers? */
  private carriesItem(inventory: Inventory, defId: string): boolean {
    let found = false;
    const check = (stack: { defId: string }): void => {
      if (stack.defId === defId) found = true;
    };
    for (const { grid } of inventory.allGrids()) {
      for (const stack of grid.items()) {
        forEachNested(stack, check);
        if (found) return true;
      }
    }
    return false;
  }

  /** The closest available exit - used by the compass marker on the HUD. */
  nearestAvailable(x: number, y: number): ExtractRuntime | null {
    let best: ExtractRuntime | null = null;
    let bestDist = Infinity;
    for (const ex of this.extracts) {
      if (!ex.available) continue;
      const d = distance(x, y, ex.def.x, ex.def.y);
      if (d < bestDist) {
        bestDist = d;
        best = ex;
      }
    }
    return best;
  }
}
