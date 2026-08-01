import { nextActorId } from '../core/Ids';
import type { GameBus } from '../core/GameEvents';
import { clamp, clamp01, damp, wrapAngle } from '../core/Math2D';
import { HealthSystem } from '../health/HealthSystem';
import { Inventory } from '../inventory/Inventory';
import { METERS_PER_TILE, TileMap, TILE_DEFS } from '../world/TileMap';
import { moveCircle } from '../world/Physics';
import type { Combatant } from '../combat/Combatant';
import type { BodyPart } from '../data/ItemTypes';

/**
 * Player - the locally controlled operator.
 *
 * Movement is built around three coupled resources, because that coupling is
 * what makes a hardcore extraction shooter tense rather than merely slow:
 *
 *   weight  -> speed and stamina drain. Greed literally slows you down.
 *   stamina -> sprinting, and the steadiness of your aim afterwards.
 *   health  -> leg damage caps speed, arm damage widens your cone.
 *
 * Nothing here is a hard gate: an overloaded, exhausted, wounded player can
 * still crawl to the extract. They will just be loud, slow and easy to hear -
 * and being heard is the actual failure state.
 */

export type Stance = 0 | 1 | 2; // prone, crouched, standing

/** Movement speeds in tiles/second at full stamina and no load. */
const SPEED_BY_STANCE: Record<Stance, number> = { 0: 0.55, 1: 1.15, 2: 2.05 };
const SPRINT_MULTIPLIER = 1.85;
/** Eye height in metres per stance. */
const EYE_HEIGHT_BY_STANCE: Record<Stance, number> = { 0: 0.45, 1: 1.05, 2: 1.62 };
/** Silhouette height in metres per stance - what bullets test against. */
const BODY_HEIGHT_BY_STANCE: Record<Stance, number> = { 0: 0.6, 1: 1.25, 2: 1.8 };

/** Load in kg below which there is no penalty at all. */
const FREE_CARRY_KG = 22;
/** Load at which the player can barely move. */
const MAX_CARRY_KG = 68;

export class Player implements Combatant {
  readonly id = nextActorId();
  readonly isPlayer = true;
  readonly name = 'Operator';
  readonly radius = 0.28;

  x = 0;
  y = 0;
  angle = 0;
  /** Aim elevation in radians, clamped to a human neck. */
  pitch = 0;

  stance: Stance = 2;
  height = BODY_HEIGHT_BY_STANCE[2];
  eyeHeight = EYE_HEIGHT_BY_STANCE[2];

  /** Lean offset -1..1, used for peeking around cover. */
  lean = 0;
  private leanTarget = 0;

  /** 0..100. */
  stamina = 100;
  private staminaLockout = 0;

  /** Ground speed in tiles/sec, measured after collision. */
  speed = 0;
  sprinting = false;

  readonly health: HealthSystem;
  readonly inventory = new Inventory();

  /** Accumulated distance since the last footstep sound. */
  private stepAccumulator = 0;
  /** Bob phase for the viewmodel and camera. */
  bobPhase = 0;

  /** Set while an interaction (looting, healing) is in progress. */
  busySeconds = 0;
  busyLabel = '';
  private busyOnComplete: (() => void) | null = null;

  constructor(private readonly bus: GameBus) {
    this.health = new HealthSystem(bus, true);
  }

  get alive(): boolean {
    return !this.health.dead;
  }

  reset(x: number, y: number, angle: number): void {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.pitch = 0;
    this.stance = 2;
    this.lean = 0;
    this.leanTarget = 0;
    this.stamina = 100;
    this.staminaLockout = 0;
    this.speed = 0;
    this.sprinting = false;
    this.stepAccumulator = 0;
    this.busySeconds = 0;
    this.busyOnComplete = null;
    this.applyStance();
  }

  // =========================================================================
  // Stance & lean
  // =========================================================================

  setStance(stance: Stance): void {
    if (this.stance === stance) return;
    // Going prone with a leg fracture is fine; getting up again is not free,
    // but we do not block it - being unable to move is never fun.
    this.stance = stance;
    this.applyStance();
    this.bus.emit('player:stanceChanged', { stance: ['liegend', 'geduckt', 'stehend'][stance] });
  }

  cycleStance(): void {
    this.setStance(this.stance === 2 ? 1 : this.stance === 1 ? 0 : 2);
  }

  private applyStance(): void {
    this.height = BODY_HEIGHT_BY_STANCE[this.stance];
  }

  setLean(target: number): void {
    this.leanTarget = clamp(target, -1, 1);
  }

  // =========================================================================
  // Carry load
  // =========================================================================

  /** 0 = unencumbered, 1 = at the practical carry limit. */
  get loadFactor(): number {
    const w = this.inventory.stats.weight;
    return clamp01((w - FREE_CARRY_KG) / (MAX_CARRY_KG - FREE_CARRY_KG));
  }

  get carriedWeight(): number {
    return this.inventory.stats.weight;
  }

  get overloaded(): boolean {
    return this.inventory.stats.weight > MAX_CARRY_KG;
  }

  // =========================================================================
  // Interaction lock
  // =========================================================================

  /** Begin a timed action. Moving or taking damage cancels it. */
  beginAction(seconds: number, label: string, onComplete: () => void): void {
    this.busySeconds = seconds;
    this.busyLabel = label;
    this.busyOnComplete = onComplete;
  }

  cancelAction(): void {
    this.busySeconds = 0;
    this.busyLabel = '';
    this.busyOnComplete = null;
  }

  get isBusy(): boolean {
    return this.busySeconds > 0;
  }

  // =========================================================================
  // Per-tick update
  // =========================================================================

  /**
   * @param moveX  strafe input -1..1 (right positive)
   * @param moveY  forward input -1..1 (forward positive)
   * @param wantSprint  sprint requested this tick
   */
  update(
    dt: number,
    map: TileMap,
    moveX: number,
    moveY: number,
    wantSprint: boolean,
  ): void {
    this.health.update(dt);
    if (!this.alive) {
      this.speed = 0;
      return;
    }

    // --- timed actions ----------------------------------------------------
    if (this.busySeconds > 0) {
      this.busySeconds -= dt;
      if (this.busySeconds <= 0) {
        const done = this.busyOnComplete;
        this.busySeconds = 0;
        this.busyLabel = '';
        this.busyOnComplete = null;
        done?.();
      }
      // Actions root the player: you cannot bandage on the move.
      moveX = 0;
      moveY = 0;
    }

    // --- lean --------------------------------------------------------------
    this.lean = damp(this.lean, this.leanTarget, 11, dt);

    // --- desired velocity --------------------------------------------------
    const inputMag = Math.hypot(moveX, moveY);
    const mods = this.health.modifiers;

    // Sprinting requires stamina, a forward input, and standing or crouched.
    const canSprint =
      wantSprint &&
      inputMag > 0.55 &&
      moveY > 0.35 &&
      this.stance === 2 &&
      this.stamina > 3 &&
      this.staminaLockout <= 0 &&
      !this.overloaded;
    this.sprinting = canSprint;

    // Load slows you down hard at the top end - the last 10 kg hurt most.
    const loadPenalty = 1 - this.loadFactor * this.loadFactor * 0.5;
    const staminaPenalty = this.stamina < 20 ? 0.68 + 0.32 * (this.stamina / 20) : 1;

    let speed = SPEED_BY_STANCE[this.stance] * mods.speed * loadPenalty * staminaPenalty;
    speed *= this.inventory.stats.speedFactor;
    if (canSprint) speed *= SPRINT_MULTIPLIER;

    // Strafing and backpedalling are slower than moving forward.
    let directionScale = 1;
    if (inputMag > 0.01) {
      const forwardness = moveY / inputMag;
      directionScale = forwardness > 0 ? 1 : 0.62;
      if (Math.abs(moveX / inputMag) > 0.7) directionScale *= 0.82;
    }
    speed *= directionScale;

    // --- move --------------------------------------------------------------
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    // Forward is +Y input; strafe is +X input, i.e. the camera's right vector.
    const worldX = cos * moveY + -sin * moveX;
    const worldY = sin * moveY + cos * moveX;
    const norm = Math.hypot(worldX, worldY);
    const dirX = norm > 0.001 ? worldX / norm : 0;
    const dirY = norm > 0.001 ? worldY / norm : 0;
    const step = Math.min(1, inputMag) * speed * dt;

    // Terrain cost: wading through water or scrambling over rubble is slow.
    const terrainCost = map.moveCostOf(Math.floor(this.x), Math.floor(this.y));
    const effectiveStep = step / Math.max(1, terrainCost);

    const before = { x: this.x, y: this.y };
    const moved = moveCircle(map, this.x, this.y, dirX * effectiveStep, dirY * effectiveStep, this.radius);
    this.x = moved.x;
    this.y = moved.y;

    const travelled = Math.hypot(this.x - before.x, this.y - before.y);
    this.speed = dt > 0 ? travelled / dt : 0;

    // --- stamina -----------------------------------------------------------
    this.updateStamina(dt, canSprint, mods.staminaDrain, mods.staminaRegen);

    // --- camera bob & footsteps -------------------------------------------
    if (travelled > 0.0001) {
      this.bobPhase += travelled * (canSprint ? 7.5 : 5.5);
      this.stepAccumulator += travelled;
      const strideLength = this.stance === 0 ? 1.1 : this.stance === 1 ? 0.85 : canSprint ? 0.72 : 0.95;
      if (this.stepAccumulator >= strideLength) {
        this.stepAccumulator = 0;
        this.emitFootstep(map, canSprint);
      }
    } else {
      this.stepAccumulator = Math.max(0, this.stepAccumulator - dt * 0.2);
    }

    // --- eye height --------------------------------------------------------
    const targetEye = EYE_HEIGHT_BY_STANCE[this.stance];
    this.eyeHeight = damp(this.eyeHeight, targetEye, 9, dt);
  }

  private updateStamina(dt: number, sprinting: boolean, drainMul: number, regenMul: number): void {
    if (this.staminaLockout > 0) this.staminaLockout -= dt;

    if (sprinting) {
      // Drain scales with load: a heavy runner gasses out fast.
      const drain = (11 + this.loadFactor * 16) * drainMul;
      this.stamina = Math.max(0, this.stamina - drain * dt);
      if (this.stamina <= 0) {
        // Hitting zero costs a recovery window before you can sprint again -
        // it is what turns a chase into a decision instead of a hold-shift.
        this.staminaLockout = 2.6;
      }
    } else {
      const idleBonus = this.speed < 0.05 ? 1.5 : 1;
      const regen = 9.5 * regenMul * idleBonus * (this.stance === 0 ? 1.35 : this.stance === 1 ? 1.15 : 1);
      this.stamina = Math.min(100, this.stamina + regen * dt);
    }
  }

  private emitFootstep(map: TileMap, sprinting: boolean): void {
    const tile = map.at(Math.floor(this.x), Math.floor(this.y));
    const surface = TILE_DEFS[tile]?.footstepLoudness ?? 1;
    // Stance is the player's main volume control - crouching is quiet.
    const stanceLoudness = this.stance === 0 ? 0.25 : this.stance === 1 ? 0.45 : sprinting ? 1.35 : 0.8;
    const radius = 9 * stanceLoudness * surface;
    this.bus.emit('sound:emit', {
      x: this.x,
      y: this.y,
      radius,
      intensity: clamp01(stanceLoudness * surface * 0.7),
      kind: sprinting ? 'sprint' : 'footstep',
      sourceId: this.id,
    });
  }

  // =========================================================================
  // Aim
  // =========================================================================

  /** Apply look input in radians, clamping pitch to a realistic range. */
  look(deltaYaw: number, deltaPitch: number): void {
    this.angle = wrapAngle(this.angle + deltaYaw);
    this.pitch = clamp(this.pitch + deltaPitch, -0.62, 0.62);
  }

  /** Muzzle height in metres for the current stance. */
  get muzzleHeight(): number {
    return this.eyeHeight - 0.12;
  }

  /** Eye height expressed in tile units, which is what the camera wants. */
  get eyeHeightTiles(): number {
    return this.eyeHeight / METERS_PER_TILE;
  }

  // =========================================================================
  // Damage feedback
  // =========================================================================

  onHit(attackerId: number, part: BodyPart, damage: number, penetrated: boolean, dirX: number, dirY: number): void {
    void attackerId;
    void penetrated;
    // Taking fire interrupts whatever you were doing - no bandaging under fire.
    this.cancelAction();
    this.bus.emit('player:hit', {
      amount: damage,
      bodyPart: part,
      fromX: this.x - dirX,
      fromY: this.y - dirY,
    });
  }

  /** Fall damage, applied when a drop or an explosion knocks the player down. */
  applyImpact(force: number): void {
    if (force < 0.2) return;
    const damage = force * 18;
    this.health.applyDamage('leftLeg', damage * 0.5, { fractureChance: clamp01(force - 0.5) * 0.5 });
    this.health.applyDamage('rightLeg', damage * 0.5, { fractureChance: clamp01(force - 0.5) * 0.5 });
  }
}
