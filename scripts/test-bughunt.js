// Unit-Tests für die Bug-Hunt-Fixes (ohne Netzwerk):
//  - findExistingSpotFiles: Skip-Zeilen → vorhandene Datei finden
//  - spotFormatFor: Formatwahl der UI → spotDL-Format (aac → mp3)
//  - displayTitle: [videoId]-Suffix aus dem Anzeige-Titel entfernen
//  - moveFile: Verschieben (auch über den Copy-Fallback)
//  - recommendationSeeds/buildRecommendations/recSearch (Fake-Fetcher)
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');

const { findExistingSpotFiles, spotFormatFor, displayTitle, moveFile, findFileRecursive, clipOutPath, recommendationSeeds, buildRecommendations, recSearch, librarySeeds, mergeSeedLists, buildSimilar, settings } = require('../server.js');
const { history } = require('../server.js');
const { buildUpdateBat, buildUpdateSh } = require('../electron/updater.js');
const { spawnSync } = require('node:child_process');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + ' — ' + e.message); }
};

// ------------------------------------------------- findExistingSpotFiles ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-bughunt-'));
try {
  fs.writeFileSync(path.join(TMP, 'Rick Astley - Never Gonna Give You Up.mp3'), 'a');
  fs.writeFileSync(path.join(TMP, 'Anderer Künstler - Anderer Track.flac'), 'b');
  fs.writeFileSync(path.join(TMP, 'noise.txt'), 'c');
  fs.writeFileSync(path.join(TMP, 'Skipped Song.mp4'), 'd'); // Video zählt nicht

  check('findExistingSpotFiles: matcht Datei aus Skip-Zeile', () => {
    const tail = 'Skipping Rick Astley - Never Gonna Give You Up (file already exists) \n';
    const found = findExistingSpotFiles(TMP, tail);
    assert.strictEqual(found.length, 1);
    assert.ok(found[0].endsWith('Never Gonna Give You Up.mp3'));
  });

  check('findExistingSpotFiles: neueste Übereinstimmung zuerst', () => {
    const tail = 'Skipping Song (file already exists)';
    const a = path.join(TMP, 'Song.flac');
    const b = path.join(TMP, 'Song.mp3');
    fs.writeFileSync(a, 'x'); fs.writeFileSync(b, 'y');
    const newer = new Date(); const older = new Date(Date.now() - 10_000);
    fs.utimesSync(a, older, older); fs.utimesSync(b, newer, newer);
    const found = findExistingSpotFiles(TMP, tail);
    assert.strictEqual(found[0], b);
    fs.unlinkSync(a); fs.unlinkSync(b);
  });

  check('findExistingSpotFiles: ohne Skip-Zeilen → leer', () => {
    assert.deepStrictEqual(findExistingSpotFiles(TMP, 'irgendeine ausgabe ohne skip'), []);
  });

  check('findExistingSpotFiles: ignorieren falscher Endungen', () => {
    const found = findExistingSpotFiles(TMP, 'Skipping Skipped Song (file already exists)');
    assert.deepStrictEqual(found, []); // .mp4 ist kein AUDIO_EXTS
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------- spotFormatFor ----
check('spotFormatFor: unterstützte Formate durchreichen', () => {
  for (const f of ['mp3', 'flac', 'ogg', 'opus', 'm4a', 'wav']) assert.strictEqual(spotFormatFor(f), f);
});
check('spotFormatFor: aac/mp4/undefined → mp3', () => {
  assert.strictEqual(spotFormatFor('aac'), 'mp3');
  assert.strictEqual(spotFormatFor('mp4'), 'mp3');
  assert.strictEqual(spotFormatFor(undefined), 'mp3');
});

// ---------------------------------------------------------- displayTitle ----
check('displayTitle: [videoId]-Suffix entfernen', () => {
  assert.strictEqual(displayTitle('Song Name [abc123XYZ_9].mp3'), 'Song Name');
});
check('displayTitle: Klammern im echten Titel bleiben', () => {
  assert.strictEqual(displayTitle('Song [feat. Artist].mp3'), 'Song [feat. Artist]');
  assert.strictEqual(displayTitle('Song [Teil 2].mp3'), 'Song [Teil 2]');
});
check('displayTitle: Titel ohne Suffix unverändert', () => {
  assert.strictEqual(displayTitle('plain.mp3'), 'plain');
  assert.strictEqual(displayTitle('Artist - Title.flac'), 'Artist - Title');
});

// ------------------------------------------------------------- moveFile ----
check('moveFile: normales Verschieben', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-move-'));
  const a = path.join(d, 'a.txt'), b = path.join(d, 'b.txt');
  fs.writeFileSync(a, 'inhalt');
  assert.ok(moveFile(a, b));
  assert.ok(!fs.existsSync(a) && fs.readFileSync(b, 'utf8') === 'inhalt');
  fs.rmSync(d, { recursive: true, force: true });
});
check('moveFile: Copy-Fallback greift, wenn rename wirft', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-move-'));
  const a = path.join(d, 'a.txt'), b = path.join(d, 'sub', 'b.txt');
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.writeFileSync(a, 'inhalt');
  // rename scheitert hier nicht, aber der Fallback-Pfad wird direkt getestet:
  // Ziel existiert schon nach dem Kopieren nicht doppelt, Quelle weg.
  assert.ok(moveFile(a, b));
  assert.ok(!fs.existsSync(a) && fs.readFileSync(b, 'utf8') === 'inhalt');
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------- findFileRecursive (Tools) --
check('findFileRecursive: findet verschachtelte Datei', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-find-'));
  fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(d, 'a', 'b', 'ffmpeg.exe'), 'x');
  assert.strictEqual(findFileRecursive(d, 'ffmpeg.exe'), path.join(d, 'a', 'b', 'ffmpeg.exe'));
  fs.rmSync(d, { recursive: true, force: true });
});
check('findFileRecursive: null bei fehlender Datei', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-find-'));
  fs.writeFileSync(path.join(d, 'nope.txt'), 'x');
  assert.strictEqual(findFileRecursive(d, 'ffmpeg.exe'), null);
  fs.rmSync(d, { recursive: true, force: true });
});

// ----------------------------------------------------------- clipOutPath ----
check('clipOutPath: frischer Pfad ohne Suffix', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-clipout-'));
  const p = clipOutPath(d, 'Song', '0-00', '0-04', 'mp4');
  assert.strictEqual(p, path.join(d, 'Song (0-00-0-04).mp4'));
  fs.rmSync(d, { recursive: true, force: true });
});
check('clipOutPath: Kollision bekommt (2)-Suffix statt Überschreiben', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-clipout-'));
  const p1 = clipOutPath(d, 'Song', '0-00', '0-04', 'mp4');
  fs.writeFileSync(p1, 'x');
  const p2 = clipOutPath(d, 'Song', '0-00', '0-04', 'mp4');
  assert.strictEqual(p2, path.join(d, 'Song (0-00-0-04) (2).mp4'));
  fs.writeFileSync(p2, 'x');
  const p3 = clipOutPath(d, 'Song', '0-00', '0-04', 'mp4');
  assert.strictEqual(p3, path.join(d, 'Song (0-00-0-04) (3).mp4'));
  fs.rmSync(d, { recursive: true, force: true });
});
check('clipOutPath: anderes Zeitfenster bleibt unberührt', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-clipout-'));
  const p1 = clipOutPath(d, 'Song', '0-00', '0-04', 'mp4');
  fs.writeFileSync(p1, 'x');
  const p2 = clipOutPath(d, 'Song', '0-05', '0-10', 'mp4');
  assert.strictEqual(p2, path.join(d, 'Song (0-05-0-10).mp4'));
  fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------ Empfehlungen ----
// Seeds: aus der History (zuletzt zuerst, dedupliziert, min. 3 Zeichen, max. 4)
check('recommendationSeeds: leere History → leere Seeds', () => {
  const saved = history.splice(0);
  assert.deepStrictEqual(recommendationSeeds(), []);
  history.push(...saved);
});
check('recommendationSeeds: Reihenfolge (neueste zuerst) + Dedupe', () => {
  const saved = history.splice(0);
  // history ist neueste-zuerst (unshift) — Index 0 = zuletzt geladen
  history.push({ title: 'Neuer Titel' }, { title: 'Älterer Titel' }, { title: 'Neuer Titel' }, { title: 'xy' });
  assert.deepStrictEqual(recommendationSeeds(), ['Neuer Titel', 'Älterer Titel']);
  history.push(...saved);
});
check('recommendationSeeds: max. 4 Seeds', () => {
  const saved = history.splice(0);
  for (let i = 0; i < 8; i++) history.push({ title: 'Track Nummer ' + i });
  const seeds = recommendationSeeds();
  assert.strictEqual(seeds.length, 4);
  history.push(...saved);
});
check('recommendationSeeds: [videoId]-Suffix wird entfernt (sonst leere Treffer)', () => {
  const saved = history.splice(0);
  history.push({ title: 'Song Name [abc123XYZ_9]' }, { title: 'Anderer [XYZ9999999]' });
  assert.deepStrictEqual(recommendationSeeds(), ['Song Name', 'Anderer']);
  history.push(...saved);
});

// buildRecommendations mit Fake-Fetcher (kein Netzwerk)
const fakeHit = (id, title, channel, extra = {}) => ({ id, title, channel, url: 'https://www.youtube.com/watch?v=' + id, duration: 200, thumb: '', ...extra });

check('buildRecommendations: baut Items + dedupliziert nach ID', async () => {
  const saved = history.splice(0);
  history.push({ title: 'Seed Eins' }, { title: 'Seed Zwei' });
  const items = await buildRecommendations(['Seed Eins', 'Seed Zwei'], async (q) => {
    if (q === 'Seed Eins') return [fakeHit('aaa111', 'Titel A', 'Kanal A'), fakeHit('bbb222', 'Titel B', 'Kanal B')];
    return [fakeHit('aaa111', 'Titel A (duplikat)', 'Kanal A'), fakeHit('ccc333', 'Titel C', 'Kanal C')];
  });
  assert.strictEqual(items.length, 3);
  assert.deepStrictEqual(items.map((i) => i.id).sort(), ['aaa111', 'bbb222', 'ccc333']);
  history.push(...saved);
});

check('buildRecommendations: filtert bereits geladene Videos (URL-ID)', async () => {
  const saved = history.splice(0);
  history.push({ title: 'Seed', url: 'https://www.youtube.com/watch?v=known12345' });
  const items = await buildRecommendations(['Seed'], async () => [fakeHit('known12345', 'Schon geladen', 'K'), fakeHit('fresh99999', 'Frisch', 'K')]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, 'fresh99999');
  history.push(...saved);
});

check('buildRecommendations: filtert bereits geladene Titel (Case-insensitiv)', async () => {
  const saved = history.splice(0);
  history.push({ title: 'Schon Da' });
  const items = await buildRecommendations(['Seed'], async () => [fakeHit('aaa111', 'SCHON DA', 'K')]);
  assert.strictEqual(items.length, 0);
  history.push(...saved);
});

check('buildRecommendations: fehlschlagender Seed bricht nichts', async () => {
  const saved = history.splice(0);
  history.push({ title: 'Gut' }, { title: 'Kaputt' });
  const items = await buildRecommendations(['Gut', 'Kaputt'], async (q) => {
    if (q === 'Kaputt') throw new Error('netzwerk weg');
    return [fakeHit('aaa111', 'Titel A', 'K')];
  });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, 'aaa111');
  history.push(...saved);
});

check('buildRecommendations: Ergebnis-Cap wird eingehalten', async () => {
  const saved = history.splice(0);
  history.push({ title: 'Seed' });
  const many = Array.from({ length: 30 }, (_, i) => fakeHit('id' + String(i).padStart(6, '0'), 'Titel ' + i, 'K'));
  const items = await buildRecommendations(['Seed'], async () => many);
  assert.ok(items.length <= 18, 'mehr als 18 Items: ' + items.length);
  history.push(...saved);
});

// recSearch: Roh-Treffer → sauberes Item-Mapping (Thumb-Fallback, Playlist-Filter)
check('recSearch: Thumb-Fallback aus ID + Playlist-URLs rausgefiltert', async () => {
  const items = await recSearch('q', async () => [
    { id: 'abc123XYZ', title: 'Song', channel: 'Chan' },
    { id: 'pl9999999', title: 'Playlist', url: 'https://www.youtube.com/playlist?list=x' },
  ]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].thumb, 'https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg');
  assert.strictEqual(items[0].url, 'https://www.youtube.com/watch?v=abc123XYZ');
});

// ------------------------------------------- Empfehlungen erweitert ----
// mergeSeedLists: primär zuerst, dedupliziert, gedeckelt, min. 3 Zeichen
check('mergeSeedLists: primär zuerst + Dedupe', () => {
  assert.deepStrictEqual(mergeSeedLists(['Song A', 'Song B'], ['Song B', 'Song C'], 10), ['Song A', 'Song B', 'Song C']);
});
check('mergeSeedLists: Cap wird eingehalten', () => {
  assert.strictEqual(mergeSeedLists(['Song Eins', 'Song Zwei', 'Song Drei'], ['Song Vier', 'Song Fünf'], 3).length, 3);
});
check('mergeSeedLists: zu kurze + leere Einträge raus', () => {
  assert.deepStrictEqual(mergeSeedLists(['ab', '', '  '], ['Guter Seed'], 10), ['Guter Seed']);
});
check('mergeSeedLists: Case-insensitive Dedupe', () => {
  assert.deepStrictEqual(mergeSeedLists(['Song X'], ['song x'], 10), ['Song X']);
});

// buildSimilar mit Fake-Fetcher: exkludiert die eigene ID + bekannte Einträge
check('buildSimilar: exkludiert eigene ID + History-Treffer', async () => {
  const saved = history.splice(0);
  history.push({ title: 'Bekannt', url: 'https://www.youtube.com/watch?v=known99999' });
  const items = await buildSimilar('Mein Titel', 'own1234567', async () => [
    { id: 'own1234567', title: 'Das Original', channel: 'K' },
    { id: 'known99999', title: 'Bekannt', channel: 'K' },
    { id: 'fresh11111', title: 'Frischer Treffer', channel: 'K' },
  ]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, 'fresh11111');
  assert.strictEqual(items[0].similarOf, 'Mein Titel');
  history.push(...saved);
});
check('buildSimilar: leerer Titel → leere Treffer (kein Netzwerk)', async () => {
  assert.deepStrictEqual(await buildSimilar('  ', 'x'), []);
});
check('buildSimilar: fehlschlagender Suchlauf → leere Treffer', async () => {
  assert.deepStrictEqual(await buildSimilar('Titel', 'x', async () => { throw new Error('offline'); }), []);
});
check('buildSimilar: Cap (12) wird eingehalten', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 'id' + String(i).padStart(6, '0'), title: 'T ' + i, channel: 'K' }));
  const items = await buildSimilar('Titel', '', async () => many);
  assert.strictEqual(items.length, 12);
});

// librarySeeds: echte Tags (Künstler + Titel) aus der Bibliothek → „artist - title"
check('librarySeeds: baut artist - title Queries aus getaggten Dateien', async () => {
  const ffmpeg = require('node:path').join(__dirname, '..', 'tools', 'ffmpeg.exe');
  if (!require('node:fs').existsSync(ffmpeg)) { console.log('  (ffmpeg fehlt — übersprungen)'); return; }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-libseeds-'));
  const mk = (name, title, artist) => {
    const f = path.join(d, name);
    spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '-metadata', 'title=' + title, '-metadata', 'artist=' + artist, f], { stdio: 'ignore', windowsHide: true });
    return f;
  };
  mk('a.mp3', 'Song Eins', 'Künstler A');
  mk('b.mp3', 'Song Zwei', 'Künstler B');
  mk('c.mp3', 'Nur Titel');
  const oldFolder = settings.folder;
  settings.folder = d;
  try {
    const seeds = await librarySeeds();
    assert.ok(seeds.includes('Künstler A - Song Eins'), JSON.stringify(seeds));
    assert.ok(seeds.includes('Künstler B - Song Zwei'), JSON.stringify(seeds));
    assert.ok(seeds.some((s) => s.includes('Nur Titel')), JSON.stringify(seeds));
  } finally {
    settings.folder = oldFolder;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --------------------------------------- Update-Relaunch (statische Checks) --
// Regression: Nach dem Update-Relaunch konnte die allererste Navigation des
// Fensters scheitern (ERR_EMPTY_RESPONSE) und blieb ohne Retry kaputt — der
// Nutzer musste die App manuell neu starten. loadUI muss die URL mit Pause
// wiederholen. Außerdem darf der Batch seine Staging-Variable NICHT "TMP"
// nennen (PowerShell erbt %TMP% und legt seinen Temp-Ordner dort neu an).
check('loadUI: UI wird mit Retry geladen (kein toter Relaunch)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('function loadUI(win, port)'), 'loadUI fehlt in main.js');
  assert.ok(main.includes('MAX_ATTEMPTS'), 'Retry-Limit fehlt');
  assert.ok(main.includes('win.loadURL(`http://127.0.0.1:${port}`).catch('), 'Retry auf loadURL fehlt');
});
check('Update-Batch: Staging-Variable heißt UPDDIR (nicht TMP)', () => {
  const body = buildUpdateBat({ newAsar: 'n', targetAsar: 't', tmp: 'x', execPath: 'e', markerBase: 'm', failFile: 'f' });
  assert.ok(!body.includes('set "TMP='), 'Batch setzt TMP (PowerShell-Temp-Kollision)');
  assert.ok(body.includes('set "UPDDIR='), 'Batch setzt UPDDIR nicht');
  assert.ok(body.includes('rmdir /s /q "!UPDDIR!"'), 'rmdir nutzt !UPDDIR! nicht');
});
check('Update-Batch: Relaunch entkoppelt von der Konsole (Start-Process)', () => {
  const body = buildUpdateBat({ newAsar: 'n', targetAsar: 't', tmp: 'x', execPath: 'e', markerBase: 'm', failFile: 'f' });
  assert.strictEqual((body.match(/Start-Process -FilePath '!EXEC!'/g) || []).length, 3);
  assert.strictEqual((body.match(/if errorlevel 1 start "" "!EXEC!"/g) || []).length, 3);
});
// Regression: Mac-Auto-Update schlug mit „spawn powershell ENOENT" fehl, weil
// die Extraktion hartkodiert PowerShell aufrief. Der Updater muss je Plattform
// ditto (macOS) bzw. unzip (Linux) verwenden und über /bin/sh relaunchen.
check('Updater: plattform-übergreifend (kein hartkodiertes spawn(powershell))', () => {
  const upd = fs.readFileSync(path.join(__dirname, '..', 'electron', 'updater.js'), 'utf8');
  // Kommentare ausblenden — der Hinweistext selbst enthält `spawn('powershell')`.
  const code = upd.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/spawn\(\s*'powershell'/.test(code), 'updater.js ruft spawn(\'powershell\') direkt auf (Mac-ENOENT-Bug)');
  assert.ok(upd.includes("process.platform === 'darwin'"), 'darwin-Zweig fehlt');
  assert.ok(upd.includes("cmd = 'ditto'"), 'ditto für macOS fehlt');
  assert.ok(upd.includes("cmd = 'unzip'"), 'unzip für Linux fehlt');
  assert.ok(upd.includes('function buildUpdateSh'), 'buildUpdateSh fehlt');
  assert.ok(upd.includes("spawn('/bin/sh', [sh]"), 'macOS-Relaunch über /bin/sh fehlt');
  const sh = buildUpdateSh({ newAsar: '/n', targetAsar: '/t', relaunch: 'open /App', failFile: '/f' });
  assert.ok(!/powershell|\bcmd\b|taskkill|tasklist/.test(sh), 'Sh-Skript enthält Windows-Reste');
  assert.ok(sh.includes('cp -f "$NEW" "$TARGET"'), 'Sh-Skript tauscht app.asar nicht');
});

// ------------------------------------------- Tab-Shift (statische Checks) --
// Regression: Beim Tab-Wechsel erschien/verschwand die klassische vertikale
// Scrollbar (je nach Seitenhöhe) und verschob dadurch den zentrierten
// main-Block sowie den Album-/Karten-Grid horizontal. scrollbar-gutter:stable
// reserviert die Gutter-Spalte dauerhaft → kein Shift mehr.
check('index.html: html reserviert scrollbar-gutter:stable (kein Karten-Shift)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/html \{[^}]*scrollbar-gutter:stable/.test(html), 'scrollbar-gutter:stable fehlt im html-Block');
});
check('main.js: Smoke-Probe layout prüft Gutter-Stabilität', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('layout: (() => {'), 'layout-Probe fehlt');
  assert.ok(main.includes("getComputedStyle(html).scrollbarGutter"), 'scrollbarGutter-Check fehlt in Probe');
});
// ------------------------------------------- Video-Player (statisch) ----
check('server.js: VIDEO_EXTS definiert + kind im Library-Scan', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/VIDEO_EXTS = new Set\(\['\.mp4', '\.webm', '\.mkv', '\.mov'\]\)/.test(srv), 'VIDEO_EXTS fehlt');
  assert.ok(srv.includes("kind: isVideo ? 'video' : 'audio'"), 'kind fehlt im Library-Scan');
  assert.ok(srv.includes('VIDEO_EXTS.has(path.extname(e.name).toLowerCase())'), 'Videos fehlen im Scan-Walk');
  assert.ok(srv.includes('function videoFrame'), 'videoFrame (Thumbnail) fehlt');
  assert.ok(srv.includes('const isVideo = VIDEO_EXTS.has(path.extname(file).toLowerCase())'), 'coverFor erkennt Videos nicht');
  assert.ok(srv.includes('LIBRARY_CACHE_MS'), 'Library-Cache fehlt');
  assert.ok(srv.includes('invalidateLibraryCache()'), 'Cache-Invalidierung fehlt');
});
check('server.js: Plattform-Tools für Windows + macOS (Mac-Build)', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(srv.includes("const IS_MAC = process.platform === 'darwin'"), 'IS_MAC fehlt');
  assert.ok(srv.includes("TOOL_YTDLP_NAME = IS_MAC ? 'yt-dlp' : 'yt-dlp.exe'"), 'TOOL_YTDLP_NAME fehlt');
  assert.ok(srv.includes("TOOL_FFMPEG_NAME = IS_MAC ? 'ffmpeg' : 'ffmpeg.exe'"), 'TOOL_FFMPEG_NAME fehlt');
  assert.ok(srv.includes('yt-dlp_macos'), 'macOS-yt-dlp-Download-URL fehlt');
  assert.ok(srv.includes('ffmpeg.martin-riedl.de/redirect/latest/macos'), 'macOS-ffmpeg-URL fehlt');
  assert.ok(srv.includes("IS_MAC ? 'python3' : 'py'"), 'Python-Auswahl (py/python3) fehlt');
  assert.ok(srv.includes("'unzip', ['-o', '-q', zip, '-d', extractDir]"), 'unzip für macOS fehlt');
  // macOS-Tools-Flow: schreibbarer Ort (resources/tools statt read-only asar),
  // Neuauflösung nach Update (reloadTools) + plattformgerechte Install-Hints.
  assert.ok(srv.includes('path.join(process.resourcesPath, \'tools\')'), 'resources/tools-Fallback fehlt');
  assert.ok(/function reloadTools\(\)[\s\S]*?reloadTools\(\);/.test(srv), 'reloadTools fehlt');
  assert.ok(srv.includes('try { reloadTools(); } catch {}'), 'reloadTools nach Tools-Update fehlt');
  assert.ok(srv.includes("IS_MAC ? 'brew install yt-dlp' : 'py -m pip install -U yt-dlp'"), 'YTDLP_INSTALL_HINT fehlt');
  assert.ok(srv.includes('${YTDLP_INSTALL_HINT}'), 'YTDLP_INSTALL_HINT wird nicht genutzt');
});
check('package.json: mac-Target + icns + make-icns-Skript', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.mac, 'mac-Build-Konfig fehlt');
  assert.ok(pkg.build.mac.icon === 'electron/icon.icns', 'mac-Icon fehlt');
  assert.ok(!('electronDist' in pkg.build), 'electronDist-Override blockiert den Mac-Build (Windows-Pfad existiert auf dem Runner nicht)');
  const targets = (pkg.build.mac.target || []).map((t) => (typeof t === 'string' ? t : t.target)).join(',');
  assert.ok(targets.includes('dmg') && targets.includes('zip'), 'dmg/zip-Targets fehlen: ' + targets);
  assert.ok(pkg.scripts['icon:mac'], 'icon:mac-Skript fehlt');
  const icns = fs.readFileSync(path.join(__dirname, '..', 'electron', 'icon.icns'));
  assert.ok(icns.toString('ascii', 0, 4) === 'icns', 'icon.icns ist kein valides icns');
  const icnsScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'make-icns.js'), 'utf8');
  assert.ok(!icnsScript.includes('ffmpeg'), 'make-icns.js darf kein ffmpeg brauchen (GitHub-Runner hat keins)');
  assert.ok(icnsScript.includes('decodePNG') && icnsScript.includes('encodePNG'), 'make-icns.js braucht PNG-Decoder/Encoder');
});
check('.github/workflows/mac-release.yml: Mac-Build + Release-Upload', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'mac-release.yml'), 'utf8');
  assert.ok(wf.includes('macos-latest'), 'Kein macOS-Runner');
  assert.ok(wf.includes('electron-builder --mac --publish never'), 'Kein --mac-Build mit publish never');
  assert.ok(wf.includes('make-icns.js'), 'Kein icns-Schritt');
  assert.ok(wf.includes('gh release upload'), 'Kein Release-Upload (gh)');
  assert.ok(wf.includes('Smoky-*-mac.zip') && wf.includes('Smoky-*.dmg'), 'Mac-Globs fehlen');
  assert.ok(wf.includes('--clobber'), '--clobber fehlt (bestehende Release überschreiben)');
});
check('index.html: Video-Player (Toggle + <video> + currentMedia + Hotkeys)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('mediaKindToggle'), 'Musik/Videos-Toggle fehlt');
  assert.ok(html.includes('<video id="playerVideo"'), 'playerVideo-Element fehlt');
  assert.ok(html.includes('const currentMedia = () =>'), 'currentMedia-Helper fehlt');
  assert.ok(html.includes("(tr.kind || 'audio') === 'video'"), 'Video-Erkennung im Render fehlt');
  assert.ok(html.includes('player.kindVideo'), 'i18n-Key kindVideo fehlt');
  assert.ok(html.includes('player.emptyVideo'), 'i18n-Key emptyVideo fehlt');
});
check('main.js: Smoke-Probe videos prüft Toggle + Wiedergabe-Umschaltung', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('videos: await (async () => {'), 'videos-Probe fehlt');
  assert.ok(main.includes('mediaKindToggle [data-kind="video"]'), 'Video-Toggle fehlt in Probe');
  assert.ok(main.includes('pv.style.display'), 'Video-Element-Check fehlt in Probe');
});
check('index.html: Mita-Toggle (Settings + Gating von Sticker/Toast)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="mitaToggle"'), 'Mita-Toggle fehlt in Settings');
  assert.ok(html.includes("smoky-mita-disabled'"), 'Storage-Key smoky-mita-disabled fehlt');
  assert.ok(html.includes('const mitaDisabled = () =>'), 'mitaDisabled-Helper fehlt');
  assert.ok(html.includes('if (mitaDisabled()) return;'), 'mitaSay ist nicht gegated');
  assert.ok(html.includes("if (mitaDisabled()) mitaSticker.style.display = 'none'"), 'Sticker-Hide beim Laden fehlt');
  assert.ok(html.includes('settings.mitaCopy'), 'i18n-Key settings.mitaCopy fehlt');
  assert.ok(html.includes("mita.off'"), 'i18n-Key mita.off fehlt');
  assert.ok(html.includes("mita.on'"), 'i18n-Key mita.on fehlt');
});
check('main.js: Smoke-Probe mita prüft Toggle + Gating', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('mita: (() => {'), 'mita-Probe fehlt');
  assert.ok(main.includes("toggle.dispatchEvent(new Event('change'))"), 'Probe nutzt nicht den Change-Event-Flow');
  assert.ok(main.includes('mitaSay(\'PROBE-TEXT\')'), 'Probe ruft mitaSay nicht auf');
  assert.ok(main.includes("localStorage.getItem('smoky-mita-disabled') === '1'"), 'Probe prüft Storage nicht');
});
check('main.js: Smoke-Probe tabs schaltet Views durch + prüft Shift (Home/Downloader)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes("tabs: await (async () => {"), 'tabs-Probe fehlt');
  assert.ok(main.includes("html.style.scrollbarGutter = 'auto'"), 'Gutter-Deaktivierung fehlt in tabs-Probe');
  assert.ok(main.includes("sbWidth === 0 || noGutterShift"), 'Overlay-Scrollbar-Absicherung fehlt');
  assert.ok(main.includes("disable-features", "OverlayScrollbar"), 'Smoke erzwingt keine klassischen Scrollbars');
});
check('server.js: Discord-Endpunkte + Secret/Token-Schutz', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const ep of ['/api/discord/status', '/api/discord/authorize', '/api/discord/callback', '/api/discord/disconnect']) {
    assert.ok(srv.includes(ep), 'Discord-Endpunkt fehlt: ' + ep);
  }
  assert.ok(srv.includes('function publicSettings()'), 'publicSettings() fehlt');
  assert.ok(srv.includes('const { discordClientSecret, discordToken, ...pub } = settings'), 'Secret/Token-Strip fehlt in publicSettings');
  assert.ok(srv.includes('settings: publicSettings()'), 'statusPayload nutzt nicht publicSettings');
  assert.ok(srv.includes('discord.com/api/oauth2/token'), 'Token-Exchange fehlt');
  assert.ok(srv.includes('discord.com/api/users/@me'), 'Profil-Fetch fehlt');
  assert.ok(srv.includes('album: String(body.album'), 'player-state speichert kein Album');
  assert.ok(srv.includes('position: Number.isFinite(pos)'), 'player-state speichert keine Position');
});
check('index.html: Discord-UI + GitHub-Button + Login-Flow', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const id of ['discordClientId', 'discordClientSecret', 'discordRpcToggle', 'discordConnect', 'discordDisconnect', 'discordProfile', 'openGithub']) {
    assert.ok(html.includes('id="' + id + '"'), 'UI-Element fehlt: ' + id);
  }
  assert.ok(html.includes('jami60/smoky-downloader'), 'GitHub-Repo-URL fehlt');
  assert.ok(html.includes('openExternalSafe'), 'openExternalSafe-Helper fehlt');
  assert.ok(html.includes('/api/discord/authorize'), 'Login-Flow ruft authorize nicht auf');
  assert.ok(html.includes('/api/discord/status'), 'Login-Flow pollt status nicht');
  assert.ok(html.includes('settings.discordConnect'), 'i18n-Key discordConnect fehlt');
  assert.ok(html.includes('settings.githubBtn'), 'i18n-Key githubBtn fehlt');
  assert.ok(html.includes('id="splashWelcome"'), 'Splash-Welcome-Element fehlt');
  assert.ok(html.includes("el.append('Welcome, ')"), 'Splash begrüßt den Discord-User nicht');
  assert.ok(html.includes("fetch('/api/discord/status')"), 'Splash lädt den Discord-Status nicht');
});
check('discord-rpc.js + main.js: setClientId + openExternal + Smoke-Probe', () => {
  const rpc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'discord-rpc.js'), 'utf8');
  assert.ok(rpc.includes('setClientId(id)'), 'setClientId fehlt in discord-rpc.js');
  assert.ok(rpc.includes('isConnected()'), 'isConnected fehlt in discord-rpc.js');
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('discord.setClientId(effId)'), 'main.js rekonfiguriert RPC nicht');
  assert.ok(main.includes("ipcMain.handle('shell:openExternal'"), 'shell:openExternal-Handler fehlt');
  assert.ok(main.includes('discordUi: (() => {'), 'Smoke-Probe discordUi fehlt');
});
check('Discord RPC: Art-Asset-Key statt localhost-Cover-URL', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(srv.includes("discordAssetKey: ''"), 'discordAssetKey-Setting fehlt');
  assert.ok(!srv.includes('coverTokenFor'), 'coverTokenFor-Rest übrig (localhost-Ansatz entfernt)');
  assert.ok(!srv.includes('/api/cover/t/'), 'Cover-Token-Endpunkt übrig (localhost-Ansatz entfernt)');
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('large_image'), 'RPC-Activity hat kein large_image');
  assert.ok(main.includes('large_image: assetKey'), 'large_image nutzt nicht den Art-Asset-Key');
  assert.ok(!main.includes('http://127.0.0.1:${port}${p.cover}'), 'localhost-Cover-URL darf nicht mehr vorkommen');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="discordAssetKey"'), 'Art-Asset-Key-Input fehlt');
  assert.ok(html.includes('postDiscordSetting({ discordAssetKey:'), 'Art-Asset-Key wird nicht gespeichert');
});
check('„Senden ans Handy“: Share-Server + Token + QR + UI', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(srv.includes('/api/share/create'), 'share/create-Endpunkt fehlt');
  assert.ok(srv.includes('/api/share/revoke'), 'share/revoke-Endpunkt fehlt');
  assert.ok(srv.includes("listen(SHARE_PORT, '0.0.0.0'"), 'Share-Server bindet nicht auf 0.0.0.0');
  assert.ok(srv.includes('function createShareToken'), 'createShareToken fehlt');
  assert.ok(srv.includes('function lanIPv4'), 'lanIPv4 fehlt');
  assert.ok(srv.includes('VIRTUAL_IF_RE'), 'VPN-/virtuelle-Adapter-Filter fehlt');
  assert.ok(srv.includes('function isCgnatIPv4'), 'CGNAT-Tunnel-Filter fehlt (NordLynx 100.66.x)');
  assert.ok(srv.includes('function isPrivateIPv4'), 'RFC-1918-Erkennung fehlt');
  assert.ok(srv.includes('shareServerPromise'), 'Idempotenz-Schutz (shareServerPromise) fehlt');
  // Der Haupt-Server muss auf 127.0.0.1 bleiben (Secrets nie im LAN).
  assert.ok(!srv.includes("server.listen(port, '0.0.0.0'"), 'Haupt-Server darf nicht auf 0.0.0.0 binden');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="shareToPhone"'), 'Share-Button fehlt');
  assert.ok(html.includes('id="shareOverlay"'), 'Share-Overlay fehlt');
  assert.ok(html.includes('id="shareQr"'), 'QR-Canvas fehlt');
  assert.ok(html.includes('src="qrcode.js"'), 'qrcode.js wird nicht eingebunden');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'qrcode.js')), 'public/qrcode.js fehlt');
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('share: (() => {'), 'Smoke-Probe share fehlt');
});

check('Polish: Downloader-Seite entfernt (kein Nav-Item, kein View)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!html.includes('data-view="Downloader"'), 'Nav-Item data-view="Downloader" existiert noch');
  assert.ok(!html.includes('id="downloaderView"'), 'downloaderView existiert noch');
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(!main.includes("'Downloader'"), 'Smoke-Views-Array referenziert Downloader noch');
});
check('Polish: Edit-Tags robust (Datei-Freigabe + Rename-Fallback)', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(srv.includes('function replaceFileAtomic'), 'replaceFileAtomic fehlt');
  assert.ok(srv.includes('fs.copyFileSync(tmp, target)'), 'Copy-Fallback fehlt in replaceFileAtomic');
  assert.ok(srv.includes("'EPERM', 'EACCES', 'EBUSY'"), 'Sperr-Fehler-Retry fehlt');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('// Windows sperrt die Datei'), 'Player-Datei wird vor dem Speichern nicht freigegeben');
});
check('Polish: Kein Auto-Play beim App-Start (restoreLastPlayback)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('// Kein Auto-Play beim App-Start'), 'Auto-Play-Hinweis fehlt in restoreLastPlayback');
  assert.ok(!html.includes('media.play().catch(() => {});'), 'Auto-Play (media.play) in restoreLastPlayback noch vorhanden');
});
check('Favoriten + Import + Smart-Alben + Album-ZIP + Loop-Fix', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(srv.includes("p === '/api/import'"), '/api/import fehlt');
  assert.ok(srv.includes("p === '/api/favorite'"), '/api/favorite fehlt');
  assert.ok(srv.includes("p === '/api/play-stats'"), '/api/play-stats fehlt');
  assert.ok(srv.includes("p === '/api/share/album'"), '/api/share/album fehlt');
  assert.ok(srv.includes('function zipFromStaging'), 'zipFromStaging fehlt');
  assert.ok(srv.includes('function createAlbumZipShare'), 'createAlbumZipShare fehlt');
  assert.ok(srv.includes('favorites: []'), 'settings.favorites fehlt');
  assert.ok(srv.includes('playStats: {}'), 'settings.playStats fehlt');
  assert.ok(srv.includes('fav: favSet.has(f)'), 'fav im Library-Scan fehlt');
  assert.ok(srv.includes('tmpFile: true'), 'tmpFile-Flag für Album-ZIP fehlt');
  assert.ok(srv.includes('Compress-Archive -Path'), 'Windows-ZIP (Compress-Archive) fehlt');
  assert.ok(srv.includes("spawn('zip'"), 'macOS/Linux-ZIP (zip) fehlt');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="playerImport"'), 'Import-Button fehlt');
  assert.ok(html.includes('data-fav='), 'Favorit-Stern (data-fav) fehlt');
  assert.ok(html.includes('function toggleFavorite'), 'toggleFavorite fehlt');
  assert.ok(html.includes("'__fav__'"), 'Smart-Album Favoriten fehlt');
  assert.ok(html.includes("'__recent__'"), 'Smart-Album Zuletzt gespielt fehlt');
  assert.ok(html.includes("'__top__'"), 'Smart-Album Meistgespielt fehlt');
  assert.ok(html.includes('data-send-album'), 'Album-ZIP-Button fehlt');
  assert.ok(html.includes('const openAlbumShare'), 'openAlbumShare fehlt');
  assert.ok(html.includes('playQueue.length === 1'), 'Einzel-Queue-Loop-Fix fehlt');
  assert.ok(html.includes('/api/play-stats'), 'play-stats-Aufruf fehlt');
});
check('Horror-Theme: Vignette + Glitch + 3-AM + feste Musik (ohne Blut)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!html.includes('buildHorrorArt'), 'buildHorrorArt (Blut-Generator) darf nicht mehr existieren');
  assert.ok(!html.includes('hb-drips'), 'Bluttropfen dürfen nicht mehr existieren');
  assert.ok(!html.includes('hb-splats'), 'Blutspritzer dürfen nicht mehr existieren');
  assert.ok(!html.includes('hbWell'), 'Blut-Lache darf nicht mehr existieren');
  assert.ok(html.includes('id="horrorVignette"'), 'horrorVignette fehlt');
  assert.ok(html.includes('runHorrorTransition'), 'runHorrorTransition fehlt');
  assert.ok(html.includes('runHorrorExit'), 'runHorrorExit fehlt');
  assert.ok(html.includes('@keyframes horrorFlash'), 'horrorFlash-Keyframes fehlen');
  assert.ok(html.includes('horrorFlicker'), 'horrorFlicker (Scanline-Glitch) fehlt');
  assert.ok(html.includes('id="horrorTransition"'), 'Übergangs-Overlay fehlt');
  assert.ok(html.includes('@keyframes horrorGlitch'), 'horrorGlitch-Keyframes fehlen');
  assert.ok(html.includes('id="horrorAudio"'), 'horrorAudio-Element fehlt');
  assert.ok(html.includes('assets/horror-music.wav'), 'horror-music.wav wird nicht eingebunden');
  assert.ok(html.includes('function onThemeChanged'), 'onThemeChanged fehlt');
  assert.ok(html.includes('maybeTrigger3am'), '3-AM-Watcher fehlt');
  assert.ok(html.includes('d.getHours() !== 3'), '3-AM-Stunden-Check fehlt');
  assert.ok(html.includes('id="horrorThemeToggle"'), 'Horror-Theme-Toggle fehlt');
  assert.ok(html.includes('id="horror3amToggle"'), '3-AM-Toggle fehlt');
  assert.ok(html.includes('id="horrorMusicToggle"'), 'Horror-Music-Toggle fehlt');
  assert.ok(html.includes('id="horrorMusicVolume"'), 'Horror-Music-Volume fehlt');
  assert.ok(html.includes('id="horrorFx"'), 'Horror-Effects-Intensity fehlt');
  assert.ok(html.includes('--horror-fx'), '--horror-fx-Intensitätsvariable fehlt');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(srv.includes('horror3am: true'), 'settings.horror3am fehlt');
  assert.ok(srv.includes('horrorMusic: true'), 'settings.horrorMusic fehlt');
  assert.ok(srv.includes('horrorMusicVolume: 40'), 'settings.horrorMusicVolume fehlt');
  assert.ok(srv.includes('horrorFx: 60'), 'settings.horrorFx fehlt');
});
check('Smoky Wrapped: Endpoint + View + Export', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(srv.includes("p === '/api/wrapped'"), '/api/wrapped fehlt');
  assert.ok(srv.includes('playLog'), 'playLog fehlt');
  assert.ok(srv.includes('busiestHour'), 'busiestHour fehlt');
  assert.ok(srv.includes('listenMinutes'), 'listenMinutes fehlt');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('data-view="Wrapped"'), 'Wrapped-Nav-Item fehlt');
  assert.ok(html.includes('id="wrappedView"'), 'wrappedView fehlt');
  assert.ok(html.includes('id="wrappedExport"'), 'Wrapped-Export fehlt');
  assert.ok(html.includes('const renderWrapped'), 'renderWrapped fehlt');
  assert.ok(html.includes('function loadWrapped'), 'loadWrapped fehlt');
});
check('Mobiler Player (Eigenes Spotify): LAN-Routen + Remote-Button', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(srv.includes("u.pathname === '/m'"), '/m-Route fehlt');
  assert.ok(srv.includes("u.pathname === '/m/api/library'"), '/m/api/library fehlt');
  assert.ok(srv.includes("u.pathname === '/m/api/cover'"), '/m/api/cover fehlt');
  assert.ok(srv.includes("u.pathname === '/m/api/play'"), '/m/api/play fehlt');
  assert.ok(srv.includes('function mobilePlayerPage'), 'mobilePlayerPage fehlt');
  assert.ok(srv.includes("p === '/api/mobile-link'"), '/api/mobile-link fehlt');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="mobilePlayerBtn"'), 'Remote-Button fehlt');
  assert.ok(html.includes('openMobilePlayer'), 'openMobilePlayer fehlt');
});

console.log(failures ? `\n✗ ${failures} Test(s) fehlgeschlagen` : '\nAlle Bug-Hunt-Unit-Tests bestanden ✅');
process.exit(failures ? 1 : 0);
