import type { GameBus, SoundEventPayload } from '../core/GameEvents';
import { Rng } from '../core/Random';
import { SpatialHash } from '../core/SpatialHash';
import { distance } from '../core/Math2D';
import type { BallisticsSystem } from '../combat/Ballistics';
import type { Combatant } from '../combat/Combatant';
import { separate } from '../world/Physics';
import type { CoverMap, NavGrid } from '../world/NavGrid';
import type { GeneratedMap } from '../world/MapGenerator';
import type { TileMap } from '../world/TileMap';
import { Enemy, type AIWorldContext } from './Enemy';
import { tierWeightsForDanger, type AITier } from './AIProfiles';

/**
 * AIDirector - owns the enemy population and the frame budget it consumes.
 *
 * Three responsibilities, all in service of "thirty enemies at 60 FPS on a
 * mid-range phone":
 *
 *   1. **Budgeting.** Pathfinding is the only genuinely expensive AI operation,
 *      so it is capped per frame. Requests beyond the cap are refused, and the
 *      AI that was refused simply re-asks next think tick - behaviour degrades
 *      gracefully instead of the frame rate degrading.
 *
 *   2. **Level of detail.** Enemies far from the player and unaware of anything
 *      tick at a fraction of the rate. Nobody can observe the difference, and
 *      it is where most of the savings come from.
 *
 *   3. **Squads.** Enemies spawned near each other share a squad id. A contact
 *      reported by one is shared with the rest, which is what produces
 *      coordinated pushes and flanks without any central planner.
 */

/** A* calls allowed per frame across the whole population. */
const PATH_BUDGET_PER_FRAME = 3;
/** Beyond this distance an unaware enemy ticks at reduced rate. */
const LOD_DISTANCE = 34;
/** Distance beyond which unaware enemies are effectively frozen. */
const FREEZE_DISTANCE = 60;

interface Squad {
  id: number;
  memberIds: number[];
  /** Last reported contact, shared by every member. */
  contactX: number;
  contactY: number;
  contactTime: number;
  engaged: boolean;
}

export class AIDirector {
  readonly enemies: Enemy[] = [];
  private readonly squads: Squad[] = [];
  private readonly byId = new Map<number, Enemy>();

  private pathBudget = PATH_BUDGET_PER_FRAME;
  private readonly rng: Rng;
  private spatial: SpatialHash | null = null;
  private neighbours: number[] = [];

  /** Set each frame so AI context can read player motion. */
  private targetSpeed = 0;
  private targetStance = 2;

  private elapsed = 0;

  constructor(
    private readonly bus: GameBus,
    private readonly ballistics: BallisticsSystem,
    seed: number,
  ) {
    this.rng = new Rng(seed ^ 0xa11d);
  }

  clear(): void {
    this.enemies.length = 0;
    this.squads.length = 0;
    this.byId.clear();
    this.elapsed = 0;
  }

  byActorId(id: number): Enemy | undefined {
    return this.byId.get(id);
  }

  get aliveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.alive) n++;
    return n;
  }

  /**
   * Populate the map from its generated spawn points.
   * Tiers are drawn from the danger of the zone each point sits in, so the
   * central building naturally holds the professionals.
   */
  populate(generated: GeneratedMap, map: TileMap, seed: number): void {
    this.clear();
    this.spatial = new SpatialHash(map.width, map.height, 6, 512);

    let squadCounter = 0;
    const spawns = generated.aiSpawns;

    for (let i = 0; i < spawns.length; i++) {
      const spawn = spawns[i];
      const zone = map.zoneAt(Math.floor(spawn.x), Math.floor(spawn.y));
      const danger = zone?.danger ?? 0.25;

      const weights = tierWeightsForDanger(danger);
      const tier = this.rng.weighted(
        weights.map((w) => w.tier),
        weights.map((w) => w.weight),
      ) as AITier;

      const enemy = new Enemy(this.bus, this.ballistics, tier, seed + i * 7919);
      enemy.spawn(spawn.x, spawn.y, spawn.angle);

      // Assign a patrol route from the same zone where possible.
      const routes = generated.patrolRoutes.filter((r) => r.zoneId === (zone?.id ?? 0));
      enemy.patrolRoute = routes.length > 0
        ? this.rng.pick(routes)
        : generated.patrolRoutes.length > 0
          ? this.rng.pick(generated.patrolRoutes)
          : null;

      this.enemies.push(enemy);
      this.byId.set(enemy.id, enemy);

      // Squad by proximity: enemies within 10 tiles of an existing squad
      // member join it, up to four to a squad.
      let squad = this.squads.find(
        (s) =>
          s.memberIds.length < 4 &&
          s.memberIds.some((id) => {
            const other = this.byId.get(id);
            return other && distance(other.x, other.y, enemy.x, enemy.y) < 10;
          }),
      );
      if (!squad) {
        squad = { id: squadCounter++, memberIds: [], contactX: 0, contactY: 0, contactTime: -999, engaged: false };
        this.squads.push(squad);
      }
      squad.memberIds.push(enemy.id);
    }

    // The boss and a personal guard detail.
    if (generated.bossSpawn) {
      const boss = new Enemy(this.bus, this.ballistics, 'commander', seed + 4242);
      boss.spawn(generated.bossSpawn.x, generated.bossSpawn.y, generated.bossSpawn.angle);
      this.enemies.push(boss);
      this.byId.set(boss.id, boss);

      const guardSquad: Squad = {
        id: squadCounter++, memberIds: [boss.id], contactX: 0, contactY: 0, contactTime: -999, engaged: false,
      };
      this.squads.push(guardSquad);

      for (let g = 0; g < 3; g++) {
        const angle = (g / 3) * Math.PI * 2;
        const gx = generated.bossSpawn.x + Math.cos(angle) * 3.2;
        const gy = generated.bossSpawn.y + Math.sin(angle) * 3.2;
        const open = map.nearestOpen(Math.floor(gx), Math.floor(gy), 6);
        if (!open) continue;
        const guard = new Enemy(this.bus, this.ballistics, 'contractor', seed + 5000 + g);
        guard.spawn(open.x + 0.5, open.y + 0.5, angle + Math.PI);
        this.enemies.push(guard);
        this.byId.set(guard.id, guard);
        guardSquad.memberIds.push(guard.id);
      }
    }
  }

  /** Route a world sound to every enemy that could plausibly hear it. */
  onSound(sound: SoundEventPayload, map: TileMap): void {
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      // Cheap reject before the expensive occlusion estimate.
      const dx = enemy.x - sound.x;
      const dy = enemy.y - sound.y;
      const maxRadius = sound.radius * 1.5;
      if (dx * dx + dy * dy > maxRadius * maxRadius) continue;
      enemy.onSound(sound, map);
    }
  }

  update(
    dt: number,
    map: TileMap,
    nav: NavGrid,
    cover: CoverMap,
    target: Combatant,
    targetSpeed: number,
    targetStance: number,
  ): void {
    this.elapsed += dt;
    this.pathBudget = PATH_BUDGET_PER_FRAME;
    this.targetSpeed = targetSpeed;
    this.targetStance = targetStance;

    // Refresh the shared flow field towards the player. Only rebuilt when the
    // player changes tile, so a standing player costs nothing.
    nav.buildFlowField(target.x, target.y);

    // Reset per-frame squad engagement flags.
    for (const squad of this.squads) {
      squad.engaged = this.elapsed - squad.contactTime < 6;
    }

    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;

      // --- level of detail --------------------------------------------------
      const dist = distance(enemy.x, enemy.y, target.x, target.y);
      const aware = enemy.awareness.level > 0.05 || enemy.state === 'engage' || enemy.state === 'investigate';
      if (!aware) {
        if (dist > FREEZE_DISTANCE) continue;
        // Distant, oblivious enemies still patrol, just less often.
        if (dist > LOD_DISTANCE && ((this.elapsed * 3) | 0) % 3 !== (enemy.id % 3)) continue;
      }

      const squad = this.squadFor(enemy.id);
      const ctx: AIWorldContext = {
        map,
        nav,
        cover,
        target,
        targetSpeed: this.targetSpeed,
        targetStance: this.targetStance,
        requestPath: (fx, fy, tx, ty) => this.requestPath(nav, fx, fy, tx, ty),
        squadEngaged: squad?.engaged ?? false,
        alertSquad: (x, y) => this.alertSquad(enemy.id, x, y),
        elapsed: this.elapsed,
      };

      // Distant unaware enemies were skipped above, so scale dt for those we
      // do tick at reduced rate.
      enemy.update(dt, ctx);
    }

    this.resolveCollisions(map);
    this.propagateSquadContacts();
  }

  /** Keep actors from standing inside each other. */
  private resolveCollisions(map: TileMap): void {
    if (!this.spatial) return;
    this.spatial.begin();
    for (const enemy of this.enemies) {
      if (enemy.alive) this.spatial.insert(enemy.id, enemy.x, enemy.y);
    }
    this.spatial.build();

    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      this.spatial.queryRadius(enemy.x, enemy.y, enemy.radius * 2.2, this.neighbours);
      for (const otherId of this.neighbours) {
        if (otherId <= enemy.id) continue; // resolve each pair once
        const other = this.byId.get(otherId);
        if (!other || !other.alive) continue;
        separate(enemy, other, map);
      }
    }
  }

  /**
   * Share a squad's contact with members who have not seen anything yet.
   * The shared belief is deliberately weaker than a first-hand sighting: you
   * move towards where your partner is shouting, you do not gain their eyes.
   */
  private propagateSquadContacts(): void {
    for (const squad of this.squads) {
      if (!squad.engaged) continue;
      for (const id of squad.memberIds) {
        const member = this.byId.get(id);
        if (!member || !member.alive) continue;
        if (member.awareness.level >= 0.6) continue;
        member.awareness.level = Math.max(member.awareness.level, 0.45);
        member.awareness.lastKnownX = squad.contactX;
        member.awareness.lastKnownY = squad.contactY;
        if (member.state === 'patrol' || member.state === 'idle') {
          member.state = 'investigate';
        }
      }
    }
  }

  private alertSquad(memberId: number, x: number, y: number): void {
    const squad = this.squadFor(memberId);
    if (!squad) return;
    squad.contactX = x;
    squad.contactY = y;
    squad.contactTime = this.elapsed;
    squad.engaged = true;
  }

  private squadFor(memberId: number): Squad | undefined {
    return this.squads.find((s) => s.memberIds.includes(memberId));
  }

  /** Budgeted path request; returns null when this frame's budget is spent. */
  private requestPath(
    nav: NavGrid,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): { x: number; y: number }[] | null {
    if (this.pathBudget <= 0) return null;
    this.pathBudget--;
    const result = nav.findPath(fromX, fromY, toX, toY);
    return result.points.length > 0 ? result.points : null;
  }

  /** Spawn a reinforcement wave - used by dynamic raid events. */
  spawnWave(
    map: TileMap,
    tier: AITier,
    count: number,
    nearX: number,
    nearY: number,
    minDistance: number,
    seed: number,
  ): Enemy[] {
    const spawned: Enemy[] = [];
    const squad: Squad = {
      id: this.squads.length, memberIds: [], contactX: nearX, contactY: nearY,
      contactTime: this.elapsed, engaged: true,
    };

    for (let i = 0; i < count; i++) {
      let placed: { x: number; y: number } | null = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        const angle = this.rng.range(0, Math.PI * 2);
        const radius = this.rng.range(minDistance, minDistance + 12);
        const px = Math.floor(nearX + Math.cos(angle) * radius);
        const py = Math.floor(nearY + Math.sin(angle) * radius);
        const open = map.nearestOpen(px, py, 5);
        if (open && distance(open.x, open.y, nearX, nearY) >= minDistance) {
          placed = open;
          break;
        }
      }
      if (!placed) continue;

      const enemy = new Enemy(this.bus, this.ballistics, tier, seed + i * 104729);
      enemy.spawn(placed.x + 0.5, placed.y + 0.5, this.rng.range(0, Math.PI * 2));
      // Reinforcements arrive already looking for you.
      enemy.awareness.level = 0.5;
      enemy.awareness.lastKnownX = nearX;
      enemy.awareness.lastKnownY = nearY;
      enemy.state = 'investigate';

      this.enemies.push(enemy);
      this.byId.set(enemy.id, enemy);
      squad.memberIds.push(enemy.id);
      spawned.push(enemy);
    }

    if (squad.memberIds.length > 0) this.squads.push(squad);
    return spawned;
  }

  /** Number of enemies currently aware of the player - drives HUD tension. */
  get engagedCount(): number {
    let n = 0;
    for (const e of this.enemies) {
      if (e.alive && (e.state === 'engage' || e.state === 'investigate')) n++;
    }
    return n;
  }
}
