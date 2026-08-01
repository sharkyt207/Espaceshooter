import type { GameBus } from '../core/GameEvents';
import type { TraderId } from './Traders';

/**
 * Quests - trader tasks that direct where the player goes and how they play.
 *
 * Objectives are written to pull the player somewhere specific and make them
 * behave in a specific way: "kill five with headshots" changes how you engage,
 * "extract from the canal gate" changes your route, "hand over three medical
 * items" changes what you pick up. That is the point - a task list is the
 * game's way of suggesting a plan for the next raid.
 *
 * Objectives are evaluated against events, so adding a new objective type means
 * adding a case here and nothing else.
 */

export type ObjectiveKind =
  | 'kill'
  | 'killHeadshot'
  | 'killTier'
  | 'collect'
  | 'handover'
  | 'extract'
  | 'extractFrom'
  | 'survive'
  | 'reach'
  | 'loot';

export interface QuestObjective {
  id: string;
  kind: ObjectiveKind;
  description: string;
  target: number;
  /** Item id for collect/handover, tier for killTier, extract id for extractFrom. */
  param?: string;
  /** Location objectives: world position and radius in tiles. */
  x?: number;
  y?: number;
  radius?: number;
  /** Handover objectives consume the items from the stash. */
  consumes?: boolean;
}

export interface QuestDef {
  id: string;
  title: string;
  trader: TraderId;
  /** Narrative brief shown on the quest screen. */
  brief: string;
  /** Character level required to accept. */
  requiredLevel: number;
  /** Quest ids that must be complete first. */
  requires: string[];
  objectives: QuestObjective[];
  rewards: {
    xp: number;
    money: number;
    reputation: number;
    items?: { defId: string; count: number }[];
  };
}

export const QUESTS: QuestDef[] = [
  {
    id: 'q_first_blood',
    title: 'Erste Bestandsaufnahme',
    trader: 'kessler',
    brief:
      'Ich brauche belastbare Zahlen darüber, wie viele Streuner sich im Hafenbecken herumtreiben. ' +
      'Zähl sie für mich. Auf meine Art.',
    requiredLevel: 1,
    requires: [],
    objectives: [
      { id: 'o1', kind: 'killTier', description: 'Streuner ausschalten', target: 4, param: 'scavenger' },
      { id: 'o2', kind: 'extract', description: 'Lebend extrahieren', target: 1 },
    ],
    rewards: { xp: 900, money: 22000, reputation: 220, items: [{ defId: 'ammo_545_ps', count: 60 }] },
  },
  {
    id: 'q_supplies',
    title: 'Knappe Vorräte',
    trader: 'marek',
    brief:
      'Meine Regale sind leer und die Leute kommen trotzdem. Bring mir Verbandmaterial, ' +
      'egal woher. Ich frage nicht nach.',
    requiredLevel: 1,
    requires: [],
    objectives: [
      { id: 'o1', kind: 'handover', description: 'Verbandpäckchen abgeben', target: 3, param: 'med_bandage', consumes: true },
      { id: 'o2', kind: 'handover', description: 'Verbandstoff abgeben', target: 4, param: 'mat_cloth', consumes: true },
    ],
    rewards: { xp: 700, money: 16000, reputation: 260, items: [{ defId: 'med_ifak', count: 2 }] },
  },
  {
    id: 'q_valuables',
    title: 'Diskrete Ware',
    trader: 'zoellner',
    brief:
      'Es gibt Dinge, die im Hafen liegen und niemandem gehören. Bring mir drei davon, ' +
      'und wir reden über den Rest.',
    requiredLevel: 2,
    requires: ['q_first_blood'],
    objectives: [
      { id: 'o1', kind: 'loot', description: 'Wertgegenstände sichern', target: 3, param: 'valuable' },
      { id: 'o2', kind: 'extract', description: 'Mit der Ware extrahieren', target: 1 },
    ],
    rewards: { xp: 1400, money: 48000, reputation: 340 },
  },
  {
    id: 'q_precision',
    title: 'Ruhige Hand',
    trader: 'kessler',
    brief:
      'Jeder kann ein Magazin leerdrücken. Zeig mir, dass du zielen kannst. ' +
      'Drei Kopftreffer. Ich zähle mit.',
    requiredLevel: 3,
    requires: ['q_first_blood'],
    objectives: [
      { id: 'o1', kind: 'killHeadshot', description: 'Kopftreffer-Ausschaltungen', target: 3 },
      { id: 'o2', kind: 'extract', description: 'Lebend extrahieren', target: 1 },
    ],
    rewards: { xp: 1800, money: 34000, reputation: 400, items: [{ defId: 'att_reddot', count: 1 }] },
  },
  {
    id: 'q_canal',
    title: 'Der stille Ausgang',
    trader: 'sana',
    brief:
      'Der Kanalsteg ist verschlossen, aber irgendwo im Hafen liegt ein Schlüssel. ' +
      'Find ihn, benutz ihn, und melde dich bei mir.',
    requiredLevel: 3,
    requires: [],
    objectives: [
      { id: 'o1', kind: 'extractFrom', description: 'Über den Kanalsteg extrahieren', target: 1, param: 'ex_2' },
    ],
    rewards: { xp: 2200, money: 42000, reputation: 520, items: [{ defId: 'bp_medium', count: 1 }] },
  },
  {
    id: 'q_endurance',
    title: 'Lange Schicht',
    trader: 'marek',
    brief:
      'Ich will wissen, wie lange ein Mensch da draußen durchhält, bevor er Fehler macht. ' +
      'Bleib zwölf Minuten im Sektor. Am Stück.',
    requiredLevel: 4,
    requires: ['q_supplies'],
    objectives: [
      { id: 'o1', kind: 'survive', description: 'Sekunden im Einsatz überstehen', target: 720 },
      { id: 'o2', kind: 'extract', description: 'Danach extrahieren', target: 1 },
    ],
    rewards: { xp: 2600, money: 38000, reputation: 480, items: [{ defId: 'med_trauma', count: 1 }] },
  },
  {
    id: 'q_contractors',
    title: 'Konkurrenz',
    trader: 'kessler',
    brief:
      'Es laufen Söldner in meinem Sektor herum, die nicht für mich arbeiten. ' +
      'Das ist ein Zustand, den ich nicht schätze.',
    requiredLevel: 6,
    requires: ['q_precision'],
    objectives: [
      { id: 'o1', kind: 'killTier', description: 'Söldner ausschalten', target: 5, param: 'contractor' },
    ],
    rewards: { xp: 4200, money: 86000, reputation: 720, items: [{ defId: 'ammo_556_pen', count: 60 }] },
  },
  {
    id: 'q_datacore',
    title: 'Was im Tresor liegt',
    trader: 'zoellner',
    brief:
      'Irgendwo in der Lagerhalle liegt ein Datenkern. Er gehört nicht dir, er gehört nicht mir, ' +
      'aber einer von uns beiden sollte ihn haben.',
    requiredLevel: 8,
    requires: ['q_valuables'],
    objectives: [
      { id: 'o1', kind: 'handover', description: 'Datenkern abgeben', target: 1, param: 'val_datacore', consumes: true },
    ],
    rewards: { xp: 6800, money: 180000, reputation: 1100, items: [{ defId: 'sec_medium', count: 1 }] },
  },
  {
    id: 'q_commander',
    title: 'Kopf der Schlange',
    trader: 'sana',
    brief:
      'Vasska hält die Lagerhalle. Solange er lebt, kommt niemand von uns an das heran, was dort liegt. ' +
      'Beende das.',
    requiredLevel: 10,
    requires: ['q_contractors'],
    objectives: [
      { id: 'o1', kind: 'killTier', description: 'Kommandant Vasska ausschalten', target: 1, param: 'commander' },
      { id: 'o2', kind: 'extract', description: 'Lebend extrahieren', target: 1 },
    ],
    rewards: { xp: 12000, money: 320000, reputation: 2200, items: [{ defId: 'arm_plate_ceramic', count: 1 }] },
  },
];

export type QuestStatus = 'locked' | 'available' | 'active' | 'complete';

export interface QuestProgress {
  status: QuestStatus;
  /** Objective id -> progress count. */
  progress: Record<string, number>;
}

export class QuestSystem {
  readonly states = new Map<string, QuestProgress>();

  constructor(private readonly bus: GameBus) {
    for (const q of QUESTS) {
      this.states.set(q.id, { status: 'locked', progress: {} });
    }
  }

  /** Recompute which quests are offerable. Call after level-ups and completions. */
  refreshAvailability(playerLevel: number): void {
    for (const quest of QUESTS) {
      const state = this.states.get(quest.id)!;
      if (state.status === 'active' || state.status === 'complete') continue;
      const prereqsMet = quest.requires.every((id) => this.states.get(id)?.status === 'complete');
      state.status = prereqsMet && playerLevel >= quest.requiredLevel ? 'available' : 'locked';
    }
  }

  accept(questId: string): boolean {
    const state = this.states.get(questId);
    if (!state || state.status !== 'available') return false;
    state.status = 'active';
    state.progress = {};
    const quest = QUESTS.find((q) => q.id === questId);
    if (quest) {
      for (const obj of quest.objectives) state.progress[obj.id] = 0;
    }
    return true;
  }

  get activeQuests(): QuestDef[] {
    return QUESTS.filter((q) => this.states.get(q.id)?.status === 'active');
  }

  /**
   * Advance every active objective matching a kind and parameter.
   * Returns true when any progress was made.
   */
  advance(kind: ObjectiveKind, amount: number, param?: string): boolean {
    let changed = false;
    for (const quest of this.activeQuests) {
      const state = this.states.get(quest.id)!;
      for (const obj of quest.objectives) {
        if (obj.kind !== kind) continue;
        if (obj.param && param !== obj.param) continue;
        const current = state.progress[obj.id] ?? 0;
        if (current >= obj.target) continue;
        const next = Math.min(obj.target, current + amount);
        state.progress[obj.id] = next;
        changed = true;
        this.bus.emit('objective:updated', {
          questId: quest.id,
          objectiveId: obj.id,
          progress: next,
          target: obj.target,
        });
        if (next >= obj.target) {
          this.bus.emit('objective:completed', { questId: quest.id, objectiveId: obj.id });
        }
      }
    }
    return changed;
  }

  /**
   * Set (rather than increment) an objective's progress.
   * Used by "survive N seconds", where the value is a high-water mark rather
   * than a running total.
   */
  setProgress(kind: ObjectiveKind, value: number, param?: string): void {
    for (const quest of this.activeQuests) {
      const state = this.states.get(quest.id)!;
      for (const obj of quest.objectives) {
        if (obj.kind !== kind) continue;
        if (obj.param && param !== obj.param) continue;
        const current = state.progress[obj.id] ?? 0;
        if (value <= current) continue;
        state.progress[obj.id] = Math.min(obj.target, value);
        this.bus.emit('objective:updated', {
          questId: quest.id,
          objectiveId: obj.id,
          progress: state.progress[obj.id],
          target: obj.target,
        });
      }
    }
  }

  /** True when every objective of a quest is satisfied. */
  isComplete(questId: string): boolean {
    const quest = QUESTS.find((q) => q.id === questId);
    const state = this.states.get(questId);
    if (!quest || !state) return false;
    return quest.objectives.every((o) => (state.progress[o.id] ?? 0) >= o.target);
  }

  /** Quests whose objectives are all met and which are ready to hand in. */
  readyToTurnIn(): QuestDef[] {
    return this.activeQuests.filter((q) => this.isComplete(q.id));
  }

  turnIn(questId: string): QuestDef | null {
    const quest = QUESTS.find((q) => q.id === questId);
    const state = this.states.get(questId);
    if (!quest || !state || state.status !== 'active' || !this.isComplete(questId)) return null;
    state.status = 'complete';
    this.bus.emit('quest:completed', { questId, title: quest.title });
    return quest;
  }

  /**
   * Objectives lost when the player dies.
   *
   * Raid-scoped objectives (survive, extract, kill counts within the run) reset;
   * anything already banked - handovers, items in the stash - is kept. Losing
   * an entire quest to one bad raid would be punishment without a lesson.
   */
  onPlayerDeath(): void {
    for (const quest of this.activeQuests) {
      const state = this.states.get(quest.id)!;
      for (const obj of quest.objectives) {
        if (obj.kind === 'survive' || obj.kind === 'extract' || obj.kind === 'extractFrom') {
          state.progress[obj.id] = 0;
        }
      }
    }
  }

  serialize(): Record<string, QuestProgress> {
    const out: Record<string, QuestProgress> = {};
    for (const [id, state] of this.states) out[id] = state;
    return out;
  }

  restore(data: Record<string, QuestProgress>): void {
    for (const [id, state] of Object.entries(data ?? {})) {
      if (this.states.has(id)) this.states.set(id, state);
    }
  }
}
