// Smoky — auto updater.
// Self-contained (no Electron imports) so it can be unit-tested in plain Node.
// Flow: fetch update.json → compare version → download the zip → extract →
// run a tiny batch that kills Smoky, replaces the app folder and relaunches.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

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
// onProgress({ phase:'download', received, total, percent }) wird regelmäßig
// gemeldet, damit die UI einen echten Fortschrittsbalken zeigen kann.
async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  let lastReport = 0;
  const report = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (onProgress && (received - lastReport >= 262144 || received === total)) {
        lastReport = received;
        onProgress({ phase: 'download', received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0 });
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), report, fs.createWriteStream(dest));
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

// buildUpdateBat(paths) → erzeugt den Inhalt des Update-Batches als String.
// Der Batch ist bewusst robust gegen die zwei häufigsten Update-Fehler:
//   1. app.asar ist noch vom laufenden Prozess gesperrt (taskkill braucht
//      länger als 1 s, AV-Scans halten die Datei fest) → Copy-Retry-Loop.
//   2. Install-Ordner ist geschützt (Program Files) → UAC-Elevation-Fallback.
// Und er garantiert: egal ob Erfolg oder Fehler, die App wird NEU GESTARTET
// (alter Stand bleibt beim Fehler intakt — nichts bleibt tot liegen).
function buildUpdateBat({ newAsar, targetAsar, tmp, execPath, markerBase, failFile, processName = 'Smoky.exe', elevation = true, maxCopyTries = 10 }) {
  const base = [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    'echo Smoky update — installing…',
    `set "NEW=${newAsar}"`,
    `set "TARGET=${targetAsar}"`,
    `set "TMP=${tmp}"`,
    `set "EXEC=${execPath}"`,
    `set "MARK=${markerBase}"`,
    `set "FAIL=${failFile}"`,
    `set "PROC=${processName}"`,
    'if "%~1"=="elevated" goto :elev',
    '',
    'REM ---- 1) App beenden und WIRKLICH warten, bis sie weg ist ----',
    'taskkill /f /im "!PROC!" >nul 2>&1',
    'set /a w=0',
    ':waitkill',
    'tasklist /fi "imagename eq !PROC!" | findstr /i "!PROC!" >nul 2>&1',
    'if errorlevel 1 goto :killed',
    'set /a w+=1',
    'if !w! geq 15 goto :killed',
    'timeout /t 1 /nobreak >nul 2>&1',
    'goto :waitkill',
    ':killed',
    '',
    'REM ---- 2) Copy mit Retries (Dateisperre / AV-Scan) ----',
    'set /a n=0',
    ':copy1',
    `copy /y "!NEW!" "!TARGET!" >nul 2>&1`,
    'if not errorlevel 1 goto :done',
    'set /a n+=1',
    `if !n! geq ${maxCopyTries} goto :elevate`,
    'timeout /t 1 /nobreak >nul 2>&1',
    'goto :copy1',
    '',
    'REM ---- 3) Geschützter Ordner (Program Files) → UAC-Elevation ----',
    ':elevate',
  ];

  const elev = elevation === false ? ['goto :give_up'] : [
    'del "!MARK!-*" >nul 2>&1',
    'echo Smoky update — requesting administrator rights…',
    'powershell -NoProfile -Command "Start-Process -FilePath \'%~f0\' -ArgumentList \'elevated\' -Verb RunAs -WindowStyle Hidden" >nul 2>&1',
    'if errorlevel 1 goto :give_up',
    'set /a w2=0',
    ':waitelev',
    'if exist "!MARK!-ok" goto :elev_ok',
    'if exist "!MARK!-fail" goto :give_up',
    'set /a w2+=1',
    'if !w2! geq 90 goto :give_up',
    'timeout /t 1 /nobreak >nul 2>&1',
    'goto :waitelev',
  ];

  // WICHTIG: Der Batch löscht sich NICHT selbst (del "%~f0" würde cmd zum
  // Hängen bringen — nach dem Löschen der noch laufenden Datei findet cmd
  // keine weitere Zeile und endet nie). Stattdessen räumt die App beim
  // nächsten Start alte smoky-update*.bat aus dem Temp auf.
  const tail = [
    '',
    ':done',
    'echo Smoky update — done, relaunching…',
    'rmdir /s /q "!TMP!" >nul 2>&1',
    'del "!MARK!-*" >nul 2>&1',
    'start "" "!EXEC!"',
    'exit /b 0',
    '',
    ':elev_ok',
    'echo Smoky update — done (elevated), relaunching…',
    'rmdir /s /q "!TMP!" >nul 2>&1',
    'del "!MARK!-*" >nul 2>&1',
    'start "" "!EXEC!"',
    'exit /b 0',
    '',
    ':give_up',
    'echo Smoky update — failed, keeping current version.',
    'echo %date% %time% update failed > "!FAIL!"',
    'start "" "!EXEC!"',
    'del "!MARK!-*" >nul 2>&1',
    'exit /b 1',
    '',
    'REM ---- 4) Elevated-Instanz (gleicher Benutzer, Admin-Rechte) ----',
    ':elev',
    'set /a n=0',
    ':copy2',
    `copy /y "!NEW!" "!TARGET!" >nul 2>&1`,
    'if not errorlevel 1 goto :done_elev',
    'set /a n+=1',
    'if !n! geq 15 goto :fail_elev',
    'timeout /t 1 /nobreak >nul 2>&1',
    'goto :copy2',
    ':done_elev',
    'echo ok > "!MARK!-ok"',
    'exit /b 0',
    ':fail_elev',
    'echo fail > "!MARK!-fail"',
    'exit /b 1',
  ];

  return base.concat(elev, tail).join('\r\n');
}

// applyUpdate(url, { appDir, execPath, userData, log, onProgress }) →
// downloads, extracts and hands over to a batch that swaps the app folder
// and relaunches. Der Batch startet die App in JEDEM Fall neu (Erfolg oder
// Fehler) — der alte Stand bleibt beim Fehler unangetastet erhalten.
async function applyUpdate(url, { appDir, execPath, userData, log = () => {}, onProgress = null }) {
  if (!appDir || !execPath) throw new Error('applyUpdate needs appDir + execPath');
  const tmp = path.join(os.tmpdir(), 'smoky-update-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });

  log('downloading update…');
  if (onProgress) onProgress({ phase: 'download', received: 0, total: 0, percent: 0 });
  const zip = path.join(tmp, 'update.zip');
  await download(url, zip, onProgress || undefined);

  log('extracting update…');
  if (onProgress) onProgress({ phase: 'extract' });
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
  // Fehlerdatei IMMER in userData (immer beschreibbar), nie im appDir —
  // das kann bei Program-Files-Installationen selbst geschützt sein.
  const failFile = path.join(userData || os.tmpdir(), 'update-failed.txt');
  const markerBase = path.join(os.tmpdir(), 'smoky-update-' + Date.now());
  const bat = path.join(os.tmpdir(), 'smoky-update.bat');
  const body = buildUpdateBat({ newAsar, targetAsar, tmp, execPath, markerBase, failFile });
  fs.writeFileSync(bat, body);

  spawn('cmd', ['/c', 'start', '', bat], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

module.exports = { parseVersion, isNewer, fetchManifest, checkForUpdates, checkForGitHubUpdate, download, unzip, buildUpdateBat, applyUpdate };
