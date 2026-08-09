// Smoky — auto updater.
// Self-contained (no Electron imports) so it can be unit-tested in plain Node.
// Flow: fetch update.json → compare version → download the zip → extract →
// run a tiny batch that kills Smoky, replaces the app folder and relaunches.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

// ------------------------------------------------------------- versions ----
function parseVersion(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// isNewer(a, b) → true when version a is strictly newer than b
function isNewer(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

// ----------------------------------------------------------- manifest -----
async function fetchManifest(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// checkForUpdates(manifestUrl, currentVersion) → { available, version, notes, url, current }
async function checkForUpdates(manifestUrl, currentVersion) {
  const manifest = await fetchManifest(manifestUrl);
  if (!manifest || !manifest.version || !manifest.url) {
    throw new Error('Update manifest is missing version or url');
  }
  return {
    available: isNewer(manifest.version, currentVersion),
    version: String(manifest.version),
    notes: manifest.notes || '',
    url: manifest.url,
    current: currentVersion,
  };
}

// ----------------------------------------------------------- download -----
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

// ------------------------------------------------------------ extract -----
function unzip(zipFile, dest) {
  return new Promise((resolve, reject) => {
    // PowerShell Expand-Archive is built into Windows — no extra deps.
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${dest}' -Force`,
    ], { windowsHide: true });
    let err = '';
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Extract failed (' + code + '): ' + err.trim()));
    });
  });
}

// Find the folder that actually contains Smoky.exe (tolerates zips that have
// a top-level folder like `win-unpacked/` and contents-only zips).
function contentRoot(staging) {
  let src = staging;
  const entries = fs.readdirSync(staging, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1 && entries.length === 1) {
    const nested = path.join(staging, dirs[0].name);
    if (fs.existsSync(path.join(nested, 'Smoky.exe'))) src = nested;
  }
  return src;
}

// applyUpdate(url, { appDir, execPath, log }) → downloads, extracts and
// hands over to a batch that swaps the app folder and relaunches.
async function applyUpdate(url, { appDir, execPath, log = () => {} }) {
  if (!appDir || !execPath) throw new Error('applyUpdate needs appDir + execPath');
  const tmp = path.join(os.tmpdir(), 'smoky-update-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  log('downloading update…');
  const zip = path.join(tmp, 'update.zip');
  await download(url, zip);

  log('extracting update…');
  const staging = path.join(tmp, 'staging');
  await unzip(zip, staging);

  const src = contentRoot(staging);
  if (!fs.existsSync(path.join(src, 'Smoky.exe'))) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('The update package does not contain Smoky.exe');
  }

  log('installing…');
  // The batch lives in %TEMP% (outside the download dir it later deletes, and
  // outside the app dir that robocopy /mir mirrors).
  const bat = path.join(os.tmpdir(), 'smoky-update.bat');
  const body = [
    '@echo off',
    'taskkill /f /im Smoky.exe >nul 2>&1',
    'timeout /t 1 /nobreak >nul',
    `robocopy "${src}" "${appDir}" /mir /r:2 /w:1 /nfl /ndl /njh /njs >nul`,
    'set rc=%errorlevel%',
    'if %rc% GEQ 8 ( echo Update copy failed (robocopy %rc%) > "%appDir%\\update-failed.txt" & timeout /t 3 /nobreak >nul & exit /b 1 )',
    `rmdir /s /q "${tmp}"`,
    'start "" "' + execPath + '"',
    'del "%~f0"',
  ].join('\r\n');
  fs.writeFileSync(bat, body);

  spawn('cmd', ['/c', 'start', '', bat], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

module.exports = { parseVersion, isNewer, fetchManifest, checkForUpdates, download, unzip, applyUpdate };
