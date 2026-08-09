import { clear, cssVar, el } from '../Dom';
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

  /**
   * The impassable ground that bounds the site, computed once per raid.
   *
   * Drawn whether or not it has been explored, on the same reasoning the zone
   * ratings already use: this is a briefed operation, and the shape of the
   * place - a channel on one side, a rock cutting on another - is exactly what
   * you would have been shown beforehand. What exploration reveals is the
   * contents, not the coastline.
   *
   * Without it the map screen presented the location as a bare rectangle with
   * some boxes inside, which is the same "square playfield" impression the
   * world geometry was rebuilt to get rid of - undone on the one screen a
   * player studies rather than glances at.
   */
  private outline: Uint8Array | null = null;

  /**
   * Flood the solid mass inwards from the map edge.
   *
   * Everything the fill reaches is boundary: the border bands, and any rock or
   * container stack piled against them. Buildings in the interior are not
   * connected to the edge, so they stay hidden until they are found.
   */
  private computeOutline(map: RaidSession['map']): Uint8Array {
    const w = map.width;
    const h = map.height;
    const out = new Uint8Array(w * h);
    const stack: number[] = [];
    const push = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = y * w + x;
      if (out[i] || !map.isSolid(x, y)) return;
      out[i] = 1;
      stack.push(i);
    };
    for (let x = 0; x < w; x++) {
      push(x, 0);
      push(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      push(0, y);
      push(w - 1, y);
    }
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      push(x - 1, y);
      push(x + 1, y);
      push(x, y - 1);
      push(x, y + 1);
    }
    return out;
  }

  constructor(actions: { onClose: () => void }) {
    const shell = screenShell('Sektorkarte', '', () => actions.onClose());
    this.root = shell.root;
    this.subtitleEl = shell.subtitleEl;

    this.canvas = el('canvas', { class: 'map-canvas' });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable for the map');
    this.ctx = ctx;

    // A key beside the map, in the space a square map leaves in a landscape
    // panel.
    //
    // Locations carry up to sixteen named districts now, and at phone scale a
    // 160-tile map gives about two pixels per tile - a twenty-tile building is
    // under forty pixels wide, which does not hold "Sanitätsstation" at any
    // legible size. Measuring the text (see `draw`) stopped labels colliding,
    // but it stopped them by drawing almost none of them, and districts the
    // player cannot read are districts that may as well not be named.
    //
    // Numbering on the map and naming in a list fixes both: every district is
    // readable, the numbers stay legible at two pixels a tile, and the list
    // fills horizontal space that a square map was wasting anyway.
    this.legendEl = el('div', { class: 'map-legend' });

    shell.body.appendChild(
      el('div', { class: 'panel', style: { flex: '1' } }, [
        el('div', {
          class: 'panel-body',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' },
        }, [
          this.canvas,
          this.legendEl,
        ]),
      ]),
    );
  }

  private readonly legendEl: HTMLElement;

  /**
   * The key beside the map: only the districts too small to label in place.
   *
   * Deliberately not a list of everything. A district whose name is already
   * drawn on the map does not need a second entry, and a key that repeats what
   * is already legible makes the player check twice.
   */
  private renderLegend(entries: { index: number; name: string; danger: number }[]): void {
    clear(this.legendEl);
    this.legendEl.style.display = entries.length > 0 ? 'flex' : 'none';
    if (entries.length === 0) return;

    for (const entry of entries) {
      const tone = entry.danger > 0.6
        ? 'var(--bad)'
        : entry.danger > 0.35 ? 'var(--warn)' : 'var(--text-faint)';
      this.legendEl.appendChild(
        el('div', { class: 'map-legend-row' }, [
          el('span', { class: 'n', text: String(entry.index) }),
          el('span', { class: 'label' }, [
            el('div', { class: 'name', text: entry.name }),
            el('div', { class: 'risk', style: { color: tone }, text: dangerLabel(entry.danger) }),
          ]),
        ]),
      );
    }
  }

  bind(session: RaidSession): void {
    this.session = session;
    this.explored = new Uint8Array(session.map.width * session.map.height);
    // Dropped rather than resized: two locations can share a size, and a
    // cached outline from the previous raid would draw the wrong coastline.
    this.outline = null;
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
    if (!this.outline || this.outline.length !== map.width * map.height) {
      this.outline = this.computeOutline(map);
    }
    const outline = this.outline;

    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = y * map.width + x;
        if (explored[i] === 0) {
          // The boundary is always drawn, so the site has its real outline
          // from the first second of the raid rather than a rectangle.
          if (outline[i] === 0) continue;
          ctx.fillStyle = cssVar('--line');
          ctx.globalAlpha = 0.5;
          ctx.fillRect(x * scale, y * scale, scale, scale);
          ctx.globalAlpha = 1;
          continue;
        }
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
    // Numbering runs over the interior districts only; the outer ring is the
    // ground everything sits on, not a place you navigate to.
    let index = 0;
    const legend: { index: number; name: string; danger: number }[] = [];

    for (const zone of map.zones) {
      if (zone.interior) index++;
      // The outer zone spans the entire location. Washing and stroking it drew
      // a rectangle around everything, which is exactly the impression the
      // boundary work exists to remove - so it contributes its ranking to the
      // legend and nothing to the picture.
      if (!zone.interior) continue;
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

      // Name and rating, drawn only where they actually fit inside the zone.
      //
      // The test used to be on the zone's size in tiles - at least 12 by 6 -
      // which is not the same question. Once locations grew to sixteen named
      // districts on a 160-tile map, plenty of zones cleared that bar while
      // being far too small for two lines of type, so labels spilled past
      // their own rectangles and collided with their neighbours'. A label
      // sitting over the wrong district is worse than no label.
      //
      // Measuring the glyphs answers the real question, and it also solves the
      // collisions for free: text that stays inside its own rectangle can only
      // overlap as much as the rectangles do, which is not at all.
      const font = Math.max(8, Math.min(13, scale * 2.2));
      ctx.font = `${font}px sans-serif`;
      const pad = 3;
      const nameWidth = ctx.measureText(zone.name).width;

      if (!zone.interior) {
        // The outer ring is the ground everything else sits on. Its label
        // always fits - it is the whole map - so it was being drawn across
        // whichever district happened to occupy the top-left corner, and the
        // header already says which zone the player is standing in.
      } else if (nameWidth + pad * 2 <= zw && font + pad * 2 <= zh) {
        // Room for the real thing.
        ctx.fillStyle = cssVar('--text-dim');
        ctx.fillText(zone.name, x + pad, y + font + pad);

        const rating = dangerLabel(zone.danger);
        if (font * 2 + pad * 3 <= zh && ctx.measureText(rating).width + pad * 2 <= zw) {
          ctx.fillStyle = heat > 0.6
            ? cssVar('--bad')
            : heat > 0.35 ? cssVar('--warn') : cssVar('--text-faint');
          ctx.fillText(rating, x + pad, y + font * 2 + pad * 2);
        }
      } else if (zone.interior) {
        // Too small for the name: number it and let the key carry the rest.
        // A digit stays legible far below the width a word needs.
        const marker = String(index);
        const mw = ctx.measureText(marker).width;
        if (mw + 2 <= zw && font <= zh) {
          ctx.fillStyle = cssVar('--text');
          ctx.fillText(marker, x + (zw - mw) / 2, y + (zh + font * 0.7) / 2);
        }
        legend.push({ index, name: zone.name, danger: zone.danger });
      }
    }

    this.renderLegend(legend);

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
