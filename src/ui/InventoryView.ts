import { clear, el } from './Dom';
import { ItemDB } from '../data/ItemDatabase';
import { RARITY_COLOR } from '../data/ItemTypes';
import type { GridContainer } from '../inventory/GridContainer';
import { conditionLabel, stackSize, type ItemStack } from '../inventory/ItemStack';

/**
 * InventoryView - renders a GridContainer as an interactive grid.
 *
 * Interaction is **tap to select, then act**, not drag and drop. On a phone,
 * dragging a 1x1 item into a 1x1 gap while under time pressure is miserable;
 * selecting an item and pressing "Nehmen" is fast, unambiguous and works with
 * one thumb. Placement is handled automatically by the container's packing.
 *
 * The grid itself is a CSS grid of empty cells with items positioned on top by
 * grid line, so an item's footprint on screen is exactly its footprint in the
 * simulation - the spatial cost of a rifle is visible, which is the point.
 */

export interface GridSource {
  /** Stable identifier used to route actions. */
  id: string;
  label: string;
  grid: GridContainer;
}

export type SelectionHandler = (stack: ItemStack | null, source: GridSource | null) => void;

export class InventoryView {
  readonly root: HTMLElement;
  private onSelect: SelectionHandler;
  private selectedId: number | null = null;
  private sources: GridSource[] = [];
  /** Cell size in px; shrinks on short viewports. */
  private cellSize = 38;

  constructor(onSelect: SelectionHandler) {
    this.root = el('div', { class: 'inv-view' });
    this.onSelect = onSelect;
  }

  get selectedStackId(): number | null {
    return this.selectedId;
  }

  setSelected(stackId: number | null): void {
    this.selectedId = stackId;
    this.refreshSelection();
  }

  /** Re-render every grid from scratch. Cheap enough at these element counts. */
  render(sources: GridSource[]): void {
    this.sources = sources;
    this.cellSize = window.innerHeight < 440 ? 32 : 38;
    clear(this.root);

    for (const source of sources) {
      const usage = `${source.grid.usedCells}/${source.grid.totalCells}`;
      this.root.appendChild(
        el('div', { class: 'panel-head', style: { border: 'none', padding: '6px 0 4px' } }, [
          el('span', { text: source.label }),
          el('span', { class: 'spacer', style: { flex: '1' } }),
          el('span', { style: { color: 'var(--text-faint)' }, text: usage }),
        ]),
      );
      this.root.appendChild(this.renderGrid(source));
    }
  }

  private renderGrid(source: GridSource): HTMLElement {
    const grid = source.grid;
    const size = this.cellSize;
    const node = el('div', {
      class: 'inv-grid',
      style: {
        gridTemplateColumns: `repeat(${grid.width}, ${size}px)`,
        gridTemplateRows: `repeat(${grid.height}, ${size}px)`,
        marginBottom: '10px',
      },
    });

    // Background cells give the grid its readable structure.
    for (let i = 0; i < grid.width * grid.height; i++) {
      node.appendChild(
        el('div', {
          class: 'inv-cell',
          style: {
            width: `${size}px`,
            height: `${size}px`,
            gridColumn: String((i % grid.width) + 1),
            gridRow: String(Math.floor(i / grid.width) + 1),
          },
        }),
      );
    }

    for (const slot of grid.slots) {
      node.appendChild(this.renderItem(slot.stack, slot.x, slot.y, slot.rotated, source));
    }
    return node;
  }

  private renderItem(
    stack: ItemStack,
    x: number,
    y: number,
    rotated: boolean,
    source: GridSource,
  ): HTMLElement {
    const def = ItemDB.get(stack.defId);
    const { w, h } = stackSize(stack, rotated);

    const node = el('div', {
      class: `inv-item${stack.id === this.selectedId ? ' selected' : ''}${stack.fresh ? ' fresh' : ''}`,
      style: {
        gridColumn: `${x + 1} / span ${w}`,
        gridRow: `${y + 1} / span ${h}`,
      },
      dataset: { stackId: String(stack.id) },
      title: def.name,
    });

    node.appendChild(
      el('div', { class: 'rarity-strip', style: { background: RARITY_COLOR[def.rarity] } }),
    );
    node.appendChild(el('div', { class: 'name', text: def.shortName }));

    // Ammunition and stackables show their count; everything else shows the
    // single most decision-relevant number for its type.
    const badge = this.badgeFor(stack, def.id);
    if (badge) node.appendChild(el('div', { class: 'count', text: badge }));

    if (def.hasDurability && stack.durability !== undefined) {
      const max = def.armor ? def.armor.maxDurability : 100;
      const fraction = Math.max(0, Math.min(1, stack.durability / max));
      node.appendChild(
        el('div', {
          class: 'cond-strip',
          style: {
            width: `${fraction * 100}%`,
            background: fraction > 0.6 ? 'var(--good)' : fraction > 0.3 ? 'var(--accent)' : 'var(--bad)',
          },
        }),
      );
    }

    node.addEventListener('click', (e) => {
      e.stopPropagation();
      const already = this.selectedId === stack.id;
      this.selectedId = already ? null : stack.id;
      this.refreshSelection();
      this.onSelect(already ? null : stack, already ? null : source);
    });

    return node;
  }

  /** The one number that matters for this item type. */
  private badgeFor(stack: ItemStack, defId: string): string | null {
    const def = ItemDB.get(defId);
    if (def.stackable && stack.count > 1) return `x${stack.count}`;
    if (def.magazine) return `${stack.rounds?.length ?? 0}/${def.magazine.capacity}`;
    if (def.weapon) {
      const loaded = (stack.magazine?.rounds?.length ?? 0) + (stack.chamber ? 1 : 0);
      return String(loaded);
    }
    if (def.med && stack.charges !== undefined && def.med.maxCharges > 1) return String(stack.charges);
    return null;
  }

  private refreshSelection(): void {
    for (const node of Array.from(this.root.querySelectorAll('.inv-item'))) {
      const id = Number((node as HTMLElement).dataset.stackId);
      node.classList.toggle('selected', id === this.selectedId);
    }
  }

  /** Locate a selected stack and the grid it lives in. */
  find(stackId: number): { stack: ItemStack; source: GridSource } | null {
    for (const source of this.sources) {
      const slot = source.grid.find(stackId);
      if (slot) return { stack: slot.stack, source };
    }
    return null;
  }
}

/**
 * Detail panel for a selected item.
 *
 * Shows the stats that actually change an outcome. For ammunition that is
 * penetration and damage; for armour it is class and remaining durability; for
 * a weapon it is the resolved handling numbers *including* fitted parts, so
 * the effect of a modification is visible before committing to it.
 */
export function renderItemDetail(
  stack: ItemStack,
  actions: { label: string; onTap: () => void; kind?: 'primary' | 'danger' | 'ghost' }[],
): HTMLElement {
  const def = ItemDB.get(stack.defId);
  const rows: HTMLElement[] = [];

  const addRow = (label: string, value: string, cls = ''): void => {
    rows.push(
      el('div', { class: 'stat-row' }, [
        el('span', { class: 'label', text: label }),
        el('span', { class: `value ${cls}`, text: value }),
      ]),
    );
  };

  addRow('Gewicht', `${def.weight.toFixed(2)} kg`);
  addRow('Größe', `${def.width} x ${def.height}`);

  const condition = conditionLabel(stack);
  if (condition && stack.durability !== undefined) {
    const max = def.armor ? def.armor.maxDurability : 100;
    addRow('Zustand', `${condition} (${Math.round((stack.durability / max) * 100)} %)`);
  }

  if (def.ammo) {
    const a = def.ammo;
    addRow('Schaden', String(a.damage));
    addRow('Durchschlag', String(a.penetration), a.penetration > 40 ? 'good' : '');
    addRow('Panzerschaden', `${a.armorDamage} %`);
    addRow('Fragmentierung', `${Math.round(a.fragmentation * 100)} %`);
    addRow('Mündungsgeschwindigkeit', `${a.muzzleVelocity} m/s`);
    if (a.projectiles > 1) addRow('Geschosse', String(a.projectiles));
  }

  if (def.weapon) {
    const w = def.weapon;
    addRow('Kaliber', w.caliber);
    addRow('Kadenz', `${w.rpm} /min`);
    addRow('Rückstoß vertikal', w.recoilVertical.toFixed(2));
    addRow('Rückstoß horizontal', w.recoilHorizontal.toFixed(2));
    addRow('Präzision', `${w.accuracyMoa.toFixed(1)} MOA`);
    addRow('Anschlagzeit', `${w.ergonomics.toFixed(2)} s`);
    addRow('Feuermodi', w.fireModes.join(' / '));
    const attached = Object.values(stack.attachments ?? {}).filter(Boolean).length;
    if (attached > 0) addRow('Anbauteile', String(attached));
  }

  if (def.magazine) {
    addRow('Kaliber', def.magazine.caliber);
    addRow('Kapazität', `${stack.rounds?.length ?? 0} / ${def.magazine.capacity}`);
  }

  if (def.armor) {
    const a = def.armor;
    addRow('Schutzklasse', String(a.armorClass), a.armorClass >= 4 ? 'good' : '');
    addRow('Deckt ab', a.covers.length > 3 ? `${a.covers.length} Zonen` : a.covers.join(', '));
    if (a.speedPenalty < 1) addRow('Bewegung', `${Math.round((a.speedPenalty - 1) * 100)} %`, 'bad');
    if (a.hearingPenalty < 1) addRow('Gehör', `${Math.round((a.hearingPenalty - 1) * 100)} %`, 'bad');
  }

  if (def.attachment) {
    const a = def.attachment;
    if (a.recoilMultiplier !== 1) {
      addRow('Rückstoß', `${Math.round((a.recoilMultiplier - 1) * 100)} %`, a.recoilMultiplier < 1 ? 'good' : 'bad');
    }
    if (a.accuracyMultiplier !== 1) {
      addRow('Streuung', `${Math.round((a.accuracyMultiplier - 1) * 100)} %`, a.accuracyMultiplier < 1 ? 'good' : 'bad');
    }
    if (a.ergonomicsDelta !== 0) {
      addRow('Handhabung', `${a.ergonomicsDelta > 0 ? '+' : ''}${a.ergonomicsDelta.toFixed(2)} s`, a.ergonomicsDelta > 0 ? 'good' : 'bad');
    }
    if (a.loudnessMultiplier !== 1) {
      addRow('Lautstärke', `${Math.round((a.loudnessMultiplier - 1) * 100)} %`, a.loudnessMultiplier < 1 ? 'good' : 'bad');
    }
    if (a.zoom > 1) addRow('Vergrößerung', `${a.zoom.toFixed(1)}x`);
  }

  if (def.container) {
    addRow('Fassungsvermögen', `${def.container.gridWidth} x ${def.container.gridHeight}`);
    if (def.container.secure) addRow('Sicher', 'Überlebt den Tod', 'good');
  }

  if (def.med) {
    addRow('Anwendungsdauer', `${def.med.useTimeSec.toFixed(1)} s`);
    if (def.med.maxCharges > 1) addRow('Ladungen', `${stack.charges ?? 0} / ${def.med.maxCharges}`);
  }

  const actionNodes = actions.map((action) => {
    const btn = el('button', { class: `btn small ${action.kind ?? ''}`, type: 'button', text: action.label });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      action.onTap();
    });
    return btn;
  });

  return el('div', { class: 'item-detail' }, [
    el('h3', { text: def.name, style: { color: RARITY_COLOR[def.rarity] } }),
    el('div', { class: 'desc', text: def.description }),
    ...rows,
    el('div', { class: 'actions' }, actionNodes),
  ]);
}
