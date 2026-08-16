// Generates the extension icons: a rounded green badge holding one white disc
// above two dark ones. Several identities were on the table, one place decided
// which of them this tab belongs to, and the two it did not pick were left
// exactly where they were.
//
// The two unpicked discs are DARKER than the badge, not paler. That is the
// whole difference between "the brighter member of a set" and "the one that was
// taken out of it": a dark disc reads as an empty place, and an empty place is
// evidence that something acted. A paler disc reads as a dimmer lamp, which is
// the visual grammar of a status indicator — and a status indicator invites the
// click this extension refuses to honour, because the policy is read-only and
// the decision is already made.
//
// Discs because a coloured dot is Firefox's own glyph for a container, so the
// vocabulary is borrowed rather than invented; because beeline already owns the
// square on this toolbar and linkward owns the three-armed stroke; and because
// nothing else holds its area as well when the badge is 16 px wide.
//
// Green, and specifically not blue. This mark used to ship linkward's palette
// byte for byte — the same gradient ramp and the same white-and-amber ink — on
// a toolbar where the two sit a couple of slots apart. Hue is the only separator
// that still works at 16 px seen out of the corner of an eye, and the previous
// version had spent it. Green also keeps its distance from beeline's red.
//
// Sizes: Firefox draws about:addons at 32 (64 on a 2x display) and the toolbar
// button at 16 (32 on 2x). Shipping only 48 and 128, as this did, meant both
// 32 px cases came from a blurry 1.5x downscale. 96 is left out — nothing asks
// for it.
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

const GRAD_TOP = [13, 145, 108]; // #0D916C
const GRAD_BOTTOM = [6, 96, 74]; // #06604A
const CHOSEN = [255, 255, 255]; // the container this tab was placed in
const EMPTY = [5, 71, 55]; // #054737 — the places it was not put
const SS = 4; // supersampling factor per axis

// Proportions of the badge, so every size is the same drawing. The chosen disc
// is deliberately much larger than the other two: at 16 px it is the only
// element guaranteed to survive, and it has to be the one that does.
const CHOSEN_R = 0.205;
const CHOSEN_Y = 0.315;
const EMPTY_R = 0.125;
const EMPTY_Y = 0.705;
const EMPTY_X = [0.295, 0.705];

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

function inDisc(px, py, cx, cy, r) {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function colorAt(px, py, size) {
  // Transparent outside the rounded badge.
  const badgeR = size * 0.22;
  if (!inRoundedRect(px, py, 0, 0, size, size, badgeR)) return [0, 0, 0, 0];

  // Vertical gradient, kept shallow. Both siblings carry one, so it is what
  // makes the three read as a set rather than as three unrelated products — but
  // a gradient steep enough to mean something is a gradient that disappears at
  // 16 px, where it is one or two pixels of ramp.
  const t = py / size;
  const bg = [
    lerp(GRAD_TOP[0], GRAD_BOTTOM[0], t),
    lerp(GRAD_TOP[1], GRAD_BOTTOM[1], t),
    lerp(GRAD_TOP[2], GRAD_BOTTOM[2], t),
  ];

  // Spaced so no two discs come within ~1.7 px of each other at 16 px. That is
  // the narrowest gap that still resolves to clean background between them; the
  // three-lane mark this replaced left 1 px and merged into a comb.
  if (inDisc(px, py, size * 0.5, size * CHOSEN_Y, size * CHOSEN_R)) {
    return [CHOSEN[0], CHOSEN[1], CHOSEN[2], 255];
  }
  if (EMPTY_X.some((x) => inDisc(px, py, size * x, size * EMPTY_Y, size * EMPTY_R))) {
    return [EMPTY[0], EMPTY[1], EMPTY[2], 255];
  }
  return [bg[0], bg[1], bg[2], 255];
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 64, 128]) {
  const png = encodePng(size, colorAt);
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log(`wrote icon-${size}.png (${png.length} bytes)`);
}
