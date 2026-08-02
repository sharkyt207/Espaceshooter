import { button, clear, el } from '../Dom';
import { screenShell, type Screen } from '../ScreenManager';
import type { GameSettings } from '../../save/SaveSystem';
import { haptic, hapticsSupported } from '../../platform/Platform';

/**
 * SettingsScreen - performance, controls and audio.
 *
 * The render-scale control matters more than it looks: it is the difference
 * between 60 FPS and 35 on a mid-range phone. Automatic is the default and
 * uses the performance governor; the manual steps exist because some players
 * would rather have a stable, sharper image at 45 FPS than an adaptive one.
 */
export class SettingsScreen implements Screen {
  readonly id = 'settings';
  readonly root: HTMLElement;
  private body: HTMLElement;

  constructor(
    private readonly settings: GameSettings,
    private readonly actions: {
      onClose: () => void;
      onApply: (settings: GameSettings) => void;
      onResetProfile: () => void;
      onShowPrimer: () => void;
    },
  ) {
    const shell = screenShell('Einstellungen', 'Steuerung, Darstellung und Ton', () => actions.onClose());
    this.root = shell.root;
    this.body = shell.body;
    this.body.style.flexDirection = 'column';
  }

  onShow(): void {
    this.render();
  }

  onBack(): boolean {
    this.actions.onClose();
    return true;
  }

  private render(): void {
    clear(this.body);

    const panel = el('div', { class: 'panel', style: { flex: '1', minHeight: '0' } });
    const content = el('div', { class: 'panel-body' });
    panel.append(el('div', { class: 'panel-head' }, [el('span', { text: 'Optionen' })]), content);

    content.appendChild(this.section('Darstellung'));
    content.appendChild(
      this.choiceRow(
        'Auflösungsskalierung',
        'Automatisch passt die interne Auflösung an, um 60 Bilder pro Sekunde zu halten.',
        [
          { label: 'Auto', value: 0 },
          { label: '60 %', value: 0.6 },
          { label: '75 %', value: 0.75 },
          { label: '100 %', value: 1 },
        ],
        this.settings.renderScale,
        (value) => {
          this.settings.renderScale = value;
          this.apply();
        },
      ),
    );
    content.appendChild(
      this.choiceRow(
        'Bildeffekte',
        'Lichtstreuung und Belichtungskurve. Kostet Bildrate, macht Licht deutlich glaubwürdiger.',
        [
          { label: 'Auto', value: -1 },
          { label: 'Aus', value: 0 },
          { label: 'Belichtung', value: 1 },
          { label: 'Voll', value: 2 },
        ],
        this.settings.postQuality,
        (value) => {
          this.settings.postQuality = value;
          this.apply();
        },
      ),
    );
    content.appendChild(
      this.toggleRow('Bildrate anzeigen', 'Blendet Diagnosewerte im Einsatz ein.', this.settings.showFps, (v) => {
        this.settings.showFps = v;
        this.apply();
      }),
    );

    content.appendChild(this.section('Steuerung'));
    content.appendChild(
      this.sliderRow('Sichtempfindlichkeit', this.settings.lookSensitivity, 0.3, 2.5, (v) => {
        this.settings.lookSensitivity = v;
        this.apply();
      }),
    );
    content.appendChild(
      this.toggleRow('Y-Achse invertieren', '', this.settings.invertY, (v) => {
        this.settings.invertY = v;
        this.apply();
      }),
    );
    content.appendChild(
      this.toggleRow(
        'Zielen umschalten',
        'An: Antippen wechselt in den Anschlag. Aus: Halten zum Zielen.',
        this.settings.toggleAds,
        (v) => {
          this.settings.toggleAds = v;
          this.apply();
        },
      ),
    );

    // Only offered where it can actually do something. A dead switch is worse
    // than a missing one - it makes the player think the feature is broken.
    if (hapticsSupported()) {
      content.appendChild(
        this.toggleRow(
          'Vibration',
          'Kurze Rückmeldung bei Treffern, Verwundungen und Extraktion.',
          this.settings.haptics,
          (v) => {
            this.settings.haptics = v;
            this.apply();
            if (v) haptic('hit');
          },
        ),
      );
    }

    content.appendChild(this.section('Ton'));
    content.appendChild(
      this.sliderRow('Lautstärke', this.settings.masterVolume, 0, 1, (v) => {
        this.settings.masterVolume = v;
        this.apply();
      }),
    );
    content.appendChild(
      this.toggleRow('Stumm', '', this.settings.muted, (v) => {
        this.settings.muted = v;
        this.apply();
      }),
    );

    content.appendChild(this.section('Profil'));
    content.appendChild(
      el('div', { class: 'list-row' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title', text: 'Erste Schritte' }),
          el('div', { class: 'sub', text: 'Die vier Regeln, die Ausrüstung kosten, wenn man sie nicht kennt.' }),
        ]),
        button('Anzeigen', () => this.actions.onShowPrimer(), 'btn small'),
      ]),
    );
    content.appendChild(
      el('div', { class: 'list-row' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title', text: 'Profil zurücksetzen' }),
          el('div', { class: 'sub', text: 'Löscht Fortschritt, Lager und Versteck unwiderruflich.' }),
        ]),
        button('Zurücksetzen', () => this.confirmReset(), 'btn small danger'),
      ]),
    );

    this.body.appendChild(panel);
  }

  private confirmReset(): void {
    const overlay = el('div', {
      class: 'panel',
      style: {
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        width: 'min(420px, 80vw)',
        zIndex: '40',
      },
    }, [
      el('div', { class: 'panel-head' }, [el('span', { text: 'Wirklich zurücksetzen?' })]),
      el('div', { class: 'panel-body' }, [
        el('div', {
          class: 'sub',
          style: { marginBottom: '12px' },
          text: 'Dein gesamter Fortschritt geht verloren. Dieser Schritt lässt sich nicht rückgängig machen.',
        }),
        el('div', { style: { display: 'flex', gap: '8px' } }, [
          button('Abbrechen', () => overlay.remove(), 'btn ghost'),
          button('Endgültig löschen', () => {
            overlay.remove();
            this.actions.onResetProfile();
          }, 'btn danger'),
        ]),
      ]),
    ]);
    this.root.appendChild(overlay);
  }

  private apply(): void {
    this.actions.onApply(this.settings);
    this.render();
  }

  private section(title: string): HTMLElement {
    return el('div', {
      class: 'panel-head',
      style: { border: 'none', padding: '12px 0 4px', color: '#c8913a' },
      text: title,
    });
  }

  private toggleRow(label: string, hint: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    return el('div', { class: 'list-row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title', text: label }),
        hint ? el('div', { class: 'sub', text: hint }) : null,
      ].filter(Boolean) as HTMLElement[]),
      button(value ? 'An' : 'Aus', () => onChange(!value), `btn small ${value ? 'primary' : 'ghost'}`),
    ]);
  }

  private choiceRow<T>(
    label: string,
    hint: string,
    options: { label: string; value: T }[],
    current: T,
    onChange: (value: T) => void,
  ): HTMLElement {
    return el('div', { class: 'list-row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title', text: label }),
        hint ? el('div', { class: 'sub', text: hint }) : null,
      ].filter(Boolean) as HTMLElement[]),
      el('div', { style: { display: 'flex', gap: '4px' } },
        options.map((option) =>
          button(
            option.label,
            () => onChange(option.value),
            `btn small ${option.value === current ? 'primary' : 'ghost'}`,
          ),
        ),
      ),
    ]);
  }

  private sliderRow(label: string, value: number, min: number, max: number, onChange: (v: number) => void): HTMLElement {
    const display = el('span', { class: 'price', text: value.toFixed(2) });
    const input = el('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: '0.05',
      value: String(value),
      style: { flex: '1', accentColor: '#c8913a' },
    });
    // `input` fires continuously while dragging, which is what we want for a
    // sensitivity slider the player is tuning by feel.
    input.addEventListener('input', () => {
      const v = Number(input.value);
      display.textContent = v.toFixed(2);
      onChange(v);
    });
    return el('div', { class: 'list-row' }, [
      el('div', { style: { width: '150px' } }, [el('div', { class: 'title', text: label })]),
      input,
      display,
    ]);
  }
}
