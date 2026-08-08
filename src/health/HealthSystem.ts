import type { GameBus } from '../core/GameEvents';
import { BODY_PARTS, BODY_PART_LABEL, type BodyPart } from '../data/ItemTypes';
import { clamp } from '../core/Math2D';

/**
 * HealthSystem - per-body-part health, bleeding, fractures, pain and metabolism.
 *
 * The design goal is that *being hurt changes how you play*, not just how big a
 * number is. Concretely:
 *
 *   - Health is per limb. A leg hit slows you; an arm hit ruins your aim.
 *     There is no single pool to top up.
 *   - Blacked-out limbs never heal in the field. Only a surgical kit brings
 *     one back, and only partially - so a bad fight has consequences that
 *     follow you to the extract.
 *   - Bleeding is a timer, not a debuff. A heavy bleed kills in about a minute,
 *     which is exactly long enough to make "treat now or run now" a decision.
 *   - Energy and hydration decay slowly and only bite on long raids, punishing
 *     hoarding without micromanaging the player.
 *
 * Head and thorax are lethal when destroyed; every other limb blacks out and
 * bleeds damage into the thorax instead, which keeps deaths readable.
 */

export interface BodyPartState {
  hp: number;
  max: number;
  /** Light bleeds tick slowly; heavy bleeds are an emergency. */
  lightBleeds: number;
  heavyBleeds: number;
  fractured: boolean;
  /** Once destroyed, a limb stays destroyed until surgery. */
  blackedOut: boolean;
}

export interface HealthModifiers {
  /** Movement speed multiplier from leg damage, fractures and pain. */
  speed: number;
  /** Weapon sway multiplier from arm damage and pain. */
  sway: number;
  /** Stamina drain multiplier. */
  staminaDrain: number;
  /** Stamina regeneration multiplier. */
  staminaRegen: number;
  /** 0..1 desaturation/vignette strength for the post-processing pass. */
  painIntensity: number;
}

/** Starting health per part. Deliberately asymmetric - the head is fragile. */
const MAX_HP: Record<BodyPart, number> = {
  head: 35,
  thorax: 85,
  stomach: 70,
  leftArm: 60,
  rightArm: 60,
  leftLeg: 65,
  rightLeg: 65,
};

/** Damage per second per bleed instance. */
const LIGHT_BLEED_DPS = 0.55;
const HEAVY_BLEED_DPS = 2.4;
/** Damage a blacked-out limb feeds into the thorax each second. */
const BLACKOUT_THORAX_DPS = 0.6;
/** Fraction of damage to a destroyed limb that carries over to the thorax. */
const BLACKOUT_CARRYOVER = 0.5;

export class HealthSystem {
  readonly parts: Record<BodyPart, BodyPartState>;

  /** 0..100. Below 20 stamina regeneration suffers; at 0 health drains. */
  energy = 100;
  hydration = 100;

  /** Seconds of painkiller effect remaining. */
  painkillerSec = 0;
  /** Untreated pain level 0..1, driven by fresh wounds and fractures. */
  pain = 0;

  /** Temporary stamina regeneration bonus from stimulants. */
  stimStaminaRegen = 0;
  private stimSec = 0;

  dead = false;
  causeOfDeath = '';

  private readonly mods: HealthModifiers = {
    speed: 1, sway: 1, staminaDrain: 1, staminaRegen: 1, painIntensity: 0,
  };
  private modsDirty = true;

  constructor(private readonly bus: GameBus, private readonly isPlayer: boolean) {
    this.parts = {} as Record<BodyPart, BodyPartState>;
    for (const part of BODY_PARTS) {
      this.parts[part] = {
        hp: MAX_HP[part],
        max: MAX_HP[part],
        lightBleeds: 0,
        heavyBleeds: 0,
        fractured: false,
        blackedOut: false,
      };
    }
  }

  reset(): void {
    for (const part of BODY_PARTS) {
      const p = this.parts[part];
      p.hp = p.max;
      p.lightBleeds = 0;
      p.heavyBleeds = 0;
      p.fractured = false;
      p.blackedOut = false;
    }
    this.energy = 100;
    this.hydration = 100;
    this.painkillerSec = 0;
    this.pain = 0;
    this.stimStaminaRegen = 0;
    this.stimSec = 0;
    this.dead = false;
    this.causeOfDeath = '';
    this.modsDirty = true;
  }

  /** Sum of current health across all parts - the number shown on the HUD. */
  get totalHp(): number {
    let sum = 0;
    for (const part of BODY_PARTS) sum += this.parts[part].hp;
    return sum;
  }

  get totalMaxHp(): number {
    let sum = 0;
    for (const part of BODY_PARTS) sum += this.parts[part].max;
    return sum;
  }

  get hasAnyBleed(): boolean {
    for (const part of BODY_PARTS) {
      const p = this.parts[part];
      if (p.lightBleeds > 0 || p.heavyBleeds > 0) return true;
    }
    return false;
  }

  get hasHeavyBleed(): boolean {
    for (const part of BODY_PARTS) {
      if (this.parts[part].heavyBleeds > 0) return true;
    }
    return false;
  }

  get hasFracture(): boolean {
    for (const part of BODY_PARTS) {
      if (this.parts[part].fractured) return true;
    }
    return false;
  }

  // =========================================================================
  // Damage
  // =========================================================================

  /**
   * Apply damage to a body part.
   *
   * `bleedChance` and `fractureChance` come from the ballistics layer: a
   * fragmenting round bleeds far more than a clean pass-through, and only
   * heavy calibres and falls break bones.
   */
  applyDamage(
    part: BodyPart,
    amount: number,
    opts: { bleedChance?: number; heavyBleedChance?: number; fractureChance?: number; roll?: () => number } = {},
  ): void {
    if (this.dead || amount <= 0) return;
    const roll = opts.roll ?? Math.random;
    const state = this.parts[part];

    if (state.blackedOut) {
      // Hits on a destroyed limb still hurt - they just travel inward.
      this.applyDamage('thorax', amount * BLACKOUT_CARRYOVER, { roll });
      return;
    }

    state.hp = Math.max(0, state.hp - amount);
    // Pain scales with the fraction of the limb removed by this hit.
    this.pain = clamp(this.pain + (amount / state.max) * 0.8, 0, 1);
    this.modsDirty = true;

    if (opts.heavyBleedChance && roll() < opts.heavyBleedChance) {
      state.heavyBleeds++;
      if (this.isPlayer) this.bus.emit('player:bleedStart', { bodyPart: part, heavy: true });
    } else if (opts.bleedChance && roll() < opts.bleedChance) {
      state.lightBleeds++;
      if (this.isPlayer) this.bus.emit('player:bleedStart', { bodyPart: part, heavy: false });
    }

    // Only limbs fracture; a fractured torso is not a mechanic we model.
    if (opts.fractureChance && !state.fractured && part !== 'head' && part !== 'thorax' && part !== 'stomach') {
      if (roll() < opts.fractureChance) {
        state.fractured = true;
        this.pain = clamp(this.pain + 0.35, 0, 1);
        if (this.isPlayer) this.bus.emit('player:fracture', { bodyPart: part });
      }
    }

    if (state.hp <= 0) this.onPartDestroyed(part);
  }

  private onPartDestroyed(part: BodyPart): void {
    const state = this.parts[part];
    if (state.blackedOut) return;
    state.blackedOut = true;
    this.modsDirty = true;

    if (part === 'head' || part === 'thorax') {
      this.kill(part === 'head' ? 'Kopfschuss' : 'Brustdurchschuss');
      return;
    }
    // Destroying the stomach does not kill outright but wrecks metabolism.
    if (part === 'stomach') {
      this.energy = Math.min(this.energy, 30);
      this.hydration = Math.min(this.hydration, 30);
    }
    this.pain = 1;
    if (this.isPlayer) this.bus.emit('player:blackout', { bodyPart: part });
  }

  kill(cause: string): void {
    if (this.dead) return;
    this.dead = true;
    this.causeOfDeath = cause;
    if (this.isPlayer) this.bus.emit('player:died', { cause });
  }

  // =========================================================================
  // Per-tick simulation
  // =========================================================================

  update(dt: number): void {
    if (this.dead) return;

    // --- bleeding ---------------------------------------------------------
    let bleedDamage = 0;
    for (const part of BODY_PARTS) {
      const p = this.parts[part];
      if (p.lightBleeds > 0) bleedDamage += p.lightBleeds * LIGHT_BLEED_DPS * dt;
      if (p.heavyBleeds > 0) bleedDamage += p.heavyBleeds * HEAVY_BLEED_DPS * dt;
    }
    if (bleedDamage > 0) {
      // Bleeding drains the thorax regardless of where the wound is: that is
      // what makes an untreated leg bleed lethal instead of merely annoying.
      this.drainPart('thorax', bleedDamage, 'Verblutet');
    }

    // --- blacked-out limbs ------------------------------------------------
    let blackoutDamage = 0;
    for (const part of BODY_PARTS) {
      if (part === 'thorax' || part === 'head') continue;
      if (this.parts[part].blackedOut) blackoutDamage += BLACKOUT_THORAX_DPS * dt;
    }
    if (blackoutDamage > 0) this.drainPart('thorax', blackoutDamage, 'Verletzungen erlegen');

    // --- metabolism -------------------------------------------------------
    // Tuned so a full 25-minute raid consumes roughly two thirds of a full
    // bar: noticeable on long runs, irrelevant on short ones.
    this.energy = Math.max(0, this.energy - 0.042 * dt);
    this.hydration = Math.max(0, this.hydration - 0.055 * dt);
    if (this.energy <= 0 || this.hydration <= 0) {
      const starve = (this.energy <= 0 ? 0.55 : 0) + (this.hydration <= 0 ? 0.7 : 0);
      this.drainPart('thorax', starve * dt, this.hydration <= 0 ? 'Dehydriert' : 'Verhungert');
    }

    // --- timers -----------------------------------------------------------
    if (this.painkillerSec > 0) {
      this.painkillerSec = Math.max(0, this.painkillerSec - dt);
      if (this.painkillerSec === 0) this.modsDirty = true;
    }
    if (this.stimSec > 0) {
      this.stimSec = Math.max(0, this.stimSec - dt);
      if (this.stimSec === 0) {
        this.stimStaminaRegen = 0;
        this.modsDirty = true;
      }
    }
    // Pain fades on its own, slowly, so a single graze does not linger.
    if (this.pain > 0) {
      const target = this.hasFracture ? 0.35 : 0;
      if (this.pain > target) {
        this.pain = Math.max(target, this.pain - 0.055 * dt);
        this.modsDirty = true;
      }
    }
  }

  private drainPart(part: BodyPart, amount: number, cause: string): void {
    const p = this.parts[part];
    p.hp = Math.max(0, p.hp - amount);
    this.modsDirty = true;
    if (p.hp <= 0 && !p.blackedOut) {
      p.blackedOut = true;
      if (part === 'thorax' || part === 'head') this.kill(cause);
    }
  }

  // =========================================================================
  // Treatment
  // =========================================================================

  /** Heal a part, or spread healing across the worst-injured parts. */
  heal(amount: number, part?: BodyPart): number {
    let used = 0;
    if (part) {
      const p = this.parts[part];
      if (p.blackedOut) return 0; // needs surgery, not a bandage
      const applied = Math.min(amount, p.max - p.hp);
      p.hp += applied;
      used = applied;
    } else {
      // Triage: always treat the most damaged living part first.
      let remaining = amount;
      for (let guard = 0; guard < BODY_PARTS.length && remaining > 0.01; guard++) {
        let worst: BodyPart | null = null;
        let worstDeficit = 0;
        for (const bp of BODY_PARTS) {
          const p = this.parts[bp];
          if (p.blackedOut) continue;
          const deficit = p.max - p.hp;
          if (deficit > worstDeficit) {
            worstDeficit = deficit;
            worst = bp;
          }
        }
        if (!worst) break;
        const applied = Math.min(remaining, worstDeficit);
        this.parts[worst].hp += applied;
        remaining -= applied;
        used += applied;
      }
    }
    if (used > 0) {
      this.pain = Math.max(0, this.pain - used * 0.004);
      this.modsDirty = true;
      if (this.isPlayer && part) this.bus.emit('player:healed', { bodyPart: part, amount: used });
    }
    return used;
  }

  /** Stop one bleed. Heavy bleeds require the heavy-capable item. */
  stopBleed(heavy: boolean): boolean {
    for (const part of BODY_PARTS) {
      const p = this.parts[part];
      if (heavy && p.heavyBleeds > 0) {
        p.heavyBleeds--;
        return true;
      }
      if (!heavy && p.lightBleeds > 0) {
        p.lightBleeds--;
        return true;
      }
    }
    return false;
  }

  fixFracture(): boolean {
    for (const part of BODY_PARTS) {
      if (this.parts[part].fractured) {
        this.parts[part].fractured = false;
        this.pain = Math.max(0, this.pain - 0.3);
        this.modsDirty = true;
        return true;
      }
    }
    return false;
  }

  applyPainkiller(durationSec: number): void {
    this.painkillerSec = Math.max(this.painkillerSec, durationSec);
    this.modsDirty = true;
  }

  applyStimulant(staminaRegen: number, durationSec: number): void {
    this.stimStaminaRegen = Math.max(this.stimStaminaRegen, staminaRegen);
    this.stimSec = Math.max(this.stimSec, durationSec);
    this.modsDirty = true;
  }

  addEnergy(amount: number): void {
    this.energy = clamp(this.energy + amount, 0, 100);
  }

  addHydration(amount: number): void {
    this.hydration = clamp(this.hydration + amount, 0, 100);
  }

  /** Surgery: restore a destroyed limb to a fraction of its maximum. */
  performSurgery(restoreFraction: number): BodyPart | null {
    for (const part of BODY_PARTS) {
      const p = this.parts[part];
      if (!p.blackedOut) continue;
      if (part === 'head' || part === 'thorax') continue; // those are fatal
      p.blackedOut = false;
      p.hp = Math.max(1, p.max * restoreFraction);
      this.modsDirty = true;
      return part;
    }
    return null;
  }

  // =========================================================================
  // Derived modifiers
  // =========================================================================

  get modifiers(): HealthModifiers {
    if (this.modsDirty) this.recompute();
    return this.mods;
  }

  private recompute(): void {
    const legL = this.parts.leftLeg;
    const legR = this.parts.rightLeg;
    const armL = this.parts.leftArm;
    const armR = this.parts.rightArm;

    // --- speed: legs -------------------------------------------------------
    let speed = 1;
    for (const leg of [legL, legR]) {
      if (leg.blackedOut) speed *= 0.55;
      else {
        const ratio = leg.hp / leg.max;
        // Only the last third of leg health starts to matter.
        if (ratio < 0.65) speed *= 0.78 + 0.22 * (ratio / 0.65);
      }
      if (leg.fractured) speed *= 0.6;
    }

    // --- sway: arms --------------------------------------------------------
    let sway = 1;
    for (const arm of [armL, armR]) {
      if (arm.blackedOut) sway *= 1.85;
      else {
        const ratio = arm.hp / arm.max;
        if (ratio < 0.7) sway *= 1 + (0.7 - ratio) * 1.1;
      }
      if (arm.fractured) sway *= 1.9;
    }

    // --- pain --------------------------------------------------------------
    const effectivePain = this.painkillerSec > 0 ? this.pain * 0.15 : this.pain;
    speed *= 1 - effectivePain * 0.22;
    sway *= 1 + effectivePain * 0.55;

    // Painkillers mask the movement penalty of a fracture without fixing it.
    if (this.painkillerSec > 0 && this.hasFracture) speed *= 1.35;

    // --- stamina -----------------------------------------------------------
    let staminaDrain = 1;
    let staminaRegen = 1 + this.stimStaminaRegen;
    if (this.energy < 25) staminaRegen *= 0.4 + 0.6 * (this.energy / 25);
    if (this.hydration < 25) staminaDrain *= 1.6 - 0.6 * (this.hydration / 25);
    if (legL.blackedOut || legR.blackedOut) staminaDrain *= 1.4;

    this.mods.speed = clamp(speed, 0.28, 1);
    this.mods.sway = clamp(sway, 1, 4);
    this.mods.staminaDrain = staminaDrain;
    this.mods.staminaRegen = staminaRegen;
    this.mods.painIntensity = effectivePain;
    this.modsDirty = false;
  }

  /** Short status line for the HUD: the most urgent thing wrong with you. */
  statusSummary(): string | null {
    if (this.hasHeavyBleed) return 'STARKE BLUTUNG';
    for (const part of BODY_PARTS) {
      if (this.parts[part].fractured) return `BRUCH: ${BODY_PART_LABEL[part].toUpperCase()}`;
    }
    if (this.hasAnyBleed) return 'BLUTUNG';
    if (this.hydration < 15) return 'DEHYDRIERT';
    if (this.energy < 15) return 'ERSCHÖPFT';
    for (const part of BODY_PARTS) {
      if (this.parts[part].blackedOut) return `${BODY_PART_LABEL[part].toUpperCase()} ZERSTÖRT`;
    }
    return null;
  }

  /** Serializable snapshot for the save system. */
  serialize(): Record<string, unknown> {
    return {
      parts: this.parts,
      energy: this.energy,
      hydration: this.hydration,
    };
  }

  restore(data: { parts?: Record<string, BodyPartState>; energy?: number; hydration?: number }): void {
    if (data.parts) {
      for (const part of BODY_PARTS) {
        const src = data.parts[part];
        if (src) Object.assign(this.parts[part], src);
      }
    }
    if (typeof data.energy === 'number') this.energy = data.energy;
    if (typeof data.hydration === 'number') this.hydration = data.hydration;
    this.dead = this.parts.head.hp <= 0 || this.parts.thorax.hp <= 0;
    this.modsDirty = true;
  }
}
