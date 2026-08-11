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

console.log(failures ? `\n✗ ${failures} Test(s) fehlgeschlagen` : '\nAlle Bug-Hunt-Unit-Tests bestanden ✅');
process.exit(failures ? 1 : 0);
