/**
 * Generate the app icons and the web manifest.
 *
 * PNGs are written by hand rather than pulled from a library: the project has
 * no runtime dependencies and adding an image toolchain to draw two squares
 * and a triangle would be the largest dependency in the repository. A PNG is a
 * signature, three chunks and a zlib stream, and Node ships zlib.
 *
 * Why PNG at all, when the favicon is an inline SVG? Because Android's install
 * prompt is the one consumer that has never reliably accepted SVG icons. The
 * home-screen icon is the difference between an app and a bookmark, and it is
 * not worth gambling on format support.
 *
 * Run: node scripts/build-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

// --- brand ----------------------------------------------------------------

const BG = [0x0b, 0x0d, 0x10];
const ACCENT = [0xc8, 0x91, 0x3a];
const DIM = [0x3d, 0x46, 0x53];

// ---------------------------------------------------------------------------
// Minimal PNG writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput), data.length + 8);
  return out;
}

/** `rgba` is a Uint8Array of size*size*4. */
function encodePng(size, rgba) {
  // Each scanline is prefixed with a filter byte; 0 means "no filter", which
  // costs a little size and saves a lot of code.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

/**
 * A chevron over a dot: a bearing marker with a contact under it. Drawn with
 * signed-distance tests and 3x3 supersampling, because at 192 px a hard-edged
 * diagonal reads as a staircase.
 *
 * `maskable` insets the mark so Android can crop it to a circle without
 * clipping anything - the safe zone is the middle 80 %.
 */
function drawIcon(size, { maskable = false } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  const inset = maskable ? 0.19 : 0.12;
  const s = size;
  const SS = 3;

  const put = (i, [r, g, b], a) => {
    // Source-over onto whatever is already there.
    const ia = 1 - a;
    rgba[i] = rgba[i] * ia + r * a;
    rgba[i + 1] = rgba[i + 1] * ia + g * a;
    rgba[i + 2] = rgba[i + 2] * ia + b * a;
    rgba[i + 3] = 255;
  };

  // Chevron: two strokes meeting at an apex.
  const apexX = 0.5;
  const apexY = inset + 0.06;
  const footY = 1 - inset - 0.30;
  const halfW = 0.5 - inset - 0.02;
  const stroke = 0.085;

  const distToSegment = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  };

  const dotX = 0.5;
  const dotY = 1 - inset - 0.13;
  const dotR = 0.085;

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      // Ground.
      rgba[i] = BG[0];
      rgba[i + 1] = BG[1];
      rgba[i + 2] = BG[2];
      rgba[i + 3] = 255;

      let chevron = 0;
      let dot = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / s;
          const v = (y + (sy + 0.5) / SS) / s;
          const dLeft = distToSegment(u, v, apexX, apexY, apexX - halfW, footY);
          const dRight = distToSegment(u, v, apexX, apexY, apexX + halfW, footY);
          if (Math.min(dLeft, dRight) < stroke * 0.5) chevron++;
          if (Math.hypot(u - dotX, v - dotY) < dotR) dot++;
        }
      }
      const n = SS * SS;
      if (chevron > 0) put(i, ACCENT, chevron / n);
      if (dot > 0) put(i, dot === n ? ACCENT : DIM, dot / n);
    }
  }

  return rgba;
}

// ---------------------------------------------------------------------------

mkdirSync(PUBLIC, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
];

for (const target of targets) {
  const png = encodePng(target.size, drawIcon(target.size, { maskable: target.maskable }));
  writeFileSync(join(PUBLIC, target.file), png);
  console.log(`${target.file}  ${target.size}x${target.size}  ${(png.length / 1024).toFixed(1)} kB`);
}

const manifest = {
  name: 'GRAYZONE PROTOCOL',
  short_name: 'Grayzone',
  description: 'Mobiler PvE-Extraction-Shooter. Offline, ohne Server.',
  lang: 'de',
  start_url: './',
  scope: './',
  // `fullscreen` rather than `standalone`: on Android this removes the status
  // bar as well, which is 24 dp of a 390 dp-tall landscape viewport.
  display: 'fullscreen',
  display_override: ['fullscreen', 'standalone'],
  orientation: 'landscape',
  background_color: '#0b0d10',
  theme_color: '#0b0d10',
  categories: ['games'],
  icons: [
    { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

writeFileSync(join(PUBLIC, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('manifest.webmanifest');
