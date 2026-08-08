import { button, clear, duration, el, money, weight as fmtWeight } from '../Dom';
import { screenShell, type Screen } from '../ScreenManager';
import type { Profile } from '../../meta/Profile';
import { loadoutRiskValue } from '../../meta/Profile';
import { MAP_BLUEPRINTS, MAP_BRIEFINGS, MAP_NIGHT_NOTES } from '../../data/MapData';
import { EQUIP_SLOTS, EQUIP_SLOT_LABEL } from '../../inventory/Inventory';
import { defOf } from '../../inventory/ItemStack';
import { totalRounds } from '../../weapons/WeaponRuntime';
import { TIME_PROFILES, type TimeOfDayId } from '../../world/Conditions';

/**
 * DeployScreen - the last chance to change your mind.
 *
 * Its whole job is to state the stakes plainly before the player commits:
 * which location, how long the raid runs, what they are carrying, what it is
 * worth, and whether it is insured. A player who deploys should never be
 * surprised by what they lost.
 */
export class DeployScreen implements Screen {
  readonly id = 'deploy';
  readonly root: HTMLElement;
  private body: HTMLElement;
  private subtitleEl: HTMLElement;
  private selectedMap = MAP_BLUEPRINTS[0].id;
  private selectedTime: TimeOfDayId = 'day';

  constructor(
    private readonly profile: Profile,
    private readonly actions: {
      onBack: () => void;
      onDeploy: (mapId: string, time: TimeOfDayId) => void;
    },
  ) {
    const shell = screenShell('Einsatzplanung', '', () => actions.onBack());
    this.root = shell.root;
    this.body = shell.body;
    this.subtitleEl = shell.subtitleEl;
  }

  onShow(): void {
    this.render();
  }

  onBack(): boolean {
    this.actions.onBack();
    return true;
  }

  private render(): void {
    clear(this.body);
    const risk = loadoutRiskValue(this.profile.loadout);
    const insuredCount = this.profile.insurance.activeCover.length;
    this.subtitleEl.textContent =
      `Auf dem Spiel: ${money(risk)}  ·  ${insuredCount} Gegenstände versichert`;

    // --- location list -------------------------------------------------------
    const list = el('div', { class: 'panel-body' });
    for (const blueprint of MAP_BLUEPRINTS) {
      const selected = blueprint.id === this.selectedMap;
      const row = el('div', { class: 'list-row clickable' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title', text: blueprint.displayName }),
          el('div', {
            class: 'sub',
            text:
              `${duration(blueprint.raidSeconds)} Einsatzdauer · ` +
              `${blueprint.aiCount} gemeldete Feindkräfte` +
              (blueprint.hasBoss ? ` · ${blueprint.bossName}` : ''),
          }),
          // What kind of place this is, in one line. The locations differ by
          // measured amounts - sightlines from 4.7 to 14.1 tiles, hostile
          // density threefold - and without this the player finds that out by
          // dying in one, which is a poor way to learn a scope was the wrong
          // choice.
          el('div', {
            class: 'sub',
            style: { color: 'var(--text-faint)', marginTop: '2px' },
            text: blueprint.character,
          }),
        ]),
        selected ? el('span', { class: 'tag', style: { borderColor: 'var(--accent)', color: 'var(--accent)' }, text: 'Gewählt' }) : null,
      ].filter(Boolean) as HTMLElement[]);
      if (selected) row.style.borderColor = 'var(--accent)';
      row.addEventListener('click', () => {
        this.selectedMap = blueprint.id;
        this.render();
      });
      list.appendChild(row);
    }

    // --- briefing -------------------------------------------------------------
    const blueprint = MAP_BLUEPRINTS.find((b) => b.id === this.selectedMap)!;
    const briefing = el('div', { class: 'panel-body' });

    // --- time of day ----------------------------------------------------------
    //
    // The player picks the hour and takes what the sky gives them. The bonus is
    // stated up front because the whole decision is "is that worth it to me",
    // and hiding the number would make it guesswork instead of a judgement.
    //
    // It sits above the written briefing rather than below it: on a short
    // landscape phone anything under a paragraph of text is below the fold, and
    // a choice you have to scroll to find is a choice most players never make.
    const timeRow = el('div', { class: 'time-row' });
    for (const profile of TIME_PROFILES) {
      const chosen = profile.id === this.selectedTime;
      const bonus = Math.round((profile.rewardScale - 1) * 100);
      const chip = el('div', { class: `time-chip${chosen ? ' selected' : ''}` }, [
        el('div', { class: 'name', text: profile.label }),
        el('div', { class: 'bonus', text: bonus > 0 ? `+${bonus} %` : 'Grundwert' }),
      ]);
      chip.addEventListener('click', () => {
        this.selectedTime = profile.id;
        this.render();
      });
      timeRow.appendChild(chip);
    }
    const timeProfile = TIME_PROFILES.find((t) => t.id === this.selectedTime)!;
    briefing.append(
      el('div', { class: 'panel-head', style: { border: 'none', padding: '0 0 6px' }, text: 'Absetzzeit' }),
      timeRow,
      el('div', { class: 'sub', style: { marginTop: '8px', color: 'var(--text-dim)' }, text: timeProfile.blurb }),
    );
    if (this.selectedTime !== 'day') {
      briefing.appendChild(
        el('div', {
          class: 'sub',
          style: { marginTop: '6px', color: 'var(--accent)', lineHeight: '1.5' },
          text: MAP_NIGHT_NOTES[blueprint.id] ?? '',
        }),
      );
    }
    briefing.append(
      el('div', {
        class: 'sub',
        style: { marginTop: '6px', color: 'var(--text-faint)' },
        text: 'Das Wetter vor Ort steht erst beim Absetzen fest.',
      }),
      el('div', {
        class: 'panel-head',
        style: { border: 'none', padding: '14px 0 6px' },
        text: blueprint.displayName,
      }),
      el('div', {
        class: 'sub',
        style: { lineHeight: '1.55', color: 'var(--text-dim)' },
        text: MAP_BRIEFINGS[blueprint.id] ?? '',
      }),
    );

    // --- loadout summary ------------------------------------------------------
    const summary = el('div', { class: 'panel-body' });
    for (const slot of EQUIP_SLOTS) {
      const stack = this.profile.loadout.equipped[slot];
      if (!stack) continue;
      const def = defOf(stack);
      const detail = def.weapon ? `${totalRounds(stack)} Schuss geladen` : '';
      summary.appendChild(
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: EQUIP_SLOT_LABEL[slot] }),
          el('span', { class: 'value', text: `${def.shortName}${detail ? ` · ${detail}` : ''}` }),
        ]),
      );
    }

    const stats = this.profile.loadout.stats;
    summary.appendChild(
      el('div', { style: { marginTop: '10px' } }, [
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Gewicht' }),
          el('span', { class: 'value', text: fmtWeight(stats.weight) }),
        ]),
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'label', text: 'Wert im Risiko' }),
          el('span', { class: 'value bad', text: money(risk) }),
        ]),
      ]),
    );

    // Warn about the obvious mistakes before they cost a raid.
    const warnings: string[] = [];
    if (!this.profile.loadout.equipped.primary && !this.profile.loadout.equipped.sidearm) {
      warnings.push('Keine Waffe angelegt.');
    }
    if (!this.profile.loadout.equipped.secure) {
      warnings.push('Kein Sicherheitsbehälter - bei einem Tod geht alles verloren.');
    }
    const hasMeds = this.profile.loadout.findStack((_, def) => def.category === 'med');
    if (!hasMeds) warnings.push('Kein medizinisches Material dabei.');
    const primary = this.profile.loadout.equipped.primary;
    if (primary && defOf(primary).weapon && totalRounds(primary) === 0) {
      warnings.push('Primärwaffe ist nicht geladen.');
    }
    if (insuredCount === 0 && risk > 40000) {
      warnings.push('Nichts versichert bei hohem Ausrüstungswert.');
    }

    if (warnings.length > 0) {
      summary.appendChild(
        el('div', { style: { marginTop: '12px' } }, [
          el('div', { class: 'panel-head', style: { border: 'none', padding: '0 0 4px', color: 'var(--accent)' }, text: 'Hinweise' }),
          ...warnings.map((w) => el('div', { class: 'sub', style: { color: 'var(--accent)' }, text: `• ${w}` })),
        ]),
      );
    }

    this.body.append(
      el('div', { class: 'panel', style: { flex: '1.2' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Einsatzorte' })]),
        list,
      ]),
      el('div', { class: 'panel', style: { flex: '1.2' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Lagebild' })]),
        briefing,
      ]),
      el('div', { class: 'panel', style: { flex: '1' } }, [
        el('div', { class: 'panel-head' }, [el('span', { text: 'Ausrüstung' })]),
        summary,
        el('div', { style: { padding: '10px' } }, [
          button('Absetzen', () => this.actions.onDeploy(this.selectedMap, this.selectedTime), 'btn primary', {
            style: { width: '100%' } as never,
          }),
        ]),
      ]),
    );
  }
}
