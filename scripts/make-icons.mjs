// Generates the extension icons (16/48/128 px): a rounded, gradient badge with
// THREE LANES crossed by one gate bar, the middle lane picked out in amber
// beyond the bar. That is the whole idea in one shape: several identities, one
// place where it is decided which of them a tab belongs to.
//
// Deliberately NOT linkward's fork, even though this repository borrowed that
// script. Two of these sit on the same toolbar, and an icon that has to be
// squinted at to tell it from its neighbour has failed at the only job an icon
// has. Three lanes and a bar survive 16 px, which is the size that decides
// whether an icon works at all.
//
// Pure Node, with a hand-rolled PNG encoder, so the repo has no image
// dependency and nothing has to be installed to rebuild them. Edges are 4×4
// supersampled for clean anti-aliasing. Re-run with `npm run icons`; the output
// is committed so a checkout is a complete extension.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');

// A gate blue rather than a brand colour: this is nobody's product, and blue is
// what the browser itself already uses for "a decision happens here".
const GRAD_TOP = [47, 111, 235]; // #2F6FEB
const GRAD_BOTTOM = [30, 78, 176]; // #1E4EB0
const TILE = [255, 255, 255]; // the lanes and the gate bar
const ACCENT = [255, 203, 0]; // #FFCB00 — the lane that was chosen
const SS = 4; // supersampling factor per axis

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, colorAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = supersample(x, y, size, colorAt);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Average SS×SS sub-samples of the (premultiplied) colour for clean edges.
function supersample(x, y, size, colorAt) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const [cr, cg, cb, ca] = colorAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size);
      const af = ca / 255;
      r += cr * af;
      g += cg * af;
      b += cb * af;
      a += ca;
    }
  }
  const n = SS * SS;
  const alpha = a / n;
  if (alpha === 0) return [0, 0, 0, 0];
  // un-premultiply: straight colour = (Σ colour·αf) · 255 / (Σ α)
  const scale = 255 / a;
  return [Math.round(r * scale), Math.round(g * scale), Math.round(b * scale), Math.round(alpha)];
}

function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const dx = Math.min(px - x, x + w - px);
  const dy = Math.min(py - y, y + h - py);
  if (dx >= r || dy >= r) return true;
  const cx = px < x + r ? x + r : x + w - r;
  const cy = py < y + r ? y + r : y + h - r;
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function colorAt(px, py, size) {
  // Transparent outside the rounded badge.
  const badgeR = size * 0.22;
  if (!inRoundedRect(px, py, 0, 0, size, size, badgeR)) return [0, 0, 0, 0];

  // Vertical gradient background.
  const t = py / size;
  const bg = [
    lerp(GRAD_TOP[0], GRAD_BOTTOM[0], t),
    lerp(GRAD_TOP[1], GRAD_BOTTOM[1], t),
    lerp(GRAD_TOP[2], GRAD_BOTTOM[2], t),
  ];

  // Three lanes and a gate bar. Drawn as round-capped segments rather than a
  // path, because a hand-rolled rasteriser has no stroking and the shape has to
  // stay legible at 16 px.
  const w = size * 0.115; // stroke half-width
  const top = size * 0.2;
  const bottom = size * 0.8;
  const gateY = size * 0.5;
  const lanes = [size * 0.28, size * 0.5, size * 0.72];

  const onSegment = (ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // Project onto the segment, clamped — the clamp is what gives round caps,
    // and the caps are what keep the crossings from notching.
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const qx = ax + dx * t;
    const qy = ay + dy * t;
    return (px - qx) ** 2 + (py - qy) ** 2 <= (w / 2) ** 2;
  };

  // The chosen lane first: it must win wherever it overlaps the gate bar.
  if (onSegment(lanes[1], gateY, lanes[1], bottom)) {
    return [ACCENT[0], ACCENT[1], ACCENT[2], 255];
  }
  // The gate bar: one horizontal stroke every lane has to pass through.
  if (onSegment(size * 0.18, gateY, size * 0.82, gateY)) {
    return [TILE[0], TILE[1], TILE[2], 255];
  }
  // The lanes above the bar, all still undecided.
  if (lanes.some((x) => onSegment(x, top, x, gateY))) {
    return [TILE[0], TILE[1], TILE[2], 255];
  }
  return [bg[0], bg[1], bg[2], 255];
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = encodePng(size, colorAt);
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log(`wrote icon-${size}.png (${png.length} bytes)`);
}
