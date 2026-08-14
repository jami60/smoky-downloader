// Smoky — zero-dependency QR-Code-Encoder (Byte-Modus, EC-Level M, Versionen 1–6).
// Bewusst ohne externe Bibliothek: erzeugt aus einem Text-String eine
// boolesche Modul-Matrix (1 = dunkel), die der Renderer auf ein <canvas>
// zeichnen kann. Der Test (scripts/test-share.js) verifiziert den Encoder
// gegen bekannte Reed-Solomon-Referenzen und per Round-Trip-Dekodierung.
(function (global) {
  'use strict';

  // -------------------------------------------------------- GF(256) --------
  // Primitives Polynom 0x11D (x^8 + x^4 + x^3 + x^2 + 1), alpha = 0x02.
  const EXP = new Array(512);
  const LOG = new Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // Polynom-Multiplikation in absteigender Koeffizienten-Reihenfolge
  // (Index 0 = höchster Grad).
  function gfPolyMulDesc(a, b) {
    const out = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        out[i + j] ^= gfMul(a[i], b[j]);
      }
    }
    return out;
  }

  // Generator-Polynom g(x) = ∏_{i=0..degree-1} (x + α^i), absteigend (monisch).
  function rsGeneratorPoly(degree) {
    let g = [1];
    for (let i = 0; i < degree; i++) g = gfPolyMulDesc(g, [1, EXP[i]]);
    return g;
  }

  // Reed-Solomon-EC-Codewörter: Rest von (data · x^ecCount) mod g(x).
  function rsEncode(data, ecCount) {
    const gen = rsGeneratorPoly(ecCount);
    const msg = new Array(data.length + ecCount).fill(0);
    for (let i = 0; i < data.length; i++) msg[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
    return msg.slice(data.length);
  }

  // --------------------------------------------------- Block-Tabelle -------
  // Nur EC-Level M, Versionen 1–6 (einheitliche Blockgrößen, deckt eine
  // Share-URL mit bis zu ~106 Bytes Nutzlast ab).
  const M_TABLE = {
    1: { total: 26, data: 16, ec: 10, blocks: 1, rem: 0 },
    2: { total: 44, data: 28, ec: 16, blocks: 1, rem: 7 },
    3: { total: 70, data: 44, ec: 26, blocks: 1, rem: 7 },
    4: { total: 100, data: 64, ec: 18, blocks: 2, rem: 7 },
    5: { total: 134, data: 86, ec: 24, blocks: 2, rem: 7 },
    6: { total: 172, data: 108, ec: 16, blocks: 4, rem: 7 },
  };

  // EC-Level → 2-Bit-Wert für die Format-Information.
  const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function textToBytes(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    // Fallback (alte Engines): UTF-8 manuell.
    const out = [];
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
      else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
    return out;
  }

  function chooseVersion(byteLen) {
    for (let v = 1; v <= 6; v++) {
      const t = M_TABLE[v];
      const needBits = 4 + 8 + byteLen * 8; // Modus + Zähler (v1–9: 8 Bit) + Daten
      if (needBits <= t.data * 8) return v;
    }
    return null;
  }

  function pushBits(bits, value, count) {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  }

  function buildDataCodewords(bytes, version, t) {
    const bits = [];
    pushBits(bits, 4, 4);              // Modus 0100 (Byte)
    pushBits(bits, bytes.length, 8);   // Zeichenanzahl (v1–9)
    for (const b of bytes) pushBits(bits, b, 8);
    const capacity = t.data * 8;
    // Terminator (max. 4 Null-Bits)
    const term = Math.min(4, capacity - bits.length);
    for (let i = 0; i < term; i++) bits.push(0);
    // Byte-Grenze auffüllen
    while (bits.length % 8 !== 0) bits.push(0);
    // Pad-Bytes 0xEC / 0x11 abwechselnd
    const pads = [0xEC, 0x11];
    let p = 0;
    while (bits.length < capacity) {
      pushBits(bits, pads[p % 2], 8);
      p++;
    }
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      codewords.push(v);
    }
    return codewords;
  }

  function interleave(dataCodewords, t) {
    const perBlock = t.data / t.blocks;
    const blocks = [];
    for (let b = 0; b < t.blocks; b++) {
      const data = dataCodewords.slice(b * perBlock, (b + 1) * perBlock);
      blocks.push({ data, ec: rsEncode(data, t.ec) });
    }
    const out = [];
    for (let i = 0; i < perBlock; i++) for (let b = 0; b < t.blocks; b++) out.push(blocks[b].data[i]);
    for (let i = 0; i < t.ec; i++) for (let b = 0; b < t.blocks; b++) out.push(blocks[b].ec[i]);
    return out;
  }

  // ----------------------------------------------------- Funktionsmuster ---
  function drawFinder7(m, res, fr, fc) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        res[fr + r][fc + c] = true;
        const dark = (r === 0 || r === 6 || c === 0 || c === 6) || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[fr + r][fc + c] = dark ? 1 : 0;
      }
    }
  }

  function reserveLight(m, res, cells) {
    for (const [r, c] of cells) { res[r][c] = true; m[r][c] = 0; }
  }

  // Finder + Separator (heller 1-Modul-Rand zur Symbolmitte hin).
  function drawFinders(m, res) {
    const size = m.length;
    drawFinder7(m, res, 0, 0);
    drawFinder7(m, res, 0, size - 7);
    drawFinder7(m, res, size - 7, 0);
    for (let i = 0; i < 8; i++) {
      // oben links: Zeile 7 + Spalte 7
      reserveLight(m, res, [[7, i], [i, 7]]);
      // oben rechts: Zeile 7 + Spalte size-8
      reserveLight(m, res, [[7, size - 8 + i], [i, size - 8]]);
      // unten links: Zeile size-8 + Spalte 7
      reserveLight(m, res, [[size - 8, i], [size - 8 + i, 7]]);
    }
  }

  function drawTiming(m, res) {
    const size = m.length;
    for (let i = 8; i < size - 8; i++) {
      res[6][i] = true;
      res[i][6] = true;
      m[6][i] = (i % 2 === 0) ? 1 : 0;
      m[i][6] = (i % 2 === 0) ? 1 : 0;
    }
  }

  function drawAlignment(m, res, r, c) {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr, cc = c + dc;
        res[rr][cc] = true;
        const d = Math.max(Math.abs(dr), Math.abs(dc));
        m[rr][cc] = (d !== 1) ? 1 : 0;
      }
    }
  }

  // Positionen der Format-Info (2 Kopien). Rückgabe: 30 [row, col]-Paare —
  // Index 0..14 = Kopie 1 (Bit 0..14), Index 15..29 = Kopie 2 (Bit 0..14).
  function formatInfoPositions(size) {
    const pos = [];
    for (let i = 0; i <= 5; i++) pos.push([8, i]);        // Kopie 1, Bit 0–5
    pos.push([8, 7]);                                     // Bit 6
    pos.push([8, 8]);                                     // Bit 7
    pos.push([7, 8]);                                     // Bit 8
    for (let i = 5; i >= 0; i--) pos.push([i, 8]);        // Bit 9–14
    for (let i = size - 1; i >= size - 7; i--) pos.push([i, 8]); // Kopie 2, Bit 0–6
    for (let i = size - 8; i <= size - 1; i++) pos.push([8, i]); // Bit 7–14
    return pos;
  }

  // BCH(15,5): 5 Daten-Bits → 10 Rest-Bits, Generator 0x537.
  function formatBits(level, mask) {
    const data = (EC_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function writeFormatInfo(m, positions, bits) {
    for (let i = 0; i < 15; i++) {
      const bit = (bits >> (14 - i)) & 1;
      const a = positions[i];
      const b = positions[i + 15];
      m[a[0]][a[1]] = bit;
      m[b[0]][b[1]] = bit;
    }
  }

  // Zickzack-Datenplatzierung (Standard), überspringt reservierte Module.
  function placeData(m, res, bits) {
    const size = m.length;
    let i = 0;
    let dir = -1; // -1 hoch, +1 runter
    let row = size - 1;
    let col = size - 1;
    while (col > 0) {
      if (col === 6) col -= 1;
      while (row >= 0 && row < size) {
        for (let k = 0; k < 2; k++) {
          const c = col - k;
          if (!res[row][c]) {
            m[row][c] = i < bits.length ? bits[i] : 0;
            i++;
          }
        }
        row += dir;
      }
      dir = -dir;
      row += dir;
      col -= 2;
    }
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

  function applyMask(m, res, maskId) {
    const size = m.length;
    const mm = m.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!res[r][c] && MASKS[maskId](r, c)) mm[r][c] ^= 1;
      }
    }
    return mm;
  }

  // Standard-Penalty (4 Regeln) für die Maskenauswahl.
  function penalty(m) {
    const size = m.length;
    let score = 0;
    // Regel 1: Läufe gleicher Farbe
    for (let r = 0; r < size; r++) {
      let run = 1, prev = m[r][0];
      for (let c = 1; c < size; c++) {
        if (m[r][c] === prev) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; prev = m[r][c]; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let c = 0; c < size; c++) {
      let run = 1, prev = m[0][c];
      for (let r = 1; r < size; r++) {
        if (m[r][c] === prev) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; prev = m[r][c]; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    // Regel 2: 2×2-Blöcke
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
      }
    }
    // Regel 3: Finder-ähnliches Muster 1:1:3:1:1 mit 4 hellen Modulen davor/danach
    const patA = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const patB = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size - 10; c++) {
        let okA = true, okB = true;
        for (let i = 0; i < 11; i++) {
          if (m[r][c + i] !== patA[i]) okA = false;
          if (m[r][c + i] !== patB[i]) okB = false;
        }
        if (okA || okB) score += 40;
      }
    }
    for (let c = 0; c < size; c++) {
      for (let r = 0; r < size - 10; r++) {
        let okA = true, okB = true;
        for (let i = 0; i < 11; i++) {
          if (m[r + i][c] !== patA[i]) okA = false;
          if (m[r + i][c] !== patB[i]) okB = false;
        }
        if (okA || okB) score += 40;
      }
    }
    // Regel 4: Dunkel-Anteil
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
    const pct = Math.floor((dark * 100) / (size * size));
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  // ---------------------------------------------------------- Encode ------
  // Gibt { size, version, level, mask, matrix } zurück oder null (Text zu lang).
  // forceMask (0–7) überspringt die Penalty-Auswahl — nützlich für Tests.
  function encode(text, level = 'M', forceMask = null) {
    const bytes = textToBytes(text);
    const version = chooseVersion(bytes.length);
    if (version === null) return null;
    const t = M_TABLE[version];
    const dataCodewords = buildDataCodewords(bytes, version, t);
    const full = interleave(dataCodewords, t);

    const size = 17 + 4 * version;
    const m = Array.from({ length: size }, () => new Array(size).fill(0));
    const res = Array.from({ length: size }, () => new Array(size).fill(false));

    drawFinders(m, res);
    drawTiming(m, res);
    if (version >= 2) drawAlignment(m, res, size - 7, size - 7);
    res[size - 8][8] = true; m[size - 8][8] = 1; // Dark Module

    const fmtPos = formatInfoPositions(size);
    for (const [r, c] of fmtPos) res[r][c] = true;

    const bits = [];
    for (const cw of full) for (let b = 7; b >= 0; b--) bits.push((cw >> b) & 1);
    placeData(m, res, bits);

    if (forceMask !== null && forceMask !== undefined) {
      const mm = applyMask(m, res, forceMask);
      writeFormatInfo(mm, fmtPos, formatBits(level, forceMask));
      return { size, version, level, mask: forceMask, matrix: mm };
    }

    let best = null;
    let bestMask = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const mm = applyMask(m, res, mask);
      writeFormatInfo(mm, fmtPos, formatBits(level, mask));
      const s = penalty(mm);
      if (s < bestScore) { bestScore = s; best = mm; bestMask = mask; }
    }

    return { size, version, level, mask: bestMask, matrix: best };
  }

  const api = { encode, rsGeneratorPoly, rsEncode, gfMul, M_TABLE, formatBits, EC_BITS, textToBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.smokyQR = encode;
})(typeof window !== 'undefined' ? window : globalThis);
