// Generates the Smoky app icon (PNG + ICO) with zero dependencies.
// Draws a rounded mint square with a pixel-letter "S", then wraps the PNG into an ICO.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4);

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function roundedRect(x0, y0, x1, y1, rad, fill) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cx = Math.max(x0 + rad - x, x - (x1 - rad - 1), 0);
      const cy = Math.max(y0 + rad - y, y - (y1 - rad - 1), 0);
      if (cx * cx + cy * cy <= rad * rad) fill(x, y);
    }
  }
}

// background: rounded mint gradient square
roundedRect(0, 0, S, S, 58, (x, y) => {
  const t = y / (S - 1);
  const r = Math.round(47 + (29 - 47) * t);
  const g = Math.round(209 + (158 - 209) * t);
  const b = Math.round(138 + (96 - 138) * t);
  setPx(x, y, r, g, b, 255);
});

// subtle inner highlight at the top
roundedRect(14, 14, S - 14, S - 14, 46, (x, y) => {
  const i = (y * S + x) * 4;
  const a = Math.max(0, 26 - y * 0.18) * 0.5;
  px[i] = Math.min(255, px[i] + a);
  px[i + 1] = Math.min(255, px[i + 1] + a);
  px[i + 2] = Math.min(255, px[i + 2] + a);
});

// "S" as a 5x7 pixel letter
const S_BITS = [
  1, 1, 1, 1, 1,
  1, 0, 0, 0, 0,
  1, 0, 0, 0, 0,
  1, 1, 1, 1, 0,
  0, 0, 0, 0, 1,
  0, 0, 0, 0, 1,
  1, 1, 1, 1, 1,
];
const cell = 30;
const ox = Math.floor((S - 5 * cell) / 2);
const oy = Math.floor((S - 7 * cell) / 2) - 2;
for (let row = 0; row < 7; row++) {
  for (let col = 0; col < 5; col++) {
    if (!S_BITS[row * 5 + col]) continue;
    roundedRect(ox + col * cell + 2, oy + row * cell + 2, ox + (col + 1) * cell - 2, oy + (row + 1) * cell - 2, 8, (x, y) => {
      setPx(x, y, 255, 255, 255, 255);
    });
  }
}

// ---------------------------------------------------------------- PNG ------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const png = encodePNG(S, S, px);
const outDir = path.join(__dirname, '..', 'electron');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), icoFromPng(png));
console.log('Icon geschrieben: electron/icon.png + electron/icon.ico (' + png.length + ' bytes)');

function icoFromPng(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0; // 256x256
  entry[2] = 0; entry[3] = 0; // no palette
  entry[4] = 0; entry[5] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8); // data size
  entry.writeUInt32LE(22, 12); // data offset (6 header + 16 entry)
  return Buffer.concat([header, entry, pngBuf]);
}
