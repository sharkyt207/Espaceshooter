import type { GameBus } from '../core/GameEvents';
import { Rng } from '../core/Random';
import type { AIDirector } from '../ai/AIDirector';
import type { TileMap } from '../world/TileMap';
import type { EffectSystem } from '../render/Effects';
import type { LootSystem } from '../loot/LootSystem';
import { LOOT_TABLES } from '../loot/LootTables';

/**
 * DynamicEvents - scripted pressure that keeps a raid from settling.
 *
 * A quiet extraction shooter is a boring one. These events exist to force
 * decisions on a player who has found a comfortable corner: a supply drop
 * offers reward at a known, advertised position; a sweep patrol takes the safe
 * route away; a blackout takes away your sightlines and hands them to whoever
 * is closer. Each event is announced, so it is a choice rather than an ambush.
 *
 * Events fire on a spaced schedule with a per-raid cap, because unpredictable
 * is good and relentless is not.
 */

export type RaidEventKind = 'supplyDrop' | 'sweepPatrol' | 'blackout' | 'reinforcements' | 'commanderMoves';

export interface ActiveRaidEvent {
  kind: RaidEventKind;
  title: string;
  description: string;
  /** Seconds the event stays active. */
  duration: number;
  elapsed: number;
  /** World marker, when the event has a location. */
  x?: number;
  y?: number;
}

interface EventDef {
  kind: RaidEventKind;
  title: string;
  description: string;
  weight: number;
  duration: number;
  /** Fraction of the raid before which the event cannot fire. */
  earliest: number;
  /** Fraction after which it stops firing. */
  latest: number;
}

const EVENT_DEFS: EventDef[] = [
  {
    kind: 'supplyDrop',
    title: 'VERSORGUNGSABWURF',
    description: 'Eine Versorgungskiste ist im Sektor niedergegangen. Position markiert.',
    weight: 30,
    duration: 999,
    earliest: 0.12,
    latest: 0.72,
  },
  {
    kind: 'sweepPatrol',
    title: 'PATROUILLE IM ANMARSCH',
    description: 'Eine Söldnerpatrouille durchkämmt den Sektor. Bewegung vermeiden.',
    weight: 26,
    duration: 90,
    earliest: 0.2,
    latest: 0.8,
  },
  {
    kind: 'blackout',
    title: 'STROMAUSFALL',
    description: 'Der Generator ist ausgefallen. Sichtverhältnisse stark eingeschränkt.',
    weight: 20,
    duration: 75,
    earliest: 0.25,
    latest: 0.85,
  },
  {
    kind: 'reinforcements',
    title: 'VERSTÄRKUNG ANGEFORDERT',
    description: 'Deine Position wurde gemeldet. Verstärkung ist unterwegs.',
    weight: 18,
    duration: 60,
    earliest: 0.3,
    latest: 0.9,
  },
  {
    kind: 'commanderMoves',
    title: 'KOMMANDANT IN BEWEGUNG',
    description: 'Der Kommandant hat sein Depot verlassen und sucht den Sektor ab.',
    weight: 12,
    duration: 120,
    earliest: 0.4,
    latest: 0.85,
  },
];

export class DynamicEventSystem {
  readonly active: ActiveRaidEvent[] = [];
  /** History for the raid summary screen. */
  readonly fired: RaidEventKind[] = [];

  /** Ambient light multiplier applied by a blackout, 1 = normal. */
  lightMultiplier = 1;

  private nextEventAt = 0;
  private readonly rng: Rng;
  private eventsFired = 0;
  private readonly maxEvents: number;

  constructor(private readonly bus: GameBus, seed: number, maxEvents = 3) {
    this.rng = new Rng(seed ^ 0xe7e7);
    this.maxEvents = maxEvents;
    // First event never lands in the opening two minutes.
    this.nextEventAt = this.rng.range(150, 260);
  }

  reset(): void {
    this.active.length = 0;
    this.fired.length = 0;
    this.eventsFired = 0;
    this.lightMultiplier = 1;
    this.nextEventAt = this.rng.range(150, 260);
  }

  update(
    dt: number,
    elapsed: number,
    raidFraction: number,
    ctx: {
      map: TileMap;
      ai: AIDirector;
      loot: LootSystem;
      effects: EffectSystem;
      playerX: number;
      playerY: number;
      seed: number;
    },
  ): void {
    // --- expire running events --------------------------------------------
    for (let i = this.active.length - 1; i >= 0; i--) {
      const ev = this.active[i];
      ev.elapsed += dt;
      if (ev.elapsed >= ev.duration) {
        this.endEvent(ev);
        this.active.splice(i, 1);
      }
    }

    if (this.eventsFired >= this.maxEvents) return;
    if (elapsed < this.nextEventAt) return;

    const candidates = EVENT_DEFS.filter(
      (d) => raidFraction >= d.earliest && raidFraction <= d.latest && !this.fired.includes(d.kind),
    );
    if (candidates.length === 0) {
      this.nextEventAt = elapsed + 60;
      return;
    }

    const def = this.rng.weighted(candidates, candidates.map((c) => c.weight));
    if (!def) return;

    this.trigger(def, ctx);
    this.eventsFired++;
    // Space events out so the raid breathes between them.
    this.nextEventAt = elapsed + this.rng.range(220, 340);
  }

  private trigger(
    def: EventDef,
    ctx: {
      map: TileMap;
      ai: AIDirector;
      loot: LootSystem;
      effects: EffectSystem;
      playerX: number;
      playerY: number;
      seed: number;
    },
  ): void {
    const event: ActiveRaidEvent = {
      kind: def.kind,
      title: def.title,
      description: def.description,
      duration: def.duration,
      elapsed: 0,
    };

    switch (def.kind) {
      case 'supplyDrop': {
        // Land it a meaningful distance away: worth going for, not free.
        const angle = this.rng.range(0, Math.PI * 2);
        const dist = this.rng.range(20, 38);
        const tx = Math.floor(ctx.playerX + Math.cos(angle) * dist);
        const ty = Math.floor(ctx.playerY + Math.sin(angle) * dist);
        const open = ctx.map.nearestOpen(tx, ty, 14);
        if (open) {
          const container = ctx.loot.createContainer(LOOT_TABLES.boss_cache, open.x + 0.5, open.y + 0.5, 0.85);
          container.name = 'Versorgungsabwurf';
          ctx.loot.containers.push(container);
          event.x = container.x;
          event.y = container.y;
          ctx.effects.explosion(container.x, container.y, 0.3, 0.4);
          // The drop is loud - everyone nearby knows where it landed.
          this.bus.emit('sound:emit', {
            x: container.x, y: container.y, radius: 55, intensity: 1,
            kind: 'explosion', sourceId: 0,
          });
        }
        break;
      }

      case 'sweepPatrol':
        ctx.ai.spawnWave(ctx.map, 'contractor', 3, ctx.playerX, ctx.playerY, 26, ctx.seed + 991);
        break;

      case 'reinforcements':
        ctx.ai.spawnWave(ctx.map, 'guard', 4, ctx.playerX, ctx.playerY, 18, ctx.seed + 1771);
        break;

      case 'blackout':
        // Halving the lightmap turns lit yards into a real hazard and makes a
        // weapon light suddenly worth the risk of carrying one.
        this.lightMultiplier = 0.35;
        break;

      case 'commanderMoves': {
        // Wake the boss and send him hunting.
        const boss = ctx.ai.enemies.find((e) => e.tier === 'commander' && e.alive);
        if (boss) {
          boss.awareness.level = 0.5;
          boss.awareness.lastKnownX = ctx.playerX;
          boss.awareness.lastKnownY = ctx.playerY;
          boss.state = 'investigate';
          event.x = boss.x;
          event.y = boss.y;
        }
        break;
      }

      default:
        break;
    }

    this.active.push(event);
    this.fired.push(def.kind);
    this.bus.emit('raid:event', { id: def.kind, title: def.title, description: def.description });
    this.bus.emit('ui:notify', { text: def.title, tone: 'warn', duration: 5 });
  }

  private endEvent(event: ActiveRaidEvent): void {
    if (event.kind === 'blackout') {
      this.lightMultiplier = 1;
      this.bus.emit('ui:notify', { text: 'STROMVERSORGUNG WIEDERHERGESTELLT', tone: 'info', duration: 3 });
    }
  }

  /** Events with a world position, for the compass and map screen. */
  markers(): { x: number; y: number; title: string }[] {
    const out: { x: number; y: number; title: string }[] = [];
    for (const ev of this.active) {
      if (ev.x !== undefined && ev.y !== undefined) out.push({ x: ev.x, y: ev.y, title: ev.title });
    }
    return out;
  }
}
