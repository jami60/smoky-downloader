// Smoky — Unit-Test für den Updater: Download-Fortschritt, Versionen.
// Startet einen lokalen HTTP-Server mit einer bekannten Dateigröße und
// prüft, dass onProgress() mit steigendem received/percent aufruft wird.
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { download, parseVersion, isNewer, buildUpdateBat, buildUpdateSh, unzip } = require('../electron/updater.js');
const { spawnSync } = require('node:child_process');

// Wartet bis zu ms lang darauf, dass eine Datei erscheint — der Relaunch läuft
// asynchron über `start`, der Marker kann erst einen Tick nach dem Batch-Ende
// geschrieben werden (Race ohne Poll).
const waitFor = (file, ms = 6000) => new Promise((resolve) => {
  const t0 = Date.now();
  (function poll() {
    if (fs.existsSync(file)) return resolve(true);
    if (Date.now() - t0 > ms) return resolve(false);
    setTimeout(poll, 100);
  })();
});

let failed = 0;
const check = (name, ok) => { console.log((ok ? '✅' : '❌') + ' ' + name); if (!ok) failed += 1; };

// ---------------------------------------------------------------- download --
(async () => {
  const size = 3 * 1024 * 1024 + 12345; // ~3 MB, ungerade Restlänge
  const payload = Buffer.alloc(size, 7);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(size) });
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dest = path.join(os.tmpdir(), 'smoky-test-dl-' + Date.now() + '.zip');
  const progress = [];
  try {
    await download(`http://127.0.0.1:${port}/update.zip`, dest, (p) => progress.push(p));

    check('Download liefert korrekte Datei', fs.existsSync(dest) && fs.statSync(dest).size === size);
    check('onProgress wurde aufgerufen', progress.length > 0);
    check('onProgress erreicht 100 %', progress.length > 0 && progress[progress.length - 1].percent === 100);
    check('onProgress meldet received == total am Ende', progress.length > 0 && progress[progress.length - 1].received === size);
    const percents = progress.map((p) => p.percent);
    check('Fortschritt steigt monoton', percents.every((v, i) => i === 0 || v >= percents[i - 1]));
    check('onProgress hat korrektes Format', progress.every((p) => p.phase === 'download' && typeof p.received === 'number' && typeof p.total === 'number'));
  } catch (e) {
    check('Download ohne Fehler', false);
    console.log('   Fehler:', e && e.message || e);
  } finally {
    try { fs.rmSync(dest, { force: true }); } catch {}
    try { server.closeAllConnections(); } catch {}
    await new Promise((r) => server.close(r));
  }

  // ------------------------------------------------------------- versions --
  check('parseVersion 1.8.2', JSON.stringify(parseVersion('1.8.2')) === JSON.stringify([1, 8, 2]));
  check('isNewer 1.8.2 > 1.8.1', isNewer('1.8.2', '1.8.1') === true);
  check('isNewer 1.8.1 > 1.8.2 ist false', isNewer('1.8.1', '1.8.2') === false);
  check('isNewer 1.8.1 > 1.8.1 ist false', isNewer('1.8.1', '1.8.1') === false);
  check('isNewer v1.8.2 (mit v) > 1.8.1', isNewer('v1.8.2', '1.8.1') === true);
  check('isNewer 2.0.0 > 1.9.9', isNewer('2.0.0', '1.9.9') === true);

  // ------------------------------------------------- update-batch content --
  const bp = {
    newAsar: 'C:\\new\\resources\\app.asar',
    targetAsar: 'C:\\Program Files\\Smoky\\resources\\app.asar',
    tmp: 'C:\\Users\\X\\AppData\\Local\\Temp\\smoky-update-1',
    execPath: 'C:\\Program Files\\Smoky\\Smoky.exe',
    markerBase: 'C:\\Users\\X\\AppData\\Local\\Temp\\smoky-upd',
    failFile: 'C:\\Users\\X\\AppData\\Roaming\\Smoky\\update-failed.txt',
  };
  const body = buildUpdateBat(bp);
  check('Batch enthält Kill-Wait-Loop (wartet bis Prozess weg ist)', body.includes(':waitkill') && body.includes('tasklist /fi "imagename eq !PROC!"'));
  check('Batch enthält Copy-Retry-Loop', body.includes(':copy1') && body.includes('goto :copy1'));
  check('Batch enthält UAC-Elevation (Program-Files-Fallback)', body.includes('-Verb RunAs'));
  check('Batch startet App bei Erfolg neu (:done)', /:done[\s\S]*Start-Process -FilePath '!EXEC!'/.test(body));
  check('Batch startet App bei Erfolg neu (:elev_ok)', /:elev_ok[\s\S]*Start-Process -FilePath '!EXEC!'/.test(body));
  check('Batch startet App bei Fehler neu (:give_up)', /:give_up[\s\S]*Start-Process -FilePath '!EXEC!'/.test(body));
  check('Fehlerdatei zeigt auf userData (immer beschreibbar)', body.includes(bp.failFile) && !body.includes('app.asar\\update-failed'));
  check('Relaunch entkoppelt von der Konsole (Start-Process in allen 3 Pfaden)', (body.match(/Start-Process -FilePath '!EXEC!'/g) || []).length === 3 && (body.match(/start "" "!EXEC!"/g) || []).length === 3);
  check('Fallback start "" "!EXEC!" nur bei PowerShell-Fehler (3×)', (body.match(/if errorlevel 1 start "" "!EXEC!"/g) || []).length === 3);
  check('Elevated-Instanz startet die App NICHT selbst (kein doppeltes Elevated-Start)', (body.match(/Start-Process -FilePath '!EXEC!'/g) || []).length === 3);
  check('Batch löscht sich NICHT selbst (cmd-Hang vermieden)', !body.includes('del "%~f0"'));
  const noElev = buildUpdateBat({ ...bp, elevation: false });
  check('Ohne Elevation: kein -Verb RunAs, direkt :give_up', !noElev.includes('-Verb RunAs') && noElev.includes(':elevate\r\ngoto :give_up'));

  // ----------------------------------------- macOS/Linux-Sh-Skript-Inhalt --
  const shBody = buildUpdateSh({
    newAsar: '/tmp/upd/staging/resources/app.asar',
    targetAsar: '/Applications/Smoky.app/Contents/Resources/app.asar',
    relaunch: "open '/Applications/Smoky.app'",
    failFile: '/Users/x/Library/Application Support/Smoky/update-failed.txt',
  });
  check('Sh-Skript tauscht app.asar (cp NEW → TARGET)', shBody.includes('cp -f "$NEW" "$TARGET"'));
  check('Sh-Skript hat Copy-Retry-Loop (Dateisperre)', shBody.includes('for i in 1 2 3 4 5') && shBody.includes('sleep 1'));
  check('Sh-Skript schreibt Fehlerdatei bei Misserfolg', shBody.includes('Smoky update failed — keeping current version.'));
  check('Sh-Skript startet App IMMER neu (relaunch am Ende)', shBody.trim().endsWith("open '/Applications/Smoky.app'"));
  check('Sh-Skript enthält keine Windows-Reste (powershell/cmd/taskkill)', !/powershell|\bcmd\b|taskkill/.test(shBody));
  check('Sh-Skript räumt Staging nach Erfolg auf', shBody.includes('rm -rf "$(dirname "$NEW")"'));

  // --------------------------------------------- batch real execution (win) --
  const root = path.join(os.tmpdir(), 'smoky-updtest-' + Date.now());
  const appDir = path.join(root, 'app');
  const resDir = path.join(appDir, 'resources');
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, 'app.asar'), 'OLD');
  const staging = path.join(root, 'staging', 'resources');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'app.asar'), 'NEW-1.8.9');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'update.zip'), 'x');
  const relaunch = path.join(root, 'relaunch.cmd');
  fs.writeFileSync(relaunch, '@echo off\r\necho done > "' + path.join(root, 'relaunched.txt') + '"\r\n');
  const failFile = path.join(root, 'update-failed.txt');
  const markerBase = path.join(root, 'smoky-upd');
  const batPath = path.join(root, 'smoky-update.bat');

  // stdio: 'ignore' ist wichtig: `start`-Kinder erben sonst die stdout-Pipe
  // von spawnSync, die nie schließt → der Test würde hängen (genau so startet
  // auch die echte App den Batch: detached + stdio ignore).
  const runBat = (opts) => spawnSync('cmd', ['/c', batPath, ...(opts && opts.elevated ? ['elevated'] : [])], { timeout: 60000, stdio: 'ignore' });

  // Happy path: Copy klappt (normal, ohne Elevation), App wird neu gestartet.
  try {
    fs.writeFileSync(batPath, buildUpdateBat({
      newAsar: path.join(staging, 'app.asar'),
      targetAsar: path.join(resDir, 'app.asar'),
      tmp,
      execPath: relaunch,
      markerBase,
      failFile,
      processName: 'Smoky-Test-Fake-' + Date.now() + '.exe',
      maxCopyTries: 3,
    }));
    const r = runBat();
    check('Batch läuft durch (exit 0, happy path)', r.status === 0 && !r.error);
    check('app.asar wurde durch das Update ersetzt', fs.readFileSync(path.join(resDir, 'app.asar'), 'utf8') === 'NEW-1.8.9');
    check('App wurde neu gestartet (relaunch-Marker)', await waitFor(path.join(root, 'relaunched.txt')));
    check('TMP-Ordner wurde aufgeräumt', !fs.existsSync(tmp));
    check('Keine Fehlerdatei im Happy Path', !fs.existsSync(failFile));
  } catch (e) {
    check('Happy path ohne Fehler', false);
    console.log('   Fehler:', e && e.message || e);
  } finally {
    try { fs.rmSync(path.join(root, 'relaunched.txt'), { force: true }); } catch {}
    try { fs.writeFileSync(path.join(resDir, 'app.asar'), 'OLD'); } catch {}
  }

  // Fehlerpfad: Copy schlägt fehl (Zielordner existiert nicht) → App wird
  // trotzdem neu gestartet + Fehlerdatei geschrieben (kein totes Ende).
  try {
    const badTarget = path.join(root, 'no-such-dir', 'app.asar');
    fs.writeFileSync(batPath, buildUpdateBat({
      newAsar: path.join(staging, 'app.asar'),
      targetAsar: badTarget,
      tmp,
      execPath: relaunch,
      markerBase,
      failFile,
      processName: 'Smoky-Test-Fake-' + Date.now() + '.exe',
      elevation: false,
      maxCopyTries: 2,
    }));
    const r = runBat();
    check('Batch meldet Fehler (exit 1, Fehlerpfad)', r.status === 1);
    check('Fehlerdatei wurde geschrieben', fs.existsSync(failFile));
    check('App wird AUCH bei Fehler neu gestartet (kein totes Ende)', await waitFor(path.join(root, 'relaunched.txt')));
    check('Keine halb-installierte Datei (Ziel nie erstellt)', !fs.existsSync(badTarget));
  } catch (e) {
    check('Fehlerpfad ohne Fehler', false);
    console.log('   Fehler:', e && e.message || e);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }

  // --------------------------------------- unzip (echter Roundtrip) --------
  // Der Mac-Bug „spawn powershell ENOENT" kam daher, dass die Extraktion
  // hartkodiert PowerShell aufrief. Der neue unzip() wählt je Plattform
  // powershell/ditto/unzip. Hier wird die Windows-Strecke mit einer echten
  // Zip (via Compress-Archive erzeugt) verifiziert; auf anderen Systemen
  // nur, dass eine fehlende Zip sauber rejected statt zu hängen.
  if (process.platform === 'win32') {
    const zroot = path.join(os.tmpdir(), 'smoky-ziptest-' + Date.now());
    const zsrc = path.join(zroot, 'src');
    fs.mkdirSync(zsrc, { recursive: true });
    const zContent = 'app.asar-payload-' + 'x'.repeat(2048);
    const zfile = path.join(zsrc, 'app.asar');
    fs.writeFileSync(zfile, zContent);
    const zip = path.join(zroot, 'test.zip');
    const zdst = path.join(zroot, 'out');
    const mk = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -LiteralPath '${zfile}' -DestinationPath '${zip}' -Force`],
      { timeout: 30000, stdio: 'ignore' });
    try {
      if (mk.status === 0 && fs.existsSync(zip)) {
        await unzip(zip, zdst);
        const out = path.join(zdst, 'app.asar');
        check('unzip entpackt eine echte Zip korrekt (roundtrip)', fs.existsSync(out) && fs.readFileSync(out, 'utf8') === zContent);
      } else {
        check('unzip entpackt eine echte Zip korrekt (roundtrip)', false);
        console.log('   (Compress-Archive schlug fehl — Test übersprungen)');
      }
    } catch (e) {
      check('unzip entpackt eine echte Zip korrekt (roundtrip)', false);
      console.log('   Fehler:', e && e.message || e);
    } finally {
      try { fs.rmSync(zroot, { recursive: true, force: true }); } catch {}
    }
  } else {
    try {
      await unzip(path.join(os.tmpdir(), 'smoky-nonexistent-' + Date.now() + '.zip'), path.join(os.tmpdir(), 'smoky-ziptest-' + Date.now()));
      check('unzip rejected bei fehlender Zip (non-win)', false);
    } catch (e) {
      check('unzip rejected bei fehlender Zip (non-win)', true);
    }
  }

  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Updater-Tests bestanden ✅');
  process.exitCode = failed ? 1 : 0;
})();
