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
    // Render at an integer pixel scale so the grid stays crisp, then let CSS
    // stretch the result to fill the panel. On a landscape phone the panel is
    // much wider than it is tall, so rendering at the fitted pixel size would
    // waste most of the screen; `image-rendering: pixelated` keeps the upscale
    // sharp rather than blurry.
    const scale = 4;
    const w = map.width * scale;
    const h = map.height * scale;

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const availableW = Math.max(160, window.innerWidth - 90);
    const availableH = Math.max(120, window.innerHeight - 120);
    const display = Math.min(availableW, availableH);
    this.canvas.style.width = `${display}px`;
    this.canvas.style.height = `${(display * h) / w}px`;

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
