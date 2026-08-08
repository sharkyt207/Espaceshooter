import type { GameBus } from '../core/GameEvents';
import { Rng } from '../core/Random';
import { clamp, clamp01, damp } from '../core/Math2D';
import { ItemDB } from '../data/ItemDatabase';
import type { FireMode } from '../data/ItemTypes';
import type { Inventory } from '../inventory/Inventory';
import { createStack, defOf, type ItemStack } from '../inventory/ItemStack';
import { BallisticsSystem } from '../combat/Ballistics';
import {
  patternFor, stepAt, PATTERN_BY_CLASS, DEFAULT_PATTERN, type RecoilStep,
} from './RecoilPattern';
import { METERS_PER_TILE } from '../world/TileMap';
import {
  chamberFromMagazine,
  cycleRound,
  loadMagazine,
  peekNextRound,
  resolveWeapon,
  roundsInMagazine,
  totalRounds,
  type ResolveContext,
  type ResolvedWeapon,
} from './WeaponRuntime';

/**
 * WeaponController - the firing and reloading state machine.
 *
 * One instance per combatant, used identically by the player and by AI. That
 * symmetry is deliberate: enemies obey the same rate of fire, the same reload
 * durations, the same recoil and the same jamming rules, so a fight is decided
 * by position and preparation rather than by hidden stat advantages.
 *
 * The controller owns:
 *   - trigger discipline (semi/burst/auto, rate limiting, trigger reset)
 *   - the reload pipeline, including magazine swaps versus loose-round loading
 *   - recoil accumulation and settling
 *   - dispersion, combining weapon, ammunition, stance, movement and injuries
 *   - malfunctions on worn weapons, and clearing them
 *
 * It never touches the camera directly; it exposes `recoilPitch`/`recoilYaw`
 * for the owner to fold into its aim.
 */

export type WeaponState = 'idle' | 'firing' | 'reloading' | 'swapping' | 'jammed' | 'clearing';

export interface FireContext {
  /** Muzzle origin in tiles. */
  x: number;
  y: number;
  /** Muzzle height in metres. */
  z: number;
  /** Aim yaw in radians. */
  angle: number;
  /** Aim pitch in radians. */
  pitch: number;
  /** Ground speed in tiles/sec - degrades accuracy. */
  speed: number;
  /** 0 = prone, 1 = crouched, 2 = standing. */
  stance: 0 | 1 | 2;
  /** Sway multiplier from the health system. */
  swayMultiplier: number;
  /** Resolution context: gear penalties and skills. */
  resolve: ResolveContext;
}

/** Multiplier on dispersion when firing from the hip. */
const HIPFIRE_SPREAD = 9.0;
/** Additional dispersion per tile/sec of movement. */
const MOVEMENT_SPREAD = 1.15;

export class WeaponController {
  state: WeaponState = 'idle';

  /** The equipped weapon instance, or null when unarmed. */
  weapon: ItemStack | null = null;
  resolved: ResolvedWeapon | null = null;

  /** Accumulated muzzle displacement, in radians. Owner folds this into aim. */
  recoilPitch = 0;
  recoilYaw = 0;

  /**
   * How far into the pattern the current string of fire is.
   *
   * Reset when the weapon has been settled for long enough that the shooter
   * has re-established their stance - see `update`. Not reset per trigger
   * pull, because tapping the trigger to reset the pattern would make
   * every weapon behave like its own first shot forever.
   */
  private shotIndex = 0;
  private pattern: RecoilStep[] = patternFor('default');

  /** 0..1 aiming-down-sights progress. */
  adsProgress = 0;
  adsRequested = false;

  /** Sustained-fire heat 0..1; widens the cone and slows settling. */
  private heat = 0;

  private triggerHeld = false;
  /** Semi-auto requires the trigger to be released between shots. */
  private triggerReset = true;
  private shotCooldown = 0;
  private burstRemaining = 0;

  private actionTimer = 0;
  private pendingReload: (() => void) | null = null;

  /** Cartridge the player has chosen to load. Null = pick the best available. */
  preferredAmmo: string | null = null;

  private readonly rng: Rng;

  constructor(
    private readonly bus: GameBus,
    private readonly ballistics: BallisticsSystem,
    private readonly ownerId: number,
    private readonly isPlayer: boolean,
    seed: number,
  ) {
    this.rng = new Rng(seed ^ (ownerId * 2654435761));
  }

  // =========================================================================
  // Equipment
  // =========================================================================

  /**
   * The pattern for whatever is equipped, keyed on the weapon's handling class.
   *
   * Per weapon *id*, not per class, so two rifles in the same family still
   * draw distinguishable shapes - the class only supplies the character, the
   * id supplies the specifics.
   */
  private patternForEquipped(): RecoilStep[] {
    if (!this.weapon) return patternFor('default');
    const def = defOf(this.weapon);
    const cls = def.weapon?.weaponClass ?? '';
    return patternFor(def.id, PATTERN_BY_CLASS[cls] ?? DEFAULT_PATTERN);
  }

  /** Equip a weapon. Passing null leaves the combatant unarmed. */
  setWeapon(stack: ItemStack | null, ctx: ResolveContext, instant = false): void {
    this.weapon = stack;
    this.resolved = stack && defOf(stack).weapon ? resolveWeapon(stack, ctx) : null;
    this.burstRemaining = 0;
    this.heat = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.shotIndex = 0;
    this.pattern = this.patternForEquipped();
    this.adsProgress = 0;
    if (!this.resolved) {
      this.state = 'idle';
      return;
    }
    if (instant) {
      this.state = this.weapon?.jammed ? 'jammed' : 'idle';
    } else {
      this.state = 'swapping';
      this.actionTimer = this.resolved.swapTime;
    }
  }

  /** Recompute derived stats - call after modding or when gear changes. */
  refresh(ctx: ResolveContext): void {
    if (this.weapon && defOf(this.weapon).weapon) this.resolved = resolveWeapon(this.weapon, ctx);
  }

  get currentFireMode(): FireMode {
    if (!this.resolved || !this.weapon) return 'single';
    const modes = this.resolved.fireModes;
    return modes[clamp(this.weapon.fireModeIndex ?? 0, 0, modes.length - 1)];
  }

  cycleFireMode(): void {
    if (!this.weapon || !this.resolved) return;
    const modes = this.resolved.fireModes;
    if (modes.length <= 1) return;
    this.weapon.fireModeIndex = ((this.weapon.fireModeIndex ?? 0) + 1) % modes.length;
    this.burstRemaining = 0;
    this.bus.emit('weapon:modeChanged', { actorId: this.ownerId, mode: this.currentFireMode });
  }

  get ammoInMagazine(): number {
    return this.weapon ? roundsInMagazine(this.weapon) : 0;
  }

  get ammoTotal(): number {
    return this.weapon ? totalRounds(this.weapon) : 0;
  }

  get magazineCapacity(): number {
    return this.resolved?.magCapacity ?? 0;
  }

  get isReloading(): boolean {
    return this.state === 'reloading';
  }

  get isBusy(): boolean {
    return this.state === 'reloading' || this.state === 'swapping' || this.state === 'clearing';
  }

  // =========================================================================
  // Trigger
  // =========================================================================

  pressTrigger(): void {
    this.triggerHeld = true;
  }

  releaseTrigger(): void {
    this.triggerHeld = false;
    this.triggerReset = true;
    // Releasing mid-burst does not cancel it: burst fire is mechanical.
  }

  setAds(on: boolean): void {
    this.adsRequested = on;
  }

  // =========================================================================
  // Simulation
  // =========================================================================

  update(dt: number, ctx: FireContext): void {
    const resolved = this.resolved;

    // --- ADS transition ---------------------------------------------------
    if (resolved) {
      const target = this.adsRequested && !this.isBusy ? 1 : 0;
      const rate = 1 / Math.max(0.05, resolved.adsTime);
      this.adsProgress = clamp01(
        this.adsProgress + (target > this.adsProgress ? rate : -rate * 1.6) * dt,
      );
    } else {
      this.adsProgress = 0;
    }

    // --- recoil settling --------------------------------------------------
    if (resolved) {
      // Settling is slower while the weapon is hot; sustained fire climbs.
      const recovery = (resolved.recoilRecovery * (Math.PI / 180)) * (1 - this.heat * 0.45);
      this.recoilPitch = approachZero(this.recoilPitch, recovery * dt);
      this.recoilYaw = approachZero(this.recoilYaw, recovery * 0.75 * dt);
      this.heat = Math.max(0, this.heat - dt * 0.85);

      // Once the weapon has been cool for long enough that the shooter has
      // re-set their stance, the pattern starts from the top again.
      //
      // Tied to heat rather than to the trigger, deliberately. Resetting per
      // trigger pull would mean tapping always produced first-shot recoil,
      // which turns every automatic weapon into a better semi-automatic one
      // and deletes the reason to learn a pattern at all. Tied to heat, a
      // controlled burst keeps its place in the pattern and only a genuine
      // pause gives it back.
      if (this.heat <= 0.001 && this.shotIndex !== 0) this.shotIndex = 0;
    }

    // --- action timers ----------------------------------------------------
    if (this.actionTimer > 0) {
      this.actionTimer -= dt;
      if (this.actionTimer <= 0) {
        this.actionTimer = 0;
        const done = this.pendingReload;
        this.pendingReload = null;
        if (done) done();
        else if (this.state === 'swapping') this.state = this.weapon?.jammed ? 'jammed' : 'idle';
        else if (this.state === 'clearing') {
          if (this.weapon) this.weapon.jammed = false;
          this.state = 'idle';
        }
      }
      return;
    }

    if (this.shotCooldown > 0) this.shotCooldown -= dt;
    if (!resolved || !this.weapon || this.state === 'jammed') return;

    // --- feed the trigger -------------------------------------------------
    if (this.burstRemaining > 0) {
      if (this.shotCooldown <= 0) this.fireOnce(ctx, resolved);
      return;
    }

    if (!this.triggerHeld || this.shotCooldown > 0) return;

    const mode = this.currentFireMode;
    if (mode === 'single' || mode === 'burst') {
      if (!this.triggerReset) return;
      this.triggerReset = false;
    }

    if (mode === 'burst') {
      this.burstRemaining = resolved.burstCount;
    }
    this.fireOnce(ctx, resolved);
  }

  // =========================================================================
  // Firing
  // =========================================================================

  private fireOnce(ctx: FireContext, resolved: ResolvedWeapon): void {
    const weapon = this.weapon;
    if (!weapon) return;

    // Chamber if needed - covers the shot right after a reload.
    if (!weapon.chamber) chamberFromMagazine(weapon);

    const cartridge = peekNextRound(weapon);
    if (!cartridge) {
      this.burstRemaining = 0;
      this.shotCooldown = 0.22;
      this.bus.emit('weapon:dryfire', { actorId: this.ownerId });
      return;
    }

    // --- malfunction check -------------------------------------------------
    const ammoDef = ItemDB.get(cartridge);
    const malfunctionScale = ammoDef.ammo?.malfunctionModifier ?? 1;
    if (resolved.jamChance > 0 && this.rng.chance(resolved.jamChance * malfunctionScale)) {
      weapon.jammed = true;
      this.state = 'jammed';
      this.burstRemaining = 0;
      this.bus.emit('weapon:jammed', { actorId: this.ownerId });
      return;
    }

    cycleRound(weapon);
    this.burstRemaining = Math.max(0, this.burstRemaining - 1);
    this.shotCooldown = 60 / resolved.rpm;

    // --- dispersion --------------------------------------------------------
    const spread = this.computeSpread(ctx, resolved, ammoDef.ammo?.accuracyModifier ?? 1);

    // --- launch ------------------------------------------------------------
    const dirX = Math.cos(ctx.angle);
    const dirY = Math.sin(ctx.angle);
    this.ballistics.fire({
      originX: ctx.x + dirX * 0.35,
      originY: ctx.y + dirY * 0.35,
      originZ: ctx.z,
      dirX,
      dirY,
      pitch: ctx.pitch,
      ammoDefId: cartridge,
      ownerId: this.ownerId,
      ownerIsPlayer: this.isPlayer,
      spreadRad: spread,
      velocityBonus: resolved.velocityBonus,
    });

    // --- recoil impulse ----------------------------------------------------
    //
    // The direction comes from the weapon's pattern, not from a die roll. That
    // is what makes recoil a skill: the same weapon draws the same shape every
    // time, so a player who has learned it can hold a burst on target, and a
    // player who has not will walk it off in a way they can go and practise.
    // Only the magnitude varies with the situation.
    const ammoRecoil = ammoDef.ammo?.recoilModifier ?? 1;
    // Standing is least stable; going prone roughly halves felt recoil.
    const stanceStability = ctx.stance === 0 ? 0.55 : ctx.stance === 1 ? 0.78 : 1;
    const adsStability = 1 - this.adsProgress * 0.22;
    const impulse = stanceStability * adsStability * ammoRecoil * (1 + this.heat * 0.45);

    const step = stepAt(this.pattern, this.shotIndex);
    this.shotIndex++;
    this.recoilPitch += resolved.recoilVertical * (Math.PI / 180) * impulse * step.vertical;
    this.recoilYaw += resolved.recoilHorizontal * (Math.PI / 180) * impulse * step.horizontal;
    this.heat = clamp01(this.heat + 0.14);

    // --- wear --------------------------------------------------------------
    // Every shot costs a little condition, so a weapon carried through many
    // raids genuinely degrades and needs servicing at the hideout.
    if (weapon.durability !== undefined) {
      weapon.durability = Math.max(0, weapon.durability - 0.035);
    }

    // --- presentation & perception ----------------------------------------
    this.bus.emit('weapon:fired', {
      actorId: this.ownerId,
      suppressed: resolved.suppressed,
      x: ctx.x,
      y: ctx.y,
    });
    this.bus.emit('sound:emit', {
      x: ctx.x,
      y: ctx.y,
      radius: resolved.loudness,
      intensity: resolved.suppressed ? 0.35 : 1,
      kind: resolved.suppressed ? 'suppressed' : 'gunshot',
      sourceId: this.ownerId,
    });
  }

  /**
   * Total dispersion half-angle in radians.
   *
   * Order of contributions matters for how it reads in play: the weapon and
   * cartridge set the floor, stance and movement scale it, hip fire multiplies
   * it hard, and injuries widen it further. Firing on the move from the hip
   * with a broken arm is meant to be nearly useless.
   */
  computeSpread(ctx: FireContext, resolved: ResolvedWeapon, ammoAccuracy: number): number {
    const base = BallisticsSystem.moaToRadians(resolved.accuracyMoa * ammoAccuracy);
    const stanceMul = ctx.stance === 0 ? 0.55 : ctx.stance === 1 ? 0.78 : 1;
    const movementMul = 1 + ctx.speed * MOVEMENT_SPREAD;
    const hipMul = 1 + (HIPFIRE_SPREAD - 1) * (1 - this.adsProgress);
    const healthMul = ctx.swayMultiplier;
    const heatMul = 1 + this.heat * 0.5;
    return base * stanceMul * movementMul * hipMul * healthMul * heatMul;
  }

  /** Current dispersion, exposed so the HUD can size the crosshair honestly. */
  currentSpread(ctx: FireContext): number {
    if (!this.resolved) return 0;
    const cartridge = this.weapon ? peekNextRound(this.weapon) : null;
    const accuracy = cartridge ? ItemDB.tryGet(cartridge)?.ammo?.accuracyModifier ?? 1 : 1;
    return this.computeSpread(ctx, this.resolved, accuracy);
  }

  // =========================================================================
  // Reloading
  // =========================================================================

  /**
   * Start a reload.
   *
   * Prefers swapping in a pre-loaded magazine, exactly like a real reload -
   * which is why filling magazines at the hideout before a raid is worth doing.
   * With no loaded magazine available, we fall back to feeding loose rounds,
   * which is much slower and is meant to feel like a mistake.
   */
  reload(inventory: Inventory): boolean {
    const weapon = this.weapon;
    const resolved = this.resolved;
    if (!weapon || !resolved || this.isBusy || this.state === 'jammed') return false;
    if (roundsInMagazine(weapon) >= resolved.magCapacity) return false;

    if (resolved.tubeFed) return this.reloadTube(inventory, resolved);

    const spare = this.findBestSpareMagazine(inventory, resolved.caliber);
    if (spare) {
      const wasEmpty = roundsInMagazine(weapon) === 0 && !weapon.chamber;
      const duration = wasEmpty ? resolved.reloadEmpty : resolved.reloadTactical;
      this.beginAction('reloading', duration, () => {
        const old = weapon.magazine;
        inventory.removeStack(spare.id);
        weapon.magazine = spare;
        // A tactical reload keeps the round already in the chamber.
        if (!weapon.chamber) chamberFromMagazine(weapon);
        if (old) {
          // Partially spent magazines go back into the kit, not the bin.
          if (!inventory.store(old)) {
            // No room: the magazine is dropped. Losing it is the cost of
            // reloading with a full rig.
          }
        }
        inventory.markDirty();
        this.state = 'idle';
        this.bus.emit('weapon:reloadEnd', { actorId: this.ownerId });
      });
      this.bus.emit('weapon:reloadStart', { actorId: this.ownerId, durationSec: duration, tactical: !wasEmpty });
      this.bus.emit('sound:emit', {
        x: 0, y: 0, radius: 6, intensity: 0.2, kind: 'reload', sourceId: this.ownerId,
      });
      return true;
    }

    // --- loose rounds ------------------------------------------------------
    const ammoId = this.chooseAmmo(inventory, resolved.caliber);
    if (!ammoId) return false;
    if (!weapon.magazine) {
      weapon.magazine = createStack(resolved.base.defaultMagazine);
    }
    const room = resolved.magCapacity - roundsInMagazine(weapon);
    const available = Math.min(room, inventory.countAvailable(ammoId));
    if (available <= 0) return false;

    // Loading loose rounds costs roughly a third of a second per cartridge.
    const duration = resolved.reloadEmpty + available * 0.34;
    this.beginAction('reloading', duration, () => {
      const taken = inventory.consume(ammoId, available);
      loadMagazine(weapon.magazine!, ammoId, taken);
      if (!weapon.chamber) chamberFromMagazine(weapon);
      inventory.markDirty();
      this.state = 'idle';
      this.bus.emit('weapon:reloadEnd', { actorId: this.ownerId });
    });
    this.bus.emit('weapon:reloadStart', { actorId: this.ownerId, durationSec: duration, tactical: false });
    return true;
  }

  /** Tube-fed weapons load one shell at a time and can be interrupted. */
  private reloadTube(inventory: Inventory, resolved: ResolvedWeapon): boolean {
    const weapon = this.weapon!;
    const ammoId = this.chooseAmmo(inventory, resolved.caliber);
    if (!ammoId) return false;
    if (!weapon.magazine) weapon.magazine = createStack(resolved.base.defaultMagazine);
    if (roundsInMagazine(weapon) >= resolved.magCapacity) return false;

    const duration = resolved.reloadTactical;
    this.beginAction('reloading', duration, () => {
      const taken = inventory.consume(ammoId, 1);
      if (taken > 0) loadMagazine(weapon.magazine!, ammoId, taken);
      if (!weapon.chamber) chamberFromMagazine(weapon);
      inventory.markDirty();
      this.state = 'idle';
      this.bus.emit('weapon:reloadEnd', { actorId: this.ownerId });
      // Keep feeding while the trigger is not being pulled and shells remain.
      if (!this.triggerHeld && roundsInMagazine(weapon) < resolved.magCapacity) {
        this.reloadTube(inventory, resolved);
      }
    });
    this.bus.emit('weapon:reloadStart', { actorId: this.ownerId, durationSec: duration, tactical: true });
    return true;
  }

  /** Interrupt an in-progress reload - shooting always wins over loading. */
  cancelReload(): void {
    if (this.state !== 'reloading') return;
    this.pendingReload = null;
    this.actionTimer = 0;
    this.state = 'idle';
  }

  /** Clear a malfunction. Takes real time, which is the whole point. */
  clearJam(): boolean {
    if (this.state !== 'jammed' || !this.weapon) return false;
    this.beginAction('clearing', 2.1, () => {
      if (this.weapon) this.weapon.jammed = false;
      this.state = 'idle';
    });
    return true;
  }

  private beginAction(state: WeaponState, duration: number, onComplete: () => void): void {
    this.state = state;
    this.actionTimer = duration;
    this.pendingReload = onComplete;
    this.burstRemaining = 0;
  }

  /**
   * Best spare magazine: the fullest compatible one. Loading the fullest
   * magazine first is what an experienced operator does, and it means the
   * player is not punished for not micromanaging their rig.
   */
  private findBestSpareMagazine(inventory: Inventory, caliber: string): ItemStack | null {
    let best: ItemStack | null = null;
    let bestCount = 0;
    for (const { grid } of inventory.allGrids()) {
      for (const stack of grid.items()) {
        const def = ItemDB.get(stack.defId);
        if (def.category !== 'magazine' || def.magazine?.caliber !== caliber) continue;
        const count = stack.rounds?.length ?? 0;
        if (count === 0) continue;
        if (count > bestCount) {
          bestCount = count;
          best = stack;
        }
      }
    }
    return best;
  }

  /**
   * Which loose cartridge to load: the player's pick if they have one and it
   * is available, otherwise the highest-penetration round they are carrying.
   */
  private chooseAmmo(inventory: Inventory, caliber: string): string | null {
    if (this.preferredAmmo) {
      const def = ItemDB.tryGet(this.preferredAmmo);
      if (def?.ammo?.caliber === caliber && inventory.countAvailable(this.preferredAmmo) > 0) {
        return this.preferredAmmo;
      }
    }
    let best: string | null = null;
    let bestPen = -1;
    for (const { grid } of inventory.allGrids()) {
      for (const stack of grid.items()) {
        const def = ItemDB.get(stack.defId);
        if (def.category !== 'ammo' || def.ammo?.caliber !== caliber) continue;
        if (def.ammo.penetration > bestPen) {
          bestPen = def.ammo.penetration;
          best = def.id;
        }
      }
    }
    return best;
  }

  /** Muzzle height in metres for the current stance. */
  static muzzleHeight(eyeHeightMeters: number): number {
    // Sits just below the eye line - what you see is very nearly what you hit.
    return eyeHeightMeters - 0.12;
  }

  /** Convert an eye height in tiles into metres. */
  static tilesToMeters(tiles: number): number {
    return tiles * METERS_PER_TILE;
  }

  /** Smoothly-damped helper exposed for the viewmodel's sway. */
  static dampTo(current: number, target: number, rate: number, dt: number): number {
    return damp(current, target, rate, dt);
  }
}

/** Move a value towards zero by at most `amount`. */
function approachZero(value: number, amount: number): number {
  if (value > 0) return Math.max(0, value - amount);
  if (value < 0) return Math.min(0, value + amount);
  return 0;
}
