import { nextActorId } from '../core/Ids';
import type { GameBus, SoundEventPayload } from '../core/GameEvents';
import { Rng } from '../core/Random';
import { angleDelta, clamp, clamp01, damp, rotateTowards, distance } from '../core/Math2D';
import { HealthSystem } from '../health/HealthSystem';
import { Inventory } from '../inventory/Inventory';
import { createStack, type ItemStack } from '../inventory/ItemStack';
import { ItemDB } from '../data/ItemDatabase';
import type { BodyPart } from '../data/ItemTypes';
import { loadMagazine } from '../weapons/WeaponRuntime';
import { WeaponController } from '../weapons/WeaponController';
import type { BallisticsSystem } from '../combat/Ballistics';
import type { Combatant } from '../combat/Combatant';
import { moveCircle } from '../world/Physics';
import { hasLineOfSight } from '../world/Raycast';
import type { CoverMap, NavGrid } from '../world/NavGrid';
import type { TileMap } from '../world/TileMap';
import type { PatrolRoute } from '../world/MapGenerator';
import { AI_PROFILES, type AIProfile, type AITier } from './AIProfiles';
import {
  createAwareness,
  hearSound,
  updateVision,
  ENGAGE_THRESHOLD,
  SUSPICION_THRESHOLD,
  type Awareness,
} from './Perception';

/**
 * Enemy - a PvE combatant with perception, tactics and a real loadout.
 *
 * Behaviour is a small state machine driven by a low-frequency "think" tick
 * (5-6 Hz depending on tier) while movement, aiming and firing run at full
 * simulation rate. Splitting them this way is what lets thirty enemies share a
 * mobile frame budget: the expensive decisions - cover scoring, path requests -
 * happen a few times a second, and only for enemies that are actually engaged.
 *
 * States and what they are for:
 *   idle        - stand post, scan. Cheapest state; most of the map is here.
 *   patrol      - walk an authored route, pausing to look around.
 *   investigate - go to the last known position of a sound or sighting and
 *                 search the area, then give up and return to patrol.
 *   engage      - fight: hold cover, fire disciplined bursts, reload behind
 *                 hard cover, and push when the odds are good.
 *   reposition  - move to a chosen tactical position (cover, flank, peek).
 *   flee        - break contact when badly hurt, then rejoin if it recovers.
 *
 * The AI uses exactly the same WeaponController, ballistics and health systems
 * as the player. It has no damage bonus, no infinite ammo, no wall vision.
 */

export type AIState = 'idle' | 'patrol' | 'investigate' | 'engage' | 'reposition' | 'flee' | 'dead';

export interface AIWorldContext {
  map: TileMap;
  nav: NavGrid;
  cover: CoverMap;
  /** The player, or whoever this AI treats as an enemy. */
  target: Combatant;
  /** Player's ground speed, used by the perception model. */
  targetSpeed: number;
  /** Player's stance 0-2. */
  targetStance: number;
  /** How brightly the target is lighting themselves up, 0..1. */
  targetGlow: number;
  /** Environmental multiplier on spotting range - darkness, fog, rain. */
  sightScale: number;
  /** Budgeted path request; returns null when the frame budget is exhausted. */
  requestPath: (fromX: number, fromY: number, toX: number, toY: number) => { x: number; y: number }[] | null;
  /** True when at least one squadmate is currently engaging. */
  squadEngaged: boolean;
  /** Broadcast a contact to the squad so others converge. */
  alertSquad: (x: number, y: number) => void;
  elapsed: number;
}

const MAX_PATH_POINTS = 24;

export class Enemy implements Combatant {
  readonly id = nextActorId();
  readonly isPlayer = false;
  readonly radius = 0.3;

  name: string;
  x = 0;
  y = 0;
  angle = 0;
  pitch = 0;
  height = 1.8;
  eyeHeight = 1.6;

  readonly health: HealthSystem;
  readonly inventory = new Inventory();
  readonly profile: AIProfile;
  readonly tier: AITier;

  readonly weapon: WeaponController;

  state: AIState = 'idle';
  private stateTimer = 0;
  private thinkTimer = 0;

  readonly awareness: Awareness = createAwareness();

  /** 0..1 - how pinned down this AI currently feels. */
  suppression = 0;
  /** Direction the suppressing fire came from. */
  private suppressFromX = 0;
  private suppressFromY = 0;

  /** Patrol route assignment. */
  patrolRoute: PatrolRoute | null = null;
  private patrolIndex = 0;
  private patrolPause = 0;

  /** Current path in world space. */
  private path: { x: number; y: number }[] = [];
  private pathIndex = 0;
  private pathCooldown = 0;

  /** Movement state exposed for the sprite animation. */
  speed = 0;
  stance: 0 | 1 | 2 = 2;
  private walkPhase = 0;

  /** Aim error offset that drifts slowly, so shots are not perfectly centred. */
  private aimErrorYaw = 0;
  private aimErrorPitch = 0;
  private aimErrorTimer = 0;

  /** Reaction and trigger discipline. */
  private reactionTimer = 0;
  private burstTimer = 0;
  private firing = false;

  /** Cached "am I currently behind cover from the threat" result. */
  private inCover = false;

  private readonly rng: Rng;

  constructor(
    private readonly bus: GameBus,
    ballistics: BallisticsSystem,
    tier: AITier,
    seed: number,
  ) {
    this.tier = tier;
    this.profile = AI_PROFILES[tier];
    this.rng = new Rng(seed ^ (this.id * 2246822519));
    this.name = this.rng.pick(this.profile.namePool);
    this.health = new HealthSystem(bus, false);
    this.weapon = new WeaponController(bus, ballistics, this.id, false, seed);
    // Stagger think ticks across the population so they never bunch on one frame.
    this.thinkTimer = this.rng.range(0, this.profile.thinkInterval);
  }

  get alive(): boolean {
    return !this.health.dead;
  }

  // =========================================================================
  // Spawning
  // =========================================================================

  /** Roll a loadout and place the enemy in the world. */
  spawn(x: number, y: number, angle: number): void {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.state = 'patrol';
    this.health.reset();
    this.buildLoadout();
    this.weapon.setWeapon(this.inventory.equipped.primary ?? null, this.resolveContext(), true);
  }

  private buildLoadout(): void {
    const p = this.profile;

    // --- weapon with a loaded magazine and spares -------------------------
    const weaponId = this.rng.pick(p.weapons);
    const weapon = createStack(weaponId);
    const wDef = ItemDB.get(weaponId).weapon!;
    const ammoDef = this.pickAmmo(wDef.caliber);

    const mag = createStack(wDef.defaultMagazine);
    const magDef = ItemDB.get(mag.defId).magazine!;
    if (ammoDef) {
      loadMagazine(mag, ammoDef.id, magDef.capacity);
      weapon.chamber = ammoDef.id;
    }
    weapon.magazine = mag;
    // Enemy weapons are field-worn; a scavenger's rifle genuinely jams.
    weapon.durability = this.rng.range(
      p.tier === 'scavenger' ? 28 : p.tier === 'commander' ? 82 : 48,
      p.tier === 'scavenger' ? 72 : 98,
    );

    // Attachments scale with tier - contractors carry kitted weapons.
    const attachChance = p.tier === 'scavenger' ? 0.12 : p.tier === 'guard' ? 0.3 : 0.62;
    weapon.attachments = {};
    for (const slot of wDef.slots) {
      if (!this.rng.chance(attachChance)) continue;
      const options = ItemDB.ofCategory('attachment').filter((a) => a.attachment?.slot === slot);
      if (options.length === 0) continue;
      const pick = this.rng.pick(options);
      weapon.attachments[slot] = createStack(pick.id);
    }
    this.inventory.equip('primary', weapon);

    // --- protection --------------------------------------------------------
    const armorId = this.rng.pick(p.armor);
    if (armorId) {
      const armor = createStack(armorId);
      const armorDef = ItemDB.get(armorId);
      if (armorDef.armor) {
        armor.durability = armorDef.armor.maxDurability * this.rng.range(0.4, 1);
      }
      this.inventory.equip(armorDef.category === 'rig' ? 'rig' : 'armor', armor);
    }
    const helmetId = this.rng.pick(p.helmets);
    if (helmetId) {
      const helmet = createStack(helmetId);
      const hDef = ItemDB.get(helmetId);
      if (hDef.armor) helmet.durability = hDef.armor.maxDurability * this.rng.range(0.4, 1);
      this.inventory.equip('helmet', helmet);
    }
    if (!this.inventory.equipped.rig) {
      this.inventory.equip('rig', createStack(this.rng.pick(p.rigs)));
    }

    // --- spare magazines and pocket loot ----------------------------------
    const spares = p.tier === 'scavenger' ? this.rng.int(0, 2) : this.rng.int(2, 4);
    for (let i = 0; i < spares; i++) {
      const spare = createStack(wDef.defaultMagazine);
      if (ammoDef) {
        loadMagazine(spare, ammoDef.id, magDef.capacity);
      }
      this.inventory.store(spare);
    }
    for (const entry of p.pocketLoot) {
      if (!this.rng.chance(entry.chance)) continue;
      const count = this.rng.int(entry.min, entry.max);
      this.inventory.store(createStack(entry.defId, count));
    }
  }

  private pickAmmo(caliber: string) {
    const pool = ItemDB.ofCategory('ammo').filter((a) => a.ammo?.caliber === caliber);
    if (pool.length === 0) return undefined;
    // Better tiers carry better ammunition - which is what makes killing a
    // contractor worth the risk.
    const tierBias = this.tier === 'scavenger' ? 0 : this.tier === 'guard' ? 1 : this.tier === 'contractor' ? 2 : 3;
    const weights = pool.map((a) => {
      const pen = a.ammo!.penetration;
      return Math.max(0.3, 10 - Math.abs(pen - (12 + tierBias * 12)) * 0.35);
    });
    return this.rng.weighted(pool, weights);
  }

  private resolveContext() {
    return {
      gearErgoPenalty: this.inventory.stats.ergonomicsPenalty,
      handlingSkill: this.tier === 'commander' ? 0.8 : this.tier === 'contractor' ? 0.55 : 0.2,
      recoilSkill: this.tier === 'commander' ? 0.8 : this.tier === 'contractor' ? 0.5 : 0.15,
    };
  }

  // =========================================================================
  // Damage feedback
  // =========================================================================

  onHit(attackerId: number, part: BodyPart, damage: number, penetrated: boolean, dirX: number, dirY: number): void {
    void part;
    void penetrated;
    void attackerId;
    // Being hit is the strongest possible cue: instant full awareness, and the
    // shooter's bearing is inferred from the round's direction of travel.
    this.awareness.level = 1;
    this.awareness.lastKnownX = this.x - dirX * 8;
    this.awareness.lastKnownY = this.y - dirY * 8;
    this.awareness.timeSinceSeen = 0;
    this.addSuppression(clamp01(damage / 40), this.x - dirX * 8, this.y - dirY * 8);
    if (this.state !== 'engage') this.enterState('engage');
  }

  onNearMiss(attackerId: number, closeness: number, fromX: number, fromY: number): void {
    void attackerId;
    this.addSuppression(closeness * 0.55, fromX, fromY);
    // A round cracking past tells you roughly where it came from.
    if (this.awareness.level < SUSPICION_THRESHOLD) {
      this.awareness.lastKnownX = fromX;
      this.awareness.lastKnownY = fromY;
    }
    this.awareness.level = Math.max(this.awareness.level, 0.55);
  }

  private addSuppression(amount: number, fromX: number, fromY: number): void {
    // Nerve is the tier's resistance: a contractor barely flinches.
    this.suppression = clamp01(this.suppression + amount * (1 - this.profile.nerve * 0.65));
    this.suppressFromX = fromX;
    this.suppressFromY = fromY;
  }

  /** Route a world sound event into perception. */
  onSound(sound: SoundEventPayload, map: TileMap): void {
    if (sound.sourceId === this.id || !this.alive) return;
    const heard = hearSound(
      this.awareness,
      this.profile,
      {
        observerX: this.x,
        observerY: this.y,
        observerAngle: this.angle,
        hearingMultiplier: this.inventory.stats.hearingFactor,
        suppressed: this.suppression > 0.4,
        // Hearing is not range-gated by the weather here: the sound event
        // itself already arrives with a shortened radius.
        sightScale: 1,
      },
      sound,
      map,
      (magnitude) => this.rng.gaussian(0, magnitude * 0.4),
    );
    if (heard && this.awareness.level > SUSPICION_THRESHOLD && this.state !== 'engage') {
      this.enterState('investigate');
    }
  }

  // =========================================================================
  // Update
  // =========================================================================

  update(dt: number, ctx: AIWorldContext): void {
    if (this.state === 'dead') return;

    this.health.update(dt);
    if (!this.alive) {
      this.die();
      return;
    }

    if (this.pathCooldown > 0) this.pathCooldown -= dt;
    this.suppression = Math.max(0, this.suppression - dt * (0.35 + this.profile.nerve * 0.5));
    this.stateTimer -= dt;

    // --- perception & decisions at the think rate -------------------------
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      const interval = this.profile.thinkInterval;
      // Perception is integrated over the interval that actually elapsed.
      const perceiveDt = interval - this.thinkTimer;
      this.thinkTimer = interval;
      this.perceive(perceiveDt, ctx);
      this.think(ctx);
    }

    // --- act at full rate --------------------------------------------------
    this.updateAim(dt, ctx);
    this.updateMovement(dt, ctx);
    this.updateWeapon(dt, ctx);
  }

  private perceive(dt: number, ctx: AIWorldContext): void {
    updateVision(
      this.awareness,
      this.profile,
      {
        observerX: this.x,
        observerY: this.y,
        observerAngle: this.angle,
        hearingMultiplier: this.inventory.stats.hearingFactor,
        suppressed: this.suppression > 0.4,
        sightScale: ctx.sightScale,
      },
      ctx.target,
      ctx.map,
      dt,
      ctx.targetSpeed,
      ctx.targetStance,
      ctx.targetGlow,
    );
  }

  // =========================================================================
  // Decision making
  // =========================================================================

  private think(ctx: AIWorldContext): void {
    const a = this.awareness;

    // Squad coordination: a contact anywhere in the squad pulls the others in.
    if (a.level >= ENGAGE_THRESHOLD && a.visible) ctx.alertSquad(a.lastKnownX, a.lastKnownY);

    // --- disengage when badly hurt ----------------------------------------
    const healthFraction = this.health.totalHp / this.health.totalMaxHp;
    if (healthFraction < this.profile.fleeThreshold && this.state !== 'flee') {
      this.enterState('flee');
      return;
    }

    switch (this.state) {
      case 'idle':
      case 'patrol':
        if (a.level >= ENGAGE_THRESHOLD) this.enterState('engage');
        else if (a.level >= SUSPICION_THRESHOLD) this.enterState('investigate');
        else this.thinkPatrol(ctx);
        break;

      case 'investigate':
        if (a.level >= ENGAGE_THRESHOLD) this.enterState('engage');
        else this.thinkInvestigate(ctx);
        break;

      case 'engage':
        this.thinkEngage(ctx);
        break;

      case 'reposition':
        // Arriving, losing the reason to move, or timing out all end the move.
        if (this.pathIndex >= this.path.length || this.stateTimer <= 0) this.enterState('engage');
        else if (a.level >= ENGAGE_THRESHOLD && a.visible && this.hasGoodFiringPosition(ctx)) {
          this.enterState('engage');
        }
        break;

      case 'flee':
        this.thinkFlee(ctx, healthFraction);
        break;

      default:
        break;
    }
  }

  private thinkPatrol(ctx: AIWorldContext): void {
    if (this.patrolPause > 0) {
      this.patrolPause -= this.profile.thinkInterval;
      // Scan while paused - standing posts turn their heads.
      this.angle += this.rng.gaussian(0, 0.25) * this.profile.thinkInterval;
      return;
    }
    if (!this.patrolRoute || this.patrolRoute.points.length === 0) {
      this.state = 'idle';
      return;
    }
    if (this.pathIndex < this.path.length) return; // still walking

    const point = this.patrolRoute.points[this.patrolIndex];
    if (distance(this.x, this.y, point.x, point.y) < 1.2) {
      this.patrolIndex = (this.patrolIndex + 1) % this.patrolRoute.points.length;
      // Pausing at waypoints makes patrols readable and gives the player
      // a window to move.
      this.patrolPause = this.rng.range(1.5, 4.5);
      return;
    }
    this.requestPathTo(ctx, point.x, point.y);
  }

  private thinkInvestigate(ctx: AIWorldContext): void {
    const a = this.awareness;
    if (this.stateTimer <= 0) {
      // Gave up. Reset belief and go back to the round.
      a.level = 0;
      this.enterState('patrol');
      return;
    }
    const distToTarget = distance(this.x, this.y, a.lastKnownX, a.lastKnownY);
    if (distToTarget < 1.6 || this.pathIndex >= this.path.length) {
      // Arrived (or path exhausted): search a nearby point rather than
      // standing on the spot.
      const angle = this.rng.range(0, Math.PI * 2);
      const radius = this.rng.range(2.5, 6);
      const sx = a.lastKnownX + Math.cos(angle) * radius;
      const sy = a.lastKnownY + Math.sin(angle) * radius;
      this.requestPathTo(ctx, sx, sy);
    }
  }

  private thinkEngage(ctx: AIWorldContext): void {
    const a = this.awareness;
    if (a.level < SUSPICION_THRESHOLD) {
      this.enterState('investigate');
      return;
    }

    this.inCover = this.isInCoverFrom(ctx, a.lastKnownX, a.lastKnownY);

    // --- reload behind cover ----------------------------------------------
    const magFraction = this.weapon.magazineCapacity > 0
      ? this.weapon.ammoInMagazine / this.weapon.magazineCapacity
      : 0;
    if (!this.weapon.isBusy && magFraction < 0.25) {
      if (this.inCover || !a.visible) {
        this.weapon.reload(this.inventory);
        return;
      }
      // Out of ammunition in the open: get to cover first.
      if (this.moveToCover(ctx, a.lastKnownX, a.lastKnownY, false)) return;
    }

    if (this.weapon.state === 'jammed') {
      this.weapon.clearJam();
      if (!this.inCover) this.moveToCover(ctx, a.lastKnownX, a.lastKnownY, false);
      return;
    }

    // --- suppressed: prioritise hard cover --------------------------------
    if (this.suppression > 0.55 && !this.inCover) {
      if (this.moveToCover(ctx, this.suppressFromX, this.suppressFromY, false)) return;
    }

    // --- no line of sight: reposition to regain it ------------------------
    if (!a.visible) {
      if (this.stateTimer <= 0) {
        // Lost them for a while - flank or push towards the last position.
        const flank = this.rng.chance(this.profile.flankTendency) && ctx.squadEngaged;
        if (flank) {
          const point = this.flankPosition(ctx, a.lastKnownX, a.lastKnownY);
          if (point && this.requestPathTo(ctx, point.x, point.y)) {
            this.enterState('reposition', 6, true);
            return;
          }
        }
        this.requestPathTo(ctx, a.lastKnownX, a.lastKnownY);
        this.stateTimer = 2.5;
      }
      return;
    }

    // --- visible: hold, peek or push --------------------------------------
    const dist = a.distance;
    const preferredRange = this.preferredEngagementRange();

    if (!this.inCover && this.rng.chance(this.profile.coverDiscipline)) {
      if (this.moveToCover(ctx, ctx.target.x, ctx.target.y, true)) return;
    }

    // Push when aggressive, healthy, and the range is wrong for our weapon.
    if (dist > preferredRange * 1.6 && this.rng.chance(this.profile.aggression * 0.5)) {
      const approach = this.approachPosition(ctx, ctx.target.x, ctx.target.y, preferredRange);
      if (approach && this.requestPathTo(ctx, approach.x, approach.y)) {
        this.enterState('reposition', 4, true);
        return;
      }
    }

    // Too close for a long gun - back off to a usable distance.
    if (dist < preferredRange * 0.35 && this.rng.chance(0.4)) {
      const away = this.retreatPosition(ctx, ctx.target.x, ctx.target.y, preferredRange * 0.8);
      if (away && this.requestPathTo(ctx, away.x, away.y)) {
        this.enterState('reposition', 3, true);
        return;
      }
    }

    // Otherwise: hold position and shoot. Clear any stale path so we stop.
    this.clearPath();
  }

  private thinkFlee(ctx: AIWorldContext, healthFraction: number): void {
    // Recovered enough (or cornered) - back into the fight.
    if (healthFraction > this.profile.fleeThreshold + 0.18) {
      this.enterState('engage');
      return;
    }
    if (this.pathIndex < this.path.length) return;

    const away = this.retreatPosition(ctx, this.awareness.lastKnownX, this.awareness.lastKnownY, 18);
    if (away) this.requestPathTo(ctx, away.x, away.y);
    else this.enterState('engage');
  }

  /**
   * Switch state.
   *
   * `keepPath` exists because of a bug worth remembering. This used to clear
   * the path unconditionally, and four callers do exactly this:
   *
   *     if (this.requestPathTo(ctx, x, y)) this.enterState('reposition', 4);
   *
   * - compute somewhere to go, then throw the route away one line later. The
   * effect was that `reposition` was entered with an empty path, its exit
   * condition (`pathIndex >= path.length`) was true on the very next think
   * tick, and the AI dropped straight back to `engage` without having moved.
   *
   * Every movement decision the AI made was discarded: it never took cover,
   * never flanked, never pushed and never fell back. It stood in the open and
   * shot, for the whole fight, which reads as a very confident enemy and is
   * actually a completely inert one.
   *
   * Clearing is still the right default - most transitions do mean "stop what
   * you were walking towards" - so the exception is opt-in and named.
   */
  private enterState(state: AIState, timer = 0, keepPath = false): void {
    this.state = state;
    if (!keepPath) this.clearPath();
    switch (state) {
      case 'investigate':
        this.stateTimer = timer || 18;
        break;
      case 'engage':
        this.stateTimer = timer || 0;
        this.reactionTimer = this.profile.reactionTime * this.rng.range(0.8, 1.35);
        break;
      case 'reposition':
        this.stateTimer = timer || 5;
        break;
      case 'flee':
        this.stateTimer = timer || 12;
        break;
      default:
        this.stateTimer = timer;
        break;
    }
  }

  /** Engagement distance the current weapon is actually good at. */
  private preferredEngagementRange(): number {
    const resolved = this.weapon.resolved;
    if (!resolved) return 6;
    // Derived from mechanical accuracy: a 1 MOA marksman rifle wants distance,
    // a shotgun wants to be in the room with you.
    return clamp(30 / Math.max(1, resolved.accuracyMoa), 4, 26);
  }

  // =========================================================================
  // Tactical position selection
  // =========================================================================

  /** True when geometry shields this position from a threat bearing. */
  private isInCoverFrom(ctx: AIWorldContext, threatX: number, threatY: number): boolean {
    const dx = threatX - this.x;
    const dy = threatY - this.y;
    const len = Math.hypot(dx, dy) || 1;
    return ctx.cover.coversFrom(Math.floor(this.x), Math.floor(this.y), dx / len, dy / len, false);
  }

  private hasGoodFiringPosition(ctx: AIWorldContext): boolean {
    return this.awareness.visible && this.isInCoverFrom(ctx, ctx.target.x, ctx.target.y);
  }

  /**
   * Find and path to cover.
   *
   * `wantLineOfSight` selects between two very different needs: a fighting
   * position that still sees the target (peeking a corner), or hard cover that
   * breaks line of sight entirely (reloading, panicking, clearing a jam).
   */
  private moveToCover(ctx: AIWorldContext, threatX: number, threatY: number, wantLineOfSight: boolean): boolean {
    const spot = this.findCoverPosition(ctx, threatX, threatY, wantLineOfSight);
    if (!spot) return false;
    if (!this.requestPathTo(ctx, spot.x, spot.y)) return false;
    this.enterState('reposition', 4, true);
    return true;
  }

  /**
   * Score candidate tiles around the AI for cover value.
   * Sampling a bounded ring keeps this affordable at the think rate; the
   * precomputed CoverMap turns the expensive part into an array read.
   */
  private findCoverPosition(
    ctx: AIWorldContext,
    threatX: number,
    threatY: number,
    wantLineOfSight: boolean,
  ): { x: number; y: number } | null {
    const searchRadius = 7;
    const cx = Math.floor(this.x);
    const cy = Math.floor(this.y);

    let bestScore = -Infinity;
    let bestX = 0;
    let bestY = 0;
    let found = false;

    // Step 2 over the box: half the candidates, indistinguishable results.
    for (let ty = cy - searchRadius; ty <= cy + searchRadius; ty += 2) {
      for (let tx = cx - searchRadius; tx <= cx + searchRadius; tx += 2) {
        if (!ctx.nav.isWalkable(tx, ty)) continue;
        const px = tx + 0.5;
        const py = ty + 0.5;

        const dx = threatX - px;
        const dy = threatY - py;
        const threatDist = Math.hypot(dx, dy) || 1;
        if (!ctx.cover.coversFrom(tx, ty, dx / threatDist, dy / threatDist, false)) continue;

        const los = hasLineOfSight(ctx.map, px, py, threatX, threatY);
        if (wantLineOfSight !== los) continue;

        // Prefer: strong cover, close to us, at a sensible range to the threat.
        const coverScore = ctx.cover.scoreAt(tx, ty) / 255;
        const travel = distance(this.x, this.y, px, py);
        const preferred = this.preferredEngagementRange();
        const rangeScore = 1 - clamp01(Math.abs(threatDist - preferred) / preferred);

        const score = coverScore * 2.2 + rangeScore * 1.4 - travel * 0.16 + this.rng.range(0, 0.3);
        if (score > bestScore) {
          bestScore = score;
          bestX = px;
          bestY = py;
          found = true;
        }
      }
    }
    return found ? { x: bestX, y: bestY } : null;
  }

  /**
   * A flanking position: offset perpendicular to the squad's line of attack,
   * at roughly the preferred engagement distance. This is what turns two AI
   * holding a doorway into a pincer.
   */
  private flankPosition(ctx: AIWorldContext, targetX: number, targetY: number): { x: number; y: number } | null {
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    const len = Math.hypot(dx, dy) || 1;
    const side = this.rng.chance(0.5) ? 1 : -1;
    const perpX = (-dy / len) * side;
    const perpY = (dx / len) * side;
    const range = this.preferredEngagementRange();

    // Try progressively tighter arcs so a blocked wide flank still yields a move.
    for (const swing of [1.0, 0.7, 0.45]) {
      const px = targetX - (dx / len) * range * 0.7 + perpX * range * swing;
      const py = targetY - (dy / len) * range * 0.7 + perpY * range * swing;
      const tile = ctx.map.nearestOpen(Math.floor(px), Math.floor(py), 4);
      if (tile && ctx.nav.isWalkable(tile.x, tile.y)) return { x: tile.x + 0.5, y: tile.y + 0.5 };
    }
    return null;
  }

  private approachPosition(
    ctx: AIWorldContext,
    targetX: number,
    targetY: number,
    desiredRange: number,
  ): { x: number; y: number } | null {
    const dx = this.x - targetX;
    const dy = this.y - targetY;
    const len = Math.hypot(dx, dy) || 1;
    const px = targetX + (dx / len) * desiredRange;
    const py = targetY + (dy / len) * desiredRange;
    const tile = ctx.map.nearestOpen(Math.floor(px), Math.floor(py), 5);
    return tile && ctx.nav.isWalkable(tile.x, tile.y) ? { x: tile.x + 0.5, y: tile.y + 0.5 } : null;
  }

  private retreatPosition(
    ctx: AIWorldContext,
    threatX: number,
    threatY: number,
    distanceAway: number,
  ): { x: number; y: number } | null {
    const dx = this.x - threatX;
    const dy = this.y - threatY;
    // Fan out from directly-away, so a blocked straight retreat still finds a
    // usable angle instead of pinning the AI against the wall behind it.
    for (const spread of [0, 0.6, -0.6, 1.1, -1.1]) {
      const angle = Math.atan2(dy, dx) + spread;
      const px = this.x + Math.cos(angle) * distanceAway;
      const py = this.y + Math.sin(angle) * distanceAway;
      const tile = ctx.map.nearestOpen(Math.floor(px), Math.floor(py), 5);
      if (tile && ctx.nav.isWalkable(tile.x, tile.y)) return { x: tile.x + 0.5, y: tile.y + 0.5 };
    }
    return null;
  }

  // =========================================================================
  // Movement
  // =========================================================================

  private requestPathTo(ctx: AIWorldContext, x: number, y: number): boolean {
    // Rate-limit requests per AI on top of the director's global budget.
    if (this.pathCooldown > 0) return false;
    const points = ctx.requestPath(this.x, this.y, x, y);
    this.pathCooldown = 0.4;
    if (!points || points.length === 0) return false;
    this.path = points.length > MAX_PATH_POINTS ? points.slice(0, MAX_PATH_POINTS) : points;
    this.pathIndex = 0;
    return true;
  }

  private clearPath(): void {
    this.path.length = 0;
    this.pathIndex = 0;
  }

  private updateMovement(dt: number, ctx: AIWorldContext): void {
    if (this.pathIndex >= this.path.length) {
      this.speed = damp(this.speed, 0, 12, dt);
      return;
    }

    const wp = this.path[this.pathIndex];
    const dx = wp.x - this.x;
    const dy = wp.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.42) {
      this.pathIndex++;
      if (this.pathIndex >= this.path.length) this.clearPath();
      return;
    }

    // Sprint when repositioning under fire or closing distance; walk otherwise.
    const urgent = this.state === 'reposition' || this.state === 'flee' ||
      (this.state === 'engage' && this.suppression > 0.3);
    let speed = this.profile.moveSpeed * (urgent ? this.profile.sprintMultiplier : 1);
    speed *= this.health.modifiers.speed;
    speed *= this.inventory.stats.speedFactor;
    // Injured or suppressed AI crouch-run, which also shrinks their profile.
    this.stance = this.suppression > 0.6 ? 1 : 2;
    if (this.stance === 1) speed *= 0.62;

    const stepLen = Math.min(dist, speed * dt);
    const moved = moveCircle(ctx.map, this.x, this.y, (dx / dist) * stepLen, (dy / dist) * stepLen, this.radius);
    const travelled = Math.hypot(moved.x - this.x, moved.y - this.y);
    this.x = moved.x;
    this.y = moved.y;
    this.speed = dt > 0 ? travelled / dt : 0;
    this.walkPhase += travelled * 5.5;

    // Stuck against geometry: drop the path so the next think re-plans.
    if (travelled < stepLen * 0.15 && (moved.hitX || moved.hitY)) {
      this.clearPath();
      this.pathCooldown = 0.15;
    }

    // Footstep noise - the player can hear AI coming, exactly as AI hear them.
    if (this.walkPhase > 5) {
      this.walkPhase = 0;
      this.bus.emit('sound:emit', {
        x: this.x,
        y: this.y,
        radius: urgent ? 10 : 6.5,
        intensity: urgent ? 0.7 : 0.4,
        kind: urgent ? 'sprint' : 'footstep',
        sourceId: this.id,
      });
    }

    this.eyeHeight = this.stance === 1 ? 1.05 : 1.6;
    this.height = this.stance === 1 ? 1.25 : 1.8;
  }

  // =========================================================================
  // Aiming and firing
  // =========================================================================

  private updateAim(dt: number, ctx: AIWorldContext): void {
    // Aim error drifts on its own clock so bursts walk rather than staying
    // perfectly offset - a static error would be trivially predictable.
    this.aimErrorTimer -= dt;
    if (this.aimErrorTimer <= 0) {
      this.aimErrorTimer = this.rng.range(0.25, 0.7);
      // Suppression and injury widen the error; range scales it.
      const stress = 1 + this.suppression * 1.6 + (1 - this.health.totalHp / this.health.totalMaxHp) * 0.8;
      const spread = this.profile.aimError * stress;
      this.aimErrorYaw = this.rng.gaussianClamped(0, spread, 2.2);
      this.aimErrorPitch = this.rng.gaussianClamped(0, spread * 0.6, 2.2);
    }

    let desiredYaw = this.angle;
    let desiredPitch = 0;

    const a = this.awareness;
    if (this.state === 'engage' && a.level > SUSPICION_THRESHOLD) {
      // Lead a moving target slightly. Better tiers lead better.
      const leadFactor = this.tier === 'commander' ? 0.28 : this.tier === 'contractor' ? 0.2 : 0.08;
      const aimX = (a.visible ? ctx.target.x : a.lastKnownX) + (a.visible ? ctx.targetSpeed * leadFactor * Math.cos(ctx.target.angle) : 0);
      const aimY = (a.visible ? ctx.target.y : a.lastKnownY) + (a.visible ? ctx.targetSpeed * leadFactor * Math.sin(ctx.target.angle) : 0);
      desiredYaw = Math.atan2(aimY - this.y, aimX - this.x) + this.aimErrorYaw;

      // Elevation: aim at centre mass, accounting for the height difference.
      const dist = Math.max(0.5, distance(this.x, this.y, aimX, aimY));
      const targetCentreM = ctx.target.height * 0.62;
      const heightDelta = targetCentreM - (this.eyeHeight - 0.12);
      desiredPitch = Math.atan2(heightDelta, dist * 2) + this.aimErrorPitch;
    } else if (this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      desiredYaw = Math.atan2(wp.y - this.y, wp.x - this.x);
    } else if (this.state === 'investigate') {
      desiredYaw = Math.atan2(a.lastKnownY - this.y, a.lastKnownX - this.x);
    }

    // Turn rate is bounded - AI cannot instantly snap around, which is what
    // makes flanking them actually work.
    const turnRate = this.profile.aimSpeed * (1 - this.suppression * 0.35);
    this.angle = rotateTowards(this.angle, desiredYaw, turnRate * dt);
    this.pitch = damp(this.pitch, desiredPitch, 8, dt);
  }

  private updateWeapon(dt: number, ctx: AIWorldContext): void {
    const resolved = this.weapon.resolved;
    if (!resolved) return;

    // Recoil pushes the AI's own aim, exactly as it does the player's.
    this.angle += this.weapon.recoilYaw * 0.35;
    this.pitch += this.weapon.recoilPitch * 0.35;

    const a = this.awareness;
    const shouldEngage =
      this.state === 'engage' &&
      a.canEngage &&
      !this.weapon.isBusy &&
      this.weapon.state !== 'jammed';

    if (shouldEngage) {
      if (this.reactionTimer > 0) {
        this.reactionTimer -= dt;
      } else {
        // Only fire once the muzzle is genuinely pointed at the target;
        // otherwise AI would hose walls while turning.
        const bearing = Math.atan2(ctx.target.y - this.y, ctx.target.x - this.x);
        const aligned = Math.abs(angleDelta(this.angle, bearing)) < 0.09 + a.distance * 0.002;

        this.burstTimer -= dt;
        if (this.burstTimer <= 0) {
          this.firing = !this.firing;
          this.burstTimer = this.firing
            ? this.profile.burstDuration * this.rng.range(0.7, 1.35)
            : this.profile.burstPause * this.rng.range(0.7, 1.4) * (1 + this.suppression);
        }

        if (this.firing && aligned) this.weapon.pressTrigger();
        else this.weapon.releaseTrigger();
      }
    } else {
      this.weapon.releaseTrigger();
      this.firing = false;
    }

    // Out of ammunition entirely: reload if we still have magazines.
    if (!this.weapon.isBusy && this.weapon.ammoTotal === 0) {
      this.weapon.reload(this.inventory);
    }

    this.weapon.update(dt, {
      x: this.x,
      y: this.y,
      z: this.eyeHeight - 0.12,
      angle: this.angle,
      pitch: this.pitch,
      speed: this.speed,
      stance: this.stance,
      swayMultiplier: this.health.modifiers.sway,
      resolve: this.resolveContext(),
    });
  }

  // =========================================================================
  // Death
  // =========================================================================

  private die(): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.weapon.releaseTrigger();
    this.bus.emit('actor:killed', {
      actorId: this.id,
      killerId: 0,
      isPlayer: false,
      name: this.name,
      x: this.x,
      y: this.y,
    });
    this.bus.emit('sound:emit', {
      x: this.x, y: this.y, radius: 14, intensity: 0.6, kind: 'death', sourceId: this.id,
    });
  }

  /** Everything this enemy was carrying, for the corpse container. */
  dropLoot(): ItemStack[] {
    const items = this.inventory.stripOnDeath();
    // The secure container is a player-only privilege - AI drop everything.
    const secure = this.inventory.unequip('secure');
    if (secure) items.push(secure);
    return items;
  }

  /** Animation pose index for the sprite renderer. */
  get animationPose(): number {
    if (this.state === 'dead') return 0;
    if (this.firing) return 3;
    if (this.speed > 0.15) return Math.floor(this.walkPhase * 0.6) % 2 === 0 ? 1 : 2;
    return 0;
  }
}
