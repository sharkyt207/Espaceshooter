import type { GameBus } from '../core/GameEvents';
import { GridContainer } from '../inventory/GridContainer';
import { Inventory } from '../inventory/Inventory';
import { createStack, defOf, stackValue, type ItemStack } from '../inventory/ItemStack';
import { loadMagazine } from '../weapons/WeaponRuntime';
import { Progression } from './Progression';
import { TraderSystem } from './Traders';
import { QuestSystem } from './Quests';
import { Hideout } from './Hideout';
import { CraftingSystem, RECIPES } from './Crafting';
import { InsuranceSystem } from './Insurance';

/**
 * Profile - everything that persists between raids.
 *
 * This is the object the save system serialises and the hideout screens edit.
 * It deliberately owns the *stash* (long-term storage) separately from the
 * *loadout* (what you take into the raid), because that separation is the
 * whole risk/reward decision: the stash is safe, the loadout is not.
 *
 * The metagame clock also lives here. Hideout construction, trader restocks,
 * crafting and insurance all advance on real elapsed seconds, which is what
 * makes "start a build, then go run a raid" the natural rhythm.
 */

const STARTING_MONEY = 180000;

export class Profile {
  /** Callsign shown on the results screen. */
  name = 'Operator';

  money = STARTING_MONEY;

  /** Long-term storage. Resized when the Lager module is upgraded. */
  stash: GridContainer;

  /** The kit taken into the next raid. */
  readonly loadout = new Inventory();

  readonly progression: Progression;
  readonly traders: TraderSystem;
  readonly quests: QuestSystem;
  readonly hideout: Hideout;
  readonly crafting: CraftingSystem;
  readonly insurance: InsuranceSystem;

  // --- career statistics ----------------------------------------------------
  raids = 0;
  survived = 0;
  kills = 0;
  deaths = 0;
  /** Highest single-raid extraction value. */
  bestHaul = 0;
  totalEarned = 0;

  /** Timestamp of the last metagame tick, for offline progress. */
  lastTickMs = Date.now();

  constructor(private readonly bus: GameBus, seed: number) {
    this.progression = new Progression(bus);
    this.traders = new TraderSystem(seed);
    this.quests = new QuestSystem(bus);
    this.hideout = new Hideout(bus);
    this.crafting = new CraftingSystem(bus);
    this.insurance = new InsuranceSystem(bus, seed);
    this.stash = new GridContainer(10, 8);
  }

  get survivalRate(): number {
    return this.raids > 0 ? this.survived / this.raids : 0;
  }

  /** Total trader value sitting in the stash. */
  get stashValue(): number {
    let total = 0;
    for (const stack of this.stash.items()) total += stackValue(stack);
    return total;
  }

  // =========================================================================
  // Metagame clock
  // =========================================================================

  /**
   * Advance every timed metagame system.
   *
   * Called on load with the real elapsed time since the last session, and then
   * once a second while the player is in the hideout. Running it on load is
   * what makes builds and crafts complete while the app is closed - important
   * on mobile, where sessions are short.
   */
  tick(elapsedSeconds: number): void {
    if (elapsedSeconds <= 0) return;
    // Cap offline progress so a month away does not trivialise the economy.
    const dt = Math.min(elapsedSeconds, 60 * 60 * 12);

    this.hideout.update(dt);
    this.traders.update(dt, this.progression.level);
    this.insurance.update(dt);

    const finished = this.crafting.update(dt);
    for (const recipe of finished) {
      const stack = createStack(recipe.output.defId, recipe.output.count);
      if (this.stash.add(stack) > 0) {
        this.bus.emit('ui:notify', {
          text: 'LAGER VOLL - PRODUKTION WARTET',
          tone: 'bad',
          duration: 5,
        });
      }
    }

    // Passive production from the kitchen.
    for (const prod of this.hideout.passiveProduction()) {
      const produced = (prod.perHour * dt) / 3600;
      const whole = Math.floor(produced);
      if (whole > 0) this.stash.add(createStack(prod.defId, whole));
    }

    this.applyStashSize();
    this.lastTickMs = Date.now();
  }

  /** Resize the stash when the Lager module levels up, preserving contents. */
  applyStashSize(): void {
    const size = this.hideout.stashSize;
    if (this.stash.width === size.width && this.stash.height === size.height) return;
    const contents = this.stash.items();
    const bigger = new GridContainer(size.width, size.height);
    for (const stack of contents) bigger.add(stack);
    this.stash = bigger;
  }

  // =========================================================================
  // Money
  // =========================================================================

  canAfford(amount: number): boolean {
    return this.money >= amount;
  }

  spend(amount: number): boolean {
    if (this.money < amount) return false;
    this.money -= amount;
    return true;
  }

  earn(amount: number): void {
    this.money += amount;
    this.totalEarned += amount;
  }

  // =========================================================================
  // Materials
  // =========================================================================

  hasMaterials(defId: string, count: number): boolean {
    return this.stash.countOf(defId) >= count;
  }

  consumeMaterials(inputs: { defId: string; count: number }[]): boolean {
    for (const input of inputs) {
      if (!this.hasMaterials(input.defId, input.count)) return false;
    }
    for (const input of inputs) this.stash.consume(input.defId, input.count);
    return true;
  }

  /** Start a craft, deducting inputs and money. */
  startCraft(recipeId: string): string | null {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return 'Rezept unbekannt';
    const moduleLevel = this.hideout.levelOf(recipe.module);
    const blocker = this.crafting.blocker(recipe, moduleLevel, this.money, (id, n) => this.hasMaterials(id, n));
    if (blocker) return blocker;
    if (recipe.money) this.spend(recipe.money);
    this.consumeMaterials(recipe.inputs);
    this.crafting.start(recipe);
    return null;
  }

  /** Start a hideout upgrade, deducting cost. */
  startUpgrade(moduleId: Parameters<Hideout['startUpgrade']>[0]): string | null {
    const blocker = this.hideout.upgradeBlocker(moduleId, this.money, (id, n) => this.hasMaterials(id, n));
    if (blocker) return blocker;
    const next = this.hideout.nextLevelDef(moduleId);
    if (!next) return 'Höchststufe erreicht';
    this.spend(next.money);
    this.consumeMaterials(next.cost);
    this.hideout.startUpgrade(moduleId);
    return null;
  }

  // =========================================================================
  // Starting kit
  // =========================================================================

  /**
   * Grant the opening loadout and stash.
   *
   * Tuned to teach rather than to spoil: a serviceable rifle with two mags, a
   * pistol as a backup, minimal armour, and enough medical supplies to survive
   * exactly one mistake.
   */
  grantStartingKit(): void {
    const rifle = createStack('wp_sg545');
    const rifleMag = createStack('mag_545_30');
    loadMagazine(rifleMag, 'ammo_545_ps', 30);
    rifle.magazine = rifleMag;
    rifle.chamber = 'ammo_545_ps';
    rifle.durability = 74;
    this.loadout.equip('primary', rifle);

    const pistol = createStack('wp_pw9');
    const pistolMag = createStack('mag_pw9_17');
    loadMagazine(pistolMag, 'ammo_9_fmj', 17);
    pistol.magazine = pistolMag;
    pistol.chamber = 'ammo_9_fmj';
    pistol.durability = 82;
    this.loadout.equip('sidearm', pistol);

    this.loadout.equip('rig', createStack('rig_light'));
    this.loadout.equip('backpack', createStack('bp_small'));
    this.loadout.equip('secure', createStack('sec_small'));

    const vest = createStack('arm_vest_soft');
    vest.durability = 30;
    this.loadout.equip('armor', vest);

    // Two spare magazines in the rig, medical in the pockets.
    for (let i = 0; i < 2; i++) {
      const spare = createStack('mag_545_30');
      loadMagazine(spare, 'ammo_545_ps', 30);
      this.loadout.store(spare);
    }
    this.loadout.store(createStack('med_bandage', 2));
    this.loadout.store(createStack('med_splint'));

    // Stash: reserve kit plus starting crafting materials.
    this.stash.add(createStack('ammo_545_ps', 60));
    this.stash.add(createStack('ammo_9_fmj', 34));
    this.stash.add(createStack('med_bandage', 3));
    this.stash.add(createStack('med_tourniquet', 1));
    this.stash.add(createStack('food_ration', 2));
    this.stash.add(createStack('drink_water', 2));
    this.stash.add(createStack('mat_scrap', 6));
    this.stash.add(createStack('mat_wire', 4));

    this.quests.refreshAvailability(this.progression.level);
    for (const id of ['kessler', 'marek', 'zoellner', 'sana'] as const) {
      this.traders.restock(id, this.progression.level);
    }
  }

  /**
   * Move everything the player brought back into the stash.
   * Items that do not fit stay in the loadout, which is a clear signal that
   * the Lager needs upgrading.
   */
  depositLoadout(): { stored: number; overflow: number } {
    let stored = 0;
    let overflow = 0;
    for (const { grid } of this.loadout.allGrids()) {
      for (const stack of [...grid.items()]) {
        const def = defOf(stack);
        // Keep magazines and ammunition on the rig - re-kitting after every
        // raid would be tedious rather than interesting.
        if (def.category === 'magazine' || def.category === 'ammo') continue;
        grid.remove(stack.id);
        if (this.stash.add(stack) === 0) stored++;
        else {
          grid.add(stack);
          overflow++;
        }
      }
    }
    this.loadout.markDirty();
    return { stored, overflow };
  }

  /** Apply between-raid healing from the medical station. */
  applyHideoutHealing(health: {
    parts: Record<string, { hp: number; max: number; fractured: boolean; blackedOut: boolean; lightBleeds: number; heavyBleeds: number }>;
    energy: number;
    hydration: number;
  }): void {
    const fraction = this.hideout.autoHealFraction;
    for (const key of Object.keys(health.parts)) {
      const part = health.parts[key];
      part.lightBleeds = 0;
      part.heavyBleeds = 0;
      if (this.hideout.healsFractures) part.fractured = false;
      if (part.blackedOut) {
        if (this.hideout.restoresLimbs) {
          part.blackedOut = false;
          part.hp = part.max * 0.5;
        }
        continue;
      }
      if (fraction > 0) {
        part.hp = Math.min(part.max, part.hp + (part.max - part.hp) * fraction);
      }
    }
    // The kitchen keeps you fed between raids at level 1 and above.
    if (this.hideout.levelOf('kitchen') >= 1) {
      health.energy = Math.max(health.energy, 70);
      health.hydration = Math.max(health.hydration, 70);
    }
  }

  /** Every insured item that came back, deposited into the stash. */
  collectInsurance(): number {
    const items = this.insurance.collect();
    let collected = 0;
    for (const item of items) {
      if (this.stash.add(item) === 0) collected++;
    }
    return collected;
  }

  /** Item instance ids the player still holds - used to resolve insurance. */
  heldItemIds(): Set<number> {
    const ids = new Set<number>();
    for (const slot of Object.values(this.loadout.equipped)) {
      if (slot) ids.add(slot.id);
    }
    for (const { grid } of this.loadout.allGrids()) {
      for (const stack of grid.items()) ids.add(stack.id);
    }
    return ids;
  }

  /** Snapshot for the save system. */
  serialize(): Record<string, unknown> {
    this.loadout.syncAll();
    return {
      name: this.name,
      money: this.money,
      raids: this.raids,
      survived: this.survived,
      kills: this.kills,
      deaths: this.deaths,
      bestHaul: this.bestHaul,
      totalEarned: this.totalEarned,
      lastTickMs: Date.now(),
      stash: { width: this.stash.width, height: this.stash.height, slots: this.stash.slots },
      loadout: {
        equipped: this.loadout.equipped,
        pockets: this.loadout.pockets.slots,
      },
      progression: this.progression.serialize(),
      traders: this.traders.serialize(),
      quests: this.quests.serialize(),
      hideout: this.hideout.serialize(),
      crafting: this.crafting.serialize(),
      insurance: this.insurance.serialize(),
    };
  }
}

/** Items in a raid loadout the player would lose on death, for the UI. */
export function loadoutRiskValue(inventory: Inventory): number {
  let total = 0;
  for (const stack of inventory.losableItems()) total += stackValue(stack);
  return total;
}

/** Convenience: sum of an item list's trader value. */
export function totalValue(stacks: ItemStack[]): number {
  let total = 0;
  for (const s of stacks) total += stackValue(s);
  return total;
}
