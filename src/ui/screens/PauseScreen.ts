import { button, el } from '../Dom';
import { screenShell, type Screen } from '../ScreenManager';

/**
 * PauseScreen - the in-raid menu.
 *
 * Note what it does *not* offer: there is no "save and quit mid-raid". A raid
 * runs to its conclusion. Abandoning one counts as a death, with the full loss
 * of everything outside the secure container, because an escape hatch from a
 * bad situation would defeat the entire premise.
 */
export class PauseScreen implements Screen {
  readonly id = 'pause';
  readonly root: HTMLElement;

  /** Seconds the abandon button stays armed after the first tap. */
  private static readonly CONFIRM_WINDOW = 4;
  private armedUntil = 0;
  private abandonBtn: HTMLButtonElement;

  constructor(private readonly actions: { onResume: () => void; onSettings: () => void; onAbandon: () => void }) {
    const shell = screenShell('Einsatz unterbrochen', 'Die Uhr läuft weiter, sobald du fortsetzt', null);
    this.root = shell.root;
    shell.body.style.flexDirection = 'column';

    // Confirm in place rather than by swapping in a second row of buttons.
    // Swapping changed the height of the menu between the tap landing and the
    // press registering, which on touch means the confirmation can appear
    // directly under a thumb that is already moving - and it made the layout
    // jump. Arming the same control keeps every element exactly where it was.
    this.abandonBtn = button('Einsatz abbrechen', () => this.onAbandonTapped(), 'btn danger');

    shell.body.appendChild(
      el('div', { class: 'menu-hero' }, [
        el('div', { class: 'menu-actions' }, [
          button('Fortsetzen', () => actions.onResume(), 'btn primary'),
          button('Einstellungen', () => actions.onSettings(), 'btn'),
          this.abandonBtn,
          el('div', {
            class: 'screen-sub',
            style: { marginTop: '14px', textAlign: 'center', lineHeight: '1.5' },
            text:
              'Ein Abbruch zählt wie ein Tod: Alles außer dem Inhalt des Sicherheitsbehälters bleibt im Sektor.',
          }),
        ]),
      ]),
    );
  }

  private onAbandonTapped(): void {
    const now = performance.now() / 1000;
    if (now < this.armedUntil) {
      this.actions.onAbandon();
      return;
    }
    this.armedUntil = now + PauseScreen.CONFIRM_WINDOW;
    this.abandonBtn.textContent = 'Einsatz aufgeben — bestätigen';
  }

  onShow(): void {
    // Always open in the unarmed state; an armed button left over from a
    // previous pause would be a nasty surprise.
    this.armedUntil = 0;
    this.abandonBtn.textContent = 'Einsatz abbrechen';
  }

  onTick(): void {
    if (this.armedUntil > 0 && performance.now() / 1000 >= this.armedUntil) {
      this.armedUntil = 0;
      this.abandonBtn.textContent = 'Einsatz abbrechen';
    }
  }

  onBack(): boolean {
    // Handled by the game shell, which resumes instead of popping blindly.
    return false;
  }
}
