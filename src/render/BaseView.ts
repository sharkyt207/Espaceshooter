import { cssVar } from '../ui/Dom';
import type { ModuleId } from '../meta/Hideout';

/**
 * BaseView - the hideout drawn as a place instead of listed as rows.
 *
 * A list of six modules with an "upgrade" button next to each tells you the
 * same facts, and none of the same story. A cutaway does two things a list
 * cannot: it shows the base as a single object that visibly fills out as you
 * invest in it, and it makes the *cost* of neglect legible - an unbuilt room
 * is a dark hole in your home, not a greyed-out row.
 *
 * Drawn as a cross-section, the way a bunker or an ant farm reads: rock
 * around the outside, rooms cut into it, cables and pipes running between
 * them. Every room has three states and each is drawn differently rather than
 * tinted differently:
 *
 *   - **unbuilt**  bare rock, rubble on the floor, no light
 *   - **building** scaffolding, work lamp, a progress bar in the floor
 *   - **built**    lit, and furnished with equipment specific to that module
 *
 * Contents are what make it worth looking at. A generator room with a running
 * engine and a storage room with full shelves are recognisably different
 * places, and at level three they are visibly busier than at level one.
 */

export interface RoomState {
  id: ModuleId;
  name: string;
  level: number;
  maxLevel: number;
  /** 0..1 while building, -1 when idle. */
  buildProgress: number;
  buildingLevel: number;
  /** Powered rooms go dark when the generator is not running. */
  powered: boolean;
}

export interface RoomHit {
  id: ModuleId;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Grid layout, in cells. Two rows of three. */
const LAYOUT: { id: ModuleId; col: number; row: number }[] = [
  { id: 'generator', col: 0, row: 1 },
  { id: 'stash', col: 1, row: 0 },
  { id: 'workshop', col: 2, row: 0 },
  { id: 'medstation', col: 1, row: 1 },
  { id: 'kitchen', col: 2, row: 1 },
  { id: 'security', col: 0, row: 0 },
];

const COLS = 3;
const ROWS = 2;

export class BaseView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private hits: RoomHit[] = [];
  private time = 0;

  /** Called with the module the player tapped. */
  onSelect: (id: ModuleId) => void = () => {};

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'base-canvas';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;

    this.canvas.addEventListener('pointerdown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scale = this.canvas.width / rect.width;
      const x = (e.clientX - rect.left) * scale;
      const y = (e.clientY - rect.top) * scale;
      for (const hit of this.hits) {
        if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
          this.onSelect(hit.id);
          return;
        }
      }
    });
  }

  /**
   * Resize to the element's box. Returns true when the size actually changed,
   * so the caller can avoid a redraw it does not need.
   */
  resize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(160, Math.floor(rect.width * dpr));
    const h = Math.max(120, Math.floor(rect.height * dpr));
    if (w === this.canvas.width && h === this.canvas.height) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  render(rooms: Map<ModuleId, RoomState>, selected: ModuleId | null, time: number): void {
    this.time = time;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.hits = [];

    drawRock(ctx, w, h);

    // Room grid with a margin for the rock shell.
    const padX = w * 0.045;
    const padY = h * 0.07;
    const gapX = w * 0.028;
    const gapY = h * 0.07;
    const cellW = (w - padX * 2 - gapX * (COLS - 1)) / COLS;
    const cellH = (h - padY * 2 - gapY * (ROWS - 1)) / ROWS;

    // Corridors first, so rooms sit on top of them.
    drawCorridors(ctx, padX, padY, cellW, cellH, gapX, gapY);

    for (const slot of LAYOUT) {
      const state = rooms.get(slot.id);
      if (!state) continue;
      const x = padX + slot.col * (cellW + gapX);
      const y = padY + slot.row * (cellH + gapY);
      this.hits.push({ id: slot.id, x, y, w: cellW, h: cellH });
      drawRoom(ctx, state, x, y, cellW, cellH, slot.id === selected, this.time);
    }
  }
}

// ===========================================================================
// Environment
// ===========================================================================

function drawRock(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#14161b');
  grad.addColorStop(1, '#0a0b0e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Strata: the ground the base is cut into. Deterministic from y alone so it
  // does not crawl between frames.
  ctx.strokeStyle = 'rgba(255,255,255,0.022)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    const y = (i / 26) * h + Math.sin(i * 2.7) * h * 0.012;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += w / 8) {
      ctx.lineTo(x, y + Math.sin(x * 0.01 + i) * h * 0.006);
    }
    ctx.stroke();
  }
}

/** Passages between rooms, and the trunk that carries power down from the generator. */
function drawCorridors(
  ctx: CanvasRenderingContext2D,
  padX: number,
  padY: number,
  cellW: number,
  cellH: number,
  gapX: number,
  gapY: number,
): void {
  ctx.fillStyle = cssVar('--bg-2');
  // Horizontal links.
  for (let row = 0; row < ROWS; row++) {
    const y = padY + row * (cellH + gapY) + cellH * 0.62;
    for (let col = 0; col < COLS - 1; col++) {
      const x = padX + col * (cellW + gapX) + cellW;
      ctx.fillRect(x, y, gapX, cellH * 0.16);
    }
  }
  // Vertical links.
  for (let col = 0; col < COLS; col++) {
    const x = padX + col * (cellW + gapX) + cellW * 0.42;
    ctx.fillRect(x, padY + cellH, cellW * 0.16, gapY);
  }
}

// ===========================================================================
// Rooms
// ===========================================================================

function drawRoom(
  ctx: CanvasRenderingContext2D,
  state: RoomState,
  x: number,
  y: number,
  w: number,
  h: number,
  selected: boolean,
  time: number,
): void {
  const built = state.level > 0;
  const building = state.buildProgress >= 0;
  const lit = built && state.powered;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // --- shell ---------------------------------------------------------------
  ctx.fillStyle = built ? '#1b1f26' : '#101216';
  ctx.fillRect(x, y, w, h);

  if (lit) {
    // A ceiling lamp, and the pool of light it throws. This is what separates
    // a finished room from a hole at a glance.
    const lamp = ctx.createRadialGradient(x + w * 0.5, y + h * 0.12, 1, x + w * 0.5, y + h * 0.12, h * 1.15);
    lamp.addColorStop(0, 'rgba(255,214,150,0.30)');
    lamp.addColorStop(0.5, 'rgba(255,196,120,0.09)');
    lamp.addColorStop(1, 'rgba(255,180,90,0)');
    ctx.fillStyle = lamp;
    ctx.fillRect(x, y, w, h);
  }

  // Floor.
  ctx.fillStyle = built ? '#232830' : '#15171c';
  ctx.fillRect(x, y + h * 0.82, w, h * 0.18);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x, y + h * 0.82, w, 2);

  if (!built && !building) drawRubble(ctx, x, y, w, h);
  if (built) drawFurniture(ctx, state, x, y, w, h, time);
  if (building) drawScaffolding(ctx, state, x, y, w, h);

  // --- vignette so rooms read as recessed ----------------------------------
  const vig = ctx.createRadialGradient(x + w * 0.5, y + h * 0.5, h * 0.25, x + w * 0.5, y + h * 0.5, h * 0.9);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vig;
  ctx.fillRect(x, y, w, h);

  // Drawn inside the clip: a room name is often wider than its room, and an
  // unclipped label writes straight across the neighbouring room.
  drawLabel(ctx, state, x, y, w, h, built);

  ctx.restore();

  // --- frame ---------------------------------------------------------------
  ctx.strokeStyle = selected ? cssVar('--accent') : built ? '#39414d' : '#23272f';
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function drawRubble(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = cssVar('--bg-2');
  for (let i = 0; i < 9; i++) {
    const rx = x + ((i * 37) % 100) / 100 * w * 0.9 + w * 0.05;
    const rw = w * (0.04 + ((i * 13) % 7) / 100);
    const rh = h * (0.03 + ((i * 7) % 5) / 100);
    ctx.fillRect(rx, y + h * 0.82 - rh, rw, rh);
  }
  // Bare rock face where the room has not been cut out yet.
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(x + w * (0.1 + i * 0.2), y);
    ctx.lineTo(x + w * (0.02 + i * 0.22), y + h * 0.8);
    ctx.stroke();
  }
}

function drawScaffolding(
  ctx: CanvasRenderingContext2D,
  state: RoomState,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  // Poles and planks.
  ctx.strokeStyle = '#6b5a3a';
  ctx.lineWidth = Math.max(1.5, w * 0.012);
  for (let i = 0; i < 3; i++) {
    const px = x + w * (0.2 + i * 0.3);
    ctx.beginPath();
    ctx.moveTo(px, y + h * 0.2);
    ctx.lineTo(px, y + h * 0.82);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(x + w * 0.14, y + h * 0.46);
  ctx.lineTo(x + w * 0.86, y + h * 0.46);
  ctx.stroke();

  // Work lamp: the only light in an unfinished room.
  const lamp = ctx.createRadialGradient(x + w * 0.78, y + h * 0.3, 1, x + w * 0.78, y + h * 0.3, h * 0.7);
  lamp.addColorStop(0, 'rgba(255,236,190,0.35)');
  lamp.addColorStop(1, 'rgba(255,220,150,0)');
  ctx.fillStyle = lamp;
  ctx.fillRect(x, y, w, h);

  // Progress, cut into the floor so it does not float over the artwork.
  const p = Math.max(0, Math.min(1, state.buildProgress));
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x + w * 0.1, y + h * 0.9, w * 0.8, h * 0.05);
  ctx.fillStyle = cssVar('--accent');
  ctx.fillRect(x + w * 0.1, y + h * 0.9, w * 0.8 * p, h * 0.05);
}

/**
 * What is actually in the room.
 *
 * Each module gets its own furniture, and the amount of it scales with level -
 * so an upgrade is visible in the picture rather than only in a number.
 */
function drawFurniture(
  ctx: CanvasRenderingContext2D,
  state: RoomState,
  x: number,
  y: number,
  w: number,
  h: number,
  time: number,
): void {
  const floor = y + h * 0.82;
  const level = state.level;
  const steel = '#39404a';
  const steelLit = '#4d5560';
  const warm = '#8a6a3a';

  switch (state.id) {
    case 'generator': {
      // Engine block, exhaust, and a flywheel that turns while powered.
      ctx.fillStyle = steel;
      ctx.fillRect(x + w * 0.18, floor - h * 0.34, w * 0.44, h * 0.34);
      ctx.fillStyle = steelLit;
      ctx.fillRect(x + w * 0.18, floor - h * 0.34, w * 0.44, h * 0.05);
      // Exhaust up through the ceiling.
      ctx.fillStyle = cssVar('--bg-3');
      ctx.fillRect(x + w * 0.52, y, w * 0.07, floor - y - h * 0.30);
      // Flywheel.
      const cxw = x + w * 0.70;
      const cyw = floor - h * 0.16;
      const r = h * 0.13;
      ctx.strokeStyle = steelLit;
      ctx.lineWidth = Math.max(1.5, w * 0.014);
      ctx.beginPath();
      ctx.arc(cxw, cyw, r, 0, Math.PI * 2);
      ctx.stroke();
      const spin = state.powered ? time * 2.2 : 0;
      for (let i = 0; i < 4; i++) {
        const a = spin + (i * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(cxw, cyw);
        ctx.lineTo(cxw + Math.cos(a) * r, cyw + Math.sin(a) * r);
        ctx.stroke();
      }
      // Status lamps, one per level.
      for (let i = 0; i < state.maxLevel; i++) {
        ctx.fillStyle = i < level ? '#4f9e6a' : '#2a2f36';
        ctx.beginPath();
        ctx.arc(x + w * (0.24 + i * 0.07), floor - h * 0.28, w * 0.014, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'stash': {
      // Shelving that fills up with level.
      const shelves = 2 + level;
      for (let s = 0; s < shelves; s++) {
        const sy = floor - h * (0.14 + s * 0.19);
        ctx.fillStyle = steel;
        ctx.fillRect(x + w * 0.12, sy, w * 0.76, h * 0.028);
        // Crates on the shelf.
        const crates = 3 + level;
        for (let c = 0; c < crates; c++) {
          const cw = w * 0.11;
          const cx2 = x + w * 0.14 + c * (w * 0.72 / crates);
          const ch = h * (0.07 + ((c + s) % 3) * 0.022);
          ctx.fillStyle = (c + s) % 2 === 0 ? warm : '#5a4a34';
          ctx.fillRect(cx2, sy - ch, cw, ch);
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(cx2, sy - ch, cw, h * 0.012);
        }
      }
      break;
    }
    case 'workshop': {
      // Bench, vice, pegboard of tools.
      ctx.fillStyle = warm;
      ctx.fillRect(x + w * 0.1, floor - h * 0.20, w * 0.8, h * 0.05);
      ctx.fillStyle = steel;
      ctx.fillRect(x + w * 0.14, floor - h * 0.15, w * 0.05, h * 0.15);
      ctx.fillRect(x + w * 0.81, floor - h * 0.15, w * 0.05, h * 0.15);
      // Pegboard.
      ctx.fillStyle = cssVar('--bg-3');
      ctx.fillRect(x + w * 0.16, y + h * 0.20, w * 0.68, h * 0.34);
      ctx.strokeStyle = steelLit;
      ctx.lineWidth = Math.max(1, w * 0.008);
      const tools = 3 + level * 2;
      for (let t = 0; t < tools; t++) {
        const tx = x + w * (0.20 + (t % 6) * 0.11);
        const ty = y + h * (0.25 + Math.floor(t / 6) * 0.13);
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx + w * 0.015, ty + h * 0.09);
        ctx.stroke();
      }
      // Vice on the bench.
      ctx.fillStyle = steelLit;
      ctx.fillRect(x + w * 0.62, floor - h * 0.27, w * 0.1, h * 0.07);
      break;
    }
    case 'medstation': {
      // Examination bed and a cabinet, plus a monitor at higher levels.
      ctx.fillStyle = cssVar('--line-bright');
      ctx.fillRect(x + w * 0.12, floor - h * 0.16, w * 0.5, h * 0.06);
      ctx.fillStyle = cssVar('--text');
      ctx.fillRect(x + w * 0.12, floor - h * 0.19, w * 0.5, h * 0.03);
      ctx.fillStyle = cssVar('--line');
      ctx.fillRect(x + w * 0.16, floor - h * 0.10, w * 0.03, h * 0.10);
      ctx.fillRect(x + w * 0.55, floor - h * 0.10, w * 0.03, h * 0.10);
      // Cabinet with a cross.
      ctx.fillStyle = '#e8ecef';
      ctx.fillRect(x + w * 0.70, floor - h * 0.42, w * 0.18, h * 0.42);
      ctx.fillStyle = '#b8453a';
      ctx.fillRect(x + w * 0.775, floor - h * 0.35, w * 0.03, h * 0.10);
      ctx.fillRect(x + w * 0.755, floor - h * 0.315, w * 0.07, h * 0.03);
      if (level >= 2) {
        ctx.fillStyle = '#12303a';
        ctx.fillRect(x + w * 0.16, y + h * 0.22, w * 0.24, h * 0.16);
        ctx.strokeStyle = '#4f9e6a';
        ctx.lineWidth = Math.max(1, w * 0.008);
        ctx.beginPath();
        // A heartbeat trace, animated.
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          const px = x + w * (0.17 + t * 0.22);
          const beat = Math.sin((t * 6 + time * 2) % (Math.PI * 2));
          const py = y + h * 0.30 - (Math.abs(beat) > 0.92 ? beat * h * 0.05 : 0);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      break;
    }
    case 'kitchen': {
      // Stove, pot, canned goods.
      ctx.fillStyle = steel;
      ctx.fillRect(x + w * 0.12, floor - h * 0.26, w * 0.36, h * 0.26);
      ctx.fillStyle = '#1c2027';
      ctx.fillRect(x + w * 0.16, floor - h * 0.20, w * 0.12, h * 0.12);
      // Burner glow.
      ctx.fillStyle = 'rgba(220,120,50,0.55)';
      ctx.beginPath();
      ctx.arc(x + w * 0.38, floor - h * 0.26, w * 0.035, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#4d5560';
      ctx.fillRect(x + w * 0.33, floor - h * 0.33, w * 0.11, h * 0.07);
      // Shelf of cans.
      ctx.fillStyle = warm;
      ctx.fillRect(x + w * 0.56, floor - h * 0.30, w * 0.34, h * 0.025);
      for (let i = 0; i < 3 + level; i++) {
        ctx.fillStyle = i % 2 ? '#8a8f75' : '#9a7a4a';
        ctx.fillRect(x + w * (0.58 + i * 0.065), floor - h * 0.36, w * 0.045, h * 0.06);
      }
      break;
    }
    case 'security': {
      // A wall of monitors, more of them at higher levels.
      const cols = 2 + level;
      const rows = 2;
      const mw = (w * 0.72) / cols;
      const mh = (h * 0.40) / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const mx = x + w * 0.14 + c * mw;
          const my = y + h * 0.18 + r * mh;
          ctx.fillStyle = '#0d1216';
          ctx.fillRect(mx, my, mw * 0.9, mh * 0.86);
          // Scanline glow, offset per screen so they do not blink in unison.
          const on = ((time * 0.7 + c * 0.4 + r * 0.9) % 3) < 2.4;
          ctx.fillStyle = on ? 'rgba(80,190,140,0.16)' : 'rgba(80,190,140,0.05)';
          ctx.fillRect(mx, my, mw * 0.9, mh * 0.86);
          ctx.strokeStyle = '#2a323b';
          ctx.lineWidth = 1;
          ctx.strokeRect(mx + 0.5, my + 0.5, mw * 0.9 - 1, mh * 0.86 - 1);
        }
      }
      // Desk.
      ctx.fillStyle = steel;
      ctx.fillRect(x + w * 0.1, floor - h * 0.14, w * 0.8, h * 0.05);
      break;
    }
    default:
      break;
  }
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  state: RoomState,
  x: number,
  y: number,
  w: number,
  h: number,
  built: boolean,
): void {
  let size = Math.max(8, Math.round(h * 0.095));
  ctx.textBaseline = 'top';

  // Shrink to fit, then truncate. "Sicherheitszentrale" is nineteen characters
  // in a room a third of a phone wide, so both steps are needed.
  let label = state.name.toUpperCase();
  const available = w * 0.88;
  const setFont = (): void => {
    ctx.font = `600 ${size}px 'DIN Alternate', 'Roboto Condensed', system-ui, sans-serif`;
  };
  setFont();
  while (ctx.measureText(label).width > available && size > 7) {
    size -= 1;
    setFont();
  }
  // Truncate without re-appending inside the loop. Appending the ellipsis on
  // every pass makes the string oscillate between fitting and not fitting, and
  // the loop never terminates - which locks the frame, not just the label.
  if (ctx.measureText(label).width > available) {
    while (label.length > 3 && ctx.measureText(`${label}…`).width > available) {
      label = label.slice(0, -1);
    }
    label = `${label}…`;
  }
  const metrics = ctx.measureText(label);
  const pad = size * 0.4;
  ctx.fillStyle = 'rgba(8,10,13,0.82)';
  ctx.fillRect(x + w * 0.04, y + h * 0.04, metrics.width + pad * 2, size + pad);

  ctx.fillStyle = built ? '#d6dce4' : '#5b6472';
  ctx.fillText(label, x + w * 0.04 + pad, y + h * 0.04 + pad * 0.5);

  // Level pips, bottom right.
  const pipR = Math.max(2, w * 0.012);
  for (let i = 0; i < state.maxLevel; i++) {
    ctx.fillStyle = i < state.level ? cssVar('--accent') : 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.arc(x + w - pipR * 2.5 - i * pipR * 3.2, y + h - pipR * 3, pipR, 0, Math.PI * 2);
    ctx.fill();
  }
}
