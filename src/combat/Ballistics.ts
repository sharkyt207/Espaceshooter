import { Pool } from '../core/Pool';
import { Rng } from '../core/Random';
import type { GameBus } from '../core/GameEvents';
import { pointSegmentDistSq, clamp01 } from '../core/Math2D';
import { METERS_PER_TILE, TileMap } from '../world/TileMap';
import { walkSegment } from '../world/Raycast';
import { ItemDB } from '../data/ItemDatabase';
import type { AmmoStats, BodyPart } from '../data/ItemTypes';
import type { Combatant } from './Combatant';
import { resolveHitZone } from './Combatant';
import type { EffectSystem } from '../render/Effects';

/**
 * Ballistics - simulated projectiles with penetration, energy loss and drop.
 *
 * Rounds are *not* hitscan. Every shot is a real projectile with a muzzle
 * velocity, a drag-driven velocity decay and gravity. That buys three things
 * that matter for the genre's feel:
 *
 *   1. Time of flight. At 80 m a rifle round takes ~90 ms; you can see a
 *      tracer cross the yard, and a moving target genuinely needs leading.
 *   2. Honest cover. A round loses energy passing through a wooden shed and
 *      may still kill on the far side, while concrete stops it dead. The same
 *      material table the renderer draws from decides this.
 *   3. Meaningful ammunition. Penetration is checked against armour class with
 *      a probabilistic curve, so "will this round go through that plate" has a
 *      real, learnable answer.
 *
 * Everything runs from a pooled, fixed-capacity array - firing a machine gun
 * for a full belt allocates nothing.
 */

/** Radians per minute-of-angle. */
const MOA_TO_RAD = (1 / 60) * (Math.PI / 180);
const GRAVITY_MPS2 = 9.81;
/** Below this speed a round no longer does meaningful damage. */
const MIN_LETHAL_VELOCITY = 90;

interface Projectile {
  active: boolean;
  x: number;
  y: number;
  /** Height above the floor in metres. */
  z: number;
  /** Velocity in tiles/second on the ground plane. */
  vx: number;
  vy: number;
  /** Vertical velocity in metres/second. */
  vz: number;
  speed: number;
  muzzleSpeed: number;
  ammoDefId: string;
  ownerId: number;
  ownerIsPlayer: boolean;
  /** Remaining penetration power, reduced by every barrier passed. */
  penetration: number;
  /** Current damage potential, scaled by retained energy. */
  damage: number;
  distanceM: number;
  tracer: boolean;
  /** Tiles already penetrated - a round cannot tunnel through a whole block. */
  barriersHit: number;
  life: number;
}

function newProjectile(): Projectile {
  return {
    active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, muzzleSpeed: 0,
    ammoDefId: '', ownerId: 0, ownerIsPlayer: false, penetration: 0, damage: 0,
    distanceM: 0, tracer: false, barriersHit: 0, life: 0,
  };
}

function resetProjectile(p: Projectile): void {
  p.active = false;
}

export interface ShotParams {
  originX: number;
  originY: number;
  /** Muzzle height in metres. */
  originZ: number;
  /** Normalised aim direction on the ground plane. */
  dirX: number;
  dirY: number;
  /** Aim elevation in radians (positive = up). */
  pitch: number;
  ammoDefId: string;
  ownerId: number;
  ownerIsPlayer: boolean;
  /** Total dispersion cone half-angle in radians. */
  spreadRad: number;
  /** Added to the ammunition's muzzle velocity (barrel/booster effects). */
  velocityBonus: number;
}

/**
 * Barriers recorded per integration step.
 *
 * Twelve is far more than any real segment crosses - a round that has already
 * been through three barriers is dropped - but the walk is bounded anyway so
 * a grazing shot down a wall face cannot overrun the buffer.
 */
const MAX_BARRIERS = 12;
/** Near misses recorded per step; suppression does not need more than this. */
const MAX_NEAR_MISSES = 8;
/**
 * How far above the head a round still counts as a near miss, in metres.
 *
 * A round cracking just overhead is the most suppressing thing there is, and
 * one sailing five metres up is not even noticed. Without this the near-miss
 * test was purely horizontal, so buckshot lofted over a three-metre wall
 * suppressed the man standing behind it - which reads to the player as being
 * shot at through concrete.
 */
const SUPPRESS_HEADROOM_M = 1.5;

export class BallisticsSystem {
  private projectiles: Pool<Projectile>;
  private readonly rng: Rng;
  private nearby: number[] = [];

  // --- per-step scratch, preallocated -------------------------------------
  // The whole system's contract is that firing allocates nothing, and the
  // ordered resolution below needs somewhere to put the events it finds.
  private barrierT = new Float32Array(MAX_BARRIERS);
  private barrierX = new Int32Array(MAX_BARRIERS);
  private barrierY = new Int32Array(MAX_BARRIERS);
  private barrierCount = 0;
  private nearMissActor: Array<Combatant | null> = new Array(MAX_NEAR_MISSES).fill(null);
  private nearMissT = new Float32Array(MAX_NEAR_MISSES);
  private nearMissCloseness = new Float32Array(MAX_NEAR_MISSES);
  private nearMissCount = 0;
  private hitActor: Combatant | null = null;
  private hitT = 0;

  constructor(
    private readonly bus: GameBus,
    private readonly effects: EffectSystem,
    seed: number,
    capacity = 128,
  ) {
    this.projectiles = new Pool(newProjectile, resetProjectile, capacity);
    this.rng = new Rng(seed ^ 0x5eed);
  }

  clear(): void {
    this.projectiles.releaseAll();
  }

  get activeCount(): number {
    return this.projectiles.active;
  }

  /**
   * Fire one cartridge. Buckshot spawns several projectiles from a single
   * call, each with its own dispersion sample.
   */
  fire(params: ShotParams): void {
    const ammoDef = ItemDB.tryGet(params.ammoDefId);
    const ammo = ammoDef?.ammo;
    if (!ammo) return;

    const pellets = ammo.projectiles;
    // Buckshot's own pattern is added on top of the weapon's dispersion.
    const pelletSpread = ammo.spreadMoa * MOA_TO_RAD;

    for (let i = 0; i < pellets; i++) {
      const p = this.projectiles.acquire();
      if (!p) return;

      // Sample the dispersion cone. A Gaussian sample clustered towards the
      // centre reads far better than a uniform disc: most rounds land near
      // point of aim and the occasional flyer feels like bad luck, not noise.
      const coneYaw = this.rng.gaussianClamped(0, params.spreadRad * 0.5 + pelletSpread * 0.5, 2.2);
      const conePitch = this.rng.gaussianClamped(0, params.spreadRad * 0.5 + pelletSpread * 0.5, 2.2);

      const yaw = Math.atan2(params.dirY, params.dirX) + coneYaw;
      const pitch = params.pitch + conePitch;

      const cosPitch = Math.cos(pitch);
      p.active = true;
      p.x = params.originX;
      p.y = params.originY;
      p.z = params.originZ;

      const muzzleMps = Math.max(80, ammo.muzzleVelocity + params.velocityBonus);
      p.muzzleSpeed = muzzleMps;
      p.speed = muzzleMps;
      // Convert m/s to tiles/s for the ground-plane components.
      const tilesPerSec = muzzleMps / METERS_PER_TILE;
      p.vx = Math.cos(yaw) * cosPitch * tilesPerSec;
      p.vy = Math.sin(yaw) * cosPitch * tilesPerSec;
      p.vz = Math.sin(pitch) * muzzleMps;

      p.ammoDefId = params.ammoDefId;
      p.ownerId = params.ownerId;
      p.ownerIsPlayer = params.ownerIsPlayer;
      p.penetration = ammo.penetration;
      p.damage = ammo.damage;
      p.distanceM = 0;
      p.barriersHit = 0;
      // Cap flight time: a stray round must not live forever.
      p.life = 3.5;
      p.tracer = ammo.tracerFraction > 0 && this.rng.chance(ammo.tracerFraction);

      if (p.tracer) {
        this.effects.tracer(p.x, p.y, p.z / METERS_PER_TILE, p.vx / tilesPerSec, p.vy / tilesPerSec, 26);
      }
    }
  }

  /**
   * Advance every projectile.
   * `queryNearby` narrows actor tests to a radius via the spatial hash;
   * `resolveActor` turns an id back into a Combatant.
   */
  update(
    dt: number,
    map: TileMap,
    queryNearby: (x: number, y: number, radius: number, out: number[]) => void,
    resolveActor: (id: number) => Combatant | undefined,
  ): void {
    for (let i = this.projectiles.active - 1; i >= 0; i--) {
      const p = this.projectiles.get(i);
      p.life -= dt;
      if (p.life <= 0) {
        this.projectiles.releaseAt(i);
        continue;
      }

      // --- integrate --------------------------------------------------------
      const ammo = ItemDB.get(p.ammoDefId).ammo!;
      // Drag: dv/dt proportional to v^2, scaled by the inverse of the ballistic
      // coefficient. Cheap, and it reproduces the right shape of decay.
      const dragK = 0.0009 / Math.max(0.05, ammo.ballisticCoefficient);
      const decay = Math.max(0, 1 - dragK * p.speed * dt);
      p.vx *= decay;
      p.vy *= decay;
      p.vz = p.vz * decay - GRAVITY_MPS2 * dt;

      const startX = p.x;
      const startY = p.y;
      const startZ = p.z;
      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      const nz = p.z + p.vz * dt * 1; // vz already in m/s

      const groundSpeedTiles = Math.hypot(p.vx, p.vy);
      p.speed = Math.hypot(groundSpeedTiles * METERS_PER_TILE, p.vz);
      const segLenTiles = Math.hypot(nx - startX, ny - startY);
      p.distanceM += segLenTiles * METERS_PER_TILE;

      // Rounds that have shed their energy simply drop out of the sim.
      if (p.speed < MIN_LETHAL_VELOCITY || nz <= 0 || p.distanceM > 400) {
        if (nz <= 0 && p.speed >= MIN_LETHAL_VELOCITY) {
          this.effects.bulletImpact(nx, ny, 0.02, -p.vx / (groundSpeedTiles || 1), -p.vy / (groundSpeedTiles || 1), true);
        }
        this.projectiles.releaseAt(i);
        continue;
      }

      // --- resolve the step in distance order --------------------------------
      //
      // Actors and geometry have to be merged along the segment rather than
      // tested one after the other, because a segment is not short. A rifle
      // round covers roughly 360 tiles a second; at 60 Hz that is six tiles a
      // step, at 30 Hz twelve. Testing every actor on the whole segment before
      // looking at a single wall meant a round was credited with a hit on
      // someone standing three tiles behind concrete whenever the wall and the
      // target happened to fall in the same step - measured, and it depended
      // on nothing but the phase of the integration, which is why being shot
      // through cover felt random rather than explicable.
      this.collectBarriers(map, startX, startY, startZ, nx, ny, nz, segLenTiles);
      this.findActors(p, startX, startY, startZ, nx, ny, nz, segLenTiles, queryNearby, resolveActor);

      // Anything the round physically reaches first is resolved first. The
      // actor is the cut-off: barriers behind it never get to touch this shot.
      const actorT = this.hitActor ? this.hitT : Infinity;
      let stoppedAt = Infinity;
      for (let b = 0; b < this.barrierCount; b++) {
        if (this.barrierT[b] > actorT) break;
        if (!this.resolveBarrier(p, map, b, startX, startY, startZ, nx, ny, nz)) {
          stoppedAt = this.barrierT[b];
          break;
        }
      }

      // Suppression is only earned by rounds that actually got past the wall.
      this.flushNearMisses(p, Math.min(stoppedAt, actorT));

      if (stoppedAt < Infinity) {
        this.projectiles.releaseAt(i);
        continue;
      }

      if (this.hitActor) {
        const impactX = startX + (nx - startX) * this.hitT;
        const impactY = startY + (ny - startY) * this.hitT;
        const impactZ = startZ + (nz - startZ) * this.hitT;
        this.resolveActorHit(p, this.hitActor, impactX, impactY, impactZ);
        this.projectiles.releaseAt(i);
        continue;
      }

      p.x = nx;
      p.y = ny;
      p.z = nz;
    }
  }

  /**
   * Closest-approach test against every actor near the segment.
   *
   * Records rather than resolves: the caller merges what this finds with the
   * barriers along the same segment and only then decides what the round
   * actually did. Near misses are recorded with their position along the
   * segment too, so a round stopped by a wall cannot suppress the person
   * standing behind it.
   */
  private findActors(
    p: Projectile,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    segLen: number,
    queryNearby: (x: number, y: number, radius: number, out: number[]) => void,
    resolveActor: (id: number) => Combatant | undefined,
  ): void {
    this.hitActor = null;
    this.hitT = 0;
    this.nearMissCount = 0;

    const midX = (x0 + x1) * 0.5;
    const midY = (y0 + y1) * 0.5;
    queryNearby(midX, midY, segLen * 0.5 + 1.2, this.nearby);
    if (this.nearby.length === 0) return;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    let bestT = Infinity;
    let bestActor: Combatant | null = null;

    for (let i = 0; i < this.nearby.length; i++) {
      const id = this.nearby[i];
      if (id === p.ownerId) continue;
      const actor = resolveActor(id);
      if (!actor || !actor.alive) continue;

      // Parametric position of closest approach, used to order events along
      // the segment and to interpolate the impact height.
      const t = lenSq > 0 ? clamp01(((actor.x - x0) * dx + (actor.y - y0) * dy) / lenSq) : 0;
      const distSq = pointSegmentDistSq(actor.x, actor.y, x0, y0, x1, y1);
      const r = actor.radius;

      // Vertical position of the round as it passes, shared by both tests.
      const impactZ = z0 + (z1 - z0) * t;

      if (distSq > r * r) {
        // Near miss: close enough to hear the round crack past. Feeds
        // suppression without needing a separate query.
        const suppressRadius = r + 1.4;
        const withinEarshot = impactZ > -0.5 && impactZ < actor.height + SUPPRESS_HEADROOM_M;
        if (withinEarshot && distSq <= suppressRadius * suppressRadius && this.nearMissCount < MAX_NEAR_MISSES) {
          const n = this.nearMissCount++;
          this.nearMissActor[n] = actor;
          this.nearMissT[n] = t;
          this.nearMissCloseness[n] = 1 - (Math.sqrt(distSq) - r) / 1.4;
        }
        continue;
      }

      // Vertical check: is the round at body height when it passes?
      if (impactZ < 0 || impactZ > actor.height) continue;

      if (t < bestT) {
        bestT = t;
        bestActor = actor;
      }
    }

    this.hitActor = bestActor;
    this.hitT = bestActor ? bestT : 0;
  }

  /** Report the near misses that happened before the round was stopped. */
  private flushNearMisses(p: Projectile, limitT: number): void {
    for (let i = 0; i < this.nearMissCount; i++) {
      if (this.nearMissT[i] <= limitT) {
        this.nearMissActor[i]?.onNearMiss?.(p.ownerId, this.nearMissCloseness[i], p.x, p.y);
      }
      // Dropped so the pool never pins a dead combatant alive.
      this.nearMissActor[i] = null;
    }
    this.nearMissCount = 0;
  }

  /**
   * Apply a hit to a combatant: pick the body part, run the armour check,
   * scale damage by retained energy, and emit the resulting events.
   */
  private resolveActorHit(p: Projectile, target: Combatant, hx: number, hy: number, hz: number): void {
    const ammoDef = ItemDB.get(p.ammoDefId);
    const ammo = ammoDef.ammo!;
    const roll = () => this.rng.float();

    // Retained energy relative to the muzzle drives both damage and the
    // round's remaining ability to defeat armour.
    const speedRatio = clamp01(p.speed / p.muzzleSpeed);
    const energyRatio = speedRatio * speedRatio;
    let damage = p.damage * (0.55 + 0.45 * energyRatio);
    let penetration = p.penetration * (0.45 + 0.55 * speedRatio);

    const heightFraction = clamp01(hz / Math.max(0.5, target.height));
    // Lateral offset: which side of centre mass the round passed.
    const dirX = p.vx;
    const dirY = p.vy;
    const len = Math.hypot(dirX, dirY) || 1;
    const rightX = -dirY / len;
    const rightY = dirX / len;
    const lateral = ((hx - target.x) * rightX + (hy - target.y) * rightY) / target.radius;

    const part: BodyPart = resolveHitZone(heightFraction, clamp01(Math.abs(lateral)) * Math.sign(lateral), roll);

    // --- armour -----------------------------------------------------------
    let penetrated = true;
    const armor = target.inventory.armorFor(part);
    if (armor) {
      const stats = armor.def.armor!;
      const durabilityRatio = clamp01((armor.stack.durability ?? 0) / stats.maxDurability);
      // A worn plate protects far less than a fresh one - degraded armour is
      // what makes long raids dangerous even when you started well equipped.
      const effectiveArmor = stats.armorClass * 10 * (0.42 + 0.58 * durabilityRatio);
      const delta = penetration - effectiveArmor;
      // Logistic curve: equal power means a coin flip, +/-10 is decisive.
      const penChance = 1 / (1 + Math.exp(-delta * 0.17));
      penetrated = roll() < penChance;

      // Armour always takes durability damage, whether or not it held.
      const durabilityLoss =
        (ammo.armorDamage / 100) * damage * stats.materialFactor * (penetrated ? 0.55 : 0.9);
      armor.stack.durability = Math.max(0, (armor.stack.durability ?? 0) - durabilityLoss);

      if (penetrated) {
        // Barely-penetrating rounds arrive with much less to give.
        const margin = clamp01(delta / 22);
        damage *= 0.5 + 0.5 * margin;
        penetration = Math.max(0, delta);
      } else {
        // Blunt trauma: high-class armour transmits less.
        const bluntFactor = Math.max(0.06, 0.3 - stats.armorClass * 0.035);
        damage *= bluntFactor;
      }
    }

    // --- terminal effects -------------------------------------------------
    let bleedChance = 0;
    let heavyBleedChance = 0;
    let fractureChance = 0;
    if (penetrated) {
      if (roll() < ammo.fragmentation) damage *= 1.55;
      // Bigger, faster wounds bleed more.
      const severity = clamp01(damage / 70);
      bleedChance = 0.24 + severity * 0.42;
      heavyBleedChance = severity * 0.3;
      fractureChance = damage > 45 ? clamp01((damage - 45) / 140) : 0;
    } else {
      // Stopped rounds still break bones through a plate.
      fractureChance = clamp01((damage - 6) / 90) * 0.35;
    }

    damage = Math.max(1, damage);
    target.health.applyDamage(part, damage, { bleedChance, heavyBleedChance, fractureChance, roll });
    target.onHit?.(p.ownerId, part, damage, penetrated, dirX / len, dirY / len);

    this.bus.emit('damage:dealt', {
      targetId: target.id,
      attackerId: p.ownerId,
      amount: damage,
      bodyPart: part,
      penetrated,
      isPlayer: target.isPlayer,
      x: hx,
      y: hy,
    });

    this.effects.bloodSpray(hx, hy, hz / METERS_PER_TILE, dirX / len, dirY / len, clamp01(damage / 60));
    this.bus.emit('sound:emit', {
      x: hx, y: hy, radius: 7, intensity: 0.3, kind: 'impact', sourceId: p.ownerId,
    });
  }

  /**
   * Record every barrier the segment physically runs into, in order.
   *
   * Pure geometry - nothing here decides whether the round gets through, so
   * the caller is free to discard barriers that sit behind an actor the round
   * reached first. The height test is what lets a round pass over a crate or
   * under a raised beam, and it is the same test the renderer draws from.
   */
  private collectBarriers(
    map: TileMap,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    segLen: number,
  ): void {
    this.barrierCount = 0;

    walkSegment(x0, y0, x1, y1, (tx, ty, dist) => {
      if (!map.isWall(tx, ty)) return true;

      const t = segLen > 0 ? clamp01(dist / segLen) : 0;
      const impactZ = z0 + (z1 - z0) * t;
      if (impactZ > map.heightOf(tx, ty)) return true; // sails over the obstacle

      const n = this.barrierCount;
      this.barrierT[n] = t;
      this.barrierX[n] = tx;
      this.barrierY[n] = ty;
      this.barrierCount = n + 1;
      return this.barrierCount < MAX_BARRIERS;
    });
  }

  /**
   * Resolve one recorded barrier against the projectile's current state.
   * Returns false when the round is stopped here.
   */
  private resolveBarrier(
    p: Projectile,
    map: TileMap,
    index: number,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): boolean {
    const tx = this.barrierX[index];
    const ty = this.barrierY[index];
    const t = this.barrierT[index];
    const resistance = map.penetrationOf(tx, ty);
    const impactX = x0 + (x1 - x0) * t;
    const impactY = y0 + (y1 - y0) * t;
    const impactZ = z0 + (z1 - z0) * t;
    const len = Math.hypot(p.vx, p.vy) || 1;

    if (p.penetration <= resistance || p.barriersHit >= 3) {
      // Stopped. Sparks fly back along the incoming direction.
      this.effects.bulletImpact(impactX, impactY, impactZ / METERS_PER_TILE, -p.vx / len, -p.vy / len, resistance > 20);
      this.bus.emit('sound:emit', {
        x: impactX, y: impactY, radius: 9, intensity: 0.35,
        kind: resistance > 40 ? 'ricochet' : 'impact', sourceId: p.ownerId,
      });
      return false;
    }

    // Punched through: bleed off penetration and energy.
    const loss = map.energyLossOf(tx, ty);
    p.penetration -= resistance;
    p.damage *= 1 - loss * 0.7;
    const speedScale = 1 - loss * 0.55;
    p.vx *= speedScale;
    p.vy *= speedScale;
    p.vz *= speedScale;
    p.speed *= speedScale;
    p.barriersHit++;

    this.effects.bulletImpact(impactX, impactY, impactZ / METERS_PER_TILE, -p.vx / len, -p.vy / len, resistance > 20);
    this.bus.emit('sound:emit', {
      x: impactX, y: impactY, radius: 8, intensity: 0.3, kind: 'impact', sourceId: p.ownerId,
    });

    return p.damage >= 4 && p.speed >= MIN_LETHAL_VELOCITY;
  }

  /** Convert a weapon's dispersion in MOA into a cone half-angle in radians. */
  static moaToRadians(moa: number): number {
    return moa * MOA_TO_RAD;
  }

  /**
   * Reference figure for the UI: how far a round of this ammunition stays
   * lethal, in metres. Not used by the simulation - purely informational.
   */
  static effectiveRangeM(ammo: AmmoStats): number {
    // Terminal velocity threshold reached earlier for blunt, draggy rounds.
    const ratio = MIN_LETHAL_VELOCITY / ammo.muzzleVelocity;
    return Math.round(Math.min(400, (Math.log(1 / ratio) * ammo.ballisticCoefficient) / 0.0009 / 4));
  }
}
