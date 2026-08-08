import type { GameBus } from '../core/GameEvents';
import { clamp01 } from '../core/Math2D';

/**
 * Progression - character level and skills.
 *
 * Two separate curves, on purpose:
 *
 *   **Level** is the broad gate. It unlocks trader tiers and hideout modules,
 *   and it comes from doing anything at all - surviving, extracting, killing,
 *   completing tasks. It is the "how long have you played" axis.
 *
 *   **Skills** improve through *use*, not through spending points. You get
 *   better at controlling recoil by firing, better at carrying weight by
 *   carrying weight. This keeps the build implicit: your character becomes
 *   whatever you actually do, and there is no wrong allocation to regret.
 *
 * Skill effects are intentionally modest (a 20-30% swing at maximum). They
 * should smooth the rough edges of a playstyle, never replace positioning and
 * preparation as the thing that decides a fight.
 */

export type SkillId =
  | 'endurance'
  | 'strength'
  | 'recoilControl'
  | 'weaponHandling'
  | 'scavenging'
  | 'medical'
  | 'stealth'
  | 'vitality'
  | 'perception';

export interface SkillDef {
  id: SkillId;
  name: string;
  description: string;
  /** Experience needed per level; skills cap at MAX_SKILL_LEVEL. */
  xpPerLevel: number;
}

export const MAX_SKILL_LEVEL = 20;

export const SKILLS: Record<SkillId, SkillDef> = {
  endurance: {
    id: 'endurance', name: 'Ausdauer', xpPerLevel: 260,
    description: 'Mehr Ausdauer und schnellere Regeneration. Steigt durch Sprinten.',
  },
  strength: {
    id: 'strength', name: 'Kraft', xpPerLevel: 320,
    description: 'Höhere Traglast, bevor das Gewicht dich ausbremst. Steigt durch schweres Tragen.',
  },
  recoilControl: {
    id: 'recoilControl', name: 'Rückstoßkontrolle', xpPerLevel: 300,
    description: 'Weniger Hochschlag, schnelleres Zurückführen. Steigt durch Schüsse im Ziel.',
  },
  weaponHandling: {
    id: 'weaponHandling', name: 'Waffenführung', xpPerLevel: 280,
    description: 'Schnelleres Anschlagen, Wechseln und Nachladen. Steigt durch Waffenhandhabung.',
  },
  scavenging: {
    id: 'scavenging', name: 'Plündern', xpPerLevel: 220,
    description: 'Schnelleres Durchsuchen von Behältern. Steigt durch Looten.',
  },
  medical: {
    id: 'medical', name: 'Medizin', xpPerLevel: 240,
    description: 'Schnellere Behandlung und effizientere Medikamente. Steigt durch Heilen.',
  },
  stealth: {
    id: 'stealth', name: 'Tarnung', xpPerLevel: 260,
    description: 'Leisere Schritte und geringere Sichtbarkeit. Steigt durch geducktes Bewegen.',
  },
  vitality: {
    id: 'vitality', name: 'Konstitution', xpPerLevel: 340,
    description: 'Geringere Blutungswahrscheinlichkeit und langsamerer Blutverlust. Steigt durch Verletzungen.',
  },
  perception: {
    id: 'perception', name: 'Wahrnehmung', xpPerLevel: 250,
    description: 'Größere Reichweite für Beute- und Gegnermarkierungen. Steigt durch Erkunden.',
  },
};

export interface SkillState {
  level: number;
  xp: number;
}

/** Total experience required to reach a character level. */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  // Superlinear but not punishing: level 10 is a few dozen raids, not hundreds.
  return Math.round(900 * Math.pow(level - 1, 1.42));
}

export function levelForXp(xp: number): number {
  let level = 1;
  while (level < 60 && xp >= xpForLevel(level + 1)) level++;
  return level;
}

export class Progression {
  xp = 0;
  level = 1;
  readonly skills: Record<SkillId, SkillState>;

  constructor(private readonly bus: GameBus) {
    this.skills = {} as Record<SkillId, SkillState>;
    for (const id of Object.keys(SKILLS) as SkillId[]) {
      this.skills[id] = { level: 0, xp: 0 };
    }
  }

  addXp(amount: number, reason: string): void {
    if (amount <= 0) return;
    this.xp += amount;
    this.bus.emit('player:xp', { amount, reason });
    const newLevel = levelForXp(this.xp);
    if (newLevel > this.level) {
      this.level = newLevel;
      this.bus.emit('player:levelUp', { level: newLevel });
      this.bus.emit('ui:notify', { text: `STUFE ${newLevel} ERREICHT`, tone: 'good', duration: 4 });
    }
  }

  /** Progress towards the next character level, 0..1. */
  get levelProgress(): number {
    const current = xpForLevel(this.level);
    const next = xpForLevel(this.level + 1);
    return next > current ? clamp01((this.xp - current) / (next - current)) : 0;
  }

  /**
   * Award skill experience. Called from gameplay in small amounts, often -
   * the accumulation is what makes the progression feel earned rather than
   * granted.
   */
  addSkillXp(id: SkillId, amount: number): void {
    if (amount <= 0) return;
    const state = this.skills[id];
    if (state.level >= MAX_SKILL_LEVEL) return;
    state.xp += amount;
    const perLevel = SKILLS[id].xpPerLevel;
    while (state.xp >= perLevel * (state.level + 1) && state.level < MAX_SKILL_LEVEL) {
      state.xp -= perLevel * (state.level + 1);
      state.level++;
      this.bus.emit('player:skillUp', { skill: SKILLS[id].name, level: state.level });
      this.bus.emit('ui:notify', {
        text: `${SKILLS[id].name.toUpperCase()} STUFE ${state.level}`,
        tone: 'good',
        duration: 3,
      });
    }
  }

  /** Normalised skill strength, 0..1. All effect formulas use this. */
  factor(id: SkillId): number {
    return this.skills[id].level / MAX_SKILL_LEVEL;
  }

  // --- derived effects ------------------------------------------------------

  /** Extra stamina capacity above the base 100. */
  get maxStaminaBonus(): number {
    return this.factor('endurance') * 45;
  }

  /** Additional kilograms carried before the weight penalty starts. */
  get carryBonusKg(): number {
    return this.factor('strength') * 14;
  }

  /** Multiplier on container search duration. */
  get searchTimeMultiplier(): number {
    return 1 - this.factor('scavenging') * 0.45;
  }

  /** Multiplier on medical item use duration. */
  get medicalTimeMultiplier(): number {
    return 1 - this.factor('medical') * 0.4;
  }

  /** Multiplier on footstep loudness. */
  get noiseMultiplier(): number {
    return 1 - this.factor('stealth') * 0.35;
  }

  /** Multiplier on bleed chance from wounds. */
  get bleedResistance(): number {
    return 1 - this.factor('vitality') * 0.4;
  }

  /** Extra tiles at which the world highlights loot and contacts. */
  get perceptionRangeBonus(): number {
    return this.factor('perception') * 6;
  }

  serialize(): Record<string, unknown> {
    return { xp: this.xp, level: this.level, skills: this.skills };
  }

  restore(data: { xp?: number; level?: number; skills?: Partial<Record<SkillId, SkillState>> }): void {
    this.xp = data.xp ?? 0;
    this.level = data.level ?? levelForXp(this.xp);
    if (data.skills) {
      for (const id of Object.keys(SKILLS) as SkillId[]) {
        const src = data.skills[id];
        if (src) this.skills[id] = { level: src.level ?? 0, xp: src.xp ?? 0 };
      }
    }
  }
}
