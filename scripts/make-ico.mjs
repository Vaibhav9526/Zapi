#!/usr/bin/env node
/**
 * ZAPI asset generator — regenerates every icon the app ships from one
 * self-contained script (no native modules, no network): the mark is a
 * rounded-square tile with a diagonal #5b7cff → #7b4dff gradient and a
 * bold white "Z". Pure-Node rasterizer (rounded-rect SDF + point-in-poly,
 * 4× supersampling) + zlib PNG encoder + ICO/ICNS container packers.
 *
 *   node scripts/make-ico.mjs
 *
 * Writes (paths match what src/main + package.json already reference):
 *   assets/zapi-icon.svg       vector source of the mark
 *   assets/icon.ico            256/48/32/16 PNG-frame ICO (win tray + build.win.icon)
 *   assets/icons/<N>x<N>.png   16–512 set (tray fallback + build.linux.icon)
 *   assets/icon.png            512 master PNG
 *   assets/tray-icon.png       32px, assets/tray-icon@2x.png 64px
 *   assets/icon.icns           mac bundle icon (referenced by build.mac.icon)
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// ── Mark geometry (normalized 0..1 over the tile) ───────────────────

const GRAD_A = [0x5b, 0x7c, 0xff]; // top-left
const GRAD_B = [0x7b, 0x4d, 0xff]; // bottom-right
const TILE_R = 0.22; // corner radius as a fraction of tile size

/**
 * "Z" as a single polygon: top bar, diagonal down-left, bottom bar.
 * `t` is the stroke weight; small sizes get a heavier stroke so the
 * glyph survives 16px rasterization.
 */
function zPolygon(t) {
  const x0 = 0.26, x1 = 0.74, y0 = 0.24, y1 = 0.76;
  // Horizontal offset of the diagonal edges — keeps the diagonal's
  // perceived weight close to the bar thickness.
  const d = t * ((x1 - x0) / (y1 - y0)) * 0.95;
  return [
    [x0, y0], [x1, y0], [x1, y0 + t], [x0 + d, y1 - t],
    [x1, y1 - t], [x1, y1], [x0, y1], [x0, y1 - t],
    [x1 - d, y0 + t], [x0, y0 + t],
  ];
}

function pointInPoly(u, v, poly) {
  // Even-odd ray cast along +x.
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Signed distance to the rounded tile, negative inside. */
function tileSDF(u, v, r) {
  const px = Math.abs(u - 0.5) - (0.5 - r);
  const py = Math.abs(v - 0.5) - (0.5 - r);
  const ax = Math.max(px, 0), ay = Math.max(py, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(px, py), 0) - r;
}

/**
 * One subsample → [r,g,b,a]. Tile is a diagonal gradient with a soft
 * top sheen; the Z is flat white. Everything outside the tile is
 * transparent so the icon sits cleanly on any taskbar.
 */
function shade(u, v, zPoly) {
  const sd = tileSDF(u, v, TILE_R);
  if (sd > 0) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (u + v) / 2));
  const sheen = 0.10 * Math.max(0, 1 - v * 2.4); // gentle light from the top
  const r = GRAD_A[0] + (GRAD_B[0] - GRAD_A[0]) * t;
  const g = GRAD_A[1] + (GRAD_B[1] - GRAD_A[1]) * t;
  const b = GRAD_A[2] + (GRAD_B[2] - GRAD_A[2]) * t;
  // Sheen lightens toward white rather than adding raw brightness.
  const mixW = sheen;
  const cr = r + (255 - r) * mixW;
  const cg = g + (255 - g) * mixW;
  const cb = b + (255 - b) * mixW;
  if (pointInPoly(u, v, zPoly)) return [255, 255, 255, 255];
  return [cr, cg, cb, 255];
}

/**
 * Render at `size` with 4× SSAA. Stroke weight bumps up below 48px so
 * the Z stays legible in the tray.
 */
function render(size) {
  const S = 4;
  const N = size * S;
  const t = size <= 48 ? 0.17 : 0.16;
  const z = zPolygon(t);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x * S + sx + 0.5) / N;
          const v = (y * S + sy + 0.5) / N;
          const [sr, sg, sb, sa] = shade(u, v, z);
          r += sr; g += sg; b += sb; a += sa;
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ── PNG encoder (8-bit RGBA, filter 0) ──────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO / ICNS containers ───────────────────────────────────────────

/** ICO with embedded PNG frames (Vista+). `frames`: [{size, png}]. */
function encodeICO(frames) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const entries = frames.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 256 is encoded as 0
    e[1] = size >= 256 ? 0 : size;
    e[4] = 1; // planes (lo byte)
    e.writeUInt16LE(32, 6); // bit count
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([dir, ...entries, ...frames.map((f) => f.png)]);
}

/** ICNS: 'icns' magic + typed PNG chunks. */
function encodeICNS(pngsBySize) {
  const TYPES = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
  const chunks = Object.entries(pngsBySize).map(([size, png]) => {
    const head = Buffer.alloc(8);
    head.write(TYPES[size], 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const total = 8 + chunks.reduce((s, c) => s + c.length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

// ── SVG source (same geometry as the rasterizer) ────────────────────

function buildSVG() {
  const VB = 1024;
  const z = zPolygon(0.16)
    .map(([x, y]) => `${(x * VB).toFixed(1)},${(y * VB).toFixed(1)}`)
    .join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5b7cff"/>
      <stop offset="1" stop-color="#7b4dff"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${VB}" height="${VB}" rx="${(TILE_R * VB).toFixed(0)}" fill="url(#bg)"/>
  <rect width="${VB}" height="${VB}" rx="${(TILE_R * VB).toFixed(0)}" fill="url(#sheen)"/>
  <polygon points="${z}" fill="#ffffff"/>
</svg>
`;
}

// ── Main ─────────────────────────────────────────────────────────────

const pngCache = new Map();
const png = (size) => {
  if (!pngCache.has(size)) pngCache.set(size, encodePNG(size, render(size)));
  return pngCache.get(size);
};

mkdirSync(join(ASSETS, 'icons'), { recursive: true });

writeFileSync(join(ASSETS, 'zapi-icon.svg'), buildSVG());

for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  writeFileSync(join(ASSETS, 'icons', `${size}x${size}.png`), png(size));
}
writeFileSync(join(ASSETS, 'icon.png'), png(512));
writeFileSync(join(ASSETS, 'tray-icon.png'), png(32));
writeFileSync(join(ASSETS, 'tray-icon@2x.png'), png(64));

writeFileSync(
  join(ASSETS, 'icon.ico'),
  encodeICO([256, 48, 32, 16].map((size) => ({ size, png: png(size) }))),
);

writeFileSync(
  join(ASSETS, 'icon.icns'),
  encodeICNS(Object.fromEntries([16, 32, 64, 128, 256, 512, 1024].map((s) => [s, png(s)]))),
);

console.log('ZAPI assets written to', ASSETS);
for (const [k, v] of [...pngCache.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${k}x${k}  ${v.length} B`);
}
