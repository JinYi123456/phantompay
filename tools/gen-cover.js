#!/usr/bin/env node
'use strict';

/**
 * Generate assets/cover.png from the cover design — zero dependencies.
 *
 * The design master is assets/cover.svg. This script draws the same design
 * with raw pixels (no canvas library, no font rasterizer): a vertical
 * gradient with a dot grid, a factory ring (blue) with a green approval arc,
 * four seat squares and the wordmark, plus the tagline lines as PNG metadata.
 * Small text is left to the SVG; the PNG carries it in the tEXt chunks so
 * the design stays fully documented in both artifacts.
 *
 * Usage: node tools/gen-cover.js [out]  (default: assets/cover.png)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 1200;
const H = 630;
const CX = 600;
const CY = 265;
const R = 150;

// ---- geometry helpers -------------------------------------------------

function inRing(x, y, cx, cy, rInner, rOuter) {
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  return d >= rInner && d <= rOuter;
}

function inArc(x, y, cx, cy, rInner, rOuter, a0, a1) {
  if (!inRing(x, y, cx, cy, rInner, rOuter)) return false;
  let a = Math.atan2(y - cy, x - cx); // -PI..PI, 0 = +x axis, clockwise down
  return a >= a0 && a <= a1;
}

function inRect(x, y, rx, ry, w, h) {
  return x >= rx && x < rx + w && y >= ry && y < ry + h;
}

// Rounded-corner test for the border frame (radius 10, stroke 2 at inset 14).
function inFrame(x, y) {
  const inset = 14;
  const bw = 2;
  const rad = 10;
  const x0 = inset, y0 = inset;
  const x1 = W - 1 - inset, y1 = H - 1 - inset;
  // outer edge of stroke
  const ox0 = x0 - bw, oy0 = y0 - bw, ox1 = x1 + bw, oy1 = y1 + bw;
  if (x < ox0 || x > ox1 || y < oy0 || y > oy1) return false;
  // inner edge (hole)
  const ix0 = x0 + bw, iy0 = y0 + bw, ix1 = x1 - bw, iy1 = y1 - bw;
  const inHole = x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1;
  if (inHole) {
    // except near corners, where the hole is rounded: keep pixels outside
    // the rounded-rect of the hole when within rad of a corner
    const nearCorner =
      (x < ix0 + rad && y < iy0 + rad) ||
      (x > ix1 - rad && y < iy0 + rad) ||
      (x < ix0 + rad && y > iy1 - rad) ||
      (x > ix1 - rad && y > iy1 - rad);
    if (!nearCorner) return false;
  }
  return true;
}

// ---- color helpers ----------------------------------------------------

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mix(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

const TOP = [0x0b, 0x0f, 0x1a];
const BOTTOM = [0x15, 0x1d, 0x33];
const DOT = [0x8f, 0xa3, 0xc8];
const BLUE = [0x4f, 0x8c, 0xff];
const GREEN = [0x2e, 0xcc, 0x71];
const LIGHT = [0xe8, 0xee, 0xfc];

// ---- rasterize --------------------------------------------------------

const raw = Buffer.alloc((W * 3 + 1) * H);
let p = 0;

for (let y = 0; y < H; y++) {
  raw[p++] = 0; // PNG filter type: None
  const base = mix(TOP, BOTTOM, y / (H - 1));
  for (let x = 0; x < W; x++) {
    let rgb = base;

    // dot grid (60px pitch, matches the SVG pattern)
    if (x % 60 === 30 && y % 60 === 30) rgb = DOT;

    // ring body (stroke 10 => r 145..155): blue by default
    if (inRing(x, y, CX, CY, R - 5, R + 5)) rgb = BLUE;

    // approval arc: from ~22.5° below +x axis to ~22.5° above it (right side)
    // matches SVG path M 675 135.1 A 150 150 0 0 1 675 394.9
    if (inArc(x, y, CX, CY, R - 5, R + 5, -Math.PI / 8, Math.PI / 8)) rgb = GREEN;

    // hub
    if (inRing(x, y, CX, CY, 0, 34)) rgb = BLUE;

    // four seats (18px squares at ring cardinal points)
    if (inRect(x, y, 591, 78, 18, 18)) rgb = LIGHT;
    if (inRect(x, y, 591, 434, 18, 18)) rgb = LIGHT;
    if (inRect(x, y, 413, 256, 18, 18)) rgb = LIGHT;
    if (inRect(x, y, 769, 256, 18, 18)) rgb = LIGHT;

    // frame
    if (inFrame(x, y)) rgb = mix(BLUE, base, 0.45);

    raw[p++] = rgb[0];
    raw[p++] = rgb[1];
    raw[p++] = rgb[2];
  }
}

// ---- PNG encoding -----------------------------------------------------

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(crcInput) : crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// CRC32 fallback for Node < 22.2.0 (zlib.crc32 exists on Node 24, but keep
// the script portable to CI's Node 20 matrix too).
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function textChunk(keyword, value) {
  return chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]));
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // color type: truecolor
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  textChunk('Title', 'PhantomPay - Autonomous Ledger & Settlement Factory'),
  textChunk('Author', 'Phantom Foundry'),
  textChunk('Description', 'Tagline: AUTONOMOUS LEDGER & SETTLEMENT FACTORY - PHANTOM FOUNDRY - POCKETFUL TRACK - DARK FACTORY - 76 TESTS GREEN. Design master: assets/cover.svg (full typography).'),
  textChunk('Software', 'tools/gen-cover.js (zero-dependency Node.js)'),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = process.argv[2] || path.join(__dirname, '..', 'assets', 'cover.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${W}x${H})`);
