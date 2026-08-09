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

// -------------------------------------------------------- github api ------
// Check the latest GitHub release of a public repo — no manifest file needed.
// The version comes from the release tag, the payload is the *-update.zip
// asset (must be attached to the release, e.g. Smoky-1.5.1-update.zip).
async function checkForGitHubUpdate(repo, currentVersion, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let release;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Smoky-Updater' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      // 404 = no release yet → treat as "nothing available", not an error.
      if (res.status === 404) {
        return { available: false, version: '', notes: '', url: '', current: currentVersion };
      }
      throw new Error('HTTP ' + res.status);
    }
    release = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const version = String(release.tag_name || '').replace(/^v/i, '');
  const asset = (release.assets || []).find((a) => /-update\.zip$/i.test(a.name || ''));
  if (!version || !asset || !asset.browser_download_url) {
    return { available: false, version, notes: '', url: '', current: currentVersion };
  }
  return {
    available: isNewer(version, currentVersion),
    version,
    notes: release.body || '',
    url: asset.browser_download_url,
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

// Find the resources/ folder inside the extracted update (the zip contains
// just resources/app.asar).
function contentRoot(staging) {
  const candidates = [
    staging,
    ...fs.readdirSync(staging, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(staging, e.name)),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'resources', 'app.asar'))) return dir;
  }
  return staging;
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
  if (!fs.existsSync(path.join(src, 'resources', 'app.asar'))) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('The update package does not contain resources/app.asar');
  }

  log('installing…');
  // The update is a single-file swap (copy resources/app.asar over the old
  // one) — the friend's bundled tools, locales and everything else stay as is.
  // NOTE: build the paths with path.join — inline backslashes in a template
  // literal would be eaten as escape sequences (\r, \u…) and corrupt the batch.
  const newAsar = path.join(src, 'resources', 'app.asar');
  const targetAsar = path.join(appDir, 'resources', 'app.asar');
  const failedFile = path.join(appDir, 'update-failed.txt');
  const bat = path.join(os.tmpdir(), 'smoky-update.bat');
  const body = [
    '@echo off',
    'taskkill /f /im Smoky.exe >nul 2>&1',
    'timeout /t 1 /nobreak >nul',
    `copy /y "${newAsar}" "${targetAsar}" >nul`,
    `if errorlevel 1 ( echo Update copy failed > "${failedFile}" & timeout /t 3 /nobreak >nul & exit /b 1 )`,
    `rmdir /s /q "${tmp}"`,
    'start "" "' + execPath + '"',
    'del "%~f0"',
  ].join('\r\n');
  fs.writeFileSync(bat, body);

  spawn('cmd', ['/c', 'start', '', bat], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

module.exports = { parseVersion, isNewer, fetchManifest, checkForUpdates, checkForGitHubUpdate, download, unzip, applyUpdate };
