// Generates build/icon.png (512x512) — flat black square, red ">" mark.
// No gradients, no rounded corners: a pixel-art chevron drawn as two thick
// strokes. Pure Node, no dependencies. electron-builder converts this PNG
// to .ico for Windows.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const S = 512;
const buf = Buffer.alloc(S * S * 4);

const BG = [10, 10, 10];      // #0a0a0a
const FG = [255, 59, 48];     // #ff3b30 — --accent

// ── ">" como dos trazos gruesos (polilínea A → B → C) ───────────
const W = 46; // grosor del trazo
const A = [180, 128];
const B = [372, 256];
const C = [180, 384];

// Distancia de un punto a un segmento, para rasterizar el trazo grueso.
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const lerp = (a, b, t) => a + (b - a) * t;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const d = Math.min(
      distToSegment(x, y, A[0], A[1], B[0], B[1]),
      distToSegment(x, y, B[0], B[1], C[0], C[1]),
    );
    // borde suave de ~1.2px para que no se vea dentado al escalar
    const edge = (W / 2) - d;
    const t = Math.max(0, Math.min(1, edge / 1.2 + 0.5));
    buf[i]     = Math.round(lerp(BG[0], FG[0], t));
    buf[i + 1] = Math.round(lerp(BG[1], FG[1], t));
    buf[i + 2] = Math.round(lerp(BG[2], FG[2], t));
    buf[i + 3] = 255;
  }
}

// build raw scanlines with filter byte 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('Wrote', out, png.length, 'bytes');
