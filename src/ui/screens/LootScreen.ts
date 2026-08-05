import { button, clear, el, money, weight as fmtWeight } from '../Dom';
import { InventoryView, renderItemDetail, type GridSource } from '../InventoryView';
import { screenShell, type Screen } from '../ScreenManager';
import type { RaidSession } from '../../raid/RaidSession';
import { EQUIP_SLOTS, EQUIP_SLOT_LABEL } from '../../inventory/Inventory';
import type { EquipSlot } from '../../data/ItemTypes';
import { RARITY_COLOR } from '../../data/ItemTypes';
import { defOf, stackValue, type ItemStack } from '../../inventory/ItemStack';

/**
 * LootScreen - the in-raid inventory, used both for looting a container and
 * for managing your own kit mid-raid.
 *
 * This screen is the pressure point of the whole game: the raid clock keeps
 * running while it is open and the world keeps simulating behind it. That is
 * deliberate. Standing in a warehouse deciding whether the rifle is worth
 * dropping the medical kit is *supposed* to be dangerous, so the header keeps
 * the clock and the carried weight visible at all times.
 */
export class LootScreen implements Screen {
  readonly id = 'loot';
  readonly root: HTMLElement;

  private body: HTMLElement;
  private subtitleEl: HTMLElement;
  private view: InventoryView;
  private detailPanel: HTMLElement;
  private selected: { stack: ItemStack; source: GridSource } | null = null;
  private session: RaidSession | null = null;

  constructor(
    private readonly actions: {
      onClose: () => void;
      notify: (text: string, tone: 'info' | 'good' | 'bad' | 'warn') => void;
    },
  ) {
    const shell = screenShell('Inventar', '', () => this.actions.onClose());
    this.root = shell.root;
    this.body = shell.body;
    this.subtitleEl = shell.subtitleEl;

    this.view = new InventoryView((stack, source) => {
      this.selected = stack && source ? { stack, source } : null;
      this.renderDetail();
    });
    this.detailPanel = el('div', { class: 'panel-body' });
  }

  bind(session: RaidSession): void {
    this.session = session;
  }

  onShow(): void {
    this.selected = null;
    this.render();
  }

  onHide(): void {
    this.session?.closeContainer();
  }

  onTick(): void {
    this.updateSubtitle();
  }

  onBack(): boolean {
    this.actions.onClose();
    return true;
  }

  private updateSubtitle(): void {
    const session = this.session;
    if (!session) return;
    const player = session.player;
    const minutes = Math.floor(session.timeLeft / 60);
    const seconds = Math.floor(session.timeLeft % 60);
    this.subtitleEl.textContent =
      `Verbleibend ${minutes}:${String(seconds).padStart(2, '0')}  ·  ` +
      `Last ${fmtWeight(player.carriedWeight)}  ·  ` +
      `Kontakte ${session.ai.engagedCount}`;
    this.subtitleEl.style.color = session.ai.engagedCount > 0 ? 'var(--bad)' : 'var(--text-dim)';
  }

  render(): void {
    const session = this.session;
    if (!session) return;
    clear(this.body);
    this.updateSubtitle();

    // --- container being searched (if any) ---------------------------------
    const container = session.openContainer;
    const containerSources: GridSource[] = container
      ? [{ id: 'container', label: container.name, grid: container.grid }]
      : [];

    // --- the player's own kit -----------------------------------------------
    const playerSources: GridSource[] = [
      { id: 'pockets', label: 'Taschen', grid: session.player.inventory.pockets },
    ];
    for (const slot of ['rig', 'backpack', 'secure'] as EquipSlot[]) {
      const grid = session.player.inventory.gridFor(slot);
      if (grid) playerSources.push({ id: slot, label: EQUIP_SLOT_LABEL[slot], grid });
    }

    this.view.render([...containerSources, ...playerSources]);

    // Equipment slots as a compact list so the player can see what they have on.
    const equipList = el('div', { class: 'panel-body' });
    for (const slot of EQUIP_SLOTS) {
      const stack = session.player.inventory.equipped[slot];
      const row = el('div', { class: 'list-row clickable' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'sub', text: EQUIP_SLOT_LABEL[slot] }),
          el('div', {
            class: 'title',
            text: stack ? defOf(stack).name : '— leer —',
            style: { color: stack ? RARITY_COLOR[defOf(stack).rarity] : 'var(--text-faint)' },
          }),
        ]),
      ]);
      if (stack) {
        row.addEventListener('click', () => {
          this.selected = {
            stack,
            source: { id: `equip:${slot}`, label: EQUIP_SLOT_LABEL[slot], grid: session.player.inventory.pockets },
          };
          this.renderDetail();
        });
      }
      equipList.appendChild(row);
    }

    const takeAllBtn = container
      ? button(
          'Alles nehmen',
          () => {
            let taken = 0;
            for (const stack of [...container.grid.items()]) {
              if (session.takeItem(stack.id)) taken++;
              else break;
            }
            this.actions.notify(taken > 0 ? `${taken} Gegenstände genommen` : 'Kein Platz', taken > 0 ? 'good' : 'bad');
            this.render();
          },
          'btn small primary',
        )
      : null;

    this.body.append(
      el('div', { class: 'panel', style: { flex: '1', minWidth: '200px' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Angelegt' })]),
        equipList,
      ]),
      el('div', { class: 'panel', style: { flex: '2.2' } }, [
        el('div', { class: 'panel-head' }, [
          el('span', { text: container ? `Behälter: ${container.name}` : 'Ausrüstung' }),
          el('span', { style: { flex: '1' } }),
          takeAllBtn,
        ].filter(Boolean) as HTMLElement[]),
        el('div', { class: 'panel-body' }, [this.view.root]),
      ]),
      el('div', { class: 'panel', style: { flex: '1.1', minWidth: '220px' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Details' })]),
        this.detailPanel,
      ]),
    );

    this.renderDetail();
  }

  private renderDetail(): void {
    clear(this.detailPanel);
    const session = this.session;
    if (!this.selected || !session) {
      this.detailPanel.appendChild(
        el('div', { class: 'empty-note', text: 'Gegenstand auswählen.' }),
      );
      return;
    }

    const { stack, source } = this.selected;
    const def = defOf(stack);
    const actions: { label: string; onTap: () => void; kind?: 'primary' | 'danger' | 'ghost' }[] = [];

    const isEquipped = source.id.startsWith('equip:');
    const equipSlot = isEquipped ? (source.id.split(':')[1] as EquipSlot) : null;
    const fromContainer = source.id === 'container';

    if (fromContainer) {
      actions.push({
        label: 'Nehmen',
        kind: 'primary',
        onTap: () => {
          if (session.takeItem(stack.id)) {
            this.selected = null;
            this.render();
          }
        },
      });
    } else if (session.openContainer && !isEquipped) {
      actions.push({
        label: 'Ablegen',
        onTap: () => {
          session.storeItem(stack.id);
          this.selected = null;
          this.render();
        },
      });
    }

    // Equipping mid-raid is how a found rifle actually becomes useful.
    if (!isEquipped) {
      for (const slot of EQUIP_SLOTS) {
        if (!session.player.inventory.canEquip(slot, stack)) continue;
        actions.push({
          label: `Anlegen: ${EQUIP_SLOT_LABEL[slot]}`,
          onTap: () => {
            source.grid.remove(stack.id);
            const displaced = session.player.inventory.equip(slot, stack);
            if (displaced && !session.player.inventory.store(displaced)) {
              // No room for the old piece - it goes on the ground, which is a
              // real cost rather than a silent deletion.
              session.loot.createCorpse(session.player.x, session.player.y, 'Abgelegte Ausrüstung', [displaced]);
              this.actions.notify('Alte Ausrüstung fallen gelassen', 'warn');
            }
            // Re-arm the weapon controller if we changed what is in our hands.
            if (slot === session.activeWeaponSlot) {
              session.swapWeapon();
              session.swapWeapon();
            }
            this.selected = null;
            this.render();
          },
        });
      }
    } else if (equipSlot) {
      actions.push({
        label: 'Ablegen',
        onTap: () => {
          const removed = session.player.inventory.unequip(equipSlot);
          if (removed && !session.player.inventory.store(removed)) {
            session.player.inventory.equip(equipSlot, removed);
            this.actions.notify('Kein Platz', 'bad');
          }
          this.selected = null;
          this.render();
        },
      });
    }

    // Secure container: the one place worth putting the good stuff.
    const secure = session.player.inventory.gridFor('secure');
    if (secure && !fromContainer && source.id !== 'secure' && !isEquipped) {
      actions.push({
        label: 'In den Sicherheitsbehälter',
        kind: 'primary',
        onTap: () => {
          source.grid.remove(stack.id);
          if (!session.player.inventory.storeSecure(stack)) {
            source.grid.add(stack);
            this.actions.notify('Sicherheitsbehälter voll', 'bad');
          } else {
            this.actions.notify('Gesichert - überlebt deinen Tod', 'good');
          }
          this.selected = null;
          this.render();
        },
      });
    }

    if (def.med) {
      actions.push({
        label: 'Anwenden',
        onTap: () => {
          if (session.useMedical(stack.id)) this.actions.onClose();
        },
      });
    }

    if (!fromContainer && !isEquipped) {
      actions.push({
        label: 'Fallen lassen',
        kind: 'danger',
        onTap: () => {
          session.dropItem(stack.id);
          this.selected = null;
          this.render();
        },
      });
    }

    this.detailPanel.appendChild(
      el('div', { class: 'stat-row', style: { marginBottom: '6px' } }, [
        el('span', { class: 'label', text: 'Händlerwert' }),
        el('span', { class: 'value', text: money(stackValue(stack)) }),
      ]),
    );
    this.detailPanel.appendChild(renderItemDetail(stack, actions));
  }
}
