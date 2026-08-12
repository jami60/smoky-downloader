// Generates the Smoky macOS app icon (electron/icon.icns) from the designed
// 2000x2000 source (electron/icon-source.png) using the bundled ffmpeg.
// Modern .icns stores PNG data directly per icon type — no iconutil needed.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const src = path.join(root, 'electron', 'icon-source.png');
const out = path.join(root, 'electron', 'icon.icns');
const ffmpeg = process.platform === 'win32'
  ? path.join(root, 'tools', 'ffmpeg.exe')
  : 'ffmpeg';
const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'smoky-icns-'));

if (!fs.existsSync(src)) throw new Error('Quelle fehlt: ' + src);

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
  const png = path.join(tmp, type + '.png');
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale=${px}:${px}:flags=lanczos`, png]);
  const data = fs.readFileSync(png);
  const chunk = Buffer.alloc(8 + data.length);
  chunk.write(type, 0, 4, 'ascii');
  chunk.writeUInt32BE(8 + data.length, 4);
  data.copy(chunk, 8);
  chunks.push(chunk);
  console.log(`  ${type} ${px}px (${data.length} B)`);
}

const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
const icns = Buffer.alloc(total);
icns.write('icns', 0, 4, 'ascii');
icns.writeUInt32BE(total, 4);
let off = 8;
for (const c of chunks) { c.copy(icns, off); off += c.length; }
fs.writeFileSync(out, icns);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('OK → electron/icon.icns (' + icns.length + ' bytes)');
