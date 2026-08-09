// Smoky — Cover-Flow-Test: /api/cover liefert eingebettete Covers und antwortet
// bei fehlendem Cover schnell mit 204 (Regression: sendJson(204) hing ewig).
// Erzeugt Test-MP3s mit dem gebündelten ffmpeg und prüft die HTTP-Antworten.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startServer, settings, server } = require('../server.js');

let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : '')); if (!ok) failed += 1; };

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-covers-'));
const ffmpeg = path.join(__dirname, '..', 'tools', 'ffmpeg.exe');
const ffmpegReady = fs.existsSync(ffmpeg);

(async () => {
  settings.folder = testDir;

  if (ffmpegReady) {
    // 1) MP3 mit eingebettetem JPEG-Cover (3 Schritte — die color-Quelle ist
    //    unendlich lang, ein 1-Befehl-Aufruf würde ewig kodieren und hängen)
    const tone = path.join(testDir, '_tone.mp3');
    const art = path.join(testDir, '_art.jpg');
    spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', tone], { stdio: 'ignore', windowsHide: true });
    spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', art], { stdio: 'ignore', windowsHide: true });
    spawnSync(ffmpeg, ['-y', '-i', tone, '-i', art, '-map', '0:a', '-map', '1:v', '-c:a', 'copy', '-c:v', 'copy', '-id3v2_version', '3', '-metadata:s:v', 'title=Album cover', path.join(testDir, 'with-cover.mp3')], { stdio: 'ignore', windowsHide: true });
    try { fs.rmSync(tone, { force: true }); fs.rmSync(art, { force: true }); } catch {}
    // 2) MP3 ohne Cover
    spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', path.join(testDir, 'no-cover.mp3')], { stdio: 'ignore', windowsHide: true });
  } else {
    // Ohne ffmpeg: nur ein Platzhalter, damit die 204-Antwort trotzdem getestet wird.
    fs.writeFileSync(path.join(testDir, 'no-cover.mp3'), 'kein echtes Audio — ffmpeg fehlt');
  }

  const port = await startServer(0, true);
  const base = `http://127.0.0.1:${port}`;

  const get = async (file, ms = 5000) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const t0 = Date.now();
    try {
      const res = await fetch(base + '/api/cover?file=' + encodeURIComponent(file), { signal: ctrl.signal });
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, type: res.headers.get('content-type'), len: buf.length, magic: buf.subarray(0, 3).toString('hex'), ms: Date.now() - t0 };
    } catch (e) { return { status: 'HANG/ERR ' + (e.name || e.message), ms: Date.now() - t0 }; }
    finally { clearTimeout(t); }
  };

  const withCover = await get(path.join(testDir, 'with-cover.mp3'));
  check('MP3 mit eingebettetem Cover → 200 + gültiges JPEG', withCover.status === 200 && withCover.magic === 'ffd8ff', withCover.status + ' ' + withCover.type + ' ' + withCover.ms + 'ms');
  check('  Cover-Antwort ist schnell (< 3 s)', withCover.ms < 3000, withCover.ms + 'ms');

  const noCover1 = await get(path.join(testDir, 'no-cover.mp3'));
  check('MP3 ohne Cover → 204 (kein Endlos-Hang)', noCover1.status === 204, String(noCover1.status) + ' ' + noCover1.ms + 'ms');
  check('  204-Antwort ist schnell (< 3 s)', noCover1.ms < 3000, noCover1.ms + 'ms');
  const noCover2 = await get(path.join(testDir, 'no-cover.mp3'));
  check('  erneuter Aufruf → ebenfalls 204, schnell', noCover2.status === 204 && noCover2.ms < 3000, String(noCover2.status) + ' ' + noCover2.ms + 'ms');

  const missing = await get(path.join(testDir, 'gibt-es-nicht.mp3'));
  check('fehlende Datei → 404', missing.status === 404, String(missing.status));

  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Cover-Tests bestanden ✅');
  // Server sauber schließen, damit der Prozess natürlich endet (sonst hängt der Test).
  try { server.closeAllConnections(); } catch {}
  await new Promise((r) => server.close(r));
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('Cover-Test abgestürzt:', e); process.exitCode = 1; });
