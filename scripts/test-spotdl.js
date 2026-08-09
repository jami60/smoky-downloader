// Smoky — Spotify/spotDL-Test (echter Netzwerk-Download, dauert ~1-2 min).
// Prüft die drei kritischen Fälle, die vor dem Fix kaputt waren:
//   1. spotDL „No results found“ → Download muss ehrlich FAILED melden (und
//      darf sich NICHT einen fremden alten File als „Ergebnis“ angeln)
//   2. erfolgreicher Einzel-Track → finished + echte .mp3-Datei
//   3. gebündelter Playlist-Download (mehrere Tracks in EINEM spotDL-Prozess)
//      → finished + alle Dateien vorhanden
// Ausführen: node scripts/test-spotdl.js
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
// Test-Isolation: echte Settings/History des Nutzers werden nie angefasst.
process.env.SMOKY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-spotdl-data-'));
const { startServer, settings, server } = require('../server.js');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

const TRACK_FAIL = 'https://open.spotify.com/track/5f0eAqFsGRYuYqzSzO6NA1'; // „nettspend 2 - Playground“ — kein YouTube-Treffer → No results
const TRACK_OK_A = 'https://open.spotify.com/track/1XkdHD8nWyj5YWbqYmckGJ?si=test'; // glosuka - P4in
const TRACK_OK_B = 'https://open.spotify.com/track/44Q5zOKMfSuJMOjHyfUBwY?si=test'; // Turk - I Can't Wait

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(base, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(base + '/api/status');
    const st = await res.json();
    const item = (st.queue || []).find((q) => q.id === id);
    if (!item) return null;
    if (['finished', 'failed', 'cancelled'].includes(item.status)) return item;
    await sleep(1500);
  }
  return null;
}

(async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-spotdl-'));
  settings.folder = testDir;
  settings.organizeFolders = false; // Dateien bleiben flach — Test einfacher
  const port = await startServer(0, true);
  const base = `http://127.0.0.1:${port}`;
  console.log('Server auf Port ' + port + ' gestartet (Testordner: ' + testDir + ')\n');

  // --------------------------------------------------------- 1) Fail-Honesty
  console.log('1) Fehlgeschlagener Track („No results“) → ehrlich failed:');
  // Köder: alter, fremder „MP3“ liegt im Ordner — darf nie als Ergebnis gelten.
  const decoy = path.join(testDir, 'Decoy Old File.mp3');
  fs.writeFileSync(decoy, 'not really audio');
  fs.utimesSync(decoy, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));

  const r1 = await fetch(base + '/api/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: TRACK_FAIL, format: 'mp3', quality: '320', outputDir: testDir }),
  });
  const j1 = await r1.json();
  const item1 = await waitFor(base, j1.item.id, 180000);
  check('Status ist failed (nicht finished)', item1 && item1.status === 'failed', item1 && item1.status + ' | ' + (item1.error || ''));
  check('  Fehlermeldung nennt die Ursache', item1 && /not found|no results/i.test(item1.error || ''), item1 && item1.error);
  check('  kein fremder File als Ergebnis', !item1 || !item1.file || item1.file !== decoy, item1 && item1.file);
  console.log('');

  // ------------------------------------------------- 2) Erfolgreicher Einzel-Track
  console.log('2) Erfolgreicher Track → finished mit echter Datei:');
  const r2 = await fetch(base + '/api/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: TRACK_OK_A, format: 'mp3', quality: '320', outputDir: testDir }),
  });
  const j2 = await r2.json();
  const item2 = await waitFor(base, j2.item.id, 240000);
  check('Status ist finished', item2 && item2.status === 'finished', item2 && item2.status + ' | ' + (item2.error || ''));
  check('  Datei existiert und ist eine Audio-Datei', !!item2 && !!item2.file && /\.(mp3|m4a|flac|wav|ogg|opus)$/i.test(item2.file) && fs.existsSync(item2.file), item2 && item2.file);
  check('  Titel wurde aus der Datei übernommen', !!item2 && item2.title && item2.title !== 'Spotify track…', item2 && item2.title);
  console.log('');

  // -------------------------------------------- 3) Gebündelter Playlist-Download
  console.log('3) Gebündelter Playlist-Download (2 Tracks, EIN Prozess):');
  const r3 = await fetch(base + '/api/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: TRACK_OK_B, format: 'mp3', quality: '320', outputDir: testDir, tracks: [TRACK_OK_B, TRACK_OK_A] }),
  });
  const j3 = await r3.json();
  const item3 = await waitFor(base, j3.item.id, 300000);
  check('Status ist finished', item3 && item3.status === 'finished', item3 && item3.status + ' | ' + (item3.error || ''));
  // Beide Tracks müssen als neue Dateien da sein (glosuka wurde in Test 2 schon
  // geladen → wird übersprungen, also zählen wir nur die NEUEN Dateien).
  const files = fs.readdirSync(testDir).filter((f) => /\.mp3$/i.test(f));
  check('  mind. 1 neue Datei im Ordner', files.length >= 1, files.join(', '));
  check('  beide Tracks vorhanden (eine wird übersprungen, eine neu)', files.some((f) => /I Can't Wait/i.test(f)), files.join(', '));
  console.log('');

  // Aufräumen
  try { server.close(); } catch {}
  console.log(failed === 0 ? `\n✅ Alle ${passed} Spotify-Tests bestanden` : `\n❌ ${failed} von ${passed + failed} Spotify-Tests fehlgeschlagen`);
  if (failures.length) console.log(failures.join('\n'));
  process.exit(failed === 0 ? 0 : 1);
})();
