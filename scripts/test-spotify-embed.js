// Spotify-Listing-Test (Netzwerk):
//  1) Playlist → schnelle Trackliste mit echten Track-URLs (Embed-Pfad, < 15 s)
//  2) Album → klare Meldung statt hängendem Picker (Spotify blockiert Album-Embeds)
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SMOKY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-spotify-'));
const { startServer } = require('../server.js');

let failures = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra && !ok ? ' — ' + extra : ''));
  if (!ok) failures++;
};

(async () => {
  const port = await startServer(0, true);
  const base = `http://127.0.0.1:${port}`;

  // 1) Playlist (Today's Top Hits, 50 Tracks) — Embed-Pfad, schnell
  const t0 = Date.now();
  let pl;
  try {
    const res = await fetch(base + '/api/playlist?url=' + encodeURIComponent('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'));
    pl = await res.json();
    const dt = Date.now() - t0;
    check('Playlist: 200 + Tracks', res.status === 200 && Array.isArray(pl.tracks) && pl.tracks.length > 0, 'status=' + res.status);
    check('Playlist: schnell (< 15 s)', dt < 15000, 'dauer=' + dt + 'ms');
    if (Array.isArray(pl.tracks) && pl.tracks.length) {
      const t = pl.tracks[0];
      check('Playlist: Track mit URL', /^https?:\/\/open\.spotify\.com\/track\//i.test(t.url || ''), JSON.stringify(t).slice(0, 100));
      check('Playlist: Track mit Titel/Künstler', !!(t.title && t.artist), JSON.stringify(t).slice(0, 100));
      console.log(`  (${pl.tracks.length} Tracks, erste: ${t.title} — ${t.artist}, ${dt}ms)`);
    }
  } catch (e) {
    check('Playlist: 200 + Tracks', false, String(e && e.message || e));
  }

  // 2) Album → klare Meldung (kein Endlos-Hang), schnell genug
  const t1 = Date.now();
  try {
    const res = await fetch(base + '/api/playlist?url=' + encodeURIComponent('https://open.spotify.com/album/2guirTSEqLizK7h9Ek8aud'));
    const body = await res.json();
    const dt = Date.now() - t1;
    const msg = String((body && body.error) || '');
    check('Album: Fehler mit klarer Meldung', res.status === 400 && /Album/i.test(msg), 'status=' + res.status + ' msg=' + msg.slice(0, 80));
    check('Album: Meldung schnell (< 40 s)', dt < 40000, 'dauer=' + dt + 'ms');
    console.log('  (Meldung: ' + msg.slice(0, 90) + '…)');
  } catch (e) {
    check('Album: Fehler mit klarer Meldung', false, String(e && e.message || e));
  }

  console.log(failures ? `\n✗ ${failures} Test(s) fehlgeschlagen` : '\nAlle Spotify-Listing-Tests bestanden ✅');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('Test abgestürzt:', e); process.exit(1); });
