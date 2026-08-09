// Smoky — Unit-Test für den Updater: Download-Fortschritt, Versionen.
// Startet einen lokalen HTTP-Server mit einer bekannten Dateigröße und
// prüft, dass onProgress() mit steigendem received/percent aufruft wird.
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { download, parseVersion, isNewer } = require('../electron/updater.js');

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

  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Updater-Tests bestanden ✅');
  process.exitCode = failed ? 1 : 0;
})();
