import { cssVar, el } from '../Dom';
import { screenShell, type Screen } from '../ScreenManager';
import type { RaidSession } from '../../raid/RaidSession';
import { TILE_DEFS } from '../../world/TileMap';

/**
 * MapScreen - a hand-drawn-feeling sector map, not a live radar.
 *
 * Two rules keep the map from deleting the tension:
 *
 *   1. **It shows terrain, not people.** No enemy markers, ever. Knowing where
 *      contacts are is what your ears are for.
 *   2. **It only shows what you have seen.** Tiles are revealed as you move
 *      through them, so the first raid on a layout is genuinely exploratory
 *      and route knowledge is something you earn.
 *
 * Extractions appear once discovered, because forgetting where the exit was
 * is frustrating rather than tense.
 */
export class MapScreen implements Screen {
  readonly id = 'map';
  readonly root: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private subtitleEl: HTMLElement;
  private session: RaidSession | null = null;

  /** Per-tile explored flag, sized on bind. */
  private explored: Uint8Array | null = null;

  constructor(actions: { onClose: () => void }) {
    const shell = screenShell('Sektorkarte', '', () => actions.onClose());
    this.root = shell.root;
    this.subtitleEl = shell.subtitleEl;

    this.canvas = el('canvas', { class: 'map-canvas' });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable for the map');
    this.ctx = ctx;

    shell.body.appendChild(
      el('div', { class: 'panel', style: { flex: '1' } }, [
        el('div', { class: 'panel-body', style: { display: 'flex', alignItems: 'center', justifyContent: 'center' } }, [
          this.canvas,
        ]),
      ]),
    );
  }

  bind(session: RaidSession): void {
    this.session = session;
    this.explored = new Uint8Array(session.map.width * session.map.height);
  }

  /**
   * Reveal terrain around the player. Called every simulation tick from the
   * game loop, not just while the map is open, so the map reflects the route
   * actually walked.
   */
  reveal(session: RaidSession, radius = 11): void {
    const explored = this.explored;
    if (!explored) return;
    const map = session.map;
    const cx = Math.floor(session.player.x);
    const cy = Math.floor(session.player.y);
    const r2 = radius * radius;

    for (let y = Math.max(0, cy - radius); y <= Math.min(map.height - 1, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(map.width - 1, cx + radius); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        explored[y * map.width + x] = 1;
      }
    }
  }

  onShow(): void {
    this.draw();
  }

  onTick(): void {
    this.draw();
  }

  onBack(): boolean {
    return false;
  }

  private draw(): void {
    const session = this.session;
    const explored = this.explored;
    if (!session || !explored) return;

    const map = session.map;
    // Render at the size it will actually be shown at, in device pixels.
    //
    // This used to draw at a fixed four pixels per tile and let CSS resize the
    // result, which was fine while the map was only coloured squares. It stops
    // being fine the moment there is type on it: a 384px canvas resampled down
    // to 294 drops roughly a quarter of every glyph, and `image-rendering:
    // pixelated` makes that worse rather than better by refusing to blend.
    //
    // Matching the backing store to the display means the zone names are drawn
    // once, at their real size, and never resampled.
    const availableW = Math.max(160, window.innerWidth - 90);
    const availableH = Math.max(120, window.innerHeight - 120);
    const display = Math.min(availableW, availableH);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const w = Math.round(display * dpr);
    const h = Math.round((w * map.height) / map.width);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const scale = w / map.width;
    this.canvas.style.width = `${display}px`;
    this.canvas.style.height = `${(display * map.height) / map.width}px`;

    const ctx = this.ctx;
    ctx.fillStyle = cssVar('--bg-0');
    ctx.fillRect(0, 0, w, h);

    // --- terrain -----------------------------------------------------------
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = y * map.width + x;
        if (explored[i] === 0) continue;
        const tile = map.tiles[i];
        const def = TILE_DEFS[tile];
        let color: string;
        if (def.wall) {
          color = def.opaque ? cssVar('--line-bright') : cssVar('--line');
        } else if (map.isIndoors(x, y)) {
          color = cssVar('--bg-3');
        } else {
          color = cssVar('--bg-2');
        }
        ctx.fillStyle = color;
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }

    // --- zone ratings --------------------------------------------------------
    //
    // The whole risk-reward loop runs on zone danger: it sets loot rarity, how
    // many hostiles spawn and how good they are. All of that machinery existed
    // and none of it was visible, so "go deeper for better loot" was something
    // a player could only discover by dying in the wrong place. A decision the
    // player cannot see the terms of is not a decision.
    //
    // Ratings are shown for every zone, explored or not, on purpose. This is a
    // briefed operation - you would know a sector's reputation before going in
    // - and it is the *contents* that exploration reveals, not the reputation.
    // Hiding the rating would not create tension, only ignorance.
    for (const zone of map.zones) {
      const x = zone.x0 * scale;
      const y = zone.y0 * scale;
      const zw = (zone.x1 - zone.x0 + 1) * scale;
      const zh = (zone.y1 - zone.y0 + 1) * scale;

      // A wash whose weight follows the danger, so the hot parts of the map
      // read at a glance without any of it being unreadable.
      const heat = Math.min(1, zone.danger);
      ctx.fillStyle = `rgba(196, 74, 52, ${0.05 + heat * 0.20})`;
      ctx.fillRect(x, y, zw, zh);
      ctx.strokeStyle = `rgba(196, 74, 52, ${0.16 + heat * 0.34})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, zw - 1, zh - 1);

      // Name and rating, but only where the zone is big enough to carry them.
      // A label spilling past its own zone points at the wrong place, which is
      // worse than no label.
      if (zw > scale * 12 && zh > scale * 6) {
        const font = Math.max(8, Math.min(13, scale * 2));
        ctx.font = `${font}px sans-serif`;
        ctx.fillStyle = cssVar('--text-dim');
        ctx.fillText(zone.name, x + 4, y + font + 2);
        ctx.fillStyle = heat > 0.6 ? cssVar('--bad') : heat > 0.35 ? cssVar('--warn') : cssVar('--text-faint');
        ctx.fillText(dangerLabel(zone.danger), x + 4, y + font * 2 + 4);
      }
    }

    // --- extraction markers -------------------------------------------------
    for (const ex of session.extraction.extracts) {
      if (!ex.discovered) continue;
      ctx.fillStyle = ex.available ? cssVar('--good') : cssVar('--info');
      const px = ex.def.x * scale;
      const py = ex.def.y * scale;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(3, scale * 1.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = cssVar('--text');
      ctx.font = `${Math.max(9, scale * 2)}px sans-serif`;
      ctx.fillText(ex.def.name, px + scale * 2, py + scale);
    }

    // --- active event markers -----------------------------------------------
    for (const marker of session.events.markers()) {
      ctx.fillStyle = cssVar('--accent');
      ctx.beginPath();
      ctx.arc(marker.x * scale, marker.y * scale, Math.max(3, scale), 0, Math.PI * 2);
      ctx.fill();
    }

    // --- searched containers you have already been through -------------------
    for (const container of session.loot.containers) {
      if (!container.searched) continue;
      const i = Math.floor(container.y) * map.width + Math.floor(container.x);
      if (explored[i] === 0) continue;
      ctx.fillStyle = 'rgba(140,150,165,0.5)';
      ctx.fillRect(container.x * scale - 1, container.y * scale - 1, 2, 2);
    }

    // --- the player ---------------------------------------------------------
    const px = session.player.x * scale;
    const py = session.player.y * scale;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(session.player.angle);
    ctx.fillStyle = cssVar('--accent');
    ctx.beginPath();
    ctx.moveTo(scale * 2.2, 0);
    ctx.lineTo(-scale * 1.2, -scale * 1.3);
    ctx.lineTo(-scale * 1.2, scale * 1.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Zone label under the cursor position, so the map teaches the map's names.
    const zone = map.zoneAt(Math.floor(session.player.x), Math.floor(session.player.y));
    const exploredCount = countExplored(explored);
    const percent = Math.round((exploredCount / explored.length) * 100);
    this.subtitleEl.textContent =
      `${session.generated.displayName}  ·  Position: ${zone?.name ?? 'Freifläche'}  ·  ${percent} % erkundet`;
  }
}

function countExplored(explored: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < explored.length; i++) n += explored[i];
  return n;
}

/**
 * A zone's danger as words rather than a number.
 *
 * Four steps, because that is as many distinctions as a player can act on
 * while moving: two would not separate "worth it" from "not", and a percentage
 * would invite arithmetic nobody does mid-raid.
 */
function dangerLabel(danger: number): string {
  if (danger >= 0.75) return 'Sehr gefährlich · beste Beute';
  if (danger >= 0.5) return 'Gefährlich · gute Beute';
  if (danger >= 0.32) return 'Umkämpft';
  return 'Ruhig · wenig zu holen';
}
