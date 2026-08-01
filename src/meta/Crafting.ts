import type { GameBus } from '../core/GameEvents';
import type { ModuleId } from './Hideout';

/**
 * Crafting - turning worthless loot into things worth carrying.
 *
 * Recipes exist for two reasons. First, they make junk meaningful: scrap,
 * wire and cloth have no trader value worth the inventory slot, but they are
 * the only path to ammunition and medical supplies you would otherwise have
 * to buy. Second, they give the player a reason to run raids for *specific*
 * inputs rather than sweeping up whatever is nearest.
 *
 * Everything takes real time and occupies a single production slot per module,
 * so crafting is a thing you start before a raid, not a menu you grind.
 */

export interface RecipeInput {
  defId: string;
  count: number;
}

export interface RecipeDef {
  id: string;
  name: string;
  /** Which hideout module runs this recipe. */
  module: ModuleId;
  /** Minimum module level required. */
  moduleLevel: number;
  inputs: RecipeInput[];
  output: { defId: string; count: number };
  /** Production time in seconds. */
  seconds: number;
  /** Optional money cost on top of materials. */
  money?: number;
}

export const RECIPES: RecipeDef[] = [
  // --- workshop: ammunition -----------------------------------------------
  {
    id: 'craft_ammo_545_ps', name: '5,45 Standard fertigen', module: 'workshop', moduleLevel: 1,
    inputs: [{ defId: 'mat_powder', count: 1 }, { defId: 'mat_scrap', count: 2 }],
    output: { defId: 'ammo_545_ps', count: 60 }, seconds: 900,
  },
  {
    id: 'craft_ammo_556_fmj', name: '5,56 Vollmantel fertigen', module: 'workshop', moduleLevel: 1,
    inputs: [{ defId: 'mat_powder', count: 1 }, { defId: 'mat_scrap', count: 2 }],
    output: { defId: 'ammo_556_fmj', count: 60 }, seconds: 900,
  },
  {
    id: 'craft_ammo_762s_ps', name: '7,62 kurz fertigen', module: 'workshop', moduleLevel: 1,
    inputs: [{ defId: 'mat_powder', count: 2 }, { defId: 'mat_scrap', count: 2 }],
    output: { defId: 'ammo_762s_ps', count: 50 }, seconds: 1080,
  },
  {
    id: 'craft_ammo_545_bp', name: '5,45 Panzerbrechend fertigen', module: 'workshop', moduleLevel: 3,
    inputs: [{ defId: 'mat_powder', count: 3 }, { defId: 'mat_steel', count: 1 }],
    output: { defId: 'ammo_545_bp', count: 30 }, seconds: 2700, money: 40000,
  },
  {
    id: 'craft_ammo_556_ap', name: '5,56 Wolframkern fertigen', module: 'workshop', moduleLevel: 3,
    inputs: [{ defId: 'mat_powder', count: 4 }, { defId: 'mat_steel', count: 2 }, { defId: 'mat_circuit', count: 1 }],
    output: { defId: 'ammo_556_ap', count: 20 }, seconds: 3600, money: 90000,
  },

  // --- workshop: parts ------------------------------------------------------
  {
    id: 'craft_mag_545', name: 'Magazine 5,45 fertigen', module: 'workshop', moduleLevel: 1,
    inputs: [{ defId: 'mat_scrap', count: 3 }],
    output: { defId: 'mag_545_30', count: 2 }, seconds: 600,
  },
  {
    id: 'craft_suppressor', name: 'Schalldämpfer fertigen', module: 'workshop', moduleLevel: 2,
    inputs: [{ defId: 'mat_steel', count: 2 }, { defId: 'tool_multi', count: 1 }],
    output: { defId: 'att_suppressor', count: 1 }, seconds: 2400, money: 22000,
  },
  {
    id: 'craft_grip', name: 'Vordergriff fertigen', module: 'workshop', moduleLevel: 1,
    inputs: [{ defId: 'mat_scrap', count: 2 }, { defId: 'mat_wire', count: 1 }],
    output: { defId: 'att_grip_vert', count: 1 }, seconds: 720,
  },

  // --- medical station ------------------------------------------------------
  {
    id: 'craft_bandage', name: 'Verbandpäckchen fertigen', module: 'medstation', moduleLevel: 1,
    inputs: [{ defId: 'mat_cloth', count: 2 }],
    output: { defId: 'med_bandage', count: 4 }, seconds: 420,
  },
  {
    id: 'craft_splint', name: 'Schienenset fertigen', module: 'medstation', moduleLevel: 1,
    inputs: [{ defId: 'mat_cloth', count: 2 }, { defId: 'mat_scrap', count: 1 }],
    output: { defId: 'med_splint', count: 2 }, seconds: 540,
  },
  {
    id: 'craft_tourniquet', name: 'Abbindesystem fertigen', module: 'medstation', moduleLevel: 2,
    inputs: [{ defId: 'mat_cloth', count: 3 }, { defId: 'mat_chem', count: 1 }],
    output: { defId: 'med_tourniquet', count: 3 }, seconds: 900,
  },
  {
    id: 'craft_ifak', name: 'Erste-Hilfe-Set fertigen', module: 'medstation', moduleLevel: 2,
    inputs: [{ defId: 'mat_cloth', count: 4 }, { defId: 'mat_chem', count: 2 }],
    output: { defId: 'med_ifak', count: 2 }, seconds: 1500,
  },
  {
    id: 'craft_stim', name: 'Kampfstimulanz fertigen', module: 'medstation', moduleLevel: 3,
    inputs: [{ defId: 'mat_chem', count: 4 }, { defId: 'mat_circuit', count: 1 }],
    output: { defId: 'med_stim_combat', count: 2 }, seconds: 2700, money: 30000,
  },
  {
    id: 'craft_surgery', name: 'Chirurgieset fertigen', module: 'medstation', moduleLevel: 3,
    inputs: [{ defId: 'mat_chem', count: 6 }, { defId: 'mat_cloth', count: 6 }, { defId: 'tool_multi', count: 1 }],
    output: { defId: 'med_surgery', count: 1 }, seconds: 3600, money: 55000,
  },

  // --- kitchen --------------------------------------------------------------
  {
    id: 'craft_water', name: 'Wasser aufbereiten', module: 'kitchen', moduleLevel: 1,
    inputs: [{ defId: 'mat_scrap', count: 1 }],
    output: { defId: 'drink_water', count: 3 }, seconds: 480,
  },
  {
    id: 'craft_ration', name: 'Feldrationen zubereiten', module: 'kitchen', moduleLevel: 2,
    inputs: [{ defId: 'food_canned', count: 2 }],
    output: { defId: 'food_ration', count: 2 }, seconds: 720,
  },
];

export interface CraftJob {
  recipeId: string;
  module: ModuleId;
  secondsRemaining: number;
  /** Total duration, for progress display. */
  totalSeconds: number;
}

export class CraftingSystem {
  /** One job per module - production slots are the scarce resource. */
  readonly jobs: CraftJob[] = [];

  constructor(private readonly bus: GameBus) {}

  recipesFor(module: ModuleId, moduleLevel: number): RecipeDef[] {
    return RECIPES.filter((r) => r.module === module && r.moduleLevel <= moduleLevel);
  }

  jobFor(module: ModuleId): CraftJob | undefined {
    return this.jobs.find((j) => j.module === module);
  }

  /** Why a recipe cannot start, or null when it can. */
  blocker(
    recipe: RecipeDef,
    moduleLevel: number,
    money: number,
    hasMaterials: (defId: string, count: number) => boolean,
  ): string | null {
    if (moduleLevel < recipe.moduleLevel) return `Modulstufe ${recipe.moduleLevel} erforderlich`;
    if (this.jobFor(recipe.module)) return 'Produktionsplatz belegt';
    if (recipe.money && money < recipe.money) return 'Nicht genug Geld';
    for (const input of recipe.inputs) {
      if (!hasMaterials(input.defId, input.count)) return 'Material fehlt';
    }
    return null;
  }

  /** Queue a job. The caller deducts inputs and money. */
  start(recipe: RecipeDef): boolean {
    if (this.jobFor(recipe.module)) return false;
    this.jobs.push({
      recipeId: recipe.id,
      module: recipe.module,
      secondsRemaining: recipe.seconds,
      totalSeconds: recipe.seconds,
    });
    this.bus.emit('craft:started', { recipeId: recipe.id, seconds: recipe.seconds });
    return true;
  }

  /**
   * Advance production. Finished jobs are returned so the caller can deposit
   * their output into the stash - crafting never touches inventory directly,
   * which keeps the "where did this item come from" path single and testable.
   */
  update(dtSeconds: number): RecipeDef[] {
    const finished: RecipeDef[] = [];
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const job = this.jobs[i];
      job.secondsRemaining -= dtSeconds;
      if (job.secondsRemaining > 0) continue;
      const recipe = RECIPES.find((r) => r.id === job.recipeId);
      this.jobs.splice(i, 1);
      if (recipe) {
        finished.push(recipe);
        this.bus.emit('craft:finished', { recipeId: recipe.id });
      }
    }
    return finished;
  }

  cancel(module: ModuleId): void {
    const index = this.jobs.findIndex((j) => j.module === module);
    // Cancelling forfeits the materials - a deliberate cost so the player
    // commits to a production plan.
    if (index >= 0) this.jobs.splice(index, 1);
  }

  serialize(): CraftJob[] {
    return this.jobs.map((j) => ({ ...j }));
  }

  restore(data: CraftJob[]): void {
    this.jobs.length = 0;
    for (const job of data ?? []) {
      if (RECIPES.some((r) => r.id === job.recipeId)) this.jobs.push({ ...job });
    }
  }
}
