// Smoky — Unit-Test für die Ordner-Struktur (organizeIntoFolders-Entscheidung).
// Regression: Album-Tag == Songtitel (YouTube ohne echtes Album) durfte KEINEN
// Ordner pro Song erzeugen — Song liegt flach im Künstler-Ordner.
const path = require('node:path');
const { resolveOrganizePath } = require('../server.js');

let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : '')); if (!ok) failed += 1; };
const base = 'C:/Musik';
const norm = (p) => path.normalize(p).replace(/\\+$/, '');

// 1) Der gemeldete Fall: album == title → nur Künstler-Ordner, kein Album-Ordner
let p = resolveOrganizePath(base, { title: 'xaviersobased - linda', artist: 'setfrvr', album: 'xaviersobased - linda' });
check('album == title → flach im Künstler-Ordner', norm(p) === norm(base + '/setfrvr'), String(p));

// 2) album mit Titel-Präfix (z. B. "linda [id]") → auch nur Künstler
p = resolveOrganizePath(base, { title: 'linda', artist: 'setfrvr', album: 'linda [Q4-qgVWti-o]' });
check('album mit Titel-Präfix → nur Künstler', norm(p) === norm(base + '/setfrvr'), String(p));

// 3) Kein Album → Künstler-Ordner
p = resolveOrganizePath(base, { title: 'linda', artist: 'setfrvr', album: '' });
check('kein Album → Künstler-Ordner', norm(p) === norm(base + '/setfrvr'), String(p));

// 4) Echtes Album → Künstler/Album
p = resolveOrganizePath(base, { title: 'Everyday', artist: 'Gucci Mane, Trouble', album: 'East Side Piru' });
check('echtes Album → Künstler/Album', norm(p) === norm(base + '/Gucci Mane, Trouble/East Side Piru'), String(p));

// 5) Kein Künstler, aber Album → Album-Ordner
p = resolveOrganizePath(base, { title: 'X', artist: '', album: 'Instrumental' });
check('kein Künstler, Album da → Album-Ordner', norm(p) === norm(base + '/Instrumental'), String(p));

// 6) Weder Künstler noch Album → null (Datei bleibt liegen)
p = resolveOrganizePath(base, { title: 'X', artist: '', album: '' });
check('weder Künstler noch Album → null', p === null, String(p));

// 7) Ungültige Zeichen werden bereinigt (safeName), Umlaute bleiben
p = resolveOrganizePath(base, { title: 'a/b:c', artist: 'Künstler*?', album: '' });
check('safeName bereinigt ungültige Zeichen, Umlaute bleiben', norm(p) === norm(base + '/Künstler__'), String(p));

console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Ordner-Tests bestanden ✅');
process.exitCode = failed ? 1 : 0;
