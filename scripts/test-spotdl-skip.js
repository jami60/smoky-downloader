// Regression-Test (Bug-Hunt #1): Ein Spotify-Download, dessen Datei bereits im
// Zielordner existiert, darf NICHT als „failed“ enden. spotDL überspringt die
// Datei (overwrite=skip), liefert Exit 0 ohne neue Datei — die App muss die
// vorhandene Datei als Ergebnis übernehmen.
//
// Benötigt Netzwerk (spotDL holt die Track-Metadaten von der Spotify-API) und
// eine spotDL-Installation. Der Skip-Check selbst ist schnell (< 10 s).
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), 'smoky-skip-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const DATA = path.join(TMP, 'data');
const FOLDER = path.join(TMP, 'out');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(FOLDER, { recursive: true });

process.env.SMOKY_DATA_DIR = DATA;

const { startServer } = require('../server.js');

const URL = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'; // Rick Astley – Never Gonna Give You Up

async function main() {
  // Dummy-Datei mit EXAKT dem Namen, den spotDL erzeugen würde — aber älter
  // als der Lauf (mtime-Filter der App darf sie nicht als „neu“ werten).
  const dummy = path.join(FOLDER, 'Rick Astley - Never Gonna Give You Up.mp3');
  fs.writeFileSync(dummy, 'x');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(dummy, old, old);

  const port = await startServer(0, true);
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

  console.log('E2E: Spotify-Download, Datei existiert bereits …');
  const { item } = await post('/api/download', { url: URL, format: 'mp3', quality: '1080', outputDir: FOLDER, browserName: 'none' });
  const id = item.id;

  let result = null;
  for (let i = 0; i < 90 && !result; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await fetch(base + '/api/status').then(r => r.json());
    const q = s.queue.find(x => x.id === id);
    if (q && ['finished', 'failed', 'cancelled'].includes(q.status)) result = q;
  }

  if (!result) { console.log('✗ TIMEOUT — Download lief nicht zu Ende'); process.exit(1); }

  const ok = result.status === 'finished' && result.file === dummy;
  console.log(`  Status: ${result.status}`);
  console.log(`  File:   ${result.file}`);
  if (!ok) {
    console.log(`  Error:  ${result.error || '(keiner)'}`);
    console.log('✗ vorhandene Datei wurde nicht als Ergebnis übernommen');
    process.exit(1);
  }
  console.log('✅ Re-Download vorhandener Track → finished (nicht failed)');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
