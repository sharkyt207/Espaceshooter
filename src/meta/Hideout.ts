import type { GameBus } from '../core/GameEvents';

/**
 * Hideout - the between-raids base and the sink that gives loot a purpose.
 *
 * Without a base, every item that is not a weapon is just currency. The
 * hideout turns junk into decisions: scrap and wire are worthless at a trader
 * but they are the only way to a bigger stash; fuel is heavy and cheap but the
 * generator does not run without it.
 *
 * Every module upgrade changes something concrete and permanent:
 *   Lager        - more stash space, the most universally wanted upgrade
 *   Werkstatt    - weapon and armour repair, plus ammunition crafting
 *   Medizinstation - heals injuries between raids and crafts medical items
 *   Generator    - powers everything else; a hard prerequisite by design
 *   Küche        - food and water production, removes a recurring cost
 *   Sicherheit   - raises the insurance return rate and shortens the wait
 *
 * Upgrades take real time to complete, so the player is encouraged to start
 * one and go run a raid rather than sit in menus.
 */

export type ModuleId = 'stash' | 'workshop' | 'medstation' | 'generator' | 'kitchen' | 'security';

export interface ModuleLevelDef {
  /** Materials consumed, by item id. */
  cost: { defId: string; count: number }[];
  money: number;
  /** Build time in seconds of real time. */
  buildSeconds: number;
  /** Generator level required. */
  requiresPower: number;
  /** Description of what this level unlocks. */
  effect: string;
}

export interface ModuleDef {
  id: ModuleId;
  name: string;
  description: string;
  levels: ModuleLevelDef[];
}

export const HIDEOUT_MODULES: Record<ModuleId, ModuleDef> = {
  generator: {
    id: 'generator',
    name: 'Generator',
    description: 'Versorgt alle anderen Module mit Strom. Verbraucht Treibstoff.',
    levels: [
      {
        cost: [{ defId: 'mat_scrap', count: 6 }, { defId: 'mat_wire', count: 4 }],
        money: 40000, buildSeconds: 300, requiresPower: 0,
        effect: 'Grundversorgung. Ermöglicht Werkstatt und Medizinstation Stufe 1.',
      },
      {
        cost: [{ defId: 'mat_battery', count: 2 }, { defId: 'mat_wire', count: 8 }, { defId: 'mat_circuit', count: 3 }],
        money: 140000, buildSeconds: 900, requiresPower: 0,
        effect: 'Erhöhte Leistung. Ermöglicht Module bis Stufe 2.',
      },
      {
        cost: [{ defId: 'mat_battery', count: 4 }, { defId: 'mat_circuit', count: 8 }, { defId: 'mat_fuel', count: 2 }],
        money: 420000, buildSeconds: 2400, requiresPower: 0,
        effect: 'Volle Leistung. Ermöglicht alle Module auf Höchststufe.',
      },
    ],
  },
  stash: {
    id: 'stash',
    name: 'Lager',
    description: 'Regale und Kisten. Bestimmt, wie viel Beute du zwischen Einsätzen behalten kannst.',
    levels: [
      {
        cost: [{ defId: 'mat_scrap', count: 4 }],
        money: 25000, buildSeconds: 180, requiresPower: 0,
        effect: 'Lagerfläche 10 x 14.',
      },
      {
        cost: [{ defId: 'mat_scrap', count: 10 }, { defId: 'mat_steel', count: 2 }],
        money: 95000, buildSeconds: 720, requiresPower: 1,
        effect: 'Lagerfläche 10 x 20.',
      },
      {
        cost: [{ defId: 'mat_steel', count: 6 }, { defId: 'tool_welder', count: 1 }],
        money: 280000, buildSeconds: 1800, requiresPower: 2,
        effect: 'Lagerfläche 10 x 28.',
      },
    ],
  },
  workshop: {
    id: 'workshop',
    name: 'Werkstatt',
    description: 'Werkbank für Reparaturen und Fertigung von Munition und Anbauteilen.',
    levels: [
      {
        cost: [{ defId: 'mat_scrap', count: 5 }, { defId: 'tool_multi', count: 1 }],
        money: 45000, buildSeconds: 420, requiresPower: 1,
        effect: 'Waffenreparatur bis 70 % Zustand. Einfache Munitionsfertigung.',
      },
      {
        cost: [{ defId: 'mat_steel', count: 3 }, { defId: 'tool_welder', count: 1 }, { defId: 'mat_circuit', count: 2 }],
        money: 165000, buildSeconds: 1200, requiresPower: 2,
        effect: 'Reparatur bis 88 %. Panzerungsreparatur. Bessere Munition.',
      },
      {
        cost: [{ defId: 'mat_steel', count: 8 }, { defId: 'tool_solder', count: 1 }, { defId: 'mat_circuit', count: 6 }],
        money: 480000, buildSeconds: 3000, requiresPower: 3,
        effect: 'Reparatur bis 96 %. Fertigung panzerbrechender Munition.',
      },
    ],
  },
  medstation: {
    id: 'medstation',
    name: 'Medizinstation',
    description: 'Behandelt Verletzungen zwischen Einsätzen und stellt Medikamente her.',
    levels: [
      {
        cost: [{ defId: 'mat_cloth', count: 6 }, { defId: 'mat_chem', count: 2 }],
        money: 38000, buildSeconds: 360, requiresPower: 1,
        effect: 'Heilt leichte Verletzungen automatisch zwischen Einsätzen.',
      },
      {
        cost: [{ defId: 'mat_chem', count: 5 }, { defId: 'mat_circuit', count: 2 }, { defId: 'mat_cloth', count: 10 }],
        money: 150000, buildSeconds: 1080, requiresPower: 2,
        effect: 'Behandelt Brüche automatisch. Fertigung von Verbandmaterial.',
      },
      {
        cost: [{ defId: 'mat_chem', count: 10 }, { defId: 'tool_solder', count: 1 }, { defId: 'mat_battery', count: 1 }],
        money: 400000, buildSeconds: 2700, requiresPower: 3,
        effect: 'Stellt zerstörte Gliedmaßen wieder her. Fertigung von Stimulanzien.',
      },
    ],
  },
  kitchen: {
    id: 'kitchen',
    name: 'Küche',
    description: 'Wasseraufbereitung und Verpflegung. Deckt den laufenden Bedarf ohne Beute.',
    levels: [
      {
        cost: [{ defId: 'mat_scrap', count: 3 }, { defId: 'mat_wire', count: 2 }],
        money: 22000, buildSeconds: 240, requiresPower: 1,
        effect: 'Produziert Wasser über die Zeit.',
      },
      {
        cost: [{ defId: 'mat_scrap', count: 8 }, { defId: 'mat_circuit', count: 1 }],
        money: 88000, buildSeconds: 900, requiresPower: 2,
        effect: 'Produziert zusätzlich Feldrationen.',
      },
    ],
  },
  security: {
    id: 'security',
    name: 'Sicherheitszentrale',
    description: 'Kontakte und Funkgeräte. Verbessert die Rückgabequote der Versicherung.',
    levels: [
      {
        cost: [{ defId: 'mat_wire', count: 4 }, { defId: 'mat_circuit', count: 2 }],
        money: 62000, buildSeconds: 600, requiresPower: 1,
        effect: 'Rückgabequote +12 %, Wartezeit -20 %.',
      },
      {
        cost: [{ defId: 'mat_circuit', count: 6 }, { defId: 'mat_battery', count: 1 }],
        money: 210000, buildSeconds: 1500, requiresPower: 2,
        effect: 'Rückgabequote +25 %, Wartezeit -40 %.',
      },
    ],
  },
};

export interface ModuleState {
  level: number;
  /** Seconds remaining on an in-progress upgrade, 0 when idle. */
  buildRemaining: number;
  /** Level being built, 0 when idle. */
  buildingLevel: number;
}

export class Hideout {
  readonly modules: Record<ModuleId, ModuleState>;

  constructor(private readonly bus: GameBus) {
    this.modules = {} as Record<ModuleId, ModuleState>;
    for (const id of Object.keys(HIDEOUT_MODULES) as ModuleId[]) {
      this.modules[id] = { level: 0, buildRemaining: 0, buildingLevel: 0 };
    }
  }

  levelOf(id: ModuleId): number {
    return this.modules[id].level;
  }

  /** The definition for the next level of a module, or null when maxed. */
  nextLevelDef(id: ModuleId): ModuleLevelDef | null {
    const def = HIDEOUT_MODULES[id];
    const state = this.modules[id];
    return state.level < def.levels.length ? def.levels[state.level] : null;
  }

  /** Why an upgrade cannot start, or null when it can. */
  upgradeBlocker(id: ModuleId, money: number, hasMaterials: (defId: string, count: number) => boolean): string | null {
    const state = this.modules[id];
    if (state.buildRemaining > 0) return 'Ausbau läuft bereits';
    const next = this.nextLevelDef(id);
    if (!next) return 'Höchststufe erreicht';
    if (this.levelOf('generator') < next.requiresPower) {
      return `Generator Stufe ${next.requiresPower} erforderlich`;
    }
    if (money < next.money) return 'Nicht genug Geld';
    for (const cost of next.cost) {
      if (!hasMaterials(cost.defId, cost.count)) return 'Material fehlt';
    }
    return null;
  }

  /** Begin an upgrade. The caller is responsible for deducting the cost. */
  startUpgrade(id: ModuleId): boolean {
    const next = this.nextLevelDef(id);
    const state = this.modules[id];
    if (!next || state.buildRemaining > 0) return false;
    state.buildRemaining = next.buildSeconds;
    state.buildingLevel = state.level + 1;
    return true;
  }

  /** Advance construction timers. Called with real elapsed seconds. */
  update(dtSeconds: number): void {
    for (const id of Object.keys(this.modules) as ModuleId[]) {
      const state = this.modules[id];
      if (state.buildRemaining <= 0) continue;
      state.buildRemaining -= dtSeconds;
      if (state.buildRemaining <= 0) {
        state.buildRemaining = 0;
        state.level = state.buildingLevel;
        state.buildingLevel = 0;
        this.bus.emit('hideout:upgraded', { moduleId: id, level: state.level });
        this.bus.emit('ui:notify', {
          text: `${HIDEOUT_MODULES[id].name.toUpperCase()} STUFE ${state.level} FERTIG`,
          tone: 'good',
          duration: 5,
        });
      }
    }
  }

  // --- derived effects ------------------------------------------------------

  /** Stash grid dimensions for the current Lager level. */
  get stashSize(): { width: number; height: number } {
    const heights = [8, 14, 20, 28];
    return { width: 10, height: heights[Math.min(this.levelOf('stash'), heights.length - 1)] };
  }

  /** Maximum condition weapon repair can reach, as a percentage. */
  get repairCeiling(): number {
    const level = this.levelOf('workshop');
    return level === 0 ? 0 : level === 1 ? 70 : level === 2 ? 88 : 96;
  }

  /** Insurance return rate bonus from the security module. */
  get insuranceBonus(): number {
    const level = this.levelOf('security');
    return level === 0 ? 0 : level === 1 ? 0.12 : 0.25;
  }

  /** Multiplier on insurance wait time. */
  get insuranceSpeed(): number {
    const level = this.levelOf('security');
    return level === 0 ? 1 : level === 1 ? 0.8 : 0.6;
  }

  /** Between-raid healing applied by the medical station. */
  get autoHealFraction(): number {
    const level = this.levelOf('medstation');
    return level === 0 ? 0 : level === 1 ? 0.45 : level === 2 ? 0.8 : 1;
  }

  get healsFractures(): boolean {
    return this.levelOf('medstation') >= 2;
  }

  get restoresLimbs(): boolean {
    return this.levelOf('medstation') >= 3;
  }

  /** Passive production per hour of real time, by item id. */
  passiveProduction(): { defId: string; perHour: number }[] {
    const out: { defId: string; perHour: number }[] = [];
    const kitchen = this.levelOf('kitchen');
    if (kitchen >= 1) out.push({ defId: 'drink_water', perHour: 2 });
    if (kitchen >= 2) out.push({ defId: 'food_ration', perHour: 1.5 });
    return out;
  }

  serialize(): Record<string, ModuleState> {
    return { ...this.modules };
  }

  restore(data: Record<string, ModuleState>): void {
    for (const id of Object.keys(HIDEOUT_MODULES) as ModuleId[]) {
      const src = data?.[id];
      if (src) this.modules[id] = { ...src };
    }
  }
}
