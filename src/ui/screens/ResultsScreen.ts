import { button, clear, duration, el, money } from '../Dom';
import { screenShell, type Screen } from '../ScreenManager';
import type { RaidResult } from '../../raid/RaidSession';
import type { Profile } from '../../meta/Profile';

/**
 * ResultsScreen - the debrief.
 *
 * Written to make the outcome *legible*, because in an extraction shooter the
 * lesson matters more than the number. A death shows what it cost and what
 * insurance may claw back; a successful run shows what the raid was actually
 * worth once you account for what you took in with you.
 *
 * The net figure is the honest one: bringing 200k of gear out of a raid you
 * started with 190k of gear is not a 200k payday, and the screen says so.
 */
export class ResultsScreen implements Screen {
  readonly id = 'results';
  readonly root: HTMLElement;
  private body: HTMLElement;
  private subtitleEl: HTMLElement;

  private result: RaidResult | null = null;
  private riskValue = 0;

  constructor(
    private readonly profile: Profile,
    private readonly actions: { onContinue: () => void },
  ) {
    const shell = screenShell('Einsatzbericht', '', null);
    this.root = shell.root;
    this.body = shell.body;
    this.subtitleEl = shell.subtitleEl;
    this.body.style.flexDirection = 'column';
  }

  /** `riskValue` is the loadout value measured before the raid started. */
  present(result: RaidResult, riskValue: number): void {
    this.result = result;
    this.riskValue = riskValue;
  }

  onShow(): void {
    this.render();
  }

  private render(): void {
    const result = this.result;
    if (!result) return;
    clear(this.body);

    this.subtitleEl.textContent = result.reason;

    const net = result.survived ? result.lootValue - this.riskValue : result.lootValue - this.riskValue;

    this.body.appendChild(
      el('div', {
        class: `result-banner ${result.survived ? 'survived' : 'died'}`,
        text: result.survived ? 'Extrahiert' : 'Im Sektor gefallen',
      }),
    );

    const tile = (key: string, value: string, color?: string): HTMLElement =>
      el('div', { class: 'result-tile' }, [
        el('div', { class: 'k', text: key }),
        el('div', { class: 'v', text: value, style: color ? { color } : {} }),
      ]);

    // Landscape phones are wide and short, so the tiles and the written
    // evaluation sit side by side rather than stacked - stacking left the
    // evaluation squeezed into a few pixels.
    const columns = el('div', {
      // overflow:hidden is load-bearing: without it a tall tile grid spills
      // over the action button underneath and swallows its taps.
      style: { display: 'flex', gap: '10px', flex: '1 1 auto', minHeight: '0', overflow: 'hidden' },
    });

    columns.appendChild(
      el('div', {
        class: 'result-grid',
        style: { flex: '1.1', alignContent: 'start', overflowY: 'auto', minHeight: '0' },
      }, [
        tile('Dauer', duration(result.durationSec)),
        tile('Ausschaltungen', String(result.kills)),
        tile('Erfahrung', `+${result.xpEarned}`, '#c8913a'),
        tile(
          result.survived ? 'Herausgebracht' : 'Gesichert',
          money(result.lootValue),
          result.survived ? '#4f9e6a' : '#8b95a3',
        ),
        tile('Eingesetzt', money(this.riskValue)),
        result.survived
          ? tile('Netto', `${net >= 0 ? '+' : ''}${money(net)}`, net >= 0 ? '#4f9e6a' : '#b8453a')
          : tile('Verloren', money(result.lostValue), '#b8453a'),
      ]),
    );

    this.body.appendChild(columns);

    // --- narrative detail ---------------------------------------------------
    const detail = el('div', { class: 'panel', style: { flex: '1', minHeight: '0' } }, [
      el('div', { class: 'panel-head' }, [el('span', { text: 'Auswertung' })]),
    ]);
    const detailBody = el('div', { class: 'panel-body' });

    if (result.extractName) {
      detailBody.appendChild(
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Ausgang' }),
          el('span', { class: 'value good', text: result.extractName }),
        ]),
      );
    }

    if (result.eventsSeen.length > 0) {
      detailBody.appendChild(
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Ereignisse' }),
          el('span', { class: 'value', text: String(result.eventsSeen.length) }),
        ]),
      );
    }

    const p = this.profile;
    detailBody.appendChild(
      el('div', { style: { marginTop: '12px' } }, [
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Einsätze gesamt' }),
          el('span', { class: 'value', text: String(p.raids) }),
        ]),
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Rückkehrquote' }),
          el('span', { class: 'value', text: `${Math.round(p.survivalRate * 100)} %` }),
        ]),
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Bester Einzelertrag' }),
          el('span', { class: 'value', text: money(p.bestHaul) }),
        ]),
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Stufe' }),
          el('span', { class: 'value', text: String(p.progression.level) }),
        ]),
      ]),
    );

    if (!result.survived) {
      const covered = p.insurance.inTransit.length;
      detailBody.appendChild(
        el('div', {
          class: 'sub',
          style: { marginTop: '14px', color: '#8b95a3', lineHeight: '1.55' },
          text:
            covered > 0
              ? `${covered} versicherte Gegenstände sind auf dem Rückweg. Sie treffen im Versteck ein, ` +
                'sobald genug Zeit vergangen ist - für den nächsten Einsatz brauchst du eine Alternative.'
              : 'Nichts war versichert. Was du dabei hattest, ist weg. Beim nächsten Mal lohnt sich die Prämie.',
        }),
      );
    } else {
      detailBody.appendChild(
        el('div', {
          class: 'sub',
          style: { marginTop: '14px', color: '#8b95a3', lineHeight: '1.55' },
          text:
            'Beute liegt in deiner Ausrüstung. Im Versteck kannst du sie ins Lager übernehmen, ' +
            'verkaufen oder für Ausbau und Fertigung verwenden.',
        }),
      );
    }

    detail.appendChild(detailBody);
    columns.appendChild(detail);

    this.body.appendChild(
      el('div', { style: { marginTop: '10px', display: 'flex', justifyContent: 'center', flex: '0 0 auto' } }, [
        button('Zurück ins Versteck', () => this.actions.onContinue(), 'btn primary'),
      ]),
    );
  }
}
