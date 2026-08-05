import { bar, clear, duration, el, weight as fmtWeight } from './Dom';
import type { InputSystem } from '../input/InputSystem';
import type { RaidSession } from '../raid/RaidSession';
import type { GameBus, NotificationPayload } from '../core/GameEvents';
import { BODY_PARTS, type BodyPart } from '../data/ItemTypes';
import { ItemDB } from '../data/ItemDatabase';
import { FIRE_MODE_LABEL } from '../weapons/WeaponRuntime';
import { clamp01 } from '../core/Math2D';

/**
 * HUD - the in-raid overlay and touch controls.
 *
 * Built from DOM rather than drawn into the canvas so text stays crisp at any
 * internal render scale, buttons get native touch handling, and the whole
 * layer costs the renderer nothing.
 *
 * Information design follows one rule: **only show what changes a decision.**
 * There is no minimap, no enemy markers and no ammo counter for weapons you are
 * not holding. What is on screen is the raid clock, your body, your magazine,
 * and whatever you can interact with right now.
 */

const NOTIFICATION_LIMIT = 5;

interface ActiveNotification {
  node: HTMLElement;
  remaining: number;
}

export class HUD {
  readonly root: HTMLElement;

  private timerEl!: HTMLElement;
  private conditionsEl!: HTMLElement;
  private contactsEl!: HTMLElement;
  private compassTicks!: HTMLElement;
  private compassMarkers!: HTMLElement;

  private healthBar!: HTMLElement;
  private staminaBar!: HTMLElement;
  private energyBar!: HTMLElement;
  private hydrationBar!: HTMLElement;
  private weightEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private bodyParts = new Map<BodyPart, HTMLElement>();

  private ammoEl!: HTMLElement;
  private weaponNameEl!: HTMLElement;
  private fireModeEl!: HTMLElement;

  private promptEl!: HTMLElement;
  private actionEl!: HTMLElement;
  private actionLabel!: HTMLElement;
  private actionBar!: HTMLElement;

  private notificationsEl!: HTMLElement;
  private notifications: ActiveNotification[] = [];

  private stickVisual!: HTMLElement;
  private stickKnob!: HTMLElement;

  private debugEl!: HTMLElement;

  /** Callbacks wired by the game shell. */
  onInteract: () => void = () => {};
  onInventory: () => void = () => {};
  onMap: () => void = () => {};
  onPause: () => void = () => {};

  constructor(
    container: HTMLElement,
    private readonly input: InputSystem,
    bus: GameBus,
  ) {
    this.root = el('div', { class: 'hud hidden' });
    container.appendChild(this.root);
    this.build();
    this.bindButtons();

    bus.on('ui:notify', (payload) => this.notify(payload));
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  setDebugVisible(visible: boolean): void {
    this.debugEl.classList.toggle('hidden', !visible);
  }

  // =========================================================================
  // Construction
  // =========================================================================

  private build(): void {
    // --- top bar: raid clock, conditions and contact count ----------------
    this.timerEl = el('div', { class: 'hud-timer', text: '00:00' });
    this.conditionsEl = el('div', { class: 'hud-conditions', text: '' });
    this.contactsEl = el('div', { class: 'hud-contacts', text: 'RUHIG' });
    this.root.appendChild(
      el('div', { class: 'hud-top' }, [this.timerEl, this.conditionsEl, this.contactsEl]),
    );

    // --- compass ----------------------------------------------------------
    this.compassTicks = el('div', { class: 'ticks' });
    this.compassMarkers = el('div', { class: 'ticks' });
    this.root.appendChild(el('div', { class: 'hud-compass' }, [this.compassTicks, this.compassMarkers]));

    // --- vitals -----------------------------------------------------------
    this.healthBar = el('div');
    this.staminaBar = el('div');
    this.energyBar = el('div');
    this.hydrationBar = el('div');
    this.weightEl = el('span', { class: 'value', text: '0.0 kg' });
    this.statusEl = el('div', { class: 'hud-status' });

    const bodyRow = el('div', { class: 'hud-body' });
    // Five columns: head, arms, torso block, legs. Compact but complete.
    for (const part of BODY_PARTS) {
      const node = el('div', { class: 'part', title: part });
      this.bodyParts.set(part, node);
    }
    bodyRow.appendChild(this.bodyParts.get('head')!);
    bodyRow.appendChild(this.bodyParts.get('leftArm')!);
    bodyRow.appendChild(this.bodyParts.get('thorax')!);
    bodyRow.appendChild(this.bodyParts.get('rightArm')!);
    bodyRow.appendChild(this.bodyParts.get('stomach')!);
    const legRow = el('div', { class: 'hud-body' }, [
      this.bodyParts.get('leftLeg')!,
      this.bodyParts.get('rightLeg')!,
    ]);

    this.root.appendChild(
      el('div', { class: 'hud-vitals' }, [
        el('div', { class: 'row' }, [el('span', { class: 'key', text: 'HP' }), this.healthBar]),
        el('div', { class: 'row' }, [el('span', { class: 'key', text: 'AUS' }), this.staminaBar]),
        el('div', { class: 'row' }, [el('span', { class: 'key', text: 'NRG' }), this.energyBar]),
        el('div', { class: 'row' }, [el('span', { class: 'key', text: 'H2O' }), this.hydrationBar]),
        bodyRow,
        legRow,
        el('div', { class: 'row', style: { marginTop: '3px' } }, [
          el('span', { class: 'key', text: 'LAST' }),
          this.weightEl,
        ]),
        this.statusEl,
      ]),
    );

    // --- weapon block ------------------------------------------------------
    this.ammoEl = el('div', { class: 'hud-ammo', text: '0' });
    this.weaponNameEl = el('div', { class: 'hud-weapon-name', text: '-' });
    this.fireModeEl = el('div', { class: 'hud-firemode', text: '' });
    this.root.appendChild(
      el('div', { class: 'hud-weapon' }, [this.ammoEl, this.weaponNameEl, this.fireModeEl]),
    );

    // --- prompts -----------------------------------------------------------
    this.promptEl = el('div', { class: 'hud-prompt hidden' });
    this.root.appendChild(this.promptEl);

    this.actionLabel = el('div', { class: 'label' });
    this.actionBar = el('div');
    this.actionEl = el('div', { class: 'hud-action hidden' }, [this.actionLabel, this.actionBar]);
    this.root.appendChild(this.actionEl);

    this.notificationsEl = el('div', { class: 'hud-notifications' });
    this.root.appendChild(this.notificationsEl);

    this.debugEl = el('div', { class: 'hud-debug hidden' });
    this.root.appendChild(this.debugEl);

    // --- touch controls ----------------------------------------------------
    this.stickKnob = el('div', { class: 'stick-knob' });
    this.stickVisual = el('div', { class: 'stick-visual' }, [this.stickKnob]);
    this.root.appendChild(this.stickVisual);

    this.buildTouchControls();
  }

  private buildTouchControls(): void {
    const layer = el('div', { class: 'touch-layer', style: { pointerEvents: 'none' } });

    const make = (cls: string, label: string): HTMLElement => {
      const node = el('div', { class: `touch-btn ${cls}`, text: label });
      layer.appendChild(node);
      return node;
    };

    this.fireBtn = make('fire', 'FEUER');
    this.adsBtn = make('ads', 'ZIEL');
    this.reloadBtn = make('reload', 'LADEN');
    this.stanceBtn = make('stance', 'HALT');
    this.interactBtn = make('interact', 'AKTION');
    this.healBtn = make('heal', 'MED');
    this.swapBtn = make('swap', 'WECHS');
    this.fireModeBtn = make('firemode', 'MODUS');
    this.torchBtn = make('torch', 'LAMPE');
    this.leanLeftBtn = make('lean-left', '◀');
    this.leanRightBtn = make('lean-right', '▶');

    const corner = el('div', { class: 'touch-corner' });
    this.inventoryBtn = el('div', { class: 'touch-btn', text: 'INV' });
    this.mapBtn = el('div', { class: 'touch-btn', text: 'KARTE' });
    this.pauseBtn = el('div', { class: 'touch-btn', text: 'MENÜ' });
    corner.append(this.inventoryBtn, this.mapBtn, this.pauseBtn);
    layer.appendChild(corner);

    this.root.appendChild(layer);
  }

  private fireBtn!: HTMLElement;
  private adsBtn!: HTMLElement;
  private reloadBtn!: HTMLElement;
  private stanceBtn!: HTMLElement;
  private interactBtn!: HTMLElement;
  private healBtn!: HTMLElement;
  private swapBtn!: HTMLElement;
  private fireModeBtn!: HTMLElement;
  private torchBtn!: HTMLElement;
  private leanLeftBtn!: HTMLElement;
  private leanRightBtn!: HTMLElement;
  private inventoryBtn!: HTMLElement;
  private mapBtn!: HTMLElement;
  private pauseBtn!: HTMLElement;

  private bindButtons(): void {
    this.input.bindHold(this.fireBtn, 'fire');
    this.input.bindHold(this.adsBtn, 'ads');
    this.input.bindHold(this.leanLeftBtn, 'leanLeft');
    this.input.bindHold(this.leanRightBtn, 'leanRight');

    this.input.bindTap(this.reloadBtn, 'reload');
    this.input.bindTap(this.stanceBtn, 'stance');
    this.input.bindTap(this.interactBtn, 'interact');
    this.input.bindTap(this.healBtn, 'heal');
    this.input.bindTap(this.swapBtn, 'swapWeapon');
    this.input.bindTap(this.fireModeBtn, 'fireMode');
    this.input.bindTap(this.torchBtn, 'toggleLight');
    this.input.bindTap(this.inventoryBtn, 'inventory');
    this.input.bindTap(this.mapBtn, 'map');
    this.input.bindTap(this.pauseBtn, 'pause');
  }

  // =========================================================================
  // Per-frame update
  // =========================================================================

  update(session: RaidSession, dt: number, debugText: string): void {
    this.updateTimer(session);
    this.updateCompass(session);
    this.updateVitals(session);
    this.updateWeapon(session);
    this.updatePrompts(session);
    this.updateNotifications(dt);
    this.updateStick();
    this.debugEl.textContent = debugText;
  }

  private updateTimer(session: RaidSession): void {
    this.timerEl.textContent = duration(session.timeLeft);
    this.timerEl.classList.toggle('urgent', session.timeLeft < 120);

    const contacts = session.ai.engagedCount;
    this.contactsEl.textContent = contacts === 0 ? 'RUHIG' : `${contacts} KONTAKT${contacts === 1 ? '' : 'E'}`;
    this.contactsEl.classList.toggle('hot', contacts > 0);

    const conditions = session.conditions.label.toUpperCase();
    if (this.conditionsEl.textContent !== conditions) {
      this.conditionsEl.textContent = conditions;
      this.conditionsEl.classList.toggle('dark', session.conditions.darkEnoughForLight);
    }

    // The torch button shows whether a light is fitted and whether it is lit -
    // switching it on is a commitment, so its state must never be ambiguous.
    this.torchBtn.classList.toggle('unavailable', !session.hasTorch);
    this.torchBtn.classList.toggle('active', session.torchOn);
  }

  /**
   * Compass strip with cardinal ticks and objective markers.
   * A compass rather than a minimap is a deliberate choice: it tells you which
   * way you are facing without telling you what is around you.
   */
  private updateCompass(session: RaidSession): void {
    const heading = session.player.angle;
    const width = this.compassTicks.parentElement?.clientWidth ?? 320;
    // 180 degrees of arc across the visible strip.
    const pxPerRad = width / Math.PI;

    clear(this.compassTicks);
    const cardinals: [number, string][] = [
      [0, 'O'], [Math.PI * 0.5, 'S'], [Math.PI, 'W'], [Math.PI * 1.5, 'N'],
    ];
    for (const [angle, label] of cardinals) {
      let delta = angle - heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const x = width * 0.5 + delta * pxPerRad;
      if (x < -20 || x > width + 20) continue;
      this.compassTicks.appendChild(
        el('span', { class: 'marker', style: { left: `${x}px`, color: 'var(--text)' }, text: label }),
      );
    }

    clear(this.compassMarkers);
    // Discovered extractions, then active event markers.
    for (const ex of session.extraction.extracts) {
      if (!ex.discovered) continue;
      const angle = Math.atan2(ex.def.y - session.player.y, ex.def.x - session.player.x);
      let delta = angle - heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const x = width * 0.5 + delta * pxPerRad;
      if (x < -20 || x > width + 20) continue;
      this.compassMarkers.appendChild(
        el('span', {
          class: 'marker',
          style: { left: `${x}px`, color: ex.available ? 'var(--good)' : 'var(--text-faint)', top: '9px' },
          text: '▲',
        }),
      );
    }
    for (const marker of session.events.markers()) {
      const angle = Math.atan2(marker.y - session.player.y, marker.x - session.player.x);
      let delta = angle - heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const x = width * 0.5 + delta * pxPerRad;
      if (x < -20 || x > width + 20) continue;
      this.compassMarkers.appendChild(
        el('span', { class: 'marker', style: { left: `${x}px`, color: 'var(--accent)', top: '9px' }, text: '◆' }),
      );
    }
  }

  private updateVitals(session: RaidSession): void {
    const player = session.player;
    const health = player.health;

    const hpFraction = clamp01(health.totalHp / health.totalMaxHp);
    this.replaceBar(this.healthBar, hpFraction, hpFraction > 0.6 ? 'var(--good)' : hpFraction > 0.3 ? 'var(--accent)' : 'var(--bad)');
    this.replaceBar(this.staminaBar, clamp01(player.stamina / 100), 'var(--info)');
    this.replaceBar(this.energyBar, clamp01(health.energy / 100), '#9e8a4f');
    this.replaceBar(this.hydrationBar, clamp01(health.hydration / 100), '#4f8a9e');

    for (const part of BODY_PARTS) {
      const node = this.bodyParts.get(part)!;
      const state = health.parts[part];
      const fraction = state.hp / state.max;
      node.className = 'part';
      if (state.blackedOut) node.classList.add('out');
      else if (fraction < 0.35) node.classList.add('bad');
      else if (fraction < 0.7) node.classList.add('warn');
      // A fracture reads as a dashed outline even when the limb is healthy.
      node.style.outline = state.fractured ? '1px dashed #c8913a' : '';
    }

    const carried = player.carriedWeight;
    this.weightEl.textContent = fmtWeight(carried);
    this.weightEl.style.color = player.overloaded ? 'var(--bad)' : player.loadFactor > 0.6 ? 'var(--accent)' : 'var(--text)';

    this.statusEl.textContent = health.statusSummary() ?? '';
  }

  private replaceBar(host: HTMLElement, fraction: number, color: string): void {
    clear(host);
    host.appendChild(bar(fraction, color));
    host.className = 'bar-host';
    host.style.flex = '1';
  }

  private updateWeapon(session: RaidSession): void {
    const controller = session.playerWeapon;
    const resolved = controller.resolved;

    if (!resolved || !controller.weapon) {
      this.ammoEl.textContent = '—';
      this.weaponNameEl.textContent = 'UNBEWAFFNET';
      this.fireModeEl.textContent = '';
      return;
    }

    const inMag = controller.ammoInMagazine;
    const chambered = controller.weapon.chamber ? 1 : 0;
    // Reserve is what is actually reachable, not what exists in the world.
    const reserve = this.countReserve(session);

    clear(this.ammoEl);
    this.ammoEl.appendChild(document.createTextNode(String(inMag + chambered)));
    this.ammoEl.appendChild(el('span', { class: 'reserve', text: ` / ${reserve}` }));

    const magFraction = resolved.magCapacity > 0 ? inMag / resolved.magCapacity : 0;
    this.ammoEl.className = 'hud-ammo';
    if (inMag + chambered === 0) this.ammoEl.classList.add('empty');
    else if (magFraction < 0.3) this.ammoEl.classList.add('low');

    let name = resolved.def.shortName;
    if (controller.state === 'reloading') name = 'NACHLADEN…';
    else if (controller.state === 'jammed') name = 'LADEHEMMUNG';
    else if (controller.state === 'clearing') name = 'BEHEBEN…';
    else if (controller.state === 'swapping') name = 'WECHSEL…';
    this.weaponNameEl.textContent = name;

    const durability = resolved.durability;
    this.weaponNameEl.style.color = durability < 35 ? 'var(--bad)' : durability < 60 ? 'var(--accent)' : 'var(--text-dim)';

    this.fireModeEl.textContent =
      `${FIRE_MODE_LABEL[controller.currentFireMode]}${resolved.suppressed ? ' · GEDÄMPFT' : ''}`;
  }

  /**
   * Rounds of the current calibre the player can actually reach: loaded spare
   * magazines plus loose cartridges. Deliberately excludes anything in the
   * secure container, because you cannot reload from it.
   */
  private countReserve(session: RaidSession): number {
    const caliber = session.playerWeapon.resolved?.caliber;
    if (!caliber) return 0;
    let total = 0;
    for (const { slot, grid } of session.player.inventory.allGrids()) {
      if (slot === 'secure') continue;
      for (const stack of grid.items()) {
        const def = ItemDB.tryGet(stack.defId);
        if (!def) continue;
        if (def.magazine) {
          if (def.magazine.caliber === caliber) total += stack.rounds?.length ?? 0;
        } else if (def.ammo?.caliber === caliber) {
          total += stack.count;
        }
      }
    }
    return total;
  }

  private updatePrompts(session: RaidSession): void {
    const player = session.player;

    if (player.isBusy) {
      this.actionEl.classList.remove('hidden');
      this.actionLabel.textContent = player.busyLabel;
      clear(this.actionBar);
      // Progress is derived from the remaining time so it works for any action.
      const total = Math.max(0.001, player.busySeconds);
      this.actionBar.appendChild(bar(1 - clamp01(player.busySeconds / (total + 0.0001)), 'var(--accent)'));
      this.promptEl.classList.add('hidden');
      return;
    }
    this.actionEl.classList.add('hidden');

    const interaction = session.interaction;
    const extracting = session.extraction.activeExtract;
    if (extracting) {
      this.promptEl.classList.remove('hidden');
      this.promptEl.textContent = `EXTRAKTION: ${extracting.def.name.toUpperCase()} — POSITION HALTEN`;
    } else if (interaction) {
      this.promptEl.classList.remove('hidden');
      this.promptEl.textContent = interaction.label.toUpperCase();
    } else {
      // Nearby blocked extraction: tell the player why it will not open.
      const blocked = session.extraction.extracts.find(
        (ex) => ex.discovered && !ex.available && Math.hypot(ex.def.x - player.x, ex.def.y - player.y) < ex.def.radius + 2,
      );
      if (blocked?.blockedReason) {
        this.promptEl.classList.remove('hidden');
        this.promptEl.textContent = blocked.blockedReason.toUpperCase();
      } else {
        this.promptEl.classList.add('hidden');
      }
    }
  }

  private updateStick(): void {
    const visual = this.input.stickVisual;
    this.stickVisual.classList.toggle('active', visual.active);
    if (!visual.active) return;
    this.stickVisual.style.left = `${visual.originX}px`;
    this.stickVisual.style.top = `${visual.originY}px`;
    this.stickKnob.style.transform = `translate(${visual.knobX}px, ${visual.knobY}px)`;
  }

  // =========================================================================
  // Notifications
  // =========================================================================

  notify(payload: NotificationPayload): void {
    const node = el('div', { class: `notification ${payload.tone}`, text: payload.text });
    this.notificationsEl.appendChild(node);
    this.notifications.push({ node, remaining: payload.duration ?? 3 });
    while (this.notifications.length > NOTIFICATION_LIMIT) {
      const oldest = this.notifications.shift();
      oldest?.node.remove();
    }
  }

  private updateNotifications(dt: number): void {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      const n = this.notifications[i];
      n.remaining -= dt;
      if (n.remaining <= 0) {
        n.node.remove();
        this.notifications.splice(i, 1);
      } else if (n.remaining < 0.4) {
        n.node.style.opacity = String(n.remaining / 0.4);
      }
    }
  }

  clearNotifications(): void {
    for (const n of this.notifications) n.node.remove();
    this.notifications.length = 0;
  }
}
