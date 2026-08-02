import { bar, button, clear, duration, el, money } from '../Dom';
import { InventoryView, renderItemDetail, type GridSource } from '../InventoryView';
import { screenShell, type Screen } from '../ScreenManager';
import type { Profile } from '../../meta/Profile';
import { loadoutRiskValue } from '../../meta/Profile';
import { EQUIP_SLOTS, EQUIP_SLOT_LABEL } from '../../inventory/Inventory';
import { ItemDB } from '../../data/ItemDatabase';
import type { EquipSlot } from '../../data/ItemTypes';
import { RARITY_COLOR } from '../../data/ItemTypes';
import { createStack, defOf, stackValue, type ItemStack } from '../../inventory/ItemStack';
import { HIDEOUT_MODULES, type ModuleId } from '../../meta/Hideout';
import { RECIPES } from '../../meta/Crafting';
import { TRADERS, type TraderId } from '../../meta/Traders';
import { QUESTS } from '../../meta/Quests';
import { SKILLS, MAX_SKILL_LEVEL, type SkillId } from '../../meta/Progression';
import { attach, canAttach, detach, loadMagazine, resolveWeapon, totalRounds, unloadMagazine } from '../../weapons/WeaponRuntime';

/**
 * HideoutScreen - everything the player does between raids.
 *
 * Navigation is a **vertical rail**, not a tab bar across the top, and that is
 * the single most important layout decision on this screen. A phone held in
 * landscape has around 390 logical pixels of height; a horizontal tab strip
 * costs 50 of them plus its margin, which is a quarter of the usable content
 * area spent on six words. Moved to the side it costs nothing vertically, and
 * it lands under the left thumb where the hand already is.
 *
 * The first stop is an overview rather than a gear grid. A player returning
 * after a raid needs to know what changed and what is worth doing next -
 * builds that finished, crafts that are ready, quests that can be handed in,
 * insurance that came back - before they start rearranging pockets.
 *
 * The header permanently shows the value at risk in the current loadout. That
 * number is the whole game in one figure: it is what you lose if the next raid
 * goes badly, and it should make the player hesitate before they tap deploy.
 */

type TabId = 'overview' | 'gear' | 'base' | 'craft' | 'traders' | 'quests' | 'insurance';

/**
 * Rail entries. The glyph is not decoration - at rail width the label wraps to
 * two lines and the shape is what the eye actually navigates by.
 */
const TABS: { id: TabId; label: string; glyph: string }[] = [
  { id: 'overview', label: 'Übersicht', glyph: '◈' },
  { id: 'gear', label: 'Ausrüstung', glyph: '⬢' },
  { id: 'base', label: 'Versteck', glyph: '⌂' },
  { id: 'craft', label: 'Werkstatt', glyph: '⚙' },
  { id: 'traders', label: 'Händler', glyph: '⇄' },
  { id: 'quests', label: 'Aufträge', glyph: '✦' },
  { id: 'insurance', label: 'Versicherung', glyph: '⛨' },
];

/**
 * One shop line: name and description on top, price and action underneath.
 *
 * Deliberately stacked rather than a single row. A trader panel on a phone is
 * around 200 px wide; putting the name, the price and a button on one line
 * leaves the name about 40 px, and a word longer than that does not wrap - it
 * overflows its flex box and paints straight over the price. Two lines cost
 * nothing here and cannot break.
 */
function tradeRow(spec: {
  title: string;
  titleColor?: string;
  detail?: string;
  note?: string;
  price: string;
  actionLabel: string;
  actionClass: string;
  disabled?: boolean;
  onAction: () => void;
}): HTMLElement {
  const action = button(spec.actionLabel, spec.onAction, spec.actionClass,
    spec.disabled ? { disabled: 'true' } : {});

  return el('div', { class: 'trade-row' }, [
    el('div', {
      class: 'title',
      text: spec.title,
      style: spec.titleColor ? { color: spec.titleColor } : {},
    }),
    spec.detail ? el('div', { class: 'detail', text: spec.detail }) : null,
    el('div', { class: 'foot' }, [
      spec.note ? el('span', { class: 'note', text: spec.note }) : null,
      el('span', { class: 'spacer' }),
      el('span', { class: 'price', text: spec.price }),
      action,
    ].filter(Boolean) as HTMLElement[]),
  ].filter(Boolean) as HTMLElement[]);
}

export class HideoutScreen implements Screen {
  readonly id = 'hideout';
  readonly root: HTMLElement;

  private body: HTMLElement;
  private subtitleEl: HTMLElement;
  private tabBar: HTMLElement;
  private content: HTMLElement;
  private activeTab: TabId = 'overview';

  private inventoryView: InventoryView;
  private detailPanel: HTMLElement;
  private selected: { stack: ItemStack; source: GridSource } | null = null;
  private selectedTrader: TraderId = 'kessler';

  constructor(
    private readonly profile: Profile,
    private readonly actions: {
      onDeploy: () => void;
      onSettings: () => void;
      onSave: () => void;
      notify: (text: string, tone: 'info' | 'good' | 'bad' | 'warn') => void;
    },
  ) {
    const deployBtn = button('Einsatz starten', () => this.actions.onDeploy(), 'btn primary');
    const settingsBtn = button('⚙', () => this.actions.onSettings(), 'btn ghost small icon');

    const shell = screenShell('Versteck', '', null, [settingsBtn, deployBtn]);
    this.root = shell.root;
    this.body = shell.body;
    this.subtitleEl = shell.subtitleEl;
    shell.header.classList.add('compact');

    this.tabBar = el('div', { class: 'nav-rail' });
    this.content = el('div', { class: 'hub-content' });
    this.body.append(this.tabBar, this.content);

    this.inventoryView = new InventoryView((stack, source) => {
      this.selected = stack && source ? { stack, source } : null;
      this.renderDetail();
    });
    this.detailPanel = el('div', { class: 'panel-body' });

    this.buildTabs();
  }

  onShow(): void {
    this.refresh();
  }

  onTick(dt: number): void {
    // The metagame clock runs while the player is in the hideout, so builds
    // and crafts visibly progress instead of only advancing on load.
    this.profile.tick(dt);
    this.updateSubtitle();
    if (this.activeTab === 'base' || this.activeTab === 'craft' || this.activeTab === 'insurance') {
      // These tabs show live timers; re-render at a low rate.
      this.timerAccumulator += dt;
      if (this.timerAccumulator > 1) {
        this.timerAccumulator = 0;
        this.renderContent();
      }
    }
  }

  private timerAccumulator = 0;

  private buildTabs(): void {
    clear(this.tabBar);
    for (const tab of TABS) {
      const badgeCount = this.badgeFor(tab.id);
      const node = el('div', {
        class: `nav-item${tab.id === this.activeTab ? ' active' : ''}`,
      }, [
        el('span', { class: 'glyph', text: tab.glyph }),
        el('span', { class: 'label', text: tab.label }),
        // A badge means "there is something here you can act on right now",
        // never just "this exists". A rail full of badges says nothing.
        badgeCount > 0 ? el('span', { class: 'badge', text: String(badgeCount) }) : null,
      ].filter(Boolean) as HTMLElement[]);
      node.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.selected = null;
        this.buildTabs();
        this.renderContent();
      });
      this.tabBar.appendChild(node);
    }
  }

  /** How many actionable things are waiting behind a rail entry. */
  private badgeFor(tab: TabId): number {
    const p = this.profile;
    switch (tab) {
      case 'quests':
        return p.quests.readyToTurnIn().length;
      case 'craft':
        return p.crafting.jobs.filter((j) => j.secondsRemaining <= 0).length;
      case 'insurance':
        return p.insurance.pending.length;
      default:
        return 0;
    }
  }

  refresh(): void {
    this.updateSubtitle();
    this.renderContent();
  }

  private updateSubtitle(): void {
    const p = this.profile;
    const risk = loadoutRiskValue(p.loadout);
    // Chips rather than a run-on sentence: at 12 px on a phone a single line of
    // four values separated by dots is a wall, and the one that matters - what
    // this raid could cost - has to be findable at a glance.
    clear(this.subtitleEl);
    this.subtitleEl.append(
      el('span', { class: 'chip' }, [
        el('span', { class: 'k', text: 'Stufe' }),
        el('span', { class: 'v', text: String(p.progression.level) }),
      ]),
      el('span', { class: 'chip' }, [
        el('span', { class: 'k', text: 'Guthaben' }),
        el('span', { class: 'v', text: money(p.money) }),
      ]),
      el('span', { class: 'chip' }, [
        el('span', { class: 'k', text: 'Lager' }),
        el('span', { class: 'v', text: money(p.stashValue) }),
      ]),
      el('span', { class: 'chip risk' }, [
        el('span', { class: 'k', text: 'Im Risiko' }),
        el('span', { class: 'v', text: money(risk) }),
      ]),
    );
  }

  private renderContent(): void {
    clear(this.content);
    switch (this.activeTab) {
      case 'overview':
        this.renderOverviewTab();
        break;
      case 'gear':
        this.renderGearTab();
        break;
      case 'base':
        this.renderBaseTab();
        break;
      case 'craft':
        this.renderCraftTab();
        break;
      case 'traders':
        this.renderTradersTab();
        break;
      case 'quests':
        this.renderQuestsTab();
        break;
      case 'insurance':
        this.renderInsuranceTab();
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // Overview - the hub proper
  // =========================================================================

  /**
   * What changed while you were out, and what is worth doing before you go
   * back. Two columns: readiness on the left (can I deploy, and what am I
   * risking), the base's running clocks on the right.
   */
  private renderOverviewTab(): void {
    const p = this.profile;

    // --- left: operator and loadout readiness ------------------------------
    const left = el('div', { class: 'panel-body' });

    left.appendChild(
      el('div', { class: 'ov-operator' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'lvl', text: `Stufe ${p.progression.level}` }),
          el('span', { class: 'grow' }),
          el('span', { class: 'xp', text: `${Math.round(p.progression.levelProgress * 100)} % zur nächsten` }),
        ]),
        bar(p.progression.levelProgress, '#c8913a'),
        el('div', { class: 'row stats' }, [
          el('span', { text: `${p.raids} Einsätze` }),
          el('span', { text: `${p.survived} überlebt` }),
          el('span', { text: `${Math.round(p.survivalRate * 100)} % Quote` }),
        ]),
      ]),
    );

    // Readiness checklist. Every line is a thing that has actually killed a
    // raid: no gun, no bandage, an empty magazine, nothing insured.
    const checks = this.readinessChecks();
    const list = el('div', { class: 'ov-checks' });
    for (const check of checks) {
      list.appendChild(
        el('div', { class: `ov-check ${check.ok ? 'ok' : check.severity}` }, [
          el('span', { class: 'mark', text: check.ok ? '✓' : '!' }),
          el('span', { class: 'grow' }, [
            el('div', { class: 'title', text: check.label }),
            el('div', { class: 'sub', text: check.detail }),
          ]),
        ]),
      );
    }
    left.append(
      el('div', { class: 'panel-head', style: { border: 'none', padding: '12px 0 6px' }, text: 'Einsatzbereitschaft' }),
      list,
    );

    // --- right: what the base is doing --------------------------------------
    const right = el('div', { class: 'panel-body' });
    const activity = this.baseActivity();

    if (activity.length === 0) {
      right.appendChild(
        el('div', { class: 'empty-note', text: 'Nichts läuft. Werkstatt und Ausbau warten auf dich.' }),
      );
    } else {
      for (const item of activity) {
        right.appendChild(
          el('div', { class: `ov-activity${item.done ? ' done' : ''}` }, [
            el('div', { class: 'row' }, [
              el('span', { class: 'title', text: item.title }),
              el('span', { class: 'grow' }),
              el('span', { class: 'clock', text: item.done ? 'Fertig' : duration(item.remaining) }),
            ]),
            el('div', { class: 'sub', text: item.detail }),
            bar(item.progress, item.done ? '#4f9e6a' : '#4f7d9e'),
          ]),
        );
      }
    }

    const quickJump = (label: string, tab: TabId): HTMLElement => {
      const b = button(label, () => {
        this.activeTab = tab;
        this.buildTabs();
        this.renderContent();
      }, 'btn small');
      b.style.flex = '1';
      return b;
    };

    right.appendChild(
      el('div', { class: 'ov-jumps' }, [
        quickJump('Ausrüstung', 'gear'),
        quickJump('Händler', 'traders'),
        quickJump('Aufträge', 'quests'),
      ]),
    );

    this.content.append(
      el('div', { class: 'panel', style: { flex: '1.15' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Operator' })]),
        left,
      ]),
      el('div', { class: 'panel', style: { flex: '1' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Versteck' })]),
        right,
      ]),
    );
  }

  private readinessChecks(): { label: string; detail: string; ok: boolean; severity: 'bad' | 'warn' }[] {
    const loadout = this.profile.loadout;
    const out: { label: string; detail: string; ok: boolean; severity: 'bad' | 'warn' }[] = [];

    const primary = loadout.equipped.primary;
    const sidearm = loadout.equipped.sidearm;
    const weapon = primary ?? sidearm;
    if (!weapon) {
      out.push({ label: 'Keine Waffe', detail: 'Du läufst unbewaffnet los.', ok: false, severity: 'bad' });
    } else {
      const rounds = totalRounds(weapon);
      out.push({
        label: defOf(weapon).name,
        detail: rounds > 0 ? `${rounds} Schuss geladen` : 'Nicht geladen',
        ok: rounds > 0,
        severity: 'bad',
      });
    }

    const spareAmmo = loadout.findStack((_, def) => def.category === 'ammo' || def.category === 'magazine');
    out.push({
      label: 'Nachschub',
      detail: spareAmmo ? 'Ersatzmunition dabei' : 'Keine Ersatzmunition im Gepäck',
      ok: !!spareAmmo,
      severity: 'warn',
    });

    const meds = loadout.findStack((_, def) => def.category === 'med');
    out.push({
      label: 'Medizin',
      detail: meds ? 'Verbandmaterial dabei' : 'Nichts gegen Blutungen dabei',
      ok: !!meds,
      severity: 'bad',
    });

    out.push({
      label: 'Sicherheitsbehälter',
      detail: loadout.equipped.secure
        ? 'Inhalt überlebt deinen Tod'
        : 'Ohne Behälter geht bei einem Tod alles verloren',
      ok: !!loadout.equipped.secure,
      severity: 'warn',
    });

    const insured = this.profile.insurance.activeCover.length;
    const risk = loadoutRiskValue(loadout);
    out.push({
      label: 'Versicherung',
      detail: insured > 0
        ? `${insured} Gegenstände abgesichert`
        : risk > 40000 ? 'Nichts abgesichert bei hohem Wert' : 'Nichts abgesichert',
      ok: insured > 0 || risk <= 40000,
      severity: 'warn',
    });

    const stats = loadout.stats;
    out.push({
      label: 'Traglast',
      detail: `${stats.weight.toFixed(1)} kg`,
      ok: stats.weight < 26,
      severity: 'warn',
    });

    return out;
  }

  private baseActivity(): { title: string; detail: string; remaining: number; progress: number; done: boolean }[] {
    const p = this.profile;
    const out: { title: string; detail: string; remaining: number; progress: number; done: boolean }[] = [];

    for (const id of Object.keys(HIDEOUT_MODULES) as ModuleId[]) {
      const state = p.hideout.modules[id];
      if (state.buildingLevel === 0) continue;
      const def = HIDEOUT_MODULES[id];
      const total = def.levels[state.buildingLevel - 1]?.buildSeconds ?? 1;
      out.push({
        title: `${def.name} · Stufe ${state.buildingLevel}`,
        detail: 'Ausbau läuft',
        remaining: state.buildRemaining,
        progress: 1 - state.buildRemaining / total,
        done: state.buildRemaining <= 0,
      });
    }

    for (const job of p.crafting.jobs) {
      const recipe = RECIPES.find((r) => r.id === job.recipeId);
      out.push({
        title: recipe?.name ?? 'Fertigung',
        detail: HIDEOUT_MODULES[job.module].name,
        remaining: job.secondsRemaining,
        progress: 1 - job.secondsRemaining / Math.max(1, job.totalSeconds),
        done: job.secondsRemaining <= 0,
      });
    }

    const returning = p.insurance.activeCover.filter((e) => e.returning);
    if (returning.length > 0) {
      const soonest = Math.min(...returning.map((e) => e.returnIn));
      out.push({
        title: `Versicherung · ${returning.length} Gegenstände`,
        detail: 'Auf dem Rückweg',
        remaining: soonest,
        progress: 0.5,
        done: false,
      });
    }
    if (p.insurance.pending.length > 0) {
      out.push({
        title: `${p.insurance.pending.length} Gegenstände zurück`,
        detail: 'Warten auf Abholung',
        remaining: 0,
        progress: 1,
        done: true,
      });
    }

    // Finished first: those are the ones that need a tap.
    out.sort((a, b) => Number(b.done) - Number(a.done) || a.remaining - b.remaining);
    return out;
  }

  // =========================================================================
  // Gear
  // =========================================================================

  private renderGearTab(): void {
    // --- equipment slots ---------------------------------------------------
    const slotList = el('div', { class: 'panel-body' });
    for (const slot of EQUIP_SLOTS) {
      const stack = this.profile.loadout.equipped[slot];
      const row = el('div', { class: 'list-row clickable' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'sub', text: EQUIP_SLOT_LABEL[slot] }),
          el('div', {
            class: 'title',
            text: stack ? defOf(stack).name : '— leer —',
            style: { color: stack ? RARITY_COLOR[defOf(stack).rarity] : '#5b6472' },
          }),
        ]),
        stack ? el('div', { class: 'price', text: money(stackValue(stack)) }) : null,
      ].filter(Boolean) as HTMLElement[]);

      row.addEventListener('click', () => {
        if (stack) {
          this.selected = { stack, source: { id: `equip:${slot}`, label: EQUIP_SLOT_LABEL[slot], grid: this.profile.stash } };
          this.renderDetail();
        }
      });
      slotList.appendChild(row);
    }

    const stats = this.profile.loadout.stats;
    slotList.appendChild(
      el('div', { style: { marginTop: '10px' } }, [
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Gesamtgewicht' }),
          el('span', { class: 'value', text: `${stats.weight.toFixed(1)} kg` }),
        ]),
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Bewegung' }),
          el('span', {
            class: `value ${stats.speedFactor < 1 ? 'bad' : ''}`,
            text: `${Math.round(stats.speedFactor * 100)} %`,
          }),
        ]),
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Handhabung' }),
          el('span', {
            class: `value ${stats.ergonomicsPenalty > 0 ? 'bad' : ''}`,
            text: `+${stats.ergonomicsPenalty.toFixed(2)} s`,
          }),
        ]),
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Gehör' }),
          el('span', {
            class: `value ${stats.hearingFactor < 1 ? 'bad' : ''}`,
            text: `${Math.round(stats.hearingFactor * 100)} %`,
          }),
        ]),
      ]),
    );

    // --- grids -------------------------------------------------------------
    const sources: GridSource[] = [
      { id: 'stash', label: 'Lager', grid: this.profile.stash },
      { id: 'pockets', label: 'Taschen', grid: this.profile.loadout.pockets },
    ];
    for (const slot of ['rig', 'backpack', 'secure'] as EquipSlot[]) {
      const grid = this.profile.loadout.gridFor(slot);
      if (grid) sources.push({ id: slot, label: EQUIP_SLOT_LABEL[slot], grid });
    }
    this.inventoryView.render(sources);

    const gridPanel = el('div', { class: 'panel', style: { flex: '2' } }, [
      el('div', { class: 'panel-head' }, [el('span', { text: 'Lager und Ausrüstung' })]),
      el('div', { class: 'panel-body' }, [this.inventoryView.root]),
    ]);

    const detailPanel = el('div', { class: 'panel', style: { flex: '1.1', minWidth: '230px' } }, [
      el('div', { class: 'panel-head' }, [el('span', { text: 'Details' })]),
      this.detailPanel,
    ]);

    this.content.append(
      el('div', { class: 'panel', style: { flex: '1', minWidth: '220px' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Ausrüstungsplätze' })]),
        slotList,
      ]),
      gridPanel,
      detailPanel,
    );

    this.renderDetail();
  }

  private renderDetail(): void {
    clear(this.detailPanel);
    if (!this.selected) {
      this.detailPanel.appendChild(
        el('div', { class: 'empty-note', text: 'Gegenstand auswählen, um Werte und Aktionen zu sehen.' }),
      );
      return;
    }

    const { stack, source } = this.selected;
    const def = defOf(stack);
    const actions: { label: string; onTap: () => void; kind?: 'primary' | 'danger' | 'ghost' }[] = [];

    const isEquipped = source.id.startsWith('equip:');
    const equipSlot = isEquipped ? (source.id.split(':')[1] as EquipSlot) : null;

    if (isEquipped && equipSlot) {
      actions.push({
        label: 'Ablegen',
        onTap: () => {
          const removed = this.profile.loadout.unequip(equipSlot);
          if (removed && this.profile.stash.add(removed) > 0) {
            this.profile.loadout.equip(equipSlot, removed);
            this.actions.notify('Kein Platz im Lager', 'bad');
          }
          this.selected = null;
          this.refresh();
        },
      });
    } else {
      // Equip into every slot the item legitimately fits.
      for (const slot of EQUIP_SLOTS) {
        if (!this.profile.loadout.canEquip(slot, stack)) continue;
        actions.push({
          label: `→ ${EQUIP_SLOT_LABEL[slot]}`,
          kind: 'primary',
          onTap: () => this.equipFrom(source, stack, slot),
        });
      }
    }

    // Move between stash and carried containers.
    if (!isEquipped) {
      if (source.id === 'stash') {
        actions.push({
          label: 'Mitnehmen',
          onTap: () => {
            this.profile.stash.remove(stack.id);
            if (!this.profile.loadout.store(stack)) {
              this.profile.stash.add(stack);
              this.actions.notify('Kein Platz in der Ausrüstung', 'bad');
            }
            this.selected = null;
            this.refresh();
          },
        });
      } else {
        actions.push({
          label: 'Ins Lager',
          onTap: () => {
            source.grid.remove(stack.id);
            if (this.profile.stash.add(stack) > 0) {
              source.grid.add(stack);
              this.actions.notify('Lager voll', 'bad');
            }
            this.selected = null;
            this.refresh();
          },
        });
      }
    }

    // --- magazines ---------------------------------------------------------
    if (def.magazine) {
      const caliber = def.magazine.caliber;
      const ammoOptions = ItemDB.ofCategory('ammo').filter(
        (a) => a.ammo?.caliber === caliber && this.profile.stash.countOf(a.id) > 0,
      );
      for (const ammo of ammoOptions) {
        actions.push({
          label: `Laden: ${ammo.shortName}`,
          onTap: () => {
            const room = def.magazine!.capacity - (stack.rounds?.length ?? 0);
            const taken = this.profile.stash.consume(ammo.id, room);
            loadMagazine(stack, ammo.id, taken);
            this.refresh();
          },
        });
      }
      if ((stack.rounds?.length ?? 0) > 0) {
        actions.push({
          label: 'Entladen',
          kind: 'ghost',
          onTap: () => {
            const removed = unloadMagazine(stack);
            for (const [ammoId, count] of removed) {
              this.profile.stash.add(createStack(ammoId, count));
            }
            this.refresh();
          },
        });
      }
    }

    // --- weapon modification ------------------------------------------------
    if (def.weapon) {
      const resolved = resolveWeapon(stack, {
        gearErgoPenalty: this.profile.loadout.stats.ergonomicsPenalty,
        handlingSkill: this.profile.progression.factor('weaponHandling'),
        recoilSkill: this.profile.progression.factor('recoilControl'),
      });
      this.detailPanel.appendChild(
        el('div', { class: 'panel-head', style: { border: 'none', padding: '0 0 4px' } }, [
          el('span', { text: 'Aufgebaute Werte' }),
        ]),
      );
      const liveRows = el('div');
      const addLive = (label: string, value: string, cls = ''): void => {
        liveRows.appendChild(
          el('div', { class: 'stat-row' }, [
            el('span', { class: 'label', text: label }),
            el('span', { class: `value ${cls}`, text: value }),
          ]),
        );
      };
      addLive('Rückstoß vertikal', resolved.recoilVertical.toFixed(2));
      addLive('Streuung', `${resolved.accuracyMoa.toFixed(2)} MOA`);
      addLive('Anschlagzeit', `${resolved.adsTime.toFixed(2)} s`);
      addLive('Lautstärke', `${Math.round(resolved.loudness)}`, resolved.suppressed ? 'good' : '');
      addLive('Vergrößerung', `${resolved.zoom.toFixed(1)}x`);
      addLive('Magazin', `${resolved.magCapacity}`);
      if (resolved.jamChance > 0) {
        addLive('Hemmungsrisiko', `${(resolved.jamChance * 100).toFixed(1)} %`, 'bad');
      }
      this.detailPanel.appendChild(liveRows);

      // Fitted parts, each removable.
      for (const [slot, att] of Object.entries(stack.attachments ?? {})) {
        if (!att) continue;
        actions.push({
          label: `− ${defOf(att).shortName}`,
          kind: 'ghost',
          onTap: () => {
            const removed = detach(stack, slot as never);
            if (removed) this.profile.stash.add(removed);
            this.refresh();
          },
        });
      }
      // Compatible parts in the stash.
      for (const candidate of this.profile.stash.items()) {
        const cDef = defOf(candidate);
        if (cDef.category !== 'attachment') continue;
        if (!canAttach(stack, candidate)) continue;
        actions.push({
          label: `+ ${cDef.shortName}`,
          onTap: () => {
            this.profile.stash.remove(candidate.id);
            const displaced = attach(stack, candidate);
            if (displaced) this.profile.stash.add(displaced);
            this.refresh();
          },
        });
      }

      // Repair at the workshop.
      const ceiling = this.profile.hideout.repairCeiling;
      if (ceiling > 0 && (stack.durability ?? 100) < ceiling) {
        const cost = Math.round((ceiling - (stack.durability ?? 0)) * def.basePrice * 0.006);
        actions.push({
          label: `Reparieren (${money(cost)})`,
          onTap: () => {
            if (!this.profile.spend(cost)) {
              this.actions.notify('Nicht genug Geld', 'bad');
              return;
            }
            stack.durability = ceiling;
            this.actions.notify('Waffe instandgesetzt', 'good');
            this.refresh();
          },
        });
      }
    }

    // --- armour repair -------------------------------------------------------
    if (def.armor && this.profile.hideout.levelOf('workshop') >= 2) {
      const max = def.armor.maxDurability;
      if ((stack.durability ?? max) < max * 0.95) {
        const cost = Math.round((max - (stack.durability ?? 0)) * def.basePrice * 0.02);
        actions.push({
          label: `Panzerung instandsetzen (${money(cost)})`,
          onTap: () => {
            if (!this.profile.spend(cost)) {
              this.actions.notify('Nicht genug Geld', 'bad');
              return;
            }
            stack.durability = max * 0.95;
            this.refresh();
          },
        });
      }
    }

    // --- sell ---------------------------------------------------------------
    const buyer = this.profile.traders.bestBuyer(stack);
    if (buyer && !isEquipped) {
      actions.push({
        label: `Verkaufen: ${money(buyer.price)}`,
        kind: 'danger',
        onTap: () => {
          const price = this.profile.traders.sell(buyer.id, stack);
          source.grid.remove(stack.id);
          this.profile.earn(price);
          this.actions.notify(`Verkauft an ${TRADERS[buyer.id].name}: ${money(price)}`, 'good');
          this.selected = null;
          this.refresh();
        },
      });
    }

    this.detailPanel.appendChild(renderItemDetail(stack, actions));
  }

  private equipFrom(source: GridSource, stack: ItemStack, slot: EquipSlot): void {
    source.grid.remove(stack.id);
    const displaced = this.profile.loadout.equip(slot, stack);
    if (displaced && this.profile.stash.add(displaced) > 0) {
      // Nowhere to put the old item: undo cleanly rather than losing it.
      this.profile.loadout.equip(slot, displaced);
      source.grid.add(stack);
      this.actions.notify('Lager voll - Wechsel nicht möglich', 'bad');
    }
    this.selected = null;
    this.refresh();
  }

  // =========================================================================
  // Base
  // =========================================================================

  private renderBaseTab(): void {
    const list = el('div', { class: 'panel-body' });

    for (const id of Object.keys(HIDEOUT_MODULES) as ModuleId[]) {
      const def = HIDEOUT_MODULES[id];
      const state = this.profile.hideout.modules[id];
      const next = this.profile.hideout.nextLevelDef(id);
      const blocker = this.profile.hideout.upgradeBlocker(id, this.profile.money, (d, n) =>
        this.profile.hasMaterials(d, n),
      );

      const rows: HTMLElement[] = [
        el('div', { class: 'title', text: `${def.name}  ·  Stufe ${state.level}/${def.levels.length}` }),
        el('div', { class: 'sub', text: def.description }),
      ];

      if (state.buildRemaining > 0) {
        rows.push(
          el('div', { class: 'sub', style: { color: '#c8913a' }, text: `Ausbau läuft: noch ${duration(state.buildRemaining)}` }),
          bar(1 - state.buildRemaining / Math.max(1, def.levels[state.buildingLevel - 1]?.buildSeconds ?? 1), '#c8913a'),
        );
      } else if (next) {
        rows.push(el('div', { class: 'sub', style: { color: '#8b95a3' }, text: next.effect }));
        const costText = next.cost
          .map((c) => {
            const have = this.profile.stash.countOf(c.defId);
            return `${ItemDB.get(c.defId).shortName} ${have}/${c.count}`;
          })
          .join('  ·  ');
        rows.push(
          el('div', { class: 'sub', text: `${money(next.money)}  ·  ${costText}  ·  ${duration(next.buildSeconds)}` }),
        );
      } else {
        rows.push(el('div', { class: 'sub', style: { color: '#4f9e6a' }, text: 'Vollständig ausgebaut' }));
      }

      const row = el('div', { class: 'list-row' }, [
        el('div', { class: 'grow' }, rows),
        next && state.buildRemaining <= 0
          ? button(
              blocker ?? 'Ausbauen',
              () => {
                const error = this.profile.startUpgrade(id);
                if (error) this.actions.notify(error, 'bad');
                else {
                  this.actions.notify(`${def.name}: Ausbau gestartet`, 'good');
                  this.actions.onSave();
                }
                this.renderContent();
              },
              `btn small ${blocker ? 'ghost' : 'primary'}`,
              blocker ? { disabled: 'true' } : {},
            )
          : null,
      ].filter(Boolean) as HTMLElement[]);

      list.appendChild(row);
    }

    // --- character sheet ----------------------------------------------------
    const skills = el('div', { class: 'panel-body' });
    const p = this.profile.progression;
    skills.appendChild(
      el('div', { style: { marginBottom: '10px' } }, [
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Stufe' }),
          el('span', { class: 'value', text: String(p.level) }),
        ]),
        bar(p.levelProgress, '#c8913a', `${Math.round(p.levelProgress * 100)} % zur nächsten Stufe`),
      ]),
    );
    for (const id of Object.keys(SKILLS) as SkillId[]) {
      const skill = SKILLS[id];
      const state = p.skills[id];
      skills.appendChild(
        el('div', { style: { marginBottom: '8px' } }, [
          el('div', { class: 'stat-row' }, [
            el('span', { class: 'label', text: skill.name }),
            el('span', { class: 'value', text: `${state.level} / ${MAX_SKILL_LEVEL}` }),
          ]),
          bar(state.level / MAX_SKILL_LEVEL, '#4f7d9e'),
          el('div', { class: 'sub', style: { fontSize: '11px', color: '#5b6472' }, text: skill.description }),
        ]),
      );
    }

    this.content.append(
      el('div', { class: 'panel', style: { flex: '1.4' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Module' })]),
        list,
      ]),
      el('div', { class: 'panel', style: { flex: '1' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Operator' })]),
        skills,
      ]),
    );
  }

  // =========================================================================
  // Crafting
  // =========================================================================

  private renderCraftTab(): void {
    const list = el('div', { class: 'panel-body' });
    const running = el('div', { class: 'panel-body' });

    for (const job of this.profile.crafting.jobs) {
      const recipe = RECIPES.find((r) => r.id === job.recipeId);
      running.appendChild(
        el('div', { class: 'list-row' }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'title', text: recipe?.name ?? job.recipeId }),
            el('div', { class: 'sub', text: `noch ${duration(job.secondsRemaining)}` }),
            bar(1 - job.secondsRemaining / job.totalSeconds, '#4f9e6a'),
          ]),
          button('Abbrechen', () => {
            this.profile.crafting.cancel(job.module);
            this.renderContent();
          }, 'btn small ghost'),
        ]),
      );
    }
    if (this.profile.crafting.jobs.length === 0) {
      running.appendChild(el('div', { class: 'empty-note', text: 'Keine laufende Produktion.' }));
    }

    let anyAvailable = false;
    for (const recipe of RECIPES) {
      const moduleLevel = this.profile.hideout.levelOf(recipe.module);
      if (moduleLevel < recipe.moduleLevel) continue;
      anyAvailable = true;
      const blocker = this.profile.crafting.blocker(recipe, moduleLevel, this.profile.money, (d, n) =>
        this.profile.hasMaterials(d, n),
      );
      const inputText = recipe.inputs
        .map((i) => `${ItemDB.get(i.defId).shortName} ${this.profile.stash.countOf(i.defId)}/${i.count}`)
        .join('  ·  ');
      const output = ItemDB.get(recipe.output.defId);

      list.appendChild(
        el('div', { class: 'list-row' }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'title', text: recipe.name }),
            el('div', { class: 'sub', text: `→ ${output.name} x${recipe.output.count}  ·  ${duration(recipe.seconds)}` }),
            el('div', { class: 'sub', text: inputText + (recipe.money ? `  ·  ${money(recipe.money)}` : '') }),
          ]),
          button(
            blocker ?? 'Starten',
            () => {
              const error = this.profile.startCraft(recipe.id);
              if (error) this.actions.notify(error, 'bad');
              else this.actions.notify(`${recipe.name} gestartet`, 'good');
              this.renderContent();
            },
            `btn small ${blocker ? 'ghost' : 'primary'}`,
            blocker ? { disabled: 'true' } : {},
          ),
        ]),
      );
    }
    if (!anyAvailable) {
      list.appendChild(
        el('div', {
          class: 'empty-note',
          text: 'Keine Rezepte verfügbar. Baue Werkstatt oder Medizinstation aus.',
        }),
      );
    }

    this.content.append(
      el('div', { class: 'panel', style: { flex: '1.6' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Rezepte' })]),
        list,
      ]),
      el('div', { class: 'panel', style: { flex: '1' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Laufende Produktion' })]),
        running,
      ]),
    );
  }

  // =========================================================================
  // Traders
  // =========================================================================

  private renderTradersTab(): void {
    const traderList = el('div', { class: 'panel-body' });
    for (const id of Object.keys(TRADERS) as TraderId[]) {
      const def = TRADERS[id];
      const state = this.profile.traders.states[id];
      const tier = this.profile.traders.tierFor(id);
      const row = el('div', { class: `list-row clickable${id === this.selectedTrader ? ' selected' : ''}` }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title', text: def.name, style: { color: def.color } }),
          el('div', { class: 'sub', text: `${def.role} · Rang ${tier + 1} · Ruf ${state.reputation}` }),
        ]),
      ]);
      row.style.borderColor = id === this.selectedTrader ? def.color : '';
      row.addEventListener('click', () => {
        this.selectedTrader = id;
        this.renderContent();
      });
      traderList.appendChild(row);
    }

    const def = TRADERS[this.selectedTrader];
    const state = this.profile.traders.states[this.selectedTrader];

    const stock = el('div', { class: 'panel-body' });
    stock.appendChild(
      el('div', { class: 'sub', style: { fontStyle: 'italic', marginBottom: '10px', color: '#8b95a3' }, text: `"${def.greeting}"` }),
    );
    if (state.offers.length === 0) {
      stock.appendChild(el('div', { class: 'empty-note', text: 'Bestand erschöpft. Kommt später wieder.' }));
    }
    state.offers.forEach((offer, index) => {
      const itemDef = defOf(offer.stack);
      const affordable = this.profile.money >= offer.price;
      stock.appendChild(
        tradeRow({
          title: itemDef.name,
          titleColor: RARITY_COLOR[itemDef.rarity],
          detail: itemDef.description,
          note: `Bestand: ${offer.quantity}`,
          price: money(offer.price),
          actionLabel: 'Kaufen',
          actionClass: `btn small ${affordable ? 'primary' : 'ghost'}`,
          disabled: !affordable,
          onAction: () => {
            if (!affordable) {
              this.actions.notify('Nicht genug Geld', 'bad');
              return;
            }
            const bought = this.profile.traders.buy(this.selectedTrader, index);
            if (!bought) return;
            if (this.profile.stash.add(bought) > 0) {
              this.actions.notify('Lager voll', 'bad');
              return;
            }
            this.profile.spend(offer.price);
            this.actions.notify(`Gekauft: ${itemDef.name}`, 'good');
            this.actions.onSave();
            this.renderContent();
          },
        }),
      );
    });

    // --- bulk sell ----------------------------------------------------------
    const sellPanel = el('div', { class: 'panel-body' });
    const sellable = this.profile.stash.items().filter((s) => this.profile.traders.sellPrice(this.selectedTrader, s) > 0);
    if (sellable.length === 0) {
      sellPanel.appendChild(el('div', { class: 'empty-note', text: `${def.name} kauft nichts aus deinem Lager.` }));
    } else {
      const total = sellable.reduce((sum, s) => sum + this.profile.traders.sellPrice(this.selectedTrader, s), 0);
      sellPanel.appendChild(
        button(
          `Alles verkaufen (${money(total)})`,
          () => {
            let earned = 0;
            for (const stack of [...sellable]) {
              earned += this.profile.traders.sell(this.selectedTrader, stack);
              this.profile.stash.remove(stack.id);
            }
            this.profile.earn(earned);
            this.actions.notify(`Verkauft für ${money(earned)}`, 'good');
            this.actions.onSave();
            this.renderContent();
          },
          'btn primary',
          { style: { width: '100%', marginBottom: '8px' } as never },
        ),
      );
      for (const stack of sellable) {
        const price = this.profile.traders.sellPrice(this.selectedTrader, stack);
        const itemDef = defOf(stack);
        sellPanel.appendChild(
          tradeRow({
            title: `${itemDef.name}${stack.count > 1 ? ` x${stack.count}` : ''}`,
            price: money(price),
            actionLabel: 'Verkaufen',
            actionClass: 'btn small',
            onAction: () => {
              this.profile.stash.remove(stack.id);
              this.profile.earn(this.profile.traders.sell(this.selectedTrader, stack));
              this.actions.onSave();
              this.renderContent();
            },
          }),
        );
      }
    }

    this.content.append(
      el('div', { class: 'panel', style: { flex: '0.9', minWidth: '190px' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Kontakte' })]),
        traderList,
      ]),
      el('div', { class: 'panel', style: { flex: '1.5' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: `Angebot · ${def.name}` })]),
        stock,
      ]),
      el('div', { class: 'panel', style: { flex: '1.1' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Verkaufen' })]),
        sellPanel,
      ]),
    );
  }

  // =========================================================================
  // Quests
  // =========================================================================

  private renderQuestsTab(): void {
    this.profile.quests.refreshAvailability(this.profile.progression.level);
    const list = el('div', { class: 'panel-body' });

    for (const quest of QUESTS) {
      const state = this.profile.quests.states.get(quest.id)!;
      const trader = TRADERS[quest.trader];
      const rows: HTMLElement[] = [
        el('div', { class: 'title', text: quest.title }),
        el('div', { class: 'sub', text: `${trader.name} · Stufe ${quest.requiredLevel}` }),
      ];

      if (state.status === 'active') {
        rows.push(el('div', { class: 'sub', style: { color: '#8b95a3', marginTop: '4px' }, text: quest.brief }));
        for (const objective of quest.objectives) {
          const progress = state.progress[objective.id] ?? 0;
          const done = progress >= objective.target;
          rows.push(
            el('div', {
              class: 'sub',
              style: { color: done ? '#4f9e6a' : '#d6dce4' },
              text: `${done ? '✓' : '•'} ${objective.description}: ${progress} / ${objective.target}`,
            }),
          );
        }
      } else if (state.status === 'complete') {
        rows.push(el('div', { class: 'sub', style: { color: '#4f9e6a' }, text: 'Abgeschlossen' }));
      } else if (state.status === 'available') {
        rows.push(el('div', { class: 'sub', style: { color: '#8b95a3', marginTop: '4px' }, text: quest.brief }));
      } else {
        const missing = quest.requires.filter((r) => this.profile.quests.states.get(r)?.status !== 'complete');
        rows.push(
          el('div', {
            class: 'sub',
            style: { color: '#5b6472' },
            text: missing.length > 0 ? 'Vorheriger Auftrag noch offen' : `Erfordert Stufe ${quest.requiredLevel}`,
          }),
        );
      }

      rows.push(
        el('div', { class: 'sub', style: { color: '#c8913a', marginTop: '4px' } , text:
          `Belohnung: ${quest.rewards.xp} EP · ${money(quest.rewards.money)} · ${quest.rewards.reputation} Ruf` +
          (quest.rewards.items?.length ? ` · ${quest.rewards.items.map((i) => ItemDB.get(i.defId).shortName).join(', ')}` : ''),
        }),
      );

      let action: HTMLElement | null = null;
      if (state.status === 'available') {
        action = button('Annehmen', () => {
          this.profile.quests.accept(quest.id);
          this.actions.notify(`Auftrag angenommen: ${quest.title}`, 'good');
          this.actions.onSave();
          this.renderContent();
        }, 'btn small primary');
      } else if (state.status === 'active' && this.profile.quests.isComplete(quest.id)) {
        action = button('Abschließen', () => this.turnInQuest(quest.id), 'btn small primary');
      } else if (state.status === 'active') {
        const handovers = quest.objectives.filter((o) => o.kind === 'handover');
        // Handover objectives are fulfilled from the stash right here.
        if (handovers.length > 0) {
          action = button('Abgeben', () => this.deliverHandovers(quest.id), 'btn small');
        }
      }

      list.appendChild(
        el('div', { class: `list-row${state.status === 'locked' ? ' locked' : ''}` }, [
          el('div', { class: 'grow' }, rows),
          action,
        ].filter(Boolean) as HTMLElement[]),
      );
    }

    this.content.append(
      el('div', { class: 'panel', style: { flex: '1' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Aufträge' })]),
        list,
      ]),
    );
  }

  private deliverHandovers(questId: string): void {
    const quest = QUESTS.find((q) => q.id === questId);
    const state = this.profile.quests.states.get(questId);
    if (!quest || !state) return;
    let delivered = 0;
    for (const objective of quest.objectives) {
      if (objective.kind !== 'handover' || !objective.param) continue;
      const need = objective.target - (state.progress[objective.id] ?? 0);
      if (need <= 0) continue;
      const taken = this.profile.stash.consume(objective.param, need);
      if (taken > 0) {
        this.profile.quests.advance('handover', taken, objective.param);
        delivered += taken;
      }
    }
    if (delivered === 0) this.actions.notify('Nichts zum Abgeben im Lager', 'bad');
    else {
      this.actions.notify(`${delivered} Gegenstände abgegeben`, 'good');
      this.actions.onSave();
    }
    this.renderContent();
  }

  private turnInQuest(questId: string): void {
    const quest = this.profile.quests.turnIn(questId);
    if (!quest) return;
    this.profile.progression.addXp(quest.rewards.xp, `Auftrag: ${quest.title}`);
    this.profile.earn(quest.rewards.money);
    this.profile.traders.states[quest.trader].reputation += quest.rewards.reputation;
    for (const reward of quest.rewards.items ?? []) {
      this.profile.stash.add(createStack(reward.defId, reward.count));
    }
    this.profile.quests.refreshAvailability(this.profile.progression.level);
    this.actions.notify(`Auftrag abgeschlossen: ${quest.title}`, 'good');
    this.actions.onSave();
    this.renderContent();
  }

  // =========================================================================
  // Insurance
  // =========================================================================

  private renderInsuranceTab(): void {
    const list = el('div', { class: 'panel-body' });
    const items = this.profile.loadout.losableItems();

    list.appendChild(
      el('div', {
        class: 'sub',
        style: { marginBottom: '10px', color: '#8b95a3', lineHeight: '1.5' },
        text:
          'Versicherte Ausrüstung kann nach einem gescheiterten Einsatz zurückkommen - nicht sofort und ' +
          'nicht garantiert. Je wertvoller der Gegenstand, desto geringer die Rückgabequote. ' +
          'Wer lebend zurückkehrt, hat die Prämie umsonst gezahlt.',
      }),
    );

    if (items.length === 0) {
      list.appendChild(el('div', { class: 'empty-note', text: 'Keine Ausrüstung angelegt.' }));
    }

    const uninsured = items.filter((s) => !this.profile.insurance.isInsured(s.id));
    if (uninsured.length > 0) {
      const total = this.profile.insurance.premiumForAll(uninsured);
      list.appendChild(
        button(
          `Alles versichern (${money(total)})`,
          () => {
            if (!this.profile.spend(total)) {
              this.actions.notify('Nicht genug Geld', 'bad');
              return;
            }
            for (const stack of uninsured) {
              this.profile.insurance.insure(stack, this.profile.hideout.insuranceSpeed);
            }
            this.actions.notify(`${uninsured.length} Gegenstände versichert`, 'good');
            this.actions.onSave();
            this.renderContent();
          },
          'btn primary',
          { style: { width: '100%', marginBottom: '8px' } as never },
        ),
      );
    }

    for (const stack of items) {
      const def = defOf(stack);
      const insured = this.profile.insurance.isInsured(stack.id);
      const premium = this.profile.insurance.premiumFor(stack);
      list.appendChild(
        el('div', { class: 'list-row' }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'title', text: def.name, style: { color: RARITY_COLOR[def.rarity] } }),
            el('div', { class: 'sub', text: `Wert ${money(stackValue(stack))}` }),
          ]),
          insured
            ? el('span', { class: 'tag', style: { borderColor: '#4f9e6a', color: '#4f9e6a' }, text: 'Versichert' })
            : button(
                `Versichern ${money(premium)}`,
                () => {
                  if (!this.profile.spend(premium)) {
                    this.actions.notify('Nicht genug Geld', 'bad');
                    return;
                  }
                  this.profile.insurance.insure(stack, this.profile.hideout.insuranceSpeed);
                  this.actions.onSave();
                  this.renderContent();
                },
                'btn small',
              ),
        ]),
      );
    }

    // --- returning items ----------------------------------------------------
    const transit = el('div', { class: 'panel-body' });
    const inTransit = this.profile.insurance.inTransit;
    const pending = this.profile.insurance.pending;

    if (pending.length > 0) {
      transit.appendChild(
        button(
          `${pending.length} Gegenstände abholen`,
          () => {
            const collected = this.profile.collectInsurance();
            this.actions.notify(`${collected} Gegenstände ins Lager übernommen`, 'good');
            this.actions.onSave();
            this.renderContent();
          },
          'btn primary',
          { style: { width: '100%', marginBottom: '8px' } as never },
        ),
      );
    }

    for (const entry of inTransit) {
      const def = ItemDB.tryGet(entry.snapshot.defId);
      if (!def) continue;
      transit.appendChild(
        el('div', { class: 'list-row' }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'title', text: def.name }),
            el('div', { class: 'sub', text: `Eintrifft in ${duration(entry.returnIn)}` }),
          ]),
        ]),
      );
    }
    if (inTransit.length === 0 && pending.length === 0) {
      transit.appendChild(el('div', { class: 'empty-note', text: 'Keine Rücksendungen unterwegs.' }));
    }

    this.content.append(
      el('div', { class: 'panel', style: { flex: '1.4' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Deckung für den nächsten Einsatz' })]),
        list,
      ]),
      el('div', { class: 'panel', style: { flex: '1' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Rücksendungen' })]),
        transit,
      ]),
    );
  }
}
