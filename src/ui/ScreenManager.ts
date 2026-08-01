import { el } from './Dom';

/**
 * ScreenManager - a stack of full-screen overlays.
 *
 * Screens are plain objects owning a root element. The manager keeps a stack so
 * "back" is well-defined everywhere (loot screen over inventory over hideout),
 * and it tells the game when the stack becomes empty so input can be released
 * and the simulation resumed.
 */

export interface Screen {
  readonly id: string;
  readonly root: HTMLElement;
  /** Called each time the screen becomes visible. */
  onShow?(): void;
  onHide?(): void;
  /** Called on the top screen once per frame, for live data. */
  onTick?(dt: number): void;
  /** Return true to consume the back action. */
  onBack?(): boolean;
}

export class ScreenManager {
  private readonly container: HTMLElement;
  private readonly screens = new Map<string, Screen>();
  private stack: Screen[] = [];

  /** Fired whenever the visible screen changes. */
  onChange: (top: Screen | null) => void = () => {};

  constructor(parent: HTMLElement) {
    this.container = el('div', { class: 'screen-host' });
    parent.appendChild(this.container);
  }

  /**
   * Register a screen, replacing any previous one with the same id.
   *
   * Replacement matters: screens hold a reference to the profile, so starting
   * a new profile rebuilds several of them. Without tearing the old root out
   * of the DOM we would accumulate hidden duplicate subtrees - stale nodes
   * that leak memory and shadow the live ones in any query.
   */
  register(screen: Screen): void {
    const previous = this.screens.get(screen.id);
    if (previous && previous !== screen) {
      previous.root.remove();
      const index = this.stack.indexOf(previous);
      if (index >= 0) this.stack.splice(index, 1);
    }
    this.screens.set(screen.id, screen);
    screen.root.classList.add('hidden');
    this.container.appendChild(screen.root);
  }

  get top(): Screen | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  isTop(id: string): boolean {
    return this.top?.id === id;
  }

  /** Replace the whole stack with a single screen. */
  show(id: string): void {
    const screen = this.screens.get(id);
    if (!screen) throw new Error(`[ScreenManager] unknown screen "${id}"`);
    for (const s of this.stack) {
      s.root.classList.add('hidden');
      s.onHide?.();
    }
    this.stack = [screen];
    screen.root.classList.remove('hidden');
    screen.onShow?.();
    this.onChange(screen);
  }

  /** Push a screen on top of the current one. */
  push(id: string): void {
    const screen = this.screens.get(id);
    if (!screen) throw new Error(`[ScreenManager] unknown screen "${id}"`);
    if (this.top === screen) return;
    // Keep the screen underneath rendered: layered menus read better than
    // a hard cut, and the hideout backdrop stays visible behind a dialog.
    this.stack.push(screen);
    screen.root.classList.remove('hidden');
    screen.onShow?.();
    this.onChange(screen);
  }

  pop(): void {
    const screen = this.stack.pop();
    if (!screen) return;
    screen.root.classList.add('hidden');
    screen.onHide?.();
    this.onChange(this.top);
  }

  /** Close everything - used when a raid starts. */
  closeAll(): void {
    for (const s of this.stack) {
      s.root.classList.add('hidden');
      s.onHide?.();
    }
    this.stack.length = 0;
    this.onChange(null);
  }

  /** Route a back action to the top screen, falling back to popping it. */
  back(): void {
    const top = this.top;
    if (!top) return;
    if (top.onBack?.()) return;
    this.pop();
  }

  tick(dt: number): void {
    this.top?.onTick?.(dt);
  }
}

/** Shared screen scaffold: title bar with a back button and a body. */
export function screenShell(
  title: string,
  subtitle: string,
  onBack: (() => void) | null,
  extraHeader: HTMLElement[] = [],
): { root: HTMLElement; body: HTMLElement; header: HTMLElement; subtitleEl: HTMLElement } {
  const subtitleEl = el('div', { class: 'screen-sub', text: subtitle });
  const headerChildren: (HTMLElement | null)[] = [];

  if (onBack) {
    const back = el('button', { class: 'btn ghost small', type: 'button', text: '‹ Zurück' });
    back.addEventListener('click', (e) => {
      e.stopPropagation();
      onBack();
    });
    headerChildren.push(back);
  }
  headerChildren.push(
    el('div', {}, [el('div', { class: 'screen-title', text: title }), subtitleEl]),
    el('div', { class: 'spacer' }),
    ...extraHeader,
  );

  const header = el('div', { class: 'screen-head' }, headerChildren.filter(Boolean) as HTMLElement[]);
  const body = el('div', { class: 'screen-body' });
  const root = el('div', { class: 'screen hidden' }, [header, body]);
  return { root, body, header, subtitleEl };
}
