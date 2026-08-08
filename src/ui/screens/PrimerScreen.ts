import { button, clear, el } from '../Dom';
import { screenShell, type Screen } from '../ScreenManager';

/**
 * PrimerScreen - the four things a new player has to know.
 *
 * Not a tutorial. There is no scripted first raid, no hand on the wheel, no
 * "press the highlighted button" - an extraction shooter where the first raid
 * is on rails teaches the wrong lesson, which is that the game will look after
 * you. It will not.
 *
 * What it does instead is state the rules that are expensive to learn by
 * losing: that death costs you everything outside the secure container, that
 * sound gives you away, that a light is a trade, and that you have to walk to
 * an exit. Four cards, skippable at any point, reachable again from settings.
 *
 * Cards carry a diagram where a diagram is clearer than a sentence - the
 * control layout in particular, which is a spatial fact and reads terribly as
 * prose.
 */

interface Card {
  eyebrow: string;
  title: string;
  body: string[];
  diagram?: () => HTMLElement;
}

export class PrimerScreen implements Screen {
  readonly id = 'primer';
  readonly root: HTMLElement;
  private body: HTMLElement;
  private index = 0;

  constructor(private readonly actions: { onDone: () => void }) {
    const shell = screenShell('Erste Schritte', '', null, [
      button('Überspringen', () => this.finish(), 'btn ghost small'),
    ]);
    this.root = shell.root;
    this.body = shell.body;
    shell.header.classList.add('compact');
  }

  onShow(): void {
    this.index = 0;
    this.render();
  }

  onBack(): boolean {
    if (this.index > 0) {
      this.index--;
      this.render();
      return true;
    }
    this.finish();
    return true;
  }

  private finish(): void {
    this.actions.onDone();
  }

  private render(): void {
    clear(this.body);
    const card = CARDS[this.index];
    const last = this.index === CARDS.length - 1;

    const text = el('div', { class: 'primer-text' }, [
      el('div', { class: 'eyebrow', text: card.eyebrow }),
      el('h2', { class: 'title', text: card.title }),
      ...card.body.map((line) => el('p', { text: line })),
    ]);

    const column = el('div', { class: 'primer-card' }, [
      text,
      card.diagram ? card.diagram() : null,
    ].filter(Boolean) as HTMLElement[]);

    const dots = el('div', { class: 'primer-dots' });
    CARDS.forEach((_, i) => {
      const dot = el('span', { class: `dot${i === this.index ? ' on' : ''}` });
      dot.addEventListener('click', () => {
        this.index = i;
        this.render();
      });
      dots.appendChild(dot);
    });

    const back = button('Zurück', () => {
      this.index--;
      this.render();
    }, 'btn ghost');
    back.style.visibility = this.index === 0 ? 'hidden' : 'visible';

    const next = button(last ? 'Los geht’s' : 'Weiter', () => {
      if (last) {
        this.finish();
        return;
      }
      this.index++;
      this.render();
    }, 'btn primary');

    this.body.append(
      el('div', { class: 'primer' }, [
        column,
        el('div', { class: 'primer-foot' }, [back, dots, next]),
      ]),
    );
  }
}

// ===========================================================================
// Diagrams
// ===========================================================================

/** The touch layout, as a picture of the screen rather than a list of names. */
function controlDiagram(): HTMLElement {
  const zone = (cls: string, label: string, hint: string): HTMLElement =>
    el('div', { class: `pz ${cls}` }, [
      el('span', { class: 'l', text: label }),
      el('span', { class: 'h', text: hint }),
    ]);

  return el('div', { class: 'primer-figure' }, [
    el('div', { class: 'phone' }, [
      zone('move', 'Bewegen', 'Daumen aufsetzen und ziehen'),
      zone('look', 'Umsehen', 'Ziehen'),
      el('div', { class: 'pb fire', text: 'FEUER' }),
      el('div', { class: 'pb ads', text: 'ZIEL' }),
      el('div', { class: 'pb torch', text: 'LAMPE' }),
    ]),
    el('div', { class: 'caption', text: 'Weit nach vorn drücken heißt sprinten.' }),
  ]);
}

/** The loop, as four states rather than a paragraph. */
function loopDiagram(): HTMLElement {
  const step = (n: string, label: string): HTMLElement =>
    el('div', { class: 'ls' }, [
      el('span', { class: 'n', text: n }),
      el('span', { class: 'l', text: label }),
    ]);

  return el('div', { class: 'primer-figure' }, [
    el('div', { class: 'loop' }, [
      step('1', 'Ausrüsten'),
      step('2', 'Absetzen'),
      step('3', 'Plündern'),
      step('4', 'Extrahieren'),
    ]),
    el('div', { class: 'caption', text: 'Schritt 4 ist der schwerste. Ohne ihn zählt Schritt 3 nicht.' }),
  ]);
}

// ===========================================================================
// Content
// ===========================================================================

const CARDS: Card[] = [
  {
    eyebrow: 'Worum es geht',
    title: 'Rein, sammeln, lebend raus',
    body: [
      'Du setzt allein in einem Sektor ab, durchsuchst ihn und verlässt ihn über einen Ausgang. ' +
      'Alles, was du mit heraus nimmst, gehört dir.',
      'Stirbst du oder brichst du ab, bleibt deine gesamte Ausrüstung im Sektor. Nur der Inhalt ' +
      'des Sicherheitsbehälters kommt mit zurück.',
      'Deshalb ist die wichtigste Entscheidung nicht, wann du schießt, sondern wann du gehst.',
    ],
    diagram: loopDiagram,
  },
  {
    eyebrow: 'Steuerung',
    title: 'Links laufen, rechts schauen',
    body: [
      'Der Bewegungsstick erscheint dort, wo dein linker Daumen aufsetzt. Ziehen auf der rechten ' +
      'Bildhälfte dreht die Kamera.',
      'Die Knöpfe liegen unter dem rechten Daumen. Die Waffenlampe sitzt bewusst links – sie soll ' +
      'nicht im Gefecht versehentlich angehen.',
    ],
    diagram: controlDiagram,
  },
  {
    eyebrow: 'Im Einsatz',
    title: 'Man hört dich, bevor man dich sieht',
    body: [
      'Sprinten ist laut, Schleichen ist leise, und ein ungedämpfter Schuss ist über den halben ' +
      'Sektor zu hören. Gegner untersuchen Geräusche und suchen dich systematisch.',
      'Schatten sind echte Deckung: Die KI sieht nach derselben Beleuchtung wie du. Eine ' +
      'eingeschaltete Lampe macht dich dagegen zum hellsten Punkt der Karte.',
      'Verletzungen heilen nicht von selbst. Blutungen töten dich, wenn du sie ignorierst.',
    ],
  },
  {
    eyebrow: 'Zwischen den Einsätzen',
    title: 'Das Versteck arbeitet weiter',
    body: [
      'Im Versteck rüstest du aus, handelst, nimmst Aufträge an und baust Module aus. Ausbau und ' +
      'Fertigung laufen in Echtzeit weiter – auch wenn das Spiel geschlossen ist.',
      'Die Versicherung holt einen Teil deiner Verluste zurück, aber nie sofort und nie vollständig. ' +
      'Sie macht einen schlechten Einsatz überlebbar, keinen verlorenen schmerzfrei.',
      'Ein Punkt in der Seitenleiste bedeutet: Dort wartet etwas auf dich.',
    ],
  },
];
