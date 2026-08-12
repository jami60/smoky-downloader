// Generates the Smoky macOS app icon (electron/icon.icns) from the designed
// 2000x2000 source (electron/icon-source.png) — zero dependencies (no ffmpeg,
// no iconutil), so it runs on any GitHub Actions runner.
// Modern .icns stores PNG data directly per icon type.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ------------------------------------------------------------ PNG decode ----
function decodePNG(buf) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`unsupported PNG: depth ${bitDepth}, colorType ${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const cur = raw[rowStart + 1 + x];
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp, di = (y * width + x) * 4;
      out[di] = line[si]; out[di + 1] = line[si + 1]; out[di + 2] = line[si + 2];
      out[di + 3] = bpp === 4 ? line[si + 3] : 255;
    }
    prev.set(line);
  }
  return { width, height, rgba: out };
}

// ------------------------------------------------------------ bilinear -----
function scaleRGBA(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let oy = 0; oy < dh; oy++) {
    const sy = ((oy + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1);
    const wy = sy - y0;
    for (let ox = 0; ox < dw; ox++) {
      const sx = ((ox + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1);
      const wx = sx - x0;
      const w00 = (1 - wx) * (1 - wy), w01 = wx * (1 - wy), w10 = (1 - wx) * wy, w11 = wx * wy;
      const p00 = (y0 * sw + x0) * 4, p01 = (y0 * sw + x1) * 4, p10 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
      const di = (oy * dw + ox) * 4;
      out[di] = src[p00] * w00 + src[p01] * w01 + src[p10] * w10 + src[p11] * w11;
      out[di + 1] = src[p00 + 1] * w00 + src[p01 + 1] * w01 + src[p10 + 1] * w10 + src[p11 + 1] * w11;
      out[di + 2] = src[p00 + 2] * w00 + src[p01 + 2] * w01 + src[p10 + 2] * w10 + src[p11 + 2] * w11;
      out[di + 3] = src[p00 + 3] * w00 + src[p01 + 3] * w01 + src[p10 + 3] * w10 + src[p11 + 3] * w11;
    }
  }
  return out;
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

// ------------------------------------------------------------------ main ----
const root = path.join(__dirname, '..');
const src = path.join(root, 'electron', 'icon-source.png');
if (!fs.existsSync(src)) throw new Error('Quelle fehlt: ' + src);
const source = decodePNG(fs.readFileSync(src));

// (icns-Typ, Pixelgröße)
const sizes = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

const chunks = [];
for (const [type, px] of sizes) {
  const rgba = scaleRGBA(source.rgba, source.width, source.height, px, px);
  const png = encodePNG(px, px, rgba);
  const c = Buffer.alloc(8 + png.length);
  c.write(type, 0, 4, 'ascii');
  c.writeUInt32BE(8 + png.length, 4);
  png.copy(c, 8);
  chunks.push(c);
  console.log(`  ${type} ${px}px (${png.length} B)`);
}

const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
const icns = Buffer.alloc(total);
icns.write('icns', 0, 4, 'ascii');
icns.writeUInt32BE(total, 4);
let off = 8;
for (const c of chunks) { c.copy(icns, off); off += c.length; }
fs.writeFileSync(path.join(root, 'electron', 'icon.icns'), icns);
console.log('OK → electron/icon.icns (' + icns.length + ' bytes)');
