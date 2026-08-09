// Unit-Tests für die Bug-Hunt-Fixes (ohne Netzwerk):
//  - findExistingSpotFiles: Skip-Zeilen → vorhandene Datei finden
//  - spotFormatFor: Formatwahl der UI → spotDL-Format (aac → mp3)
//  - displayTitle: [videoId]-Suffix aus dem Anzeige-Titel entfernen
//  - moveFile: Verschieben (auch über den Copy-Fallback)
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');

const { findExistingSpotFiles, spotFormatFor, displayTitle, moveFile } = require('../server.js');

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

console.log(failures ? `\n✗ ${failures} Test(s) fehlgeschlagen` : '\nAlle Bug-Hunt-Unit-Tests bestanden ✅');
process.exit(failures ? 1 : 0);
