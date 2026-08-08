/**
 * GameEvents - the single contract between simulation, audio and UI.
 *
 * Payloads deliberately carry primitives and ids rather than live object
 * references. That keeps this file dependency-free (no import cycles), makes
 * every event trivially serializable for replay/telemetry, and means the UI can
 * never accidentally mutate simulation state through an event payload.
 */

import { EventBus } from './EventBus';

/** Where a sound came from, and how loud - consumed by AI hearing and audio. */
export interface SoundEventPayload {
  x: number;
  y: number;
  /** World-units at which the sound becomes inaudible. */
  radius: number;
  /** 0..1 relative intensity, used for AI investigation priority. */
  intensity: number;
  kind: SoundKind;
  /** Actor id that produced it, so an actor never hears only itself. */
  sourceId: number;
}

export type SoundKind =
  | 'gunshot'
  | 'suppressed'
  | 'footstep'
  | 'sprint'
  | 'reload'
  | 'impact'
  | 'ricochet'
  | 'door'
  | 'container'
  | 'death'
  | 'explosion'
  | 'voice';

export interface DamagePayload {
  targetId: number;
  attackerId: number;
  amount: number;
  bodyPart: string;
  /** True when the round defeated armor rather than being stopped by it. */
  penetrated: boolean;
  isPlayer: boolean;
  x: number;
  y: number;
}

export interface NotificationPayload {
  text: string;
  tone: 'info' | 'good' | 'bad' | 'warn';
  /** Seconds on screen; the HUD queues these. */
  duration?: number;
}

/**
 * Every event in the game. Adding a key here is the intended way to let a new
 * system talk to UI/audio without a direct dependency.
 */
export interface GameEventMap {
  // --- combat -------------------------------------------------------------
  'sound:emit': SoundEventPayload;
  'damage:dealt': DamagePayload;
  'actor:killed': { actorId: number; killerId: number; isPlayer: boolean; name: string; x: number; y: number };
  'weapon:fired': { actorId: number; suppressed: boolean; x: number; y: number };
  'weapon:dryfire': { actorId: number };
  'weapon:reloadStart': { actorId: number; durationSec: number; tactical: boolean };
  'weapon:reloadEnd': { actorId: number };
  'weapon:jammed': { actorId: number };
  'weapon:modeChanged': { actorId: number; mode: string };

  // --- player state -------------------------------------------------------
  'player:hit': { amount: number; bodyPart: string; fromX: number; fromY: number };
  'player:bleedStart': { bodyPart: string; heavy: boolean };
  'player:fracture': { bodyPart: string };
  'player:blackout': { bodyPart: string };
  'player:healed': { bodyPart: string; amount: number };
  'player:died': { cause: string };
  'player:stanceChanged': { stance: string };
  'player:levelUp': { level: number };
  'player:skillUp': { skill: string; level: number };
  'player:xp': { amount: number; reason: string };

  // --- interaction / loot -------------------------------------------------
  'loot:opened': { containerId: number; name: string };
  'loot:taken': { itemDefId: string; count: number; rarity: string };
  'inventory:changed': Record<string, never>;
  'inventory:full': { itemDefId: string };

  // --- raid ---------------------------------------------------------------
  'raid:started': { mapId: string; seed: number };
  'raid:extractAvailable': { extractId: string; name: string };
  'raid:extracting': { extractId: string; secondsLeft: number };
  'raid:extractCancelled': Record<string, never>;
  'raid:ended': { survived: boolean; reason: string };
  'raid:timeWarning': { secondsLeft: number };
  'raid:event': { id: string; title: string; description: string };
  'objective:updated': { questId: string; objectiveId: string; progress: number; target: number };
  'objective:completed': { questId: string; objectiveId: string };
  'quest:completed': { questId: string; title: string };

  // --- meta ---------------------------------------------------------------
  'craft:started': { recipeId: string; seconds: number };
  'craft:finished': { recipeId: string };
  'hideout:upgraded': { moduleId: string; level: number };
  'trader:transaction': { traderId: string; delta: number };
  'insurance:returned': { count: number };

  // --- presentation -------------------------------------------------------
  'ui:notify': NotificationPayload;
  'ui:screen': { screen: string };
  'fx:screenShake': { intensity: number; duration: number };
}

export type GameBus = EventBus<GameEventMap>;

/** Process-wide bus. Systems receive it by injection; this is the default wiring. */
export const bus: GameBus = new EventBus<GameEventMap>();
