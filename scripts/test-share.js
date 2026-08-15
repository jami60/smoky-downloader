// Smoky — „Senden ans Handy“-Tests:
//  - public/qrcode.js: Reed-Solomon-Referenz, RS-Invarianz, Round-Trip-
//    Dekodierung (unabhängiger Dekoder), Struktur- und Format-Info-Checks.
//  - server.js: Token-Erzeugung/-Widerruf/-Ablauf, Pfad-Validierung und der
//    LAN-Server (Landing-Page + Datei-Stream).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.SMOKY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-share-data-'));
const qr = require('../public/qrcode.js');
const { startServer, settings, server, shareServer: _shareServerRef, shareTokens, createShareToken, revokeShareToken, createAlbumZipShare, zipFromStaging, lanIPv4, SHARE_TTL_MS } = require('../server.js');

let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : '')); if (!ok) failed += 1; };

// ------------------------------------------------------------ QR: GF/RS ----
const gen7 = qr.rsGeneratorPoly(7);
check('RS-Generatorpolynom (7 EC) entspricht Referenz', JSON.stringify(gen7) === JSON.stringify([1, 127, 122, 154, 164, 11, 68, 117]), JSON.stringify(gen7));

// Invarianz: (Daten + EC) muss durch das Generatorpolynom teilbar sein.
function rsInvariant(data, ecCount) {
  const gen = qr.rsGeneratorPoly(ecCount);
  const ec = qr.rsEncode(data, ecCount);
  const full = data.concat(ec);
  const msg = full.slice();
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) for (let j = 0; j < gen.length; j++) msg[i + j] ^= qr.gfMul(gen[j], coef);
  }
  return msg.slice(data.length).every((x) => x === 0);
}
check('RS-Invarianz (7 EC): Rest == 0', rsInvariant([16, 32, 12, 86, 97, 128, 236, 17], 7));
check('RS-Invarianz (16 EC): Rest == 0', rsInvariant([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 16));
check('RS-Invarianz (26 EC): Rest == 0', rsInvariant([255, 0, 128, 64, 32, 16, 8, 4, 2, 1, 99, 100], 26));

// ------------------------------------------------- QR: unabhängiger Dekoder -
// Liest die Format-Info (beide Kopien), validiert BCH, entmaskiert, liest die
// Zickzack-Daten, de-interleaved und dekodiert den Byte-Modus.
const MTABLE = {
  1: { total: 26, data: 16, ec: 10, blocks: 1 },
  2: { total: 44, data: 28, ec: 16, blocks: 1 },
  3: { total: 70, data: 44, ec: 26, blocks: 1 },
  4: { total: 100, data: 64, ec: 18, blocks: 2 },
  5: { total: 134, data: 86, ec: 24, blocks: 2 },
  6: { total: 172, data: 108, ec: 16, blocks: 4 },
};

function readFmt1(m, size) {
  const coords = [];
  for (let i = 0; i <= 5; i++) coords.push([8, i]);
  coords.push([8, 7]); coords.push([8, 8]); coords.push([7, 8]);
  for (let i = 5; i >= 0; i--) coords.push([i, 8]);
  let v = 0; for (const [r, c] of coords) v = (v << 1) | m[r][c];
  return v;
}
function readFmt2(m, size) {
  const coords = [];
  for (let i = size - 1; i >= size - 7; i--) coords.push([i, 8]);
  for (let i = size - 8; i <= size - 1; i++) coords.push([8, i]);
  let v = 0; for (const [r, c] of coords) v = (v << 1) | m[r][c];
  return v;
}
function bchCodeword(d) {
  let rem = d;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return (d << 10) | rem;
}

function buildReserved(size, version) {
  const res = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { res[r][c] = true; };
  // Finder 7x7
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) mark(fr + r, fc + c);
  }
  // Separatoren (explizit, identisch zum Encoder)
  for (let i = 0; i < 8; i++) {
    mark(7, i); mark(i, 7);                       // oben links
    mark(7, size - 8 + i); mark(i, size - 8);     // oben rechts
    mark(size - 8, i); mark(size - 8 + i, 7);     // unten links
  }
  // Timing
  for (let i = 8; i < size - 8; i++) { mark(6, i); mark(i, 6); }
  // Alignment (v2–6, unten rechts)
  if (version >= 2) for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(size - 7 + dr, size - 7 + dc);
  // Dark module + Format-Info-Flächen
  mark(size - 8, 8);
  const fmtCoords = [];
  for (let i = 0; i <= 5; i++) fmtCoords.push([8, i]);
  fmtCoords.push([8, 7], [8, 8], [7, 8]);
  for (let i = 5; i >= 0; i--) fmtCoords.push([i, 8]);
  for (let i = size - 1; i >= size - 7; i--) fmtCoords.push([i, 8]);
  for (let i = size - 8; i <= size - 1; i++) fmtCoords.push([8, i]);
  for (const [r, c] of fmtCoords) mark(r, c);
  return res;
}

const MASKS = [
  (r, c) => ((r + c) % 2) === 0,
  (r, c) => (r % 2) === 0,
  (r, c) => (c % 3) === 0,
  (r, c) => ((r + c) % 3) === 0,
  (r, c) => ((Math.floor(r / 2) + Math.floor(c / 3)) % 2) === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function decodeMatrix(m) {
  const size = m.length;
  const version = (size - 17) / 4;
  const f1 = readFmt1(m, size);
  const f2 = readFmt2(m, size);
  if (f1 !== f2) throw new Error('Format-Kopien verschieden');
  const raw = f1 ^ 0x5412;
  let dataBits = -1;
  for (let d = 0; d < 32; d++) if (bchCodeword(d) === raw) { dataBits = d; break; }
  if (dataBits < 0) throw new Error('Format-Info ungültig');
  const mask = dataBits & 7;
  const level = (dataBits >> 3) & 3;
  if (level !== 0) throw new Error('EC-Level != M');
  const res = buildReserved(size, version);
  // Zickzack lesen (entmaskiert)
  const bits = [];
  let dir = -1, row = size - 1, col = size - 1;
  while (col > 0) {
    if (col === 6) col -= 1;
    while (row >= 0 && row < size) {
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (!res[row][c]) bits.push(m[row][c] ^ (MASKS[mask](row, c) ? 1 : 0));
      }
      row += dir;
    }
    dir = -dir; row += dir; col -= 2;
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    bytes.push(v);
  }
  const t = MTABLE[version];
  const full = bytes.slice(0, t.total);
  const perBlock = t.data / t.blocks;
  const dataBlocks = Array.from({ length: t.blocks }, () => []);
  let idx = 0;
  for (let i = 0; i < perBlock; i++) for (let b = 0; b < t.blocks; b++) dataBlocks[b].push(full[idx++]);
  const dataCodewords = dataBlocks.flat();
  const dbits = [];
  for (const cw of dataCodewords) for (let b = 7; b >= 0; b--) dbits.push((cw >> b) & 1);
  let p = 0;
  const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dbits[p++]; return v; };
  const mode = rd(4);
  if (mode !== 4) throw new Error('Modus != Byte (=' + mode + ')');
  const count = rd(8);
  const out = [];
  for (let i = 0; i < count; i++) out.push(rd(8));
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(new Uint8Array(out));
  return out.map((b) => String.fromCharCode(b)).join('');
}

function structuralOk(m) {
  const size = m.length;
  let ok = m[0][0] === 1 && m[0][6] === 1 && m[6][0] === 1 && m[6][6] === 1 && m[3][3] === 1 && m[1][1] === 0;
  ok = ok && m[0][size - 1] === 1 && m[0][size - 7] === 1 && m[6][size - 7] === 1 && m[3][size - 4] === 1;
  ok = ok && m[size - 1][0] === 1 && m[size - 7][0] === 1 && m[size - 7][6] === 1 && m[size - 4][3] === 1;
  ok = ok && m[size - 8][8] === 1;
  for (let c = 8; c < size - 8; c++) if (m[6][c] !== (c % 2 === 0 ? 1 : 0)) ok = false;
  return ok;
}

const roundTrips = [
  'http://192.168.1.23:4174/share/abc123def456',
  'Smoky Test',
  'https://example.com/path?q=äöü',
  '🎵 Smoky 🔥 (töne & Zeichen)',
  'x'.repeat(40),
];
for (const txt of roundTrips) {
  const r = qr.encode(txt);
  const okEnc = !!r;
  let decoded = null, decErr = null;
  try { decoded = decodeMatrix(r.matrix); } catch (e) { decErr = String(e.message || e); }
  check(`Round-Trip: ${txt.slice(0, 24)}${txt.length > 24 ? '…' : ''}`, okEnc && decoded === txt && structuralOk(r.matrix), okEnc ? (decErr || 'decoded=' + JSON.stringify(decoded)) : 'encode=null');
}

const tooLong = qr.encode('y'.repeat(200));
check('Zu langer Text → null', tooLong === null);

// Referenz-Vektor von Nayukis qrcodegen (Version 3, EC-Level M, Maske 2) —
// stellt sicher, dass der Encoder byte-genau dem Standard entspricht.
const NAYUKI_URL = 'http://192.168.1.23:4174/share/abc123';
const NAYUKI_MATRIX = '1111111001010010000100111111110000010011101010100101000001101110101011101000000010111011011101010110001111010101110110111010101001000001001011101100000101100011110000010000011111111010101010101010111111100000000110011010010100000000101111100110001111101011111001101110111010000011100101000101100010110010011100000110000111000011100101000010110100101100111010000001010111010110010001101111101101001001010101010111101011111101101110001001110110011001100000101010001011100010100110110100110000100111110000101100011110110111011010001110000001101000100110010010101000010110011011010010101010111110100101001111101110000000010000110101110001111111111110010001111011101011100100000101011010010001000100001011101011000010010011111110010111010101011000000110100011101110101101110111111010110101000001000110011101011011001011111110111010010100000001100';
(() => {
  const r = qr.encode(NAYUKI_URL);
  let flat = '';
  for (let i = 0; i < r.size; i++) for (let j = 0; j < r.size; j++) flat += r.matrix[i][j] ? '1' : '0';
  check('Byte-genau identisch zu Nayuki-qrcodegen (v3, M, Maske 2)', flat === NAYUKI_MATRIX && r.mask === 2, 'mask=' + r.mask);
})();

// ---------------------------------------------------------- Share-Token ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoky-share-files-'));
const fileA = path.join(tmpDir, 'song.mp3');
fs.writeFileSync(fileA, Buffer.from('süße-beats'));
settings.folder = tmpDir;

const bad1 = createShareToken(path.join(os.tmpdir(), 'outside.mp3'));
check('createShareToken: Pfad außerhalb → error', !!bad1.error, JSON.stringify(bad1));
const missing = createShareToken(path.join(tmpDir, 'nope.mp3'));
check('createShareToken: fehlende Datei → error', !!missing.error, JSON.stringify(missing));

// LAN-IP-Erkennung darf nicht crashen und (im WLAN) eine IPv4 liefern oder null sein.
check('lanIPv4: Funktion liefert String/null', lanIPv4() === null || /^\d+\.\d+\.\d+\.\d+$/.test(lanIPv4()), String(lanIPv4()));

// Regression: VPN-/virtuelle Adapter dürfen NICHT als LAN-IP gewählt werden —
// sonst zeigt der QR-Code auf die NordLynx-Tunnel-IP (100.66.x) und das Handy
// lädt die Seite nie („Seite lädt nicht“).
const vpnIfs = {
  'NordLynx': [{ address: '100.66.6.169', family: 'IPv4', internal: false }],
  'WLAN': [{ address: '192.168.178.79', family: 'IPv4', internal: false }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
};
check('lanIPv4: überspringt VPN-Adresse (NordLynx 100.66.x)', lanIPv4(vpnIfs) === '192.168.178.79', String(lanIPv4(vpnIfs)));

const vpnOnly = { 'NordLynx': [{ address: '100.66.6.169', family: 'IPv4', internal: false }] };
check('lanIPv4: nur VPN vorhanden → Fallback auf VPN-IP statt null', lanIPv4(vpnOnly) === '100.66.6.169', String(lanIPv4(vpnOnly)));

const prio = {
  'Ethernet': [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
  'WLAN': [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
};
check('lanIPv4: bevorzugt 192.168.x vor 10.x', lanIPv4(prio) === '192.168.1.20', String(lanIPv4(prio)));

check('lanIPv4: keine Interfaces → null', lanIPv4({}) === null, String(lanIPv4({})));

(async () => {
  const port = await startServer(0, true);
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  const cr = await (await post('/api/share/create', { path: fileA })).json();
  const tokenOk = cr.token && /^[0-9a-f]{16}$/.test(cr.token) && cr.filename === 'song.mp3' && /^http:\/\//.test(cr.url) && cr.url.endsWith('/share/' + cr.token);
  check('/api/share/create: Token + URL + Dateiname', tokenOk, JSON.stringify(cr));

  // Revoke
  const rv = await (await post('/api/share/revoke', { token: cr.token })).json();
  check('/api/share/revoke: entfernt bestehenden Token', rv.ok === true && rv.removed === true, JSON.stringify(rv));
  const rv2 = await (await post('/api/share/revoke', { token: cr.token })).json();
  check('/api/share/revoke: zweiter Aufruf → removed=false', rv2.ok === true && rv2.removed === false, JSON.stringify(rv2));

  // HTTP-Auslieferung über den LAN-Server
  const cr2 = await (await post('/api/share/create', { path: fileA })).json();
  const { startShareServer } = require('../server.js');
  const sp = await startShareServer();
  check('Share-Server gestartet (0.0.0.0)', typeof sp === 'number' && sp > 0, String(sp));
  const shareBase = `http://127.0.0.1:${sp}`;

  const landing = await fetch(`${shareBase}/share/${cr2.token}`);
  const landingText = await landing.text();
  check('Share-Landing-Page: 200 + Download-Link + Dateiname', landing.status === 200 && landingText.includes(`/share/${cr2.token}/dl`) && landingText.includes('song.mp3'), 'status=' + landing.status);

  const dl = await fetch(`${shareBase}/share/${cr2.token}/dl`);
  const dlBuf = await dl.arrayBuffer();
  check('Share-/dl: 200 + exakte Bytes', dl.status === 200 && Buffer.from(dlBuf).toString('utf8') === 'süße-beats', 'status=' + dl.status + ',len=' + dlBuf.byteLength);
  check('Share-/dl: Content-Disposition attachment', /attachment/.test(dl.headers.get('content-disposition') || ''), dl.headers.get('content-disposition'));

  const invalid = await fetch(`${shareBase}/share/deadbeefdeadbeef`);
  check('Unbekannter Token → 404', invalid.status === 404, 'status=' + invalid.status);

  // ---------------------------------------------------- Album-ZIP-Send ----
  const albumA = path.join(tmpDir, 'album-a.mp3');
  const albumB = path.join(tmpDir, 'album-b.flac');
  fs.writeFileSync(albumA, Buffer.from('track-one'));
  fs.writeFileSync(albumB, Buffer.from('track-two'));

  // ZIP-Erstellung plattformunabhängig (Windows Compress-Archive, sonst zip).
  const stageDir = path.join(os.tmpdir(), 'smoky-zip-stage-' + Date.now());
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, '01 first.mp3'), 'aa');
  fs.writeFileSync(path.join(stageDir, '02 second.mp3'), 'bb');
  const zipOut = path.join(os.tmpdir(), 'smoky-zip-' + Date.now() + '.zip');
  const zipped = await zipFromStaging(stageDir, zipOut);
  const zipMagic = zipped ? fs.readFileSync(zipOut).subarray(0, 4).toString('latin1') : '';
  check('zipFromStaging: erzeugt gültiges ZIP (PK-Magic)', zipped === true && zipMagic === 'PK\u0003\u0004', JSON.stringify(zipMagic));
  try { fs.rmSync(stageDir, { recursive: true, force: true }); fs.rmSync(zipOut, { force: true }); } catch {}

  // Validierung: leere/ungültige Pfade → klarer Fehler.
  const emptyZip = await createAlbumZipShare([], 'Leer');
  check('createAlbumZipShare: leere Liste → error', !!emptyZip.error, JSON.stringify(emptyZip));

  // Gültige Tracks → Token + ZIP-Dateiname (oder klare LAN-Fehlermeldung).
  const albRes = await createAlbumZipShare([albumA, albumB], 'Test Album');
  if (albRes.error) {
    check('createAlbumZipShare: gültige Tracks (ohne LAN → klare Meldung)', /LAN-IP/i.test(albRes.error), JSON.stringify(albRes));
  } else {
    const albOk = !!albRes.token && /^[0-9a-f]{16}$/.test(albRes.token) && albRes.filename === 'Test Album.zip' && /^http:\/\//.test(albRes.url) && albRes.url.endsWith('/share/' + albRes.token);
    check('createAlbumZipShare: Token + Dateiname + URL', albOk, JSON.stringify(albRes));
    const shareEntry = shareTokens.get(albRes.token);
    const tmpOk = !!shareEntry && shareEntry.tmpFile === true && fs.existsSync(shareEntry.path);
    check('createAlbumZipShare: tmp-ZIP auf Platte + tmpFile-Flag', tmpOk, shareEntry ? shareEntry.path : 'no entry');
    const zipPathToCheck = shareEntry && shareEntry.path;
    const removed = revokeShareToken(albRes.token);
    check('createAlbumZipShare: Widerruf löscht tmp-ZIP', removed === true && !fs.existsSync(zipPathToCheck), zipPathToCheck);
  }

  // Ablauf: Token-Expiry künstlich in die Vergangenheit setzen
  const t = shareTokens.get(cr2.token);
  if (t) { t.expiresAt = Date.now() - 1; }
  const expired = await fetch(`${shareBase}/share/${cr2.token}`);
  check('Abgelaufener Token → 404', expired.status === 404, 'status=' + expired.status);

  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Share-Tests bestanden ✅');
  try { server.closeAllConnections(); } catch {}
  try { if (server.listening) await new Promise((r) => server.close(r)); } catch {}
  const shareSrv = require('../server.js').shareServer;
  try { if (shareSrv) { shareSrv.closeAllConnections(); if (shareSrv.listening) await new Promise((r) => shareSrv.close(r)); } } catch {}
  // Keep-Alive-Sockets können das Event-Loop-Ende verzögern — kurz flushen
  // und dann hart beenden.
  await new Promise((r) => setTimeout(r, 50));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Share-Test abgestürzt:', e); process.exitCode = 1; });
