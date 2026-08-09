// Smoky — build the auto-update package after `electron-builder` has run.
// Creates dist/Smoky-<version>-update.zip (win-unpacked contents at the zip
// root) and dist/update.json — the manifest the app fetches to learn about
// and download new versions.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const dist = path.join(root, 'dist');
const unpacked = path.join(dist, 'win-unpacked');

if (!fs.existsSync(path.join(unpacked, 'Smoky.exe'))) {
  console.error('dist/win-unpacked/Smoky.exe not found — run the electron-builder build first (npm run dist).');
  process.exit(1);
}

const zip = path.join(dist, `Smoky-${version}-update.zip`);
if (fs.existsSync(zip)) fs.rmSync(zip, { force: true });

// Everything we ever change (UI, server, updater) lives inside app.asar — so
// an update is just that one file: ~45 MB instead of 330 MB. Small enough for
// any free host (Google Drive, MEGA, OneDrive, Dropbox, GitHub Releases…).
const staging = path.join(dist, '.update-staging');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(path.join(staging, 'resources'), { recursive: true });
fs.copyFileSync(path.join(unpacked, 'resources', 'app.asar'), path.join(staging, 'resources', 'app.asar'));

console.log('Zipping app.asar →', zip, '…');
const r = spawnSync('powershell', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path '${path.join(staging, '*')}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`,
], { stdio: 'inherit' });
fs.rmSync(staging, { recursive: true, force: true });
if (r.status !== 0) {
  console.error('Compress-Archive failed (exit ' + r.status + ')');
  process.exit(1);
}

const size = fs.statSync(zip).size;
const host = process.env.SMOKY_UPDATE_BASE_URL || 'https://example.com/smoky';
const manifest = {
  version,
  url: `${host}/Smoky-${version}-update.zip`,
  notes: '',
  size,
};
fs.writeFileSync(path.join(dist, 'update.json'), JSON.stringify(manifest, null, 2));

console.log('Done:');
console.log('  ' + zip + '  (' + (size / 1024 / 1024).toFixed(1) + ' MB)');
console.log('  ' + path.join(dist, 'update.json'));
console.log('');
console.log('Next: upload both files somewhere public, then put the real download URL');
console.log('into dist/update.json and set it as UPDATE_MANIFEST_URL in electron/main.js');
console.log('(or host update.json anywhere and point SMOKY_UPDATE_URL at it).');
