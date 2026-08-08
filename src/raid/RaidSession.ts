import type { GameBus, SoundEventPayload } from '../core/GameEvents';
import { SpatialHash } from '../core/SpatialHash';
import { Rng } from '../core/Random';
import { clamp01, distance, wrapAngle } from '../core/Math2D';
import { generateMap, type GeneratedMap, type MapBlueprint } from '../world/MapGenerator';
import { applyConditions, defaultConditions, type RaidConditions } from '../world/Conditions';
import { CoverMap, NavGrid } from '../world/NavGrid';
import type { TileMap } from '../world/TileMap';
import { hasLineOfSight } from '../world/Raycast';
import { BallisticsSystem } from '../combat/Ballistics';
import type { Combatant } from '../combat/Combatant';
import { EffectSystem } from '../render/Effects';
import { AIDirector } from '../ai/AIDirector';
import { LootSystem, type LootContainer } from '../loot/LootSystem';
import { Player } from '../player/Player';
import { WeaponController, type FireContext } from '../weapons/WeaponController';
import type { ResolveContext } from '../weapons/WeaponRuntime';
import type { InputState } from '../input/InputSystem';
import type { EquipSlot } from '../data/ItemTypes';
import { defOf, stackValue, type ItemStack } from '../inventory/ItemStack';
import type { Profile } from '../meta/Profile';
import { ExtractionSystem } from './Extraction';
import { DynamicEventSystem } from './DynamicEvents';
import type { BodyPart } from '../data/ItemTypes';
import type { AudioEngine } from '../audio/AudioEngine';
import { estimateOcclusion } from '../ai/Perception';

/**
 * Aim-assist window, as a half-angle in radians at one tile's range.
 *
 * A person is about 0.6 tiles across, so half a body at one tile subtends
 * roughly 0.3 rad. This is a little wider, because the assist only slows the
 * turn and being slightly generous about when to slow costs the player
 * nothing.
 */
const ASSIST_ANGLE = 0.34;
/** Floor on that window, so a far target does not become a pinpoint. */
const ASSIST_MIN_ANGLE = 0.012;
/** Beyond this there is nothing to help with. */
const ASSIST_RANGE = 60;

/**
 * RaidSession - one deployment, from insertion to extraction or death.
 *
 * This is where the systems meet. It owns the world instance for the raid, ties
 * the player to the simulation, routes sound to both the AI and the mixer,
 * tracks objectives, and produces the result the metagame consumes.
 *
 * The raid is the *only* place gameplay state exists. Nothing here survives to
 * the next deployment except through `RaidResult`, which is what keeps the
 * "you lose what you were carrying" contract honest and easy to reason about.
 */

export interface RaidResult {
  survived: boolean;
  /** Short reason shown on the results screen. */
  reason: string;
  durationSec: number;
  kills: number;
  xpEarned: number;
  /** Trader value of everything brought out. */
  lootValue: number;
  extractName: string | null;
  /** Value that was left behind on death (secure container excluded). */
  lostValue: number;
  eventsSeen: string[];
  /** "Nacht · Sturm" - what the player deployed into. */
  conditions: string;
  /** Reward multiplier those conditions were worth. */
  conditionBonus: number;
}

export interface InteractionTarget {
  kind: 'container';
  container: LootContainer;
  distance: number;
  label: string;
}

export type RaidPhase = 'active' | 'extracting' | 'ended';

export class RaidSession {
  readonly generated: GeneratedMap;
  readonly map: TileMap;
  readonly nav: NavGrid;
  readonly cover: CoverMap;

  readonly effects = new EffectSystem();
  readonly ballistics: BallisticsSystem;
  readonly ai: AIDirector;
  readonly loot: LootSystem;
  readonly extraction: ExtractionSystem;
  readonly events: DynamicEventSystem;

  readonly player: Player;
  /** The player's firing state machine - the same class the AI uses. */
  readonly playerWeapon: WeaponController;
  /** Which slot the player currently has in hand. */
  activeWeaponSlot: EquipSlot = 'primary';

  phase: RaidPhase = 'active';
  /** Seconds elapsed since insertion. */
  elapsed = 0;
  /** Seconds remaining before the raid closes. */
  timeLeft: number;

  kills = 0;
  private xpEarned = 0;
  private lootedValue = 0;

  /** Container the player is currently searching, if any. */
  openContainer: LootContainer | null = null;
  /** Best interaction target this frame, for the HUD prompt. */
  interaction: InteractionTarget | null = null;

  /** Body part of the last damage dealt to each actor - for headshot tracking. */
  private lastHitPart = new Map<number, BodyPart>();

  private readonly spatial: SpatialHash;
  /** Own stream, so weather cannot perturb combat or loot rolls. */
  private readonly weatherRng: Rng;
  private readonly disposers: (() => void)[] = [];
  private timeWarned = new Set<number>();

  private result: RaidResult | null = null;

  constructor(
    private readonly bus: GameBus,
    private readonly profile: Profile,
    private readonly audio: AudioEngine,
    blueprint: MapBlueprint,
    seed: number,
    readonly conditions: RaidConditions = defaultConditions(),
  ) {
    this.generated = generateMap(blueprint, seed);
    this.map = this.generated.map;
    // Fold the sky for this time of day and weather into the baked lightmap.
    // Layout is untouched, so the same seed is the same ground under any sky.
    applyConditions(this.map, this.generated.ambient, conditions);
    this.nav = new NavGrid(this.map);
    this.cover = new CoverMap(this.map);
    this.timeLeft = this.generated.raidSeconds;

    this.ballistics = new BallisticsSystem(bus, this.effects, seed);
    this.ai = new AIDirector(bus, this.ballistics, seed);
    this.loot = new LootSystem(seed);
    this.extraction = new ExtractionSystem(bus);
    this.events = new DynamicEventSystem(bus, seed);

    this.player = new Player(bus);
    this.playerWeapon = new WeaponController(bus, this.ballistics, this.player.id, true, seed);
    this.spatial = new SpatialHash(this.map.width, this.map.height, 6, 512);
    this.weatherRng = new Rng(seed ^ 0x5747);

    this.setup();
  }

  private setup(): void {
    // Player starts at the spawn furthest from every extraction.
    const spawn = this.generated.playerSpawns[0] ?? { x: 4.5, y: 4.5, angle: 0 };
    this.player.reset(spawn.x, spawn.y, spawn.angle);

    // The raid inventory *is* the profile loadout: what you brought is what
    // you have, and losing it means losing it for real.
    this.transferLoadout();

    // Start with whatever is in the primary slot, falling back down the list.
    const weapons = this.player.inventory.weapons();
    this.activeWeaponSlot = weapons[0]?.slot ?? 'primary';
    this.playerWeapon.setWeapon(weapons[0]?.stack ?? null, this.resolveContext(), true);
    this.restorePreferredAmmo();

    this.audio.setAmbience(this.conditions.precipitation, this.conditions.wind);

    this.loot.dangerBonus = (this.conditions.rewardScale - 1) * 0.35;
    this.loot.populate(this.generated.lootAnchors, this.map);
    this.ai.populate(this.generated, this.map, this.generated.seed);
    this.ai.sightScale = this.conditions.sightScale;
    this.extraction.load(this.generated.extracts);

    this.disposers.push(this.bus.on('sound:emit', (payload) => this.onSound(payload)));
    this.disposers.push(this.bus.on('damage:dealt', (payload) => {
      this.lastHitPart.set(payload.targetId, payload.bodyPart as BodyPart);
    }));
    this.disposers.push(this.bus.on('actor:killed', (payload) => this.onActorKilled(payload)));

    this.bus.emit('raid:started', { mapId: this.generated.blueprintId, seed: this.generated.seed });
  }

  /** Copy the profile's prepared loadout onto the in-raid player. */
  private transferLoadout(): void {
    const source = this.profile.loadout;
    source.syncAll();
    for (const slot of Object.keys(source.equipped) as (keyof typeof source.equipped)[]) {
      const stack = source.equipped[slot];
      if (stack) this.player.inventory.equip(slot, stack);
    }
    for (const stack of source.pockets.items()) {
      this.player.inventory.pockets.add(stack);
    }
    this.player.inventory.markDirty();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.audio.stopAmbience();
  }

  // =========================================================================
  // Lightning
  // =========================================================================

  /**
   * Additive world light from a strike, 0..1.
   *
   * This lives in the simulation rather than the renderer because it is not a
   * screen effect: a strike lights the actual map for a moment, which shows you
   * the yard you were about to cross. Driving it from the seeded RNG on the
   * fixed timestep also keeps a replay of a given seed identical.
   */
  lightning = 0;
  private nextStrike = 6;

  private updateLightning(dt: number): void {
    if (this.lightning > 0) this.lightning = Math.max(0, this.lightning - dt * 7);
    if (!this.conditions.thunder) return;
    this.nextStrike -= dt;
    if (this.nextStrike > 0) return;
    this.nextStrike = this.weatherRng.range(7, 23);
    this.lightning = this.weatherRng.range(0.7, 1.2);
    this.audio.playThunder();
  }

  // =========================================================================
  // Simulation
  // =========================================================================

  /**
   * Apply one tick of player input.
   *
   * Kept separate from `update` so the simulation can be stepped without input
   * (menus, the death camera) and so input handling stays testable.
   */
  applyInput(dt: number, input: InputState, toggleAds: boolean): void {
    if (this.phase === 'ended' || !this.player.alive) return;

    // Look: the input system has already scaled by sensitivity and ADS.
    this.player.look(input.lookX, input.lookY);

    // Lean.
    this.player.setLean(input.leanLeft ? -1 : input.leanRight ? 1 : 0);

    // Movement. Aiming and searching both slow the player right down.
    const moveScale = this.playerWeapon.adsProgress > 0.5 ? 0.55 : 1;
    this.player.update(dt, this.map, input.moveX * moveScale, input.moveY * moveScale, input.sprint);

    // Sprinting physically cannot be combined with a shouldered weapon.
    const wantAds = toggleAds ? this.adsToggled : input.ads;
    this.playerWeapon.setAds(wantAds && !this.player.sprinting && !this.player.isBusy);

    if (input.fire && !this.player.isBusy && !this.player.sprinting) {
      this.playerWeapon.pressTrigger();
    } else {
      this.playerWeapon.releaseTrigger();
    }

    this.playerWeapon.update(dt, this.fireContext());

    // Skills improve through use, not through spending points.
    if (this.player.sprinting) this.profile.progression.addSkillXp('endurance', dt * 4);
    if (this.player.stance === 1 && this.player.speed > 0.1) {
      this.profile.progression.addSkillXp('stealth', dt * 3);
    }
    if (this.player.carriedWeight > 26) this.profile.progression.addSkillXp('strength', dt * 1.5);
    this.profile.progression.addSkillXp('perception', dt * 0.35);
  }

  /** Toggle-to-aim state, when the player prefers it over hold-to-aim. */
  adsToggled = false;

  toggleAds(): void {
    this.adsToggled = !this.adsToggled;
  }

  // =========================================================================
  // Weapon light
  // =========================================================================

  /** Player's intent. Whether it does anything depends on the fitted weapon. */
  torchWanted = false;

  /** True when a light is actually fitted to the weapon in hand. */
  get hasTorch(): boolean {
    return (this.playerWeapon.resolved?.lightRadius ?? 0) > 0;
  }

  /** True when the light is fitted and switched on. */
  get torchOn(): boolean {
    return this.torchWanted && this.hasTorch;
  }

  /** Beam reach in tiles, 0 when the light is off. */
  get torchRadius(): number {
    return this.torchOn ? (this.playerWeapon.resolved?.lightRadius ?? 0) : 0;
  }

  /**
   * How much the light gives the player away, 0..1.
   *
   * Scaled by how dark it is: a torch in daylight is invisible and costs
   * nothing, at night it is the brightest thing on the map. That relationship
   * is what turns the switch into a decision instead of a setting.
   */
  get torchGlow(): number {
    if (!this.torchOn) return 0;
    return clamp01(1 - this.conditions.ambientScale);
  }

  /** Returns false when the player has no light to switch on. */
  toggleTorch(): boolean {
    if (!this.hasTorch) {
      this.bus.emit('ui:notify', { text: 'KEINE LAMPE AN DIESER WAFFE', tone: 'bad', duration: 2.5 });
      return false;
    }
    this.torchWanted = !this.torchWanted;
    this.bus.emit('ui:notify', {
      text: this.torchWanted ? 'LAMPE AN' : 'LAMPE AUS',
      tone: this.torchWanted ? 'warn' : 'info',
      duration: 1.6,
    });
    // A click carries a few metres. Switching on next to a patrol is a
    // mistake in itself, not just afterwards.
    this.bus.emit('sound:emit', {
      x: this.player.x, y: this.player.y, radius: 4, intensity: 0.12,
      kind: 'container', sourceId: this.player.id,
    });
    return true;
  }

  private resolveContext(): ResolveContext {
    return {
      gearErgoPenalty: this.player.inventory.stats.ergonomicsPenalty,
      handlingSkill: this.profile.progression.factor('weaponHandling'),
      recoilSkill: this.profile.progression.factor('recoilControl'),
    };
  }

  private fireContext(): FireContext {
    return {
      x: this.player.x,
      y: this.player.y,
      z: this.player.muzzleHeight,
      angle: this.player.angle + this.playerWeapon.recoilYaw,
      pitch: this.player.pitch + this.playerWeapon.recoilPitch,
      speed: this.player.speed,
      stance: this.player.stance,
      swayMultiplier: this.player.health.modifiers.sway,
      resolve: this.resolveContext(),
    };
  }

  /** Current weapon dispersion in radians, for the dynamic crosshair. */
  get playerSpread(): number {
    return this.playerWeapon.currentSpread(this.fireContext());
  }

  /**
   * Choose which cartridge the next reload should load, or clear the choice.
   *
   * Without this the weapon always auto-picked the highest-penetration round
   * in the bag, which sounds sensible and is frequently the worst available
   * choice: 5.45 BP is 44 damage at 44 penetration, 5.45 HP is 66 at 12. Every
   * scavenger in a jacket takes fifty per cent longer to put down because the
   * gun helpfully loaded armour-piercing for a fight that had no armour in it.
   *
   * The decision - do I load for flesh or for plates - is one of the better
   * ones this genre has, and it was being made for the player, badly. The
   * auto-pick stays as the fallback for anyone who does not want to think
   * about it, and now it can be overridden.
   *
   * Takes effect on the next reload rather than immediately: a magazine
   * already in the weapon holds what it holds.
   */
  setPreferredAmmo(ammoId: string | null): void {
    this.playerWeapon.preferredAmmo = ammoId;

    // Remember it past the extraction. The controller is rebuilt for every
    // deployment, so without this the choice died with the raid and the player
    // had to make it again before every fight - which is how a feature ends up
    // present and unused.
    const caliber = this.playerWeapon.resolved?.caliber;
    if (!caliber) return;
    if (ammoId) this.profile.ammoPreferences[caliber] = ammoId;
    else delete this.profile.ammoPreferences[caliber];
  }

  /** The player's current cartridge choice, or null for automatic. */
  get preferredAmmo(): string | null {
    return this.playerWeapon.preferredAmmo;
  }

  /**
   * Re-apply the saved preference for whatever is now in the player's hands.
   *
   * Preferences are per calibre, so swapping from a rifle to a sidearm has to
   * look up a different one. Called wherever the active weapon changes.
   */
  private restorePreferredAmmo(): void {
    const caliber = this.playerWeapon.resolved?.caliber;
    this.playerWeapon.preferredAmmo = caliber
      ? this.profile.ammoPreferences[caliber] ?? null
      : null;
  }

  /**
   * Is the crosshair on a hostile the player can actually see?
   *
   * This is the whole input to aim assist, and it is worth being precise about
   * what aim assist here does: it slows the turn rate while the crosshair is
   * on a target, and does nothing else. It never moves the player's aim, never
   * bends a bullet, never widens the hitbox. A thumb overshoots a distant
   * target because the last few pixels of travel are worth several degrees;
   * slowing that travel gives the player back the precision a mouse would have
   * given them, without giving them the shot.
   *
   * The window is angular, not a screen radius, so it tightens with distance
   * exactly as the target does. `ASSIST_ANGLE` is the half-width at one tile;
   * dividing by distance keeps it roughly the angular size of a person, and
   * the floor stops a target at forty tiles becoming an invisible pinpoint.
   *
   * Line of sight is checked last because it is the expensive part, and the
   * angular test rejects almost everything first.
   */
  get crosshairOnTarget(): boolean {
    const px = this.player.x;
    const py = this.player.y;
    const angle = this.player.angle;

    for (const enemy of this.ai.enemies) {
      if (!enemy.alive) continue;
      const dx = enemy.x - px;
      const dy = enemy.y - py;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.5 || dist > ASSIST_RANGE) continue;

      // Half the angular width of a body at this range, floored so distant
      // targets stay reachable rather than requiring pixel-perfect aim.
      const window = Math.max(ASSIST_MIN_ANGLE, ASSIST_ANGLE / dist);
      if (Math.abs(wrapAngle(Math.atan2(dy, dx) - angle)) > window) continue;

      if (hasLineOfSight(this.map, px, py, enemy.x, enemy.y)) return true;
    }
    return false;
  }

  /** Cycle to the next weapon the player is carrying. */
  swapWeapon(): void {
    const weapons = this.player.inventory.weapons();
    if (weapons.length === 0) return;
    const index = weapons.findIndex((w) => w.slot === this.activeWeaponSlot);
    const next = weapons[(index + 1) % weapons.length];
    if (next.slot === this.activeWeaponSlot && weapons.length === 1) return;
    this.activeWeaponSlot = next.slot;
    this.playerWeapon.setWeapon(next.stack, this.resolveContext());
    // Preferences are per calibre, so a swap has to look up a different one.
    this.restorePreferredAmmo();
    this.profile.progression.addSkillXp('weaponHandling', 4);
  }

  reload(): void {
    if (this.playerWeapon.state === 'jammed') {
      this.playerWeapon.clearJam();
      return;
    }
    if (this.playerWeapon.reload(this.player.inventory)) {
      this.profile.progression.addSkillXp('weaponHandling', 8);
    }
  }

  cycleFireMode(): void {
    this.playerWeapon.cycleFireMode();
  }

  update(dt: number): void {
    if (this.phase === 'ended') return;

    this.elapsed += dt;
    this.timeLeft -= dt;

    // --- raid timer --------------------------------------------------------
    for (const warn of [300, 120, 60]) {
      if (this.timeLeft <= warn && !this.timeWarned.has(warn)) {
        this.timeWarned.add(warn);
        this.bus.emit('raid:timeWarning', { secondsLeft: warn });
        this.bus.emit('ui:notify', {
          text: `NOCH ${Math.round(warn / 60)} MINUTEN BIS ZUM ABZUG`,
          tone: warn <= 60 ? 'bad' : 'warn',
          duration: 5,
        });
      }
    }
    if (this.timeLeft <= 0) {
      this.finish(false, 'Zeit abgelaufen - im Sektor zurückgelassen');
      return;
    }

    // --- effects and world -------------------------------------------------
    this.effects.update(dt, this.map);
    this.updateLightning(dt);
    this.events.update(dt, this.elapsed, this.raidFraction, {
      map: this.map,
      ai: this.ai,
      loot: this.loot,
      effects: this.effects,
      playerX: this.player.x,
      playerY: this.player.y,
      seed: this.generated.seed,
    });

    // --- combat ------------------------------------------------------------
    this.rebuildSpatial();
    this.ballistics.update(
      dt,
      this.map,
      (x, y, r, out) => this.spatial.queryRadius(x, y, r, out),
      (id) => this.resolveActor(id),
    );

    this.ai.targetGlow = this.torchGlow;
    this.ai.update(
      dt,
      this.map,
      this.nav,
      this.cover,
      this.player,
      this.player.speed,
      this.player.stance,
    );

    // --- player state ------------------------------------------------------
    if (!this.player.alive) {
      this.finish(false, `Gefallen: ${this.player.health.causeOfDeath || 'Verwundungen'}`);
      return;
    }

    // --- interaction & extraction -----------------------------------------
    this.updateInteraction();

    const extractResult = this.extraction.update(
      dt,
      this.player.x,
      this.player.y,
      this.player.inventory,
      this.profile.money,
      this.raidFraction,
    );
    this.phase = this.extraction.activeExtract ? 'extracting' : 'active';
    if (extractResult?.extracted) {
      if (extractResult.fee > 0) this.profile.spend(extractResult.fee);
      this.finish(true, `Extrahiert über ${extractResult.extractName}`, extractResult.extractName);
      return;
    }

    // --- objectives --------------------------------------------------------
    this.profile.quests.setProgress('survive', Math.floor(this.elapsed));

    // --- audio listener ----------------------------------------------------
    this.audio.listener.x = this.player.x;
    this.audio.listener.y = this.player.y;
    this.audio.listener.angle = this.player.angle;
    this.audio.listener.hearingFactor = this.player.inventory.stats.hearingFactor;
    this.audio.update(dt);

    this.loot.prune();
  }

  private rebuildSpatial(): void {
    this.spatial.begin();
    this.spatial.insert(this.player.id, this.player.x, this.player.y);
    for (const enemy of this.ai.enemies) {
      if (enemy.alive) this.spatial.insert(enemy.id, enemy.x, enemy.y);
    }
    this.spatial.build();
  }

  private resolveActor(id: number): Combatant | undefined {
    if (id === this.player.id) return this.player;
    return this.ai.byActorId(id);
  }

  get raidFraction(): number {
    return clamp01(1 - this.timeLeft / this.generated.raidSeconds);
  }

  // =========================================================================
  // Sound routing
  // =========================================================================

  /**
   * A single sound event feeds three consumers: the AI's hearing model, the
   * mixer, and (for the player's own unsuppressed shots) temporary deafness.
   * Routing them from one place guarantees the player and the AI are reacting
   * to exactly the same event.
   */
  private onSound(payload: SoundEventPayload): void {
    // Weather is applied to the event itself rather than to each listener, so
    // the AI and the mixer can never disagree about how far a shot carried.
    const scale = this.conditions.soundScale;
    if (scale !== 1) payload = { ...payload, radius: payload.radius * scale };

    this.ai.onSound(payload, this.map);

    const occlusion = estimateOcclusion(this.map, this.player.x, this.player.y, payload.x, payload.y);
    this.audio.play(payload.kind, payload.x, payload.y, payload.radius, occlusion, payload.intensity);

    if (payload.sourceId === this.player.id && payload.kind === 'gunshot') {
      // Firing without a suppressor costs you your hearing for a moment - a
      // real, tactical downside to spraying.
      this.audio.applyMuzzleDeafness(0.32);
    }
  }

  // =========================================================================
  // Kills and rewards
  // =========================================================================

  private onActorKilled(payload: { actorId: number; name: string; x: number; y: number; isPlayer: boolean }): void {
    if (payload.isPlayer) return;
    const enemy = this.ai.byActorId(payload.actorId);
    if (!enemy) return;

    this.kills++;
    // Fighting in the dark or in a storm is harder, and pays accordingly.
    const xp = Math.round(enemy.profile.xpReward * this.conditions.rewardScale);
    this.xpEarned += xp;
    this.profile.progression.addXp(xp, `Ausschaltung: ${enemy.name}`);

    // Objectives.
    this.profile.quests.advance('kill', 1);
    this.profile.quests.advance('killTier', 1, enemy.tier);
    if (this.lastHitPart.get(payload.actorId) === 'head') {
      this.profile.quests.advance('killHeadshot', 1);
    }

    // The corpse keeps everything they were carrying - the best loot in the
    // game is on the people who were about to kill you.
    this.loot.createCorpse(enemy.x, enemy.y, enemy.name, enemy.dropLoot());

    this.bus.emit('ui:notify', { text: `${enemy.name} ausgeschaltet  +${xp} EP`, tone: 'good', duration: 3 });
    this.effects.shake(0.12, 0.15);
  }

  // =========================================================================
  // Interaction
  // =========================================================================

  private updateInteraction(): void {
    const reach = 1.9 + this.profile.progression.perceptionRangeBonus * 0.08;
    const container = this.loot.findNearest(this.player.x, this.player.y, reach);
    if (!container) {
      this.interaction = null;
      return;
    }
    this.interaction = {
      kind: 'container',
      container,
      distance: distance(this.player.x, this.player.y, container.x, container.y),
      label: container.searched ? `${container.name} (durchsucht)` : `${container.name} durchsuchen`,
    };
  }

  /** Begin searching the container the player is standing at. */
  tryInteract(): boolean {
    const target = this.interaction;
    if (!target || this.player.isBusy) return false;
    const container = target.container;

    if (container.searched) {
      this.openContainer = container;
      this.bus.emit('loot:opened', { containerId: container.id, name: container.name });
      return true;
    }

    const seconds = container.searchSeconds * this.profile.progression.searchTimeMultiplier;
    this.player.beginAction(seconds, `${container.name} durchsuchen`, () => {
      container.searched = true;
      this.openContainer = container;
      this.profile.progression.addSkillXp('scavenging', 12);
      this.bus.emit('loot:opened', { containerId: container.id, name: container.name });
      this.bus.emit('sound:emit', {
        x: container.x, y: container.y, radius: 8, intensity: 0.25,
        kind: 'container', sourceId: this.player.id,
      });
    });
    // Searching is noisy: rummaging through a crate can be heard.
    this.bus.emit('sound:emit', {
      x: this.player.x, y: this.player.y, radius: 6, intensity: 0.2,
      kind: 'container', sourceId: this.player.id,
    });
    return true;
  }

  closeContainer(): void {
    this.openContainer = null;
  }

  /** Move an item from an open container into the player's kit. */
  takeItem(stackId: number): boolean {
    const container = this.openContainer;
    if (!container) return false;
    const stack = container.grid.remove(stackId);
    if (!stack) return false;
    if (!this.player.inventory.store(stack)) {
      // No room: put it back exactly where it was rather than dropping it.
      container.grid.add(stack);
      this.bus.emit('inventory:full', { itemDefId: stack.defId });
      this.bus.emit('ui:notify', { text: 'KEIN PLATZ IM INVENTAR', tone: 'bad', duration: 2.5 });
      return false;
    }

    const def = defOf(stack);
    const value = stackValue(stack);
    this.lootedValue += value;
    stack.fresh = false;

    this.profile.quests.advance('collect', stack.count, def.id);
    for (const tag of def.tags ?? []) this.profile.quests.advance('loot', stack.count, tag);

    this.bus.emit('loot:taken', { itemDefId: def.id, count: stack.count, rarity: def.rarity });
    this.bus.emit('inventory:changed', {});
    this.profile.progression.addSkillXp('scavenging', 3);
    return true;
  }

  /** Put an item from the player's kit into the open container. */
  storeItem(stackId: number): boolean {
    const container = this.openContainer;
    if (!container) return false;
    const stack = this.player.inventory.removeStack(stackId);
    if (!stack) return false;
    if (container.grid.add(stack) > 0) {
      this.player.inventory.store(stack);
      return false;
    }
    this.bus.emit('inventory:changed', {});
    return true;
  }

  /**
   * Use a medical item. `stackId` omitted picks the most appropriate item for
   * the most urgent problem - the quick-heal button on the HUD.
   */
  useMedical(stackId?: number): boolean {
    if (this.player.isBusy) return false;
    const health = this.player.health;
    const inventory = this.player.inventory;

    let stack: ItemStack | null = null;
    if (stackId !== undefined) {
      stack = inventory.findStack((s) => s.id === stackId);
    } else {
      // Triage order: heavy bleeds kill fastest, then fractures, then health.
      const need: ((s: ItemStack) => boolean)[] = [];
      if (health.hasHeavyBleed) {
        need.push((s) => defOf(s).med?.effects.some((e) => e.kind === 'stopBleed' && e.heavy) ?? false);
      }
      if (health.hasFracture) {
        need.push((s) => defOf(s).med?.effects.some((e) => e.kind === 'fixFracture') ?? false);
      }
      if (health.hasAnyBleed) {
        need.push((s) => defOf(s).med?.effects.some((e) => e.kind === 'stopBleed') ?? false);
      }
      if (health.totalHp < health.totalMaxHp * 0.85) {
        need.push((s) => defOf(s).med?.effects.some((e) => e.kind === 'heal') ?? false);
      }
      if (health.hydration < 35) {
        need.push((s) => defOf(s).med?.effects.some((e) => e.kind === 'hydration' && e.amount > 0) ?? false);
      }
      if (health.energy < 35) {
        need.push((s) => defOf(s).med?.effects.some((e) => e.kind === 'energy' && e.amount > 0) ?? false);
      }
      for (const predicate of need) {
        stack = inventory.findStack((s) => predicate(s));
        if (stack) break;
      }
    }

    if (!stack) {
      this.bus.emit('ui:notify', { text: 'KEIN PASSENDES MEDIKAMENT', tone: 'bad', duration: 2.5 });
      return false;
    }

    const def = defOf(stack);
    const med = def.med;
    if (!med) return false;

    const useTime = med.useTimeSec * this.profile.progression.medicalTimeMultiplier;
    const target = stack;
    this.player.beginAction(useTime, `${def.name} anwenden`, () => {
      this.applyMedEffects(target);
    });
    return true;
  }

  private applyMedEffects(stack: ItemStack): void {
    const def = defOf(stack);
    const med = def.med;
    if (!med) return;
    const health = this.player.health;

    let consumed = 1;
    for (const effect of med.effects) {
      switch (effect.kind) {
        case 'heal': {
          const healed = health.heal(effect.amount);
          // Charge-based kits consume proportionally to what they restored.
          if (med.maxCharges > 10) consumed = Math.max(consumed, Math.ceil(healed));
          break;
        }
        case 'stopBleed':
          health.stopBleed(effect.heavy);
          break;
        case 'fixFracture':
          health.fixFracture();
          break;
        case 'painkiller':
          health.applyPainkiller(effect.durationSec);
          break;
        case 'stimulant':
          health.applyStimulant(effect.staminaRegen, effect.durationSec);
          break;
        case 'energy':
          health.addEnergy(effect.amount);
          break;
        case 'hydration':
          health.addHydration(effect.amount);
          break;
        case 'surgery': {
          const part = health.performSurgery(effect.restoreFraction);
          if (part) {
            this.bus.emit('ui:notify', { text: 'GLIEDMASSE WIEDERHERGESTELLT', tone: 'good', duration: 4 });
          }
          break;
        }
        default:
          break;
      }
    }
    for (const effect of med.sideEffects ?? []) {
      if (effect.kind === 'energy') health.addEnergy(effect.amount);
      if (effect.kind === 'hydration') health.addHydration(effect.amount);
    }

    stack.charges = (stack.charges ?? 1) - consumed;
    if (stack.charges <= 0) this.player.inventory.removeStack(stack.id);

    this.profile.progression.addSkillXp('medical', 18);
    this.bus.emit('inventory:changed', {});
  }

  /** Drop an item into the world at the player's feet. */
  dropItem(stackId: number): boolean {
    const stack = this.player.inventory.removeStack(stackId);
    if (!stack) return false;
    this.loot.createCorpse(this.player.x, this.player.y, 'Abgelegte Ausrüstung', [stack]);
    this.bus.emit('inventory:changed', {});
    return true;
  }

  // =========================================================================
  // Ending
  // =========================================================================

  private finish(survived: boolean, reason: string, extractName: string | null = null): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';

    let lootValue = 0;
    let lostValue = 0;

    if (survived) {
      for (const { grid } of this.player.inventory.allGrids()) {
        for (const stack of grid.items()) lootValue += stackValue(stack);
      }
      for (const stack of Object.values(this.player.inventory.equipped)) {
        if (stack) lootValue += stackValue(stack);
      }
      const extractXp = Math.round(600 * this.conditions.rewardScale);
      this.profile.progression.addXp(extractXp, 'Erfolgreiche Extraktion');
      this.xpEarned += extractXp;
      this.profile.quests.advance('extract', 1);
      if (extractName) {
        const ex = this.generated.extracts.find((e) => e.name === extractName);
        if (ex) this.profile.quests.advance('extractFrom', 1, ex.id);
      }
    } else {
      for (const stack of this.player.inventory.losableItems()) lostValue += stackValue(stack);
      // The secure container is the only thing that comes home.
      const secure = this.player.inventory.equipped.secure;
      if (secure) lootValue += stackValue(secure);
      this.player.inventory.stripOnDeath();
      this.profile.quests.onPlayerDeath();
    }

    this.result = {
      survived,
      reason,
      durationSec: this.elapsed,
      kills: this.kills,
      xpEarned: this.xpEarned,
      lootValue,
      extractName,
      lostValue,
      eventsSeen: [...this.events.fired],
      conditions: this.conditions.label,
      conditionBonus: this.conditions.rewardScale,
    };

    this.bus.emit('raid:ended', { survived, reason });
  }

  /** Immediately abandon the raid - used by the pause menu. */
  abort(reason = 'Einsatz abgebrochen'): void {
    this.finish(false, reason);
  }

  get raidResult(): RaidResult | null {
    return this.result;
  }

  /**
   * Move the raid's surviving inventory back onto the profile loadout so the
   * hideout screens see what came home.
   */
  commitToProfile(): void {
    const source = this.player.inventory;
    const dest = this.profile.loadout;

    for (const slot of ['primary', 'secondary', 'sidearm', 'armor', 'helmet', 'rig', 'backpack', 'secure'] as const) {
      const existing = dest.equipped[slot];
      const carried = source.equipped[slot];
      if (carried) {
        source.syncAll();
        dest.equip(slot, carried);
      } else if (existing) {
        dest.unequip(slot);
      }
    }
    dest.pockets.clear();
    for (const stack of source.pockets.items()) dest.pockets.add(stack);
    dest.markDirty();
  }

  /** Ambient light multiplier from active events, for the renderer. */
  get lightMultiplier(): number {
    return this.events.lightMultiplier;
  }
}
