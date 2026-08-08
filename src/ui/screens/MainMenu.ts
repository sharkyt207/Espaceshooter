import { button, el, money } from '../Dom';
import type { Screen } from '../ScreenManager';
import type { Profile } from '../../meta/Profile';

/**
 * MainMenu - the entry point.
 *
 * Deliberately sparse. The only decisions that belong here are "continue",
 * "start over" and "settings"; everything about the character lives in the
 * hideout, which is where the player should spend their between-raid time.
 */
export class MainMenu implements Screen {
  readonly id = 'menu';
  readonly root: HTMLElement;

  private continueBtn: HTMLButtonElement;
  private statusLine: HTMLElement;

  constructor(
    private readonly profile: Profile,
    private readonly hasSave: () => boolean,
    actions: {
      onContinue: () => void;
      onNewGame: () => void;
      onSettings: () => void;
    },
  ) {
    this.continueBtn = button('Fortsetzen', actions.onContinue, 'btn primary');
    this.statusLine = el('div', { class: 'screen-sub', style: { marginTop: '10px' } });

    this.root = el('div', { class: 'screen hidden' }, [
      el('div', { class: 'menu-hero' }, [
        el('div', { class: 'subtitle', text: 'Extraction Protocol' }),
        el('div', { class: 'title', text: 'GRAYZONE' }),
        el('div', {
          class: 'tagline',
          text:
            'Hafenbecken 7. Du gehst mit dem rein, was du dir leisten kannst, und kommst mit dem raus, ' +
            'was du lebend heraustragen kannst. Alles andere bleibt im Sektor.',
        }),
        this.statusLine,
        el('div', { class: 'menu-actions' }, [
          this.continueBtn,
          button('Neues Profil', actions.onNewGame, 'btn'),
          button('Einstellungen', actions.onSettings, 'btn ghost'),
        ]),
        el('div', {
          class: 'screen-sub menu-colophon',
          text:
            'Technischer Prototyp - eigenständige Umsetzung, eigene Assets, eigene Systeme. ' +
            'Ausgelegt auf Touch, Querformat und 60 Bilder pro Sekunde.',
        }),
      ]),
    ]);
  }

  onShow(): void {
    const saved = this.hasSave();
    this.continueBtn.disabled = !saved;
    this.continueBtn.textContent = saved ? 'Fortsetzen' : 'Kein Profil vorhanden';

    if (saved) {
      this.statusLine.textContent =
        `Stufe ${this.profile.progression.level} · ${money(this.profile.money)} · ` +
        `${this.profile.raids} Einsätze · ${Math.round(this.profile.survivalRate * 100)} % Rückkehrquote`;
    } else {
      this.statusLine.textContent = 'Starte ein neues Profil, um einzusteigen.';
    }
  }
}
