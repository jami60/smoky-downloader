// Smoky — API-Smoke-Test (läuft ohne GUI, ohne echte Downloads).
// Startet den Server auf einem zufälligen Port und prüft alle kritischen
// Endpoints auf korrekte Antworten. Ausführen: node scripts/smoke-test.js
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Test-Isolation: Daten (Settings/History) landen in einem Temp-Ordner — die
// echten Settings des Nutzers dürfen durch Tests nie überschrieben werden.
process.env.SMOKY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-data-'));
const { startServer, settings } = require('../server.js');
const APP_VERSION = require('../package.json').version;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

async function json(base, path, opts) {
  const res = await fetch(base + path, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  return { res, data };
}

(async () => {
  // Testordner statt des echten Download-Ordners — keine Nebenwirkungen.
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-smoke-'));
  settings.folder = testDir;
  const port = await startServer(0, true);
  const base = `http://127.0.0.1:${port}`;
  console.log('Server auf Port ' + port + ' gestartet\n');

  // ------------------------------------------------------------- status ----
  const { res: sr, data: st } = await json(base, '/api/status');
  check('GET /api/status → 200', sr.status === 200);
  check('  version = ' + APP_VERSION, st.version === APP_VERSION, String(st.version));
  check('  queue/history/conversions/clips sind Arrays', Array.isArray(st.queue) && Array.isArray(st.history) && Array.isArray(st.conversions) && Array.isArray(st.clips));
  check('  settings + storage vorhanden', !!st.settings && !!st.storage);
  check('  tools-Map (ytdlp/ffmpeg) vorhanden', typeof st.tools === 'object' && 'ytdlp' in st.tools && 'ffmpeg' in st.tools);
  check('  player-State vorhanden', 'player' in st);

  // ------------------------------------------------------------- version ----
  const { data: ver } = await json(base, '/api/version');
  check('GET /api/version → ' + APP_VERSION, ver.version === APP_VERSION, String(ver.version));

  // ------------------------------------------------------------- settings ----
  const { data: set1 } = await json(base, '/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxParallel: 4, theme: 'ocean' }),
  });
  check('POST /api/settings → ok', set1 && set1.settings && set1.settings.maxParallel === 4 && set1.settings.theme === 'ocean');
  const { data: st2 } = await json(base, '/api/status');
  check('  Settings-Persistenz im Status', st2.settings && st2.settings.maxParallel === 4 && st2.settings.theme === 'ocean');
  await json(base, '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxParallel: 3, theme: 'midnight' }) });
  const { res: badTheme } = await json(base, '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'does-not-exist' }) });
  check('POST /api/settings mit unbekanntem Theme → 400', badTheme.status === 400);

  // ------------------------------------------------------------- download ----
  const { res: dl1 } = await json(base, '/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  check('POST /api/download ohne URL → 400', dl1.status === 400);
  const { res: dl2 } = await json(base, '/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'not-a-url' }) });
  check('POST /api/download mit Müll → 400', dl2.status === 400);

  // ------------------------------------------------------------- playlist ----
  const { res: pl } = await json(base, '/api/playlist?url=abc');
  check('GET /api/playlist mit Müll-URL → 400', pl.status === 400);
  const { res: pl2 } = await json(base, '/api/playlist');
  check('GET /api/playlist ohne URL → 400', pl2.status === 400);
  // Bug-Hunt #6: Host-Whitelist — der lokale Server darf keine fremden URLs fetchen
  const { res: plEvil } = await json(base, '/api/playlist?url=' + encodeURIComponent('https://evil.example.com/steal'));
  check('GET /api/playlist mit fremdem Host → 400 (Whitelist)', plEvil.status === 400);
  const { res: plOkHost, data: plOkData } = await json(base, '/api/playlist?url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123'));
  // Netzwerk-robust: Entscheidend ist, dass die Whitelist den Host NICHT ablehnt
  // (ein yt-dlp-Netzwerkfehler darf den Test nicht kippen lassen).
  const whitelistRejected = plOkHost.status === 400 && /unsupported host/i.test(String((plOkData && plOkData.error) || ''));
  check('GET /api/playlist mit erlaubtem Host → nicht von Whitelist blockiert', !whitelistRejected);

  // ------------------------------------------------------------- library ----
  const { res: lib, data: libData } = await json(base, '/api/library');
  check('GET /api/library → 200 + tracks-Array', lib.status === 200 && Array.isArray(libData.tracks));

  // ------------------------------------------------------------- stats ----
  const { res: stats, data: statsData } = await json(base, '/api/stats');
  check('GET /api/stats → 200 + Kennzahlen', stats.status === 200 && typeof statsData.total === 'number' && 'bytesFmt' in statsData && 'weekCount' in statsData);

  // ------------------------------------------------------------- files -----
  const { res: cover } = await json(base, '/api/cover?file=' + encodeURIComponent('C:/does/not/exist.mp3'));
  check('GET /api/cover mit fehlender Datei → 404', cover.status === 404);
  // Cover-Regression: echte Audiodatei OHNE Cover → 204 schnell (kein Endlos-Hang)
  const ffmpegBin = path.join(__dirname, '..', 'tools', 'ffmpeg.exe');
  if (fs.existsSync(ffmpegBin)) {
    const probe = path.join(testDir, 'cover-no-cover.mp3');
    spawnSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', probe], { stdio: 'ignore', windowsHide: true });
    const t0 = Date.now();
    const cov = await fetch(base + '/api/cover?file=' + encodeURIComponent(probe));
    const dt = Date.now() - t0;
    check('GET /api/cover ohne Cover → 204 schnell (kein Hang)', cov.status === 204 && dt < 4000, 'status=' + cov.status + ' dauer=' + dt + 'ms');
  }
  const { res: play } = await json(base, '/api/play?file=' + encodeURIComponent('C:/does/not/exist.mp3'));
  check('GET /api/play mit fehlender Datei → 404', play.status === 404);
  const { res: playTraversal } = await json(base, '/api/play?file=' + encodeURIComponent('..\\..\\package.json'));
  check('GET /api/play mit Path-Traversal → 404', playTraversal.status === 404);

  // ------------------------------------------------------------- tags ------
  const { res: tags } = await json(base, '/api/edit-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'C:/does/not/exist.mp3' }) });
  check('POST /api/edit-tags mit fehlender Datei → 400', tags.status === 400);
  const { res: tagsOut } = await json(base, '/api/edit-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: '../outside.mp3' }) });
  check('POST /api/edit-tags außerhalb des Ordners → 400', tagsOut.status === 400);

  // ------------------------------------------------------------- convert ----
  const { res: conv } = await json(base, '/api/convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'C:/does/not/exist.mp3', format: 'mp3' }) });
  check('POST /api/convert mit fehlender Datei → 404', conv.status === 404);

  // ------------------------------------------------------------- upload ----
  const { res: up } = await json(base, '/api/upload', { method: 'POST', headers: { 'X-File-Name': 'test.txt' }, body: 'hallo' });
  check('POST /api/upload → 200 + Pfad', up.status === 200);

  // ------------------------------------------------------------- static ----
  const idx = await fetch(base + '/');
  const idxText = await idx.text();
  check('GET / → 200 + HTML mit #downloadPanel', idx.status === 200 && idxText.includes('downloadPanel'));
  const trav = await fetch(base + '/..%2f..%2fpackage.json');
  check('GET /..%2f..%2fpackage.json (Traversal) → nicht 200', trav.status !== 200);
  // Bug-Hunt #5: Sibling-Prefix („public2“) darf NICHT durch den Guard rutschen
  const trav2 = await fetch(base + '/..%2fpublic2%2fevil.js');
  check('GET /..%2fpublic2%2fevil.js (Sibling-Prefix) → 403', trav2.status === 403, 'status=' + trav2.status);
  const trav3 = await fetch(base + '/..%2f..%2fserver.js');
  check('GET /..%2f..%2fserver.js (Traversal hoch) → 403', trav3.status === 403, 'status=' + trav3.status);
  const okStatic = await fetch(base + '/desktop-shim.js');
  check('GET /desktop-shim.js → 200 (legitime Datei bleibt erreichbar)', okStatic.status === 200);

  // ------------------------------------------------------------- clear -----
  const { res: hc } = await json(base, '/api/history-clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('POST /api/history-clear → ok', hc.status === 200);

  console.log('\n──────────────────────────────');
  console.log(`Ergebnis: ${passed} ok, ${failed} fehlgeschlagen`);
  if (failures.length) {
    console.log('Fehlgeschlagen:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('Smoke-Test bestanden ✅');
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error('Smoke-Test abgestürzt:', e); process.exit(1); });
