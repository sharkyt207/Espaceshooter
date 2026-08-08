import { Loop } from '../core/Loop';
import { bus } from '../core/GameEvents';
import { hashString } from '../core/Random';
import { InputSystem } from '../input/InputSystem';
import { AudioEngine } from '../audio/AudioEngine';
import { SaveSystem, type GameSettings } from '../save/SaveSystem';
import { Profile, loadoutRiskValue } from '../meta/Profile';
import { RaidSession } from '../raid/RaidSession';
import { RaidRenderer } from '../render/RaidRenderer';
import { applyStyleToDocument, styleById } from '../render/Style';
import { HUD } from '../ui/HUD';
import { ScreenManager } from '../ui/ScreenManager';
import { MainMenu } from '../ui/screens/MainMenu';
import { HideoutScreen } from '../ui/screens/HideoutScreen';
import { DeployScreen } from '../ui/screens/DeployScreen';
import { LootScreen } from '../ui/screens/LootScreen';
import { MapScreen } from '../ui/screens/MapScreen';
import { ResultsScreen } from '../ui/screens/ResultsScreen';
import { SettingsScreen } from '../ui/screens/SettingsScreen';
import { PauseScreen } from '../ui/screens/PauseScreen';
import { PrimerScreen } from '../ui/screens/PrimerScreen';
import { blueprintById } from '../data/MapData';
import { makeConditions, rollWeather, type TimeOfDayId } from '../world/Conditions';
import {
  haptic,
  interceptBack,
  reacquireWakeLock,
  releaseWakeLock,
  requestWakeLock,
  setHapticsEnabled,
} from '../platform/Platform';
import { stackValue } from '../inventory/ItemStack';

/**
 * Game - the application shell.
 *
 * Owns the loop, the systems that outlive a raid (input, audio, save, profile)
 * and the screen stack. A `RaidSession` is created on deploy and destroyed at
 * the debrief, which is what guarantees no in-raid state leaks into the
 * metagame except through `RaidResult`.
 *
 * The update order each tick is deliberate:
 *   1. poll input           - one authoritative sample per tick
 *   2. apply input to the player
 *   3. step the simulation  - AI, ballistics, world
 *   4. update the UI        - reads state, never writes it
 * Reversing 2 and 3 would make the player react to a world one frame stale,
 * which is felt immediately in a shooter.
 */

export type GameState = 'menu' | 'hideout' | 'raid' | 'results';

export class Game {
  private readonly loop: Loop;
  private readonly input = new InputSystem();
  private readonly audio = new AudioEngine();
  private readonly save = new SaveSystem();
  private readonly screens: ScreenManager;
  private readonly renderer: RaidRenderer;
  private readonly hud: HUD;

  private profile: Profile;
  private settings: GameSettings;

  private session: RaidSession | null = null;
  private state: GameState = 'menu';
  /** Loadout value measured at deploy, used for the net figure at debrief. */
  private riskAtDeploy = 0;

  private mainMenu!: MainMenu;
  private hideout!: HideoutScreen;
  private deployScreen!: DeployScreen;
  private lootScreen!: LootScreen;
  private mapScreen!: MapScreen;
  private resultsScreen!: ResultsScreen;
  private settingsScreen!: SettingsScreen;
  private pauseScreen!: PauseScreen;
  private primerScreen!: PrimerScreen;

  private readonly disposers: (() => void)[] = [];
  private lastFrameMs = 16;

  constructor(container: HTMLElement) {
    this.settings = this.save.loadSettings();
    this.profile = new Profile(bus, hashString('grayzone-default'));

    this.renderer = new RaidRenderer(container);
    this.screens = new ScreenManager(container);
    this.hud = new HUD(container, this.input, bus);

    this.buildScreens();
    this.applySettings(this.settings);

    this.input.attach(this.renderer.canvas.parentElement ?? container);
    this.wireEvents();

    this.loop = new Loop({
      tickRate: 60,
      update: (dt) => this.update(dt),
      render: (_alpha, dt) => this.render(dt),
    });

    window.addEventListener('resize', () => this.renderer.resize());
    window.addEventListener('orientationchange', () => {
      // Give the browser a beat to settle the new viewport before measuring.
      setTimeout(() => this.renderer.resize(), 120);
    });
    // iOS Safari moves its toolbars without firing `resize`, which leaves the
    // canvas the wrong height until something else happens to trigger one.
    window.visualViewport?.addEventListener('resize', () => this.renderer.resize());
    document.addEventListener('visibilitychange', () => this.onVisibilityChange());

    // Android's back button and back swipe close the page by default. Twenty
    // five minutes of raid is far too much to lose to an edge swipe.
    this.disposers.push(interceptBack(() => this.onSystemBack()));

    this.renderer.resize();
    this.screens.show('menu');
    this.loop.start();
  }

  // =========================================================================
  // Setup
  // =========================================================================

  private buildScreens(): void {
    this.mainMenu = new MainMenu(this.profile, () => this.save.hasSave(), {
      onContinue: () => this.continueGame(),
      onNewGame: () => this.newGame(),
      onSettings: () => this.screens.push('settings'),
    });

    this.hideout = new HideoutScreen(this.profile, {
      onDeploy: () => this.screens.push('deploy'),
      onSettings: () => this.screens.push('settings'),
      onSave: () => this.save.save(this.profile),
      notify: (text, tone) => bus.emit('ui:notify', { text, tone, duration: 3 }),
    });

    this.deployScreen = new DeployScreen(this.profile, {
      onBack: () => this.screens.pop(),
      onDeploy: (mapId, time) => this.startRaid(mapId, time),
    });

    this.lootScreen = new LootScreen({
      onClose: () => this.closeOverlay(),
      notify: (text, tone) => bus.emit('ui:notify', { text, tone, duration: 3 }),
    });

    this.mapScreen = new MapScreen({ onClose: () => this.closeOverlay() });

    this.resultsScreen = new ResultsScreen(this.profile, {
      onContinue: () => this.returnToHideout(),
    });

    this.settingsScreen = new SettingsScreen(this.settings, {
      onClose: () => this.screens.pop(),
      onApply: (settings) => this.applySettings(settings),
      onResetProfile: () => this.resetProfile(),
      onShowPrimer: () => this.screens.push('primer'),
      rendererName: () => this.renderer.rendererName,
    });

    this.pauseScreen = new PauseScreen({
      onResume: () => this.closeOverlay(),
      onSettings: () => this.screens.push('settings'),
      onAbandon: () => this.abandonRaid(),
    });

    this.primerScreen = new PrimerScreen({ onDone: () => this.dismissPrimer() });

    for (const screen of [
      this.mainMenu, this.hideout, this.deployScreen, this.lootScreen,
      this.mapScreen, this.resultsScreen, this.settingsScreen, this.pauseScreen,
      this.primerScreen,
    ]) {
      this.screens.register(screen);
    }

    this.screens.onChange = (top) => {
      if (top) {
        // Any open screen releases held inputs so the player does not walk
        // into a wall while reading a menu.
        this.input.releaseAll();
        // On desktop the mouse is pointer-locked for looking. A locked cursor
        // cannot reach the UI, so every menu has to release it - otherwise the
        // pause screen is visible but completely uninteractable.
        if (document.pointerLockElement && document.exitPointerLock) {
          try {
            document.exitPointerLock();
          } catch {
            // Never let a presentation detail break screen navigation.
          }
        }
      }
      this.hud.setVisible(this.state === 'raid' && !top);
    };

    this.hud.onInteract = () => this.tryInteract();
  }

  private wireEvents(): void {
    // --- presentation feedback --------------------------------------------
    this.disposers.push(
      bus.on('player:hit', (payload) => {
        const angle = Math.atan2(payload.fromY - (this.session?.player.y ?? 0), payload.fromX - (this.session?.player.x ?? 0));
        this.renderer.onPlayerHit(angle);
        this.session?.effects.shake(Math.min(0.5, payload.amount / 60), 0.25);
        // A heavy hit gets its own pattern: on a phone the player often feels
        // it before they have read the health bar.
        haptic(payload.amount >= 28 ? 'critical' : 'hurt');
      }),
    );

    this.disposers.push(
      bus.on('damage:dealt', (payload) => {
        // Hit confirmation only for the player's own rounds.
        if (payload.attackerId !== this.session?.player.id) return;
        const target = this.session?.ai.byActorId(payload.targetId);
        const killed = !!target && !target.alive;
        this.renderer.onHitConfirmed(killed);
        haptic(killed ? 'kill' : 'hit');
      }),
    );

    this.disposers.push(
      bus.on('weapon:fired', (payload) => {
        if (payload.actorId !== this.session?.player.id) return;
        const controller = this.session.playerWeapon;
        const resolved = controller.resolved;
        if (!resolved) return;
        this.renderer.onShotFired(resolved.recoilVertical * 0.12);
        this.session.effects.muzzleBlast(
          this.session.player.x,
          this.session.player.y,
          this.session.player.muzzleHeight / 2,
          Math.cos(this.session.player.angle),
          Math.sin(this.session.player.angle),
          resolved.suppressed,
        );
        this.session.effects.ejectCasing(
          this.session.player.x,
          this.session.player.y,
          this.session.player.muzzleHeight / 2,
          Math.cos(this.session.player.angle),
          Math.sin(this.session.player.angle),
        );
        this.session.effects.shake(0.06 + resolved.recoilVertical * 0.01, 0.08);
      }),
    );

    this.disposers.push(bus.on('loot:opened', () => this.openLoot()));

    this.disposers.push(
      bus.on('raid:ended', (payload) => {
        haptic(payload.survived ? 'extract' : 'critical');
        // Deferred to the next tick so the finishing system can complete.
        queueMicrotask(() => this.endRaid());
      }),
    );

    this.disposers.push(
      bus.on('player:levelUp', () => {
        this.profile.quests.refreshAvailability(this.profile.progression.level);
      }),
    );
  }

  private applySettings(settings: GameSettings): void {
    this.settings = settings;
    this.save.saveSettings(settings);

    this.audio.setVolume(settings.masterVolume);
    this.audio.setMuted(settings.muted);
    this.input.sensitivity = settings.lookSensitivity;
    this.input.invertY = settings.invertY;
    this.renderer.fixedScale = settings.renderScale;
    this.renderer.applyPostQuality(settings.postQuality);
    this.renderer.setRendererMode(settings.renderer);

    // The style reaches the DOM and the renderer separately, because they are
    // separate surfaces: the menus are CSS, the raid is pixels. Both read the
    // same definition, which is what keeps a hub and the raid it launches
    // looking like the same game.
    const style = styleById(settings.style);
    applyStyleToDocument(style);
    this.renderer.setStyle(style);
    this.hud.setDebugVisible(settings.showFps);
    setHapticsEnabled(settings.haptics);
    this.renderer.resize();
  }

  // =========================================================================
  // Profile lifecycle
  // =========================================================================

  private newGame(): void {
    this.audio.unlock();
    this.profile = new Profile(bus, hashString(`grayzone-${Date.now()}`));
    this.profile.applyStashSize();
    this.profile.grantStartingKit();
    this.rebuildProfileScreens();
    this.save.save(this.profile, true);
    this.state = 'hideout';
    this.screens.show('hideout');
    // First profile ever: state the rules that are expensive to learn by
    // losing a loadout. Returning players never see it again.
    if (!this.settings.primerSeen) this.screens.push('primer');
  }

  private dismissPrimer(): void {
    if (!this.settings.primerSeen) {
      this.applySettings({ ...this.settings, primerSeen: true });
    }
    this.screens.pop();
  }

  private continueGame(): void {
    this.audio.unlock();
    const loaded = this.save.load(this.profile);
    if (!loaded) {
      this.newGame();
      return;
    }
    this.rebuildProfileScreens();
    this.state = 'hideout';
    this.screens.show('hideout');
  }

  private resetProfile(): void {
    this.save.clear();
    this.screens.show('menu');
    this.state = 'menu';
    this.profile = new Profile(bus, hashString('grayzone-default'));
    this.rebuildProfileScreens();
  }

  /**
   * Screens hold a reference to the profile, so replacing the profile means
   * rebuilding them. Cheap, and far safer than mutating a live profile in
   * place while screens hold stale sub-objects.
   */
  private rebuildProfileScreens(): void {
    const host = this.screens;
    this.hideout = new HideoutScreen(this.profile, {
      onDeploy: () => host.push('deploy'),
      onSettings: () => host.push('settings'),
      onSave: () => this.save.save(this.profile),
      notify: (text, tone) => bus.emit('ui:notify', { text, tone, duration: 3 }),
    });
    this.deployScreen = new DeployScreen(this.profile, {
      onBack: () => host.pop(),
      onDeploy: (mapId, time) => this.startRaid(mapId, time),
    });
    this.resultsScreen = new ResultsScreen(this.profile, {
      onContinue: () => this.returnToHideout(),
    });
    this.mainMenu = new MainMenu(this.profile, () => this.save.hasSave(), {
      onContinue: () => this.continueGame(),
      onNewGame: () => this.newGame(),
      onSettings: () => host.push('settings'),
    });

    host.register(this.hideout);
    host.register(this.deployScreen);
    host.register(this.resultsScreen);
    host.register(this.mainMenu);
  }

  // =========================================================================
  // Raid lifecycle
  // =========================================================================

  private startRaid(mapId: string, time: TimeOfDayId = 'day'): void {
    this.audio.unlock();
    this.audio.resume();

    const blueprint = blueprintById(mapId);
    // A fresh seed per deployment: the same location, a different arrangement.
    const seed = (Math.random() * 0xffffffff) >>> 0;
    // The player chooses the hour; the sky is out of their hands. Rolling it
    // from the seed keeps a deployment reproducible from its seed alone.
    const conditions = makeConditions(time, rollWeather(seed >>> 3));

    this.riskAtDeploy = loadoutRiskValue(this.profile.loadout);
    this.session = new RaidSession(bus, this.profile, this.audio, blueprint, seed, conditions);
    this.lootScreen.bind(this.session);
    this.mapScreen.bind(this.session);

    this.profile.raids++;
    this.save.save(this.profile);

    this.state = 'raid';
    // A raid runs up to 25 minutes with long stretches of no touch input.
    // Without this the screen dims and locks somewhere on the approach.
    void requestWakeLock();
    this.screens.closeAll();
    this.hud.clearNotifications();
    this.hud.setVisible(true);
    this.input.clearActions();

    bus.emit('ui:notify', {
      text: `${blueprint.displayName.toUpperCase()} - ${conditions.label.toUpperCase()}`,
      tone: 'info',
      duration: 5,
    });
    if (conditions.darkEnoughForLight) {
      bus.emit('ui:notify', {
        text: this.session.hasTorch ? 'LAMPE VERFÜGBAR - TASTE LAMPE' : 'KEINE LAMPE AN DER WAFFE',
        tone: this.session.hasTorch ? 'info' : 'warn',
        duration: 6,
      });
    }
  }

  private abandonRaid(): void {
    this.session?.abort();
  }

  /** Called once the session reports a result. */
  private endRaid(): void {
    const session = this.session;
    const result = session?.raidResult;
    if (!session || !result) return;

    // Menus do not need the screen held awake, and holding it costs battery.
    releaseWakeLock();

    session.commitToProfile();

    // --- statistics ---------------------------------------------------------
    this.profile.kills += result.kills;
    if (result.survived) {
      this.profile.survived++;
      this.profile.bestHaul = Math.max(this.profile.bestHaul, result.lootValue);
    } else {
      this.profile.deaths++;
    }

    // --- insurance ----------------------------------------------------------
    this.profile.insurance.resolveRaid(
      result.survived,
      this.profile.heldItemIds(),
      this.profile.hideout.insuranceBonus,
    );

    // --- between-raid recovery ---------------------------------------------
    this.profile.applyHideoutHealing({
      parts: session.player.health.parts as never,
      energy: session.player.health.energy,
      hydration: session.player.health.hydration,
    });

    this.profile.quests.refreshAvailability(this.profile.progression.level);

    session.dispose();
    this.session = null;
    this.state = 'results';

    this.hud.setVisible(false);
    this.resultsScreen.present(result, this.riskAtDeploy);
    this.screens.show('results');
    this.save.save(this.profile, true);
  }

  private returnToHideout(): void {
    // Deposit anything that survived into the stash, keeping ammo on the rig.
    const { overflow } = this.profile.depositLoadout();
    if (overflow > 0) {
      bus.emit('ui:notify', {
        text: `${overflow} GEGENSTÄNDE PASSEN NICHT INS LAGER`,
        tone: 'warn',
        duration: 5,
      });
    }
    this.state = 'hideout';
    this.screens.show('hideout');
    this.hideout.refresh();
    this.save.save(this.profile, true);
  }

  // =========================================================================
  // In-raid interaction
  // =========================================================================

  private tryInteract(): void {
    const session = this.session;
    if (!session) return;
    session.tryInteract();
  }

  private openLoot(): void {
    if (this.state !== 'raid') return;
    this.lootScreen.render();
    this.screens.push('loot');
  }

  /** Close the top overlay and return to the raid. */
  private closeOverlay(): void {
    this.screens.pop();
    if (!this.screens.isOpen) {
      this.hud.setVisible(this.state === 'raid');
      this.input.clearActions();
    }
  }

  private onVisibilityChange(): void {
    if (document.hidden) {
      this.audio.suspend();
      this.input.releaseAll();
      // Opening the pause screen mid-raid is the honest behaviour: the raid
      // clock keeps running, but the player is not left walking blind.
      if (this.state === 'raid' && !this.screens.isOpen) this.screens.push('pause');
      this.save.flush();
    } else {
      this.audio.resume();
      this.loop.resetTiming();
      // The browser drops the wake lock when the page is hidden and never
      // restores it, so every return to the foreground has to ask again.
      reacquireWakeLock();
    }
  }

  /**
   * The system back gesture.
   *
   * It behaves like the in-game back button rather than like navigation: close
   * the top screen, or open the pause menu if a raid is running with nothing
   * open. It never leaves the page.
   */
  private onSystemBack(): void {
    if (this.screens.isOpen) {
      const top = this.screens.top;
      if (top?.onBack?.()) return;
      this.screens.pop();
      return;
    }
    if (this.state === 'raid') {
      this.screens.push('pause');
      return;
    }
    if (this.state === 'hideout') this.screens.push('settings');
  }

  // =========================================================================
  // Frame
  // =========================================================================

  private update(dt: number): void {
    const input = this.input.poll();

    if (this.state !== 'raid' || !this.session) {
      this.screens.tick(dt);
      this.input.endFrame();
      this.consumeMenuActions();
      return;
    }

    const session = this.session;
    const overlayOpen = this.screens.isOpen;

    if (!overlayOpen) {
      this.consumeRaidActions(session);
      session.applyInput(dt, input, this.settings.toggleAds);
      // Look sensitivity scales down while aiming - handled by the input
      // layer, which also needs the optic's magnification: a 4x scope sweeps
      // four times as much of the field of view for the same thumb travel, and
      // one ADS setting cannot serve both irons and glass.
      this.input.adsFactor = session.playerWeapon.adsProgress;
      this.input.magnification = session.playerWeapon.resolved?.zoom ?? 1;
    } else {
      // The world keeps running while a menu is open: looting is not a
      // time-out, and that is the point.
      session.player.update(dt, session.map, 0, 0, false);
      this.screens.tick(dt);
      this.consumeMenuActions();
    }

    session.update(dt);
    this.mapScreen.reveal(session);
    this.input.endFrame();
  }

  /** Route one-shot actions while a raid is in progress. */
  private consumeRaidActions(session: RaidSession): void {
    if (this.input.consumeAction('reload')) session.reload();
    if (this.input.consumeAction('stance')) session.player.cycleStance();
    if (this.input.consumeAction('interact')) this.tryInteract();
    if (this.input.consumeAction('swapWeapon')) session.swapWeapon();
    if (this.input.consumeAction('fireMode')) session.cycleFireMode();
    if (this.input.consumeAction('toggleLight')) session.toggleTorch();
    if (this.input.consumeAction('heal')) session.useMedical();
    if (this.input.consumeAction('inventory')) {
      this.lootScreen.render();
      this.screens.push('loot');
    }
    if (this.input.consumeAction('map')) this.screens.push('map');
    if (this.input.consumeAction('pause')) this.screens.push('pause');
    if (this.settings.toggleAds && this.input.state.ads) {
      // Toggle-to-aim: the hold button acts as a toggle edge.
      session.toggleAds();
      this.input.state.ads = false;
    }
  }

  /**
   * Route one-shot actions while a screen is open.
   *
   * Every toggle closes the screen it opened - pressing the map button again
   * puts the map away. Escape is the universal back. Anything else is
   * discarded so a button mashed during a menu does not fire the moment the
   * player returns to the raid.
   */
  private consumeMenuActions(): void {
    // Consume all three unconditionally: `consumeAction` has a side effect, so
    // short-circuiting would leave an action queued for the next frame.
    const pause = this.input.consumeAction('pause');
    const inventory = this.input.consumeAction('inventory');
    const map = this.input.consumeAction('map');
    const top = this.screens.top?.id;

    if (pause) {
      if (top === 'pause' || top === 'loot' || top === 'map') this.closeOverlay();
      else this.screens.back();
    } else if (inventory && top === 'loot') {
      this.closeOverlay();
    } else if (map && top === 'map') {
      this.closeOverlay();
    }

    this.input.clearActions();
  }

  private render(dt: number): void {
    const frameStart = performance.now();

    if (this.state === 'raid' && this.session) {
      this.renderer.render(this.session, dt, this.lastFrameMs);
      if (!this.screens.isOpen) {
        this.hud.update(this.session, dt, this.debugText());
      }
    }

    this.lastFrameMs = performance.now() - frameStart;
  }

  private debugText(): string {
    if (!this.settings.showFps) return '';
    const stats = this.loop.stats;
    const ai = this.session?.ai;
    return [
      `${stats.fps.toFixed(0)} FPS  ${this.renderer.internalResolution}`,
      `sim ${stats.simMs.toFixed(1)}ms  draw ${stats.renderMs.toFixed(1)}ms`,
      `KI ${ai?.aliveCount ?? 0}  aktiv ${ai?.engagedCount ?? 0}`,
      `Geschosse ${this.session?.ballistics.activeCount ?? 0}`,
    ].join('\n');
  }

  /** Value of everything the player currently carries - used by the debrief. */
  private carriedValue(): number {
    if (!this.session) return 0;
    let total = 0;
    for (const { grid } of this.session.player.inventory.allGrids()) {
      for (const stack of grid.items()) total += stackValue(stack);
    }
    return total;
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    for (const d of this.disposers) d();
    this.session?.dispose();
    this.save.flush();
    void this.carriedValue;
  }
}
