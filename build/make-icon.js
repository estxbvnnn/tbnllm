// Generates build/icon.png (512x512) — a rounded gradient square with a ◐ mark.
// Pure Node, no dependencies. electron-builder converts this PNG to .ico for Windows.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const S = 512;
const buf = Buffer.alloc(S * S * 4);

const lerp = (a, b, t) => Math.round(a + (b - a) * t);
// gradient endpoints
const top = [124, 108, 255];   // #7c6cff
const bot = [77, 214, 196];    // #4dd6c4

const R = 108;                 // corner radius
const cx = S / 2, cy = S / 2;
const circR = 150;             // brand circle radius

function inRoundedRect(x, y) {
  const minX = R, maxX = S - R, minY = R, maxY = S - R;
  if (x >= minX && x <= maxX) return true;
  if (y >= minY && y <= maxY) return true;
  // corners
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
  return dx * dx + dy * dy <= R * R;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (!inRoundedRect(x, y)) { buf[i + 3] = 0; continue; }
    const t = y / S;
    let r = lerp(top[0], bot[0], t);
    let g = lerp(top[1], bot[1], t);
    let b = lerp(top[2], bot[2], t);
    // brand mark ◐
    const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (d2 <= circR * circR) {
      if (x < cx) { r = 255; g = 255; b = 255; }               // left half solid white
      else { r = lerp(r, 255, 0.55); g = lerp(g, 255, 0.55); b = lerp(b, 255, 0.55); } // right half light
    }
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
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
