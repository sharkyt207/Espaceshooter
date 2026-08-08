import { button, clear, el } from '../Dom';
import { screenShell, type Screen } from '../ScreenManager';
import type { GameSettings } from '../../save/SaveSystem';
import { applyPreset, defaultTouchConfig, type ButtonId, type ClawPreset } from '../../input/TouchConfig';

/**
 * ControlsScreen - the touch layout and everything that scales aim.
 *
 * Split out from the general settings screen because it is a different kind of
 * screen. The others are a list of choices; this one is a workbench, and it has
 * to be usable while the values it changes are being felt. Burying twelve aim
 * sliders in the middle of the audio and profile options would have made both
 * screens worse.
 *
 * Two decisions worth stating:
 *
 * **Presets move buttons, they do not change the input model.** Two-, three-
 * and four-finger all run through the same router; what differs is where the
 * controls sit and how large they are, because that is what actually decides
 * which grip is comfortable. A preset that swapped input systems would mean
 * three code paths to keep correct and three sets of bugs.
 *
 * **Editing any slider drops the preset to Custom.** Silently keeping a
 * preset's name on a layout that no longer matches it is how a settings screen
 * starts lying to the player - and the first thing they do afterwards is
 * re-pick the preset to "fix" it and lose their work.
 */
export class ControlsScreen implements Screen {
  readonly id = 'controls';
  readonly root: HTMLElement;
  private body: HTMLElement;

  constructor(
    private readonly settings: GameSettings,
    private readonly actions: {
      onClose: () => void;
      onApply: (settings: GameSettings) => void;
    },
  ) {
    const shell = screenShell(
      'Steuerung',
      'Griff, Empfindlichkeit und Tastenlayout',
      () => actions.onClose(),
    );
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

  private apply(): void {
    this.actions.onApply(this.settings);
  }

  /** Any manual edit means the layout is no longer the preset it came from. */
  private touched(): void {
    this.settings.touch.preset = 'custom';
    this.apply();
  }

  private render(): void {
    clear(this.body);
    const touch = this.settings.touch;

    const panel = el('div', { class: 'panel', style: { flex: '1', minHeight: '0' } });
    const content = el('div', { class: 'panel-body' });
    panel.append(el('div', { class: 'panel-head' }, [el('span', { text: 'Steuerung' })]), content);

    // --- grip ---------------------------------------------------------------
    content.appendChild(this.section('Griff'));
    content.appendChild(
      this.choiceRow(
        'Voreinstellung',
        PRESET_HINT[touch.preset],
        [
          { label: '2 Finger', value: 'two' as ClawPreset },
          { label: '3 Finger', value: 'three' as ClawPreset },
          { label: '4 Finger', value: 'four' as ClawPreset },
          { label: 'Eigen', value: 'custom' as ClawPreset },
        ],
        touch.preset,
        (value) => {
          this.settings.touch = applyPreset(this.settings.touch, value);
          this.apply();
          this.render();
        },
      ),
    );

    // --- aiming -------------------------------------------------------------
    content.appendChild(this.section('Zielen'));
    content.appendChild(
      this.sliderRow(
        'Empfindlichkeit horizontal',
        touch.sensitivityX * 1000, 1, 12,
        (v) => { touch.sensitivityX = v / 1000; this.touched(); },
        (v) => v.toFixed(1),
      ),
    );
    content.appendChild(
      this.sliderRow(
        'Empfindlichkeit vertikal',
        touch.sensitivityY * 1000, 1, 12,
        (v) => { touch.sensitivityY = v / 1000; this.touched(); },
        (v) => v.toFixed(1),
      ),
    );
    content.appendChild(
      this.sliderRow(
        'Beim Zielen',
        touch.adsScale, 0.15, 1,
        (v) => { touch.adsScale = v; this.touched(); },
        (v) => `${Math.round(v * 100)} %`,
        'Anteil der normalen Empfindlichkeit im Anschlag.',
      ),
    );
    content.appendChild(
      this.sliderRow(
        'Im Zielfernrohr',
        touch.scopeScale, 0.1, 1,
        (v) => { touch.scopeScale = v; this.touched(); },
        (v) => `${Math.round(v * 100)} %`,
        'Getrennt, weil Vergrößerung die scheinbare Drehgeschwindigkeit mitskaliert.',
      ),
    );
    content.appendChild(
      this.sliderRow(
        'Beschleunigung',
        touch.acceleration, 0, 1,
        (v) => { touch.acceleration = v; this.touched(); },
        (v) => (v < 0.02 ? 'aus' : `${Math.round(v * 100)} %`),
        'Schnelles Wischen dreht weiter. Null bleibt linear.',
      ),
    );
    content.appendChild(
      this.sliderRow(
        'Glättung',
        touch.smoothing, 0, 0.85,
        (v) => { touch.smoothing = v; this.touched(); },
        (v) => (v < 0.02 ? 'aus' : `${Math.round(v * 100)} %`),
        'Ruhiger, aber träger. Kostet Reaktionszeit.',
      ),
    );
    content.appendChild(
      this.sliderRow(
        'Zielhilfe',
        touch.aimAssist, 0, 0.4,
        (v) => { touch.aimAssist = v; this.touched(); },
        (v) => (v < 0.02 ? 'aus' : `${Math.round(v * 100)} %`),
        'Bremst nur über einem Ziel. Bewegt das Zielen nie für dich.',
      ),
    );
    content.appendChild(
      this.toggleRow('Y-Achse invertieren', '', this.settings.invertY, (v) => {
        this.settings.invertY = v;
        this.settings.touch.invertY = v;
        this.apply();
      }),
    );

    // --- gyro ---------------------------------------------------------------
    content.appendChild(this.section('Kreiselsensor'));
    content.appendChild(
      this.toggleRow(
        'Bewegungssteuerung',
        'Neigen ergänzt den Daumen, statt ihn zu ersetzen.',
        touch.gyroEnabled,
        (v) => { touch.gyroEnabled = v; this.touched(); },
      ),
    );
    if (touch.gyroEnabled) {
      content.appendChild(
        this.sliderRow(
          'Kreisel-Stärke',
          touch.gyroScale, 0.2, 3,
          (v) => { touch.gyroScale = v; this.touched(); },
          (v) => `${v.toFixed(1)}x`,
        ),
      );
    }

    // --- layout -------------------------------------------------------------
    content.appendChild(this.section('Bereiche'));
    content.appendChild(
      this.sliderRow(
        'Breite der Laufzone',
        touch.moveZoneWidth, 0.25, 0.6,
        (v) => { touch.moveZoneWidth = v; this.touched(); },
        (v) => `${Math.round(v * 100)} %`,
        'Links davon läuft der Daumen, rechts davon dreht die Kamera.',
      ),
    );
    content.appendChild(
      this.sliderRow(
        'Stickweg',
        touch.stickRadius, 36, 120,
        (v) => { touch.stickRadius = Math.round(v); this.touched(); },
        (v) => `${Math.round(v)} px`,
        'Wie weit der Daumen für vollen Ausschlag wandern muss.',
      ),
    );

    // --- buttons ------------------------------------------------------------
    content.appendChild(this.section('Tasten'));
    content.appendChild(
      el('div', {
        class: 'sub',
        style: { padding: '0 0 8px' },
        text: 'Größe und Sichtbarkeit je Taste. Auf null gestellt verschwindet sie und nimmt auch keine Berührung mehr an.',
      }),
    );
    for (const [id, label] of BUTTON_LABELS) {
      const layout = touch.buttons[id];
      if (!layout) continue;
      content.appendChild(
        el('div', { class: 'list-row' }, [
          el('div', { class: 'grow' }, [el('div', { class: 'title', text: label })]),
          el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flex: '0 0 auto' } }, [
            this.miniSlider(layout.size, 0.08, 0.42, (v) => { layout.size = v; this.touched(); }, 'Größe'),
            this.miniSlider(layout.opacity, 0, 1, (v) => { layout.opacity = v; this.touched(); }, 'Deckkraft'),
          ]),
        ]),
      );
    }

    content.appendChild(this.section('Zurücksetzen'));
    content.appendChild(
      el('div', { class: 'list-row' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title', text: 'Auf Werkseinstellung' }),
          el('div', { class: 'sub', text: 'Setzt Layout und Empfindlichkeit auf den Dreifingergriff zurück.' }),
        ]),
        button('Zurücksetzen', () => {
          this.settings.touch = defaultTouchConfig();
          this.settings.touch.invertY = this.settings.invertY;
          this.apply();
          this.render();
        }, 'btn small'),
      ]),
    );

    this.body.appendChild(panel);
  }

  // =========================================================================
  // Rows
  // =========================================================================

  private section(label: string): HTMLElement {
    return el('div', { class: 'section-label', text: label });
  }

  private toggleRow(label: string, hint: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const btn = button(value ? 'An' : 'Aus', () => {
      value = !value;
      btn.textContent = value ? 'An' : 'Aus';
      btn.className = `btn small ${value ? 'primary' : 'ghost'}`;
      onChange(value);
    }, `btn small ${value ? 'primary' : 'ghost'}`);
    return el('div', { class: 'list-row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title', text: label }),
        hint ? el('div', { class: 'sub', text: hint }) : null,
      ].filter(Boolean) as HTMLElement[]),
      btn,
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
      el('div', { style: { display: 'flex', gap: '4px', flex: '0 0 auto' } },
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

  private sliderRow(
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
    format: (v: number) => string,
    hint = '',
  ): HTMLElement {
    const display = el('span', { class: 'price', text: format(value) });
    const input = el('input', { class: 'slider' }) as HTMLInputElement;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String((max - min) / 100);
    input.value = String(value);
    // `input` rather than `change`: the player is judging the value by feel
    // while dragging, and a slider that only reports on release cannot be
    // tuned that way.
    input.addEventListener('input', () => {
      const v = Number(input.value);
      display.textContent = format(v);
      onChange(v);
    });
    return el('div', { class: 'list-row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title', text: label }),
        hint ? el('div', { class: 'sub', text: hint }) : null,
      ].filter(Boolean) as HTMLElement[]),
      el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flex: '0 0 auto' } }, [
        input, display,
      ]),
    ]);
  }

  /** A compact slider for the per-button grid, where two fit on one row. */
  private miniSlider(
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
    title: string,
  ): HTMLElement {
    const input = el('input', { class: 'slider mini' }) as HTMLInputElement;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String((max - min) / 40);
    input.value = String(value);
    input.title = title;
    input.setAttribute('aria-label', title);
    input.addEventListener('input', () => onChange(Number(input.value)));
    return input;
  }
}

const PRESET_HINT: Record<ClawPreset, string> = {
  two: 'Beide Daumen. Feuer liegt groß unter dem rechten Daumen.',
  three: 'Rechter Zeigefinger feuert, der rechte Daumen behält die Kamera.',
  four: 'Beide Zeigefinger an den Schultern, beide Daumen bleiben frei.',
  custom: 'Eigenes Layout.',
};

/** Only the buttons worth exposing; the corner row is fixed by design. */
const BUTTON_LABELS: [ButtonId, string][] = [
  ['fire', 'Feuer'],
  ['ads', 'Zielen'],
  ['reload', 'Nachladen'],
  ['stance', 'Haltung'],
  ['interact', 'Aktion'],
  ['heal', 'Medizin'],
  ['swapWeapon', 'Waffenwechsel'],
  ['fireMode', 'Feuermodus'],
  ['toggleLight', 'Lampe'],
];
