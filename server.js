// Smoky — multi media downloader backend.
// Zero-dependency Node server: serves the UI and runs yt-dlp / spotDL downloads.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');

const PORT = process.env.PORT || 4173;
const APP_VERSION = require('./package.json').version;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// In the packaged app the code lives inside the read-only app.asar, so
// persistent state must live outside it (Windows: %APPDATA%\Smoky). In dev
// and standalone runs we keep the data/ folder next to server.js.
// SMOKY_DATA_DIR: Test-Isolation — Smoke-Tests legen ihre Daten in einen
// Temp-Ordner, damit echte Settings/History nie überschrieben werden.
const DATA_DIR = process.env.SMOKY_DATA_DIR || (__dirname.includes('app.asar')
  ? path.join(process.env.APPDATA || process.env.HOME || process.cwd(), 'Smoky')
  : path.join(ROOT, 'data'));
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const VAULT_QUOTA = 10 * 1024 * 1024 * 1024; // 10 GB "local vault"

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac', '.webm': 'video/webm', '.mp4': 'video/mp4',
};
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.aac']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov']);
// Formate, die spotDL selbst erzeugen kann (--format {mp3,flac,ogg,opus,m4a,wav}).
// aac ist nicht dabei → fällt in launchItem auf mp3 zurück.
const SPOT_FORMATS = new Set(['mp3', 'flac', 'ogg', 'opus', 'm4a', 'wav']);
// execFileSync darf nie endlos blockieren — weder beim Boot (Tool-Erkennung)
// noch beim Tools-Update. 8 s reichen für --version weit (yt-dlp braucht hier
// ~2 s, mit Defender-Erstscan deutlich länger, aber endlich).
const TOOL_TIMEOUT = 8000;

// ---------------------------------------------------------------- state ----
const queue = [];            // active + waiting items (in memory)
let history = [];            // persisted finished items
const THEMES = ['smoky', 'midnight', 'aurora', 'ember', 'ocean', 'rose', 'cyber', 'forest', 'slate', 'solar', 'rain', 'horror', 'light', 'spring', 'summer', 'autumn', 'galaxy', 'lava', 'sakura', 'custom'];
let settings = {
  folder: path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads', 'Smoky'),
  format: 'mp4-1080',
  quality: 'best',
  ambientSnow: true,
  theme: 'midnight',
  musicVolume: 22,
  guideSeen: false,
  maxParallel: 3,
  organizeFolders: false,
  // Discord: RPC (Client-ID reicht) + optionaler Login (Client-ID + Secret).
  // NIE im /api/status oder im Settings-Export zurückgeben — Secret + Token
  // bleiben lokal auf diesem Gerät.
  discordClientId: '',
  discordClientSecret: '',
  discordRpc: true,
  discordAssetKey: '', // Optional: Discord-Portal „Rich Presence → Art Assets“-Key
  discordProfile: null, // { id, username, avatar, discriminator }
  discordToken: null,
};
const running = [];          // derzeit aktive Downloads (parallel, max. settings.maxParallel)
let conversions = [];        // ffmpeg conversions (in memory)
let clips = [];              // clip jobs (yt-dlp section download + ffmpeg)
let playerState = null;      // { title, artist, album, playing, position, duration, updatedAt }
let serverPort = PORT;       // tatsächlicher Port (für den Discord-OAuth-Redirect)

// ------------------------------------------------------- phone share ----
// „Senden ans Handy“: ein separater, LAN-sichtbarer Mini-Server (0.0.0.0),
// der NUR explizit freigegebene Dateien über kurzlebige Token ausliefert.
// Der Haupt-Server bleibt auf 127.0.0.1 — Settings, Downloads & Secrets sind
// damit nie im Netzwerk erreichbar.
const SHARE_PORT = process.env.SHARE_PORT ? parseInt(process.env.SHARE_PORT, 10) : 4174;
const SHARE_TTL_MS = 10 * 60 * 1000; // Token laufen nach 10 Minuten ab
const shareTokens = new Map();       // token -> { path, filename, expiresAt }
let shareServer = null;
let sharePort = null;

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, value) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); } catch {}
}
fs.mkdirSync(DATA_DIR, { recursive: true });
history = loadJson(HISTORY_FILE, []);
settings = { ...settings, ...loadJson(SETTINGS_FILE, {}) };

// ------------------------------------------------------- format mapping ----
const HEIGHTS = { 360: 360, 480: 480, 720: 720, 1080: 1080, 1440: 1440, 2160: 2160 };

function videoArgs(quality, ext) {
  const h = HEIGHTS[String(quality).trim()] || 1080;
  const sel = h >= 9999 ? 'bestvideo+bestaudio/best' : `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
  return ['-f', sel, '--merge-output-format', ext];
}

// Audio downloads always carry automatic tags (title, artist) and, where the
// container supports it, the cover art — via yt-dlp's embed flags. (WAV and
// raw AAC have no standard cover-art slot, so they get tags only.)
const EMBED = ['--embed-metadata'];
const EMBED_ART = [...EMBED, '--embed-thumbnail'];
// WAV und AAC haben keinen Cover-Art-Slot — dort wird der Thumbnail als
// separate Bilddatei neben die Audiodatei geschrieben (--write-thumbnail);
// coverFor() findet ihn dann über siblingCover().
const AUDIO_ARGS = {
  mp3:  ['-x', '--audio-format', 'mp3', '--audio-quality', '0', ...EMBED_ART],
  m4a:  ['-x', '--audio-format', 'm4a', ...EMBED_ART],
  flac: ['-x', '--audio-format', 'flac', ...EMBED_ART],
  wav:  ['-x', '--audio-format', 'wav', '--write-thumbnail', ...EMBED],
  ogg:  ['-x', '--audio-format', 'ogg', ...EMBED_ART],
  opus: ['-x', '--audio-format', 'opus', ...EMBED_ART],
  aac:  ['-x', '--audio-format', 'aac', '--write-thumbnail', ...EMBED],
};

const FORMATS = {};
for (const ext of ['mp4', 'webm', 'mkv', 'mov']) {
  FORMATS[ext] = { label: `${ext.toUpperCase()} Video`, kind: 'video', ext, args: (q) => videoArgs(q, ext) };
}
for (const ext of Object.keys(AUDIO_ARGS)) {
  FORMATS[ext] = { label: `${ext.toUpperCase()} Audio`, kind: 'audio', ext, args: () => AUDIO_ARGS[ext] };
}
// legacy aliases from the earlier UI
FORMATS['mp4-1080'] = { ...FORMATS.mp4, label: 'MP4 Video · 1080p' };
FORMATS['mp4-4k'] = { ...FORMATS.mp4, label: 'MP4 Video · 4K', args: () => videoArgs(2160, 'mp4') };
FORMATS['mp4-best'] = { ...FORMATS.mp4, label: 'MP4 Video · Best', args: () => videoArgs(9999, 'mp4') };
FORMATS['mkv-4k'] = { ...FORMATS.mkv, label: 'WebM / MKV · 4K', args: () => videoArgs(9999, 'mkv') };

function browserFlag(name) {
  const map = { 'opera-gx': 'opera' };
  const browser = map[name] || name;
  if (!browser || browser === 'none' || browser === 'Disabled') return [];
  return ['--cookies-from-browser', browser];
}

// ------------------------------------------------------------- utilities ---
function now() { return Date.now(); }

function isSpotify(url) {
  return /open\.spotify\.com|^spotify:/.test(url);
}

function hasCommand(cmd) {
  // some ffmpeg builds only accept `-version`, CLI tools usually accept `--version`
  for (const flag of ['-version', '--version']) {
    try {
      require('node:child_process').execFileSync(cmd, [flag], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch { /* try next flag */ }
  }
  return false;
}

// ----------------------------------------------------- platform tools ------
// Die gebündelten Tools sind plattformspezifisch: Windows liefert .exe-Dateien
// mit, macOS nutzt unix-Binaries (werden beim ersten Tools-Update in den
// tools-Ordner geholt — dort sucht bundledPath() dann auch).
const IS_MAC = process.platform === 'darwin';
// Fallback-Installationshinweise, falls kein Tool gefunden wird (die App lädt
// die Binaries normalerweise selbst über „Tools aktualisieren“).
const YTDLP_INSTALL_HINT = IS_MAC ? 'brew install yt-dlp' : 'py -m pip install -U yt-dlp';
const SPOTDL_INSTALL_HINT = IS_MAC ? 'python3 -m pip install -U spotdl' : 'py -m pip install -U spotdl';
const TOOL_YTDLP_NAME = IS_MAC ? 'yt-dlp' : 'yt-dlp.exe';
const TOOL_FFMPEG_NAME = IS_MAC ? 'ffmpeg' : 'ffmpeg.exe';
const TOOL_FFPROBE_NAME = IS_MAC ? 'ffprobe' : 'ffprobe.exe';
const TOOL_YTDLP_URL = IS_MAC
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
// ffmpeg für macOS: statische Builds von Martin Riedl (Intel + Apple Silicon),
// Windows: gyan.dev essentials-Zip. Beide liefern ffmpeg + ffprobe.
const TOOL_FFMPEG_ARCH = (() => {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'amd64';
  return 'amd64';
})();
const TOOL_FFMPEG_ZIP_URL = IS_MAC
  ? `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${TOOL_FFMPEG_ARCH}/release/ffmpeg.zip`
  : 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

// Bundled tools ship inside the app — the packaged build keeps them in
// resources/tools (electron-builder extraResources), dev/standalone keeps
// them in ./tools next to server.js. Bundled tools win over system tools so
// friends don't need to install anything.
function bundledPath(name) {
  const dirs = [
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'tools') : null,
    path.join(__dirname, 'tools'),
  ].filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function bundledCmd(name) {
  const p = bundledPath(name);
  if (!p) return null;
  // ffmpeg accepts `-version`; yt-dlp does NOT (it parses it as a rate-limit
  // flag and exits 2) — try both forms so every bundled tool is recognised.
  for (const flag of ['-version', '--version']) {
    try {
      require('node:child_process').execFileSync(p, [flag], { stdio: 'ignore', windowsHide: true, timeout: TOOL_TIMEOUT });
      return { cmd: p, args: [] };
    } catch { /* try next flag */ }
  }
  return null;
}

// Resolve the best yt-dlp: bundled exe first (ships with the app), then the
// pip-installed `py -m yt_dlp` (usually much newer than a standalone exe on
// PATH, which gets HTTP 403 from YouTube when outdated), then PATH.
function resolveYtdlp() {
  const bundled = bundledCmd(TOOL_YTDLP_NAME);
  if (bundled) return bundled;
  try {
    require('node:child_process').execFileSync(IS_MAC ? 'python3' : 'py', ['-m', 'yt_dlp', '--version'], { stdio: 'ignore', windowsHide: true, timeout: TOOL_TIMEOUT });
    return { cmd: IS_MAC ? 'python3' : 'py', args: ['-m', 'yt_dlp'] };
  } catch {}
  if (hasCommand('yt-dlp')) return { cmd: 'yt-dlp', args: [] };
  return null;
}

function cmdVersion(cmd, flag) {
  if (!cmd) return null;
  try {
    return require('node:child_process').execFileSync(cmd.cmd, [flag], { encoding: 'utf8', windowsHide: true, timeout: TOOL_TIMEOUT }).trim().split(/\r?\n/)[0];
  } catch { return null; }
}

// Tool-Versionen werden NUR beim Start (und nach einem Tools-Update) ermittelt
// und gecacht — niemals im /api/status-Hot-Path. Ein einziger execFileSync pro
// Poll (yt-dlp --version dauert hier ~2 s, mit Windows-Defender-Erstscan des
// neuen Binaries deutlich länger) blockiert die komplette Server-Event-Loop:
// die App friert ein, sobald der Renderer im Sekundentakt /api/status pollt
// (Regression aus v1.8.6 — in v1.8.5 gab es keine Versionen im Status).
let toolVersions = { ytdlp: null, ffmpeg: null };
function refreshToolVersions() {
  toolVersions = { ytdlp: cmdVersion(ytdlp, '--version'), ffmpeg: cmdVersion(ffmpegCmd, '-version') };
  return toolVersions;
}

// ------------------------------------------------ bundled tools update -----
// yt-dlp / ffmpeg aktualisieren: Download in den tools-Ordner, Selbsttest des
// neuen Binaries und erst DANN ersetzen (transactional). Bei jedem Fehler
// bleibt das bisherige Binary unangetastet.
function downloadFile(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('node:https') : require('node:http');
    const req = mod.get(url, { headers: { 'User-Agent': 'Smoky/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(downloadFile(next, dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' für ' + url));
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve(dest)));
      ws.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function findFileRecursive(dir, name) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const found = findFileRecursive(p, name); if (found) return found; }
      else if (e.name === name) return p;
    }
  } catch {}
  return null;
}

async function updateBundledTools() {
  const ytdlpPath = bundledPath(TOOL_YTDLP_NAME);
  // Wichtiger macOS-Fix: Im gepackten Build liegt server.js im read-only
  // app.asar — __dirname/tools wäre dort nicht beschreibbar. Deshalb auf
  // resources/tools ausweichen (ausserhalb des asar, wird beim ersten Update
  // angelegt). Dev (ohne resourcesPath) nutzt weiter __dirname/tools.
  const toolsDir = ytdlpPath
    ? path.dirname(ytdlpPath)
    : (typeof process.resourcesPath === 'string'
        ? path.join(process.resourcesPath, 'tools')
        : path.join(__dirname, 'tools'));
  const out = {};
  try { fs.mkdirSync(toolsDir, { recursive: true }); } catch {}
  // yt-dlp (18 MB, GitHub Release)
  try {
    const tmp = path.join(toolsDir, TOOL_YTDLP_NAME + '.tmp');
    await downloadFile(TOOL_YTDLP_URL, tmp);
    const ver = cmdVersion({ cmd: tmp }, '--version');
    if (!ver) throw new Error('neues ' + TOOL_YTDLP_NAME + ' startet nicht');
    const cur = path.join(toolsDir, TOOL_YTDLP_NAME);
    try { fs.unlinkSync(cur + '.old'); } catch {}
    if (fs.existsSync(cur)) fs.renameSync(cur, cur + '.old');
    fs.renameSync(tmp, cur);
    if (!IS_MAC) { try { fs.chmodSync(cur, 0o755); } catch {} }
    try { fs.unlinkSync(cur + '.old'); } catch {}
    out.ytdlp = ver;
  } catch (e) {
    try { fs.unlinkSync(path.join(toolsDir, TOOL_YTDLP_NAME + '.tmp')); } catch {}
    out.error = 'yt-dlp: ' + String(e.message || e);
  }
  // ffmpeg + ffprobe (Zip herunterladen und entpacken — Windows via
  // PowerShell, macOS via unzip; Windows-Zip verschachtelt, macOS flach)
  const zip = path.join(toolsDir, 'ffmpeg-release.zip');
  const extractDir = path.join(toolsDir, 'ffmpeg-extract');
  try {
    await downloadFile(TOOL_FFMPEG_ZIP_URL, zip);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    if (IS_MAC) {
      require('node:child_process').execFileSync('unzip', ['-o', '-q', zip, '-d', extractDir], { stdio: 'ignore' });
    } else {
      require('node:child_process').execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${extractDir}' -Force`], { windowsHide: true, stdio: 'ignore' });
    }
    const ffmpegNew = findFileRecursive(extractDir, TOOL_FFMPEG_NAME);
    const ffprobeNew = findFileRecursive(extractDir, TOOL_FFPROBE_NAME);
    if (!ffmpegNew || !ffprobeNew) throw new Error('ffmpeg/ffprobe nicht im Archiv gefunden');
    const v = cmdVersion({ cmd: ffmpegNew }, '-version');
    if (!v) throw new Error('neues ' + TOOL_FFMPEG_NAME + ' startet nicht');
    for (const name of [TOOL_FFMPEG_NAME, TOOL_FFPROBE_NAME]) {
      const cur = path.join(toolsDir, name);
      const src = name === TOOL_FFMPEG_NAME ? ffmpegNew : ffprobeNew;
      try { fs.unlinkSync(cur + '.old'); } catch {}
      if (fs.existsSync(cur)) fs.renameSync(cur, cur + '.old');
      fs.copyFileSync(src, cur);
      if (IS_MAC) { try { fs.chmodSync(cur, 0o755); } catch {} }
    }
    for (const name of [TOOL_FFMPEG_NAME, TOOL_FFPROBE_NAME]) { try { fs.unlinkSync(path.join(toolsDir, name + '.old')); } catch {} }
    out.ffmpeg = v;
  } catch (e) {
    out.error = (out.error ? out.error + ' | ' : '') + 'ffmpeg: ' + String(e.message || e);
  } finally {
    // Immer aufräumen (Erfolg UND Fehler) — Zip + Entpack-Ordner dürfen weder
    // liegen bleiben noch ins Paket wandern.
    try { fs.unlinkSync(zip); } catch {}
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
  }
  // Nach dem Austausch der Binaries die Tool-Auflösung neu laden (sonst bliebe
  // ytdlp auf einem frischen Mac `null` bis zum Neustart) und den gecachten
  // Versions-Stand aktualisieren, damit /api/status die neuen Versionen meldet
  // (ohne erneuten execFileSync pro Poll).
  try { reloadTools(); } catch {}
  try { refreshToolVersions(); } catch {}
  out.ok = !out.error;
  return out;
}

// Same idea for spotDL: prefer the pip-installed `py -m spotdl`, fall back to PATH.
function resolveSpotdl() {
  try {
    require('node:child_process').execFileSync(IS_MAC ? 'python3' : 'py', ['-m', 'spotdl', '--version'], { stdio: 'ignore', windowsHide: true, timeout: TOOL_TIMEOUT });
    return { cmd: IS_MAC ? 'python3' : 'py', args: ['-m', 'spotdl'] };
  } catch {}
  if (hasCommand('spotdl')) return { cmd: 'spotdl', args: [] };
  return null;
}

// Tool-Auflösung ist veränderlich: Beim ersten Start auf einem frischen Mac
// ist kein yt-dlp/ffmpeg vorhanden — erst „Tools aktualisieren“ lädt die
// Binaries herunter. Deshalb als `let` halten und nach einem Tools-Update über
// reloadTools() neu auflösen, damit Downloads sofort (ohne Neustart) laufen.
let ytdlp = null;
let spotdl = null;
let ffmpegCmd = null;
let ffprobeCmd = null;
// Directory of the ffmpeg/ffprobe we resolved to — passed to yt-dlp via
// --ffmpeg-location so friends without ffmpeg on their PATH can still merge.
// Only set when it's a real file path (bundled exe); PATH-resolved ffmpeg
// needs no hint.
let FFMPEG_DIR = null;
// Prepending the bundled tools dir to PATH guarantees that yt-dlp and spotDL
// (which spawn ffmpeg/ffprobe themselves for postprocessing) find the bundled
// copy — belt and braces on top of --ffmpeg-location, and the only mechanism
// spotDL honours.
let TOOL_ENV = process.env;
let YTDLP_OK = false;
let SPOTDL_OK = false;
let FFMPEG_OK = false;
let FFPROBE_OK = false;

function reloadTools() {
  ytdlp = resolveYtdlp();
  spotdl = resolveSpotdl();
  ffmpegCmd = bundledCmd(TOOL_FFMPEG_NAME) || (hasCommand('ffmpeg') ? { cmd: 'ffmpeg', args: [] } : null);
  ffprobeCmd = bundledCmd(TOOL_FFPROBE_NAME) || (hasCommand('ffprobe') ? { cmd: 'ffprobe', args: [] } : null);
  FFMPEG_DIR = ffmpegCmd && ffmpegCmd.cmd.includes(path.sep) && fs.existsSync(ffmpegCmd.cmd)
    ? path.dirname(ffmpegCmd.cmd)
    : null;
  TOOL_ENV = FFMPEG_DIR
    ? { ...process.env, PATH: `${FFMPEG_DIR}${path.delimiter}${process.env.PATH || ''}` }
    : process.env;
  YTDLP_OK = !!ytdlp;
  SPOTDL_OK = !!spotdl;
  FFMPEG_OK = !!ffmpegCmd;
  FFPROBE_OK = !!ffprobeCmd;
}
reloadTools();
// Einmalig beim Start ermitteln (danach nur noch nach einem Tools-Update).
refreshToolVersions();

async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else if (e.isFile()) { const st = await fsp.stat(p); total += st.size; }
    }  } catch {}
  return total;
}

// Newest regular file in a folder — fallback for finding the output file of
// tools that don't announce their destination (e.g. spotDL).
async function newestFileIn(dir, sinceMs) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    let best = null, bestTime = 0;
    for (const e of entries) {
      if (e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      const st = await fsp.stat(p);
      // `sinceMs`: nur Dateien berücksichtigen, die WÄHREND dieses Downloads
      // entstanden sind — nie einen alten, fremden Eintrag als Ergebnis
      // interpretieren (sonst angelt sich ein Download einen falschen File).
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = p; }
    }
    return best;
  } catch { return null; }
}

// Alle Audiodateien, die seit `sinceMs` in `dir` neu entstanden sind — für
// gebündelte spotDL-Downloads, die mehrere Dateien auf einmal liefern.
async function newAudioFilesIn(dir, sinceMs) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (!AUDIO_EXTS.has(path.extname(p).toLowerCase())) continue;
      const st = await fsp.stat(p);
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      out.push({ path: p, mtime: st.mtimeMs });
    }
    return out.sort((a, b) => a.mtime - b.mtime).map((x) => x.path);
  } catch { return []; }
}


// Spotify-Re-Download: Existiert die Datei schon, überspringt spotDL sie
// („Skipping … (file already exists)") und liefert Exit 0 — ohne neue Datei.
// Die App darf das nicht als „failed“ werten: die vorhandene Datei wird als
// Ergebnis übernommen. Die Namen aus der Skip-Zeile werden gegen die Dateien
// im Zielordner gematcht.
function findExistingSpotFiles(folder, tail) {
  const names = [];
  for (const line of String(tail || '').split(/\r?\n/)) {
    let m = line.match(/Skipping\s+(.+?)\s+\(file already exists\)/i);
    if (m) names.push(m[1].trim());
    else {
      m = line.match(/Skipping explicit song:\s*(.+)/i);
      if (m) names.push(m[1].trim());
    }
  }
  if (!names.length) return [];
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = names.map(norm).filter(Boolean);
  const out = [];
  try {
    for (const f of fs.readdirSync(folder)) {
      const p = path.join(folder, f);
      if (!AUDIO_EXTS.has(path.extname(f).toLowerCase())) continue;
      const stem = norm(f.slice(0, f.length - path.extname(f).length));
      if (wanted.some((w) => stem === w || stem.includes(w) || w.includes(stem))) {
        try { out.push({ path: p, mtime: fs.statSync(p).mtimeMs }); } catch {}
      }
    }
  } catch {}
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.path);
}

// Verschiebt eine Datei — mit Fallback über Laufwerksgrenzen hinweg: renameSync
// wirft EXDEV, wenn Quelle und Ziel auf verschiedenen Volumes liegen (z. B.
// Download auf D:, Zielordner auf C:). Dann kopieren + löschen.
function moveFile(src, dest) {
  try { fs.renameSync(src, dest); return true; } catch {}
  try {
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
    return true;
  } catch { return false; }
}

// -------------------------------------------------------------- download ---
function isPlaylistUrl(url) {
  // YouTube playlists carry a list= param (also /playlist?list= and /playlists/…);
  // Spotify playlists/albums are explicit path segments.
  if (/youtube\.com|youtu\.be/i.test(url)) return /[?&]list=[^&]+/.test(url);
  if (/open\.spotify\.com/i.test(url)) return /\/(playlist|album)\/[A-Za-z0-9]+/.test(url);
  return false;
}

// Anzeige-Titel aus einem Dateinamen: Endung und das yt-dlp-„[videoId]“-Suffix
// entfernen (die Datei selbst behält den Suffix — die Cover-Nachrüstung braucht
// ihn). Nur echte IDs ([A-Za-z0-9_-]{6,}) am Ende werden entfernt.
function displayTitle(base) {
  return String(base).replace(/\.[^.]+$/, '').replace(/\s*\[[A-Za-z0-9_-]{6,}\]\s*$/, '');
}

function parseProgress(line, item) {
  // 0) playlist position — "[download] Downloading item 3 of 10"
  let m = line.match(/Downloading item (\d+) of (\d+)/i);
  if (m) { item.trackIndex = parseInt(m[1], 10); item.trackCount = parseInt(m[2], 10); }
  // 1) final file naming — [download] Destination / Merger / Remuxer / ExtractAudio
  m = line.match(/\[download\]\s+Destination:\s+(.+)/i)
    || line.match(/\[Merger\]\s+Merging formats into\s+"([^"]+)"/i)
    || line.match(/\[VideoRemuxer\]\s+Remuxing video into\s+"([^"]+)"/i)
    || line.match(/\[ExtractAudio\]\s+Destination:\s+(.+)/i)
    || line.match(/\[download\]\s+(.+)\s+has already been downloaded/i);
  if (m) {
    const base = path.basename(m[1].trim());
    item.file = m[1].trim();
    item.title = displayTitle(base);
  }
  // 2) percent / speed / ETA
  m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+([^\s]+)/i);
  if (m) {
    item.percent = parseFloat(m[1]);
    const sp = line.match(/at\s+([^\s]+)/i);
    const et = line.match(/ETA\s+([^\s]+)/i);
    item.speed = sp ? sp[1] : item.speed;
    item.eta = et ? et[1] : item.eta;
    return true;
  }
  // 3) phase changes
  if (/\[ExtractAudio\]/.test(line) || /\[Merger\]/.test(line) || /\[VideoRemuxer\]/.test(line) || /\[FixupM4a\]/.test(line) || /\[Metadata\]/.test(line)) {
    item.status = 'processing';
    return true;
  }
  // 4) spotDL (Spotify): "Found 50 songs in Today's Top Hits (Playlist)"
  m = line.match(/Found\s+(\d+)\s+songs?/i);
  if (m) { item.trackCount = parseInt(m[1], 10); item.trackIndex = item.trackIndex || 0; return true; }
  // spotDL: `Downloaded "Artist - Title":` — ein fertiger Track
  m = line.match(/^Downloaded\s+"(.+?)":/i);
  if (m) {
    item.trackIndex = (item.trackIndex || 0) + 1;
    item.title = m[1].trim();
    if (item.trackCount) item.percent = Math.round((item.trackIndex / item.trackCount) * 100);
    return true;
  }
  return false;
}

function enqueue(url, formatKey, quality, folder, browserName, tracks) {
  const picked = Array.isArray(tracks) && tracks.length ? tracks.filter((t) => /^https?:\/\//i.test(t)) : null;
  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    url,
    tracks: picked,
    format: FORMATS[formatKey] ? FORMATS[formatKey].label : FORMATS['mp4-1080'].label,
    formatKey: FORMATS[formatKey] ? formatKey : 'mp4-1080',
    quality,
    folder,
    browserName: browserName || 'none',
    title: isSpotify(url) ? (isPlaylistUrl(url) ? 'Spotify playlist…' : 'Spotify track…') : 'Resolving link…',
    status: 'queued',
    percent: 0,
    speed: null,
    eta: null,
    trackIndex: null,
    trackCount: picked ? picked.length : (isPlaylistUrl(url) ? 0 : null),
    _isSpot: isSpotify(url),
    file: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
  queue.push(item);
  pump();
  return item;
}

function pump() {
  if (queue.length === 0) return;
  const limit = Math.max(1, Math.min(6, Number(settings.maxParallel) || 3));
  while (running.length < limit) {
    // spotDL nie parallel starten: die gleichzeitigen YouTube-Suchen mehrerer
    // spotDL-Prozesse triggern Rate-Limits („No results found“ trotz vorhan-
    // dener Videos). Gebündelte Playlists holen sich Parallelität intern über
    // --threads. Läuft ein spotDL-Prozess, starten nur noch Nicht-Spotify-
    // Items — die Spotify-Items warten der Reihe nach.
    const spotRunning = running.some((r) => r._isSpot);
    const item = spotRunning
      ? queue.find((q) => q.status === 'queued' && !q._isSpot)
      : queue.find((q) => q.status === 'queued');
    if (!item) break;
    running.push(item);
    launchItem(item);
  }
}

// Liest aus spotDLs Ausgabe die eigentliche Fehlerursache heraus (spotDL
// liefert Exit 0, auch wenn einzelne Tracks fehlschlagen).
function extractSpotError(tail) {
  const lines = tail.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    let m = line.match(/No results found for song:\s*(.+)/i);
    if (m) return `Not found on YouTube: ${m[1].trim()}`;
    m = line.match(/LookupError:\s*(.+)/i);
    if (m) return m[1].trim();
    m = line.match(/Failed to download\s+"([^"]+)"/i);
    if (m) return `Failed to download: ${m[1].trim()}`;
    m = line.match(/^ERROR:\s*(.+)/i);
    if (m) return m[1].trim();
  }
  return null;
}

function launchItem(item) {
  item.status = 'downloading';
  item.startedAt = now();
  item.percent = 0;
  item._retrying = false;
  item._finished = false;

  const folder = item.folder || settings.folder;
  try { fs.mkdirSync(folder, { recursive: true }); } catch {}

  const isSpot = isSpotify(item.url);
  const outTpl = path.join(folder, '%(title)s [%(id)s].%(ext)s');
  // Track-Auswahl: Wenn konkrete Track-URLs gewaehlt wurden, werden genau die
  // geladen statt der ganzen Playlist.
  const picked = item.tracks;

  let cmd, args;
  if (isSpot) {
    if (!SPOTDL_OK) {
      item.status = 'failed';
      item.error = `spotDL is not installed. Run: ${SPOTDL_INSTALL_HINT}`;
      finish(item);
      return;
    }
    // Explizites `download`-Operation: spotDL 4.5.2 erkennt die Operation nur
    // bei EINER einzelnen URL automatisch — mit mehreren Queries (gebündelte
    // Playlist) wirft es sonst „invalid choice“.
    // --threads: gebündelte Playlist-Downloads laufen innerhalb EINES spotDL-
    // Prozesses parallel — deutlich schneller als N einzelne Prozesse. Die
    // Anzahl paralleler spotDL-PROZESSE wird unten trotzdem auf 1 begrenzt,
    // damit die gleichzeitigen YouTube-Suchen nicht gedrosselt werden.
    cmd = spotdl.cmd;
    // Die Formatwahl der UI respektieren: spotDL kann mp3/flac/ogg/opus/m4a/wav.
    // Nur nicht unterstützte Ziele (z. B. aac) fallen auf mp3 zurück.
    args = [...spotdl.args, 'download', ...(picked || [item.url]), '--output', folder, '--format', spotFormatFor(item.formatKey), '--overwrite', 'skip', '--threads', '4'];
    if (picked) item.title = 'Spotify playlist…';
  } else {
    if (!YTDLP_OK) {
      item.status = 'failed';
      item.error = `yt-dlp is not installed. Run: ${YTDLP_INSTALL_HINT}`;
      finish(item);
      return;
    }
    const fmt = FORMATS[item.formatKey] || FORMATS['mp4-1080'];
    const playlist = isPlaylistUrl(item.url);
    cmd = ytdlp.cmd;
    args = [
      ...ytdlp.args,
      '--newline', '--no-warnings',
      // playlists download every track; single videos stay single even when
      // they happen to belong to a playlist
      playlist ? '--yes-playlist' : '--no-playlist',
      '-o', outTpl,
      ...fmt.args(item.quality),
      ...(FFMPEG_DIR ? ['--ffmpeg-location', FFMPEG_DIR] : []),
      ...browserFlag(item.browserName),
      ...(picked || [item.url]),
    ];
    if (playlist && !picked) item.title = 'Playlist…';
  }

  const child = spawn(cmd, args, { windowsHide: true, env: TOOL_ENV });
  item.child = child;

  let tail = '';
  const onData = (buf) => {
    const text = buf.toString();
    tail = (tail + text).slice(-600);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (line.includes('[download]') && item.status === 'queued') item.status = 'downloading';
      parseProgress(line, item);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    item.status = 'failed';
    item.error = String(err.message || err);
    if (canAutoRetry(item)) { scheduleRetry(item); return; }
    finish(item);
  });

  child.on('close', async (code) => {
    if (item.status === 'failed' || item.status === 'cancelled') { finish(item); return; }
    if (item._retrying) return; // 'error' hat den Retry schon eingeplant — kein Doppel-Retry
    if (code === 0) {
      // spotDL meldet Exit 0 auch dann, wenn NICHTS heruntergeladen wurde
      // (z. B. „LookupError: No results found for song: …“). Für Spotify daher
      // IMMER prüfen, dass wirklich eine neue Audiodatei entstanden ist —
      // sonst wird der Download ehrlich als fehlgeschlagen markiert statt sich
      // einen fremden, alten File aus dem Ordner als „Ergebnis“ zu angeln.
      if (isSpot) {
        const since = (item.startedAt || Date.now()) - 5000; // Puffer für mtime-Präzision
        const newFiles = await newAudioFilesIn(folder, since);
        if (!newFiles.length) {
          // Nichts Neues, aber spotDL hat alle Tracks übersprungen, weil die
          // Dateien bereits existieren → kein Fehler, Datei ist schon da.
          const existing = findExistingSpotFiles(folder, tail);
          if (existing.length) {
            item.status = 'finished';
            item.percent = 100;
            item.speed = null;
            item.eta = null;
            item.file = existing[0]; // neueste Übereinstimmung
            item.title = displayTitle(path.basename(item.file));
            finish(item);
            return;
          }
          item.status = 'failed';
          item.error = extractSpotError(tail) || 'spotDL finished without downloading anything';
          finish(item);
          return;
        }
        item.status = 'finished';
        item.percent = 100;
        item.speed = null;
        item.eta = null;
        const found = newFiles[newFiles.length - 1];
        item.file = found;
        // Gebündelte Playlist-Downloads: ALLE neuen Dateien organisieren (und
        // bei der neuesten den verschobenen Zielpfad übernehmen).
        try {
          for (const f of newFiles) {
            const copy = { ...item, file: f };
            await organizeIntoFolders(copy);
            if (f === found && copy.file) item.file = copy.file;
          }
        } catch {}
        item.title = displayTitle(path.basename(item.file));
        finish(item);
        return;
      }
      item.status = 'finished';
      item.percent = 100;
      item.speed = null;
      item.eta = null;
      // yt-dlp kündigt sein Ziel normal an; falls doch nicht (exotische
      // Ausgaben), nur Dateien akzeptieren, die während dieses Laufs entstanden.
      if (!item.file) {
        const found = await newestFileIn(folder, (item.startedAt || Date.now()) - 5000);
        if (found) {
          item.file = found;
          if (!item.title || item.title === 'Resolving link…' || item.title === 'Spotify track…') {
            item.title = displayTitle(path.basename(found));
          }
        }
      }
      // Optional: fertige Audiodateien nach Künstler/Album sortieren.
      try { await organizeIntoFolders(item); } catch {}
    } else {
      item.status = 'failed';
      const last = tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
      item.error = last || `yt-dlp exited with code ${code}`;
      if (canAutoRetry(item)) { scheduleRetry(item); return; }
    }
    finish(item);
  });
}

// Auto-Retry: fehlgeschlagene Downloads bis zu 2× automatisch erneut starten
// (mit Backoff). Permanente Fehler (Login, Privat, Copyright, …) werden nie
// wiederholt — nur flüchtige wie kurze Netzwerk-Aussetzer.
function canAutoRetry(item) {
  if ((item.retries || 0) >= 2) return false;
  const msg = String(item.error || '').toLowerCase();
  if (/not installed|sign in|signin|private|unavailable|removed|copyright|dpapi|decrypt|cookie database|unsupported url|geo-restricted|content is not available|no results found|lookuperror|not found on youtube|nothing was downloaded/i.test(msg)) return false;
  return true;
}

function scheduleRetry(item) {
  item.retries = (item.retries || 0) + 1;
  const delay = item.retries * 3000 + 2000; // 5s, dann 8s
  item.status = 'queued';
  item.error = null;
  item.percent = 0;
  item.child = null;
  item._retrying = true; // verhindert Doppel-Retry durch nachfolgendes 'close'
  const ri = running.indexOf(item);
  if (ri !== -1) running.splice(ri, 1);
  setTimeout(pump, delay);
}

// Zielordner für die Ordner-Struktur: Künstler/Album — oder nur Künstler,
// wenn kein echtes Album vorliegt. Wichtig: bei YouTube-Videos ohne Album
// entspricht das Album-Tag oft dem Songtitel — das würde einen Ordner PRO
// SONG erzeugen („setfrvr/xaviersobased - linda/xaviersobased - linda.mp3")
// statt einer sauberen Gruppierung. Album-Tags, die dem Titel entsprechen,
// gelten daher als fehlend → Song liegt flach im Künstler-Ordner.
function resolveOrganizePath(folder, tags) {
  const artist = (tags.artist || '').trim();
  let album = (tags.album || '').trim();
  const title = (tags.title || '').trim();
  if (!artist && !album) return null;
  if (album && title && (album === title || album.startsWith(title + ' ') || title.startsWith(album + ' '))) album = '';
  return artist
    ? path.join(folder, safeName(artist), album ? safeName(album) : '')
    : path.join(folder, safeName(album));
}

// Verschiebt fertige Audiodateien nach Künstler/Album (nur wenn aktiviert).
async function organizeIntoFolders(item) {
  if (!item.file || !settings.organizeFolders) return;
  const ext = path.extname(item.file).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) return;
  const tags = await probeTags(item.file);
  const targetDir = resolveOrganizePath(settings.folder, tags);
  if (!targetDir) return;
  const base = path.basename(item.file);
  const oldDir = path.dirname(item.file);
  const oldStem = base.slice(0, base.length - path.extname(base).length);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    let target = path.join(targetDir, base);
    if (path.normalize(target) === path.normalize(item.file)) return;
    if (fs.existsSync(target)) target = path.join(targetDir, item.id + '-' + base);
    // moveFile statt renameSync: scheitert nicht an Laufwerksgrenzen (EXDEV).
    if (!moveFile(item.file, target)) return;
    item.file = target;
    item.folder = targetDir;
    // Passendes Schwester-Bild (Thumbnail) mit umziehen, falls vorhanden.
    try {
      for (const f of fs.readdirSync(oldDir)) {
        const l = f.toLowerCase();
        if (!SIBLING_IMG_EXTS.some((e) => l.endsWith(e))) continue;
        const fStem = f.slice(0, f.length - path.extname(f).length);
        if (fStem === oldStem || fStem.startsWith(oldStem)) {
          const dest = path.join(targetDir, f);
          if (!fs.existsSync(dest)) moveFile(path.join(oldDir, f), dest);
        }
      }
    } catch {}
  } catch {}
}

// Fuehrt einen Befehl aus und liefert stdout zurueck (mit Timeout).
function runCmdOut(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const p = spawn(cmd, args, { windowsHide: true, env: TOOL_ENV });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs || 60000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err.trim() || out.trim()).split(/\r?\n/).slice(-2).join(' | ') || `exit ${code}`));
    });
  });
}

// Listet die Tracks einer Playlist auf (Titel/Artist/URL) — ohne sie zu laden.
// Spotify: Embed-Listing (schnell, ~1 Request), Fallback spotDL save; alles
// andere yt-dlp --flat-playlist (schnell).
// Spotify-Session (sp_t-Cookie) + Embed-Listing — deutlich schneller und
// robuster als `spotdl save`: Playlists liefern dieselbe Trackliste in ~2 s
// statt >100 s (ein Request statt Track-für-Track-Metadaten). Album-Embeds
// hat Spotify abgeschafft (404) — dort greift unten der Fallback.
const SPOTIFY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
let spotifySessionCache = { cookie: null, at: 0 };
async function spotifySession() {
  if (spotifySessionCache.cookie && Date.now() - spotifySessionCache.at < 10 * 60 * 1000) return spotifySessionCache.cookie;
  const res = await fetch('https://open.spotify.com', { headers: { 'User-Agent': SPOTIFY_UA, 'Accept-Language': 'en' }, redirect: 'manual' });
  const setc = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const sp_t = (setc.join(';').match(/sp_t=[^;]+/) || [''])[0];
  if (!sp_t) throw new Error('Spotify session unavailable');
  spotifySessionCache = { cookie: sp_t, at: Date.now() };
  return sp_t;
}

// Trackliste aus der Spotify-Embed-Seite. Playlists funktionieren und liefern
// die volle Trackliste inkl. Track-URIs; Album-Embeds antworten mit
// pageProps.status 404 (von Spotify abgeschafft) → wirft → Fallback unten.
async function spotifyEmbedTracks(url) {
  const m = String(url).match(/open\.spotify\.com\/(playlist|album)\/([A-Za-z0-9]+)/i);
  if (!m) throw new Error('unsupported spotify url');
  const kind = m[1].toLowerCase();
  const id = m[2];
  const cookie = await spotifySession();
  const res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
    headers: { 'User-Agent': SPOTIFY_UA, Cookie: cookie, 'Accept-Language': 'en' },
  });
  const html = await res.text();
  const data = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!data) throw new Error('spotify embed parse failed');
  const j = JSON.parse(data[1]);
  const pageProps = (j.props && j.props.pageProps) || {};
  if (pageProps.status && pageProps.status !== 200) throw new Error('spotify embed unavailable (' + pageProps.status + ')');
  const entity = pageProps.state && pageProps.state.data && pageProps.state.data.entity;
  const list = entity && entity.trackList;
  if (!Array.isArray(list) || !list.length) throw new Error('no tracks in spotify embed');
  return list.map((t, i) => ({
    index: i + 1,
    title: t.title || ('Track ' + (i + 1)),
    artist: t.subtitle || '',
    url: t.uri ? 'https://open.spotify.com/track/' + String(t.uri).split(':').pop() : '',
  })).filter((t) => /^https?:\/\//i.test(t.url));
}

async function listPlaylistTracks(url) {
  if (isSpotify(url)) {
    const isAlbum = /\/album\//i.test(url);
    // 1) Schneller Embed-Pfad (kein spotDL nötig) — funktioniert für Playlists.
    try {
      return await spotifyEmbedTracks(url);
    } catch { /* Fallback unten */ }
    // 2) Bisheriger Weg: spotDL save (Alben, private Playlists).
    if (!SPOTDL_OK) throw new Error(`spotDL is not installed. Run: ${SPOTDL_INSTALL_HINT}`);
    const tmp = path.join(os.tmpdir(), 'smoky-playlist-' + crypto.randomBytes(4).toString('hex') + '.spotdl');
    let spotdlErr = null;
    try {
      await runCmdOut(spotdl.cmd, [...spotdl.args, 'save', url, '--save-file', tmp], 90000);
      const raw = fs.readFileSync(tmp, 'utf8');
      const tracks = JSON.parse(raw);
      return (Array.isArray(tracks) ? tracks : []).map((t, i) => ({
        index: i + 1,
        title: t.name || ('Track ' + (i + 1)),
        artist: t.artist || (Array.isArray(t.artists) ? t.artists.join(', ') : ''),
        url: t.url || '',
      })).filter((t) => /^https?:\/\//i.test(t.url));
    } catch (e) { spotdlErr = e; }
    finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    // 3) Beides gescheitert — verständliche Meldung statt hängendem Picker
    // (Album-Listen blockt Spotify gerade komplett: Embed abgeschafft, API 429).
    throw new Error(isAlbum
      ? 'Spotify blockiert Album-Listen gerade (Album-Embeds abgeschafft). Nutze die Playlist des Albums oder füge die Track-Links einzeln ein.'
      : ('Die Playlist konnte nicht geladen werden. ' + (spotdlErr && spotdlErr.message ? spotdlErr.message.slice(0, 120) : '')));
  }
  if (!YTDLP_OK) throw new Error(`yt-dlp is not installed. Run: ${YTDLP_INSTALL_HINT}`);
  const json = await runCmdOut(ytdlp.cmd, [...ytdlp.args, '--flat-playlist', '--no-warnings', '-J', url], 60000);
  const parsed = JSON.parse(json);
  const entries = (parsed && parsed.entries) || [];
  return entries.map((e, i) => {
    const id = e.id;
    return {
      index: i + 1,
      title: e.title || ('Track ' + (i + 1)),
      artist: e.channel || e.uploader || '',
      url: e.url || (id ? `https://www.youtube.com/watch?v=${id}` : ''),
    };
  }).filter((t) => /^https?:\/\//i.test(t.url));
}

function finish(item) {
  if (item._finished) return; // idempotent — 'error' + 'close' feuern nacheinander
  item._finished = true;
  item.finishedAt = now();
  if (item.status === 'finished') invalidateLibraryCache();
  if (item.status === 'finished') {
    let size = null;
    try { if (item.file) size = fs.statSync(item.file).size; } catch {}
    item.bytes = size;
    history.unshift({
      id: item.id,
      title: item.title,
      url: item.url,
      format: item.format,
      file: item.file,
      folder: item.folder,
      finishedAt: item.finishedAt,
      size,
    });
    history = history.slice(0, 200);
    saveJson(HISTORY_FILE, history);
  }
  const ri = running.indexOf(item); if (ri !== -1) running.splice(ri, 1);
  setTimeout(pump, 400);
}

// ------------------------------------------------------------ converter ---
// Audio targets: container -> ffmpeg audio codec args
const AUDIO_TARGETS = {
  mp3:  ['-c:a', 'libmp3lame', '-q:a', '0'],
  m4a:  ['-c:a', 'aac', '-b:a', '192k'],
  flac: ['-c:a', 'flac'],
  wav:  ['-c:a', 'pcm_s16le'],
  ogg:  ['-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-c:a', 'libopus', '-b:a', '160k'],
  aac:  ['-c:a', 'aac', '-b:a', '192k'],
};

function ffprobe(args) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(ffprobeCmd.cmd, args, { windowsHide: true });
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  });
}

async function probeMedia(file) {
  const dur = await ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  // Echte Video-Streams zählen, aber NICHT eingebettete Cover (attached_pic) —
  // sonst wird eine MP3 mit Album-Cover fälschlich als Video erkannt.
  let hasRealVideo = false;
  try {
    const raw = await ffprobe(['-v', 'error', '-show_entries', 'stream=codec_type:stream_disposition', '-of', 'json', file]);
    const parsed = JSON.parse(raw);
    hasRealVideo = (parsed.streams || []).some((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  } catch {}
  const duration = parseFloat(dur);
  return {
    duration: isFinite(duration) ? duration : null,
    hasVideo: hasRealVideo,
  };
}

function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';
}

// Tags (Titel/Artist/Album) aus einer Audiodatei lesen — werden beim
// MP3 → MP4-Zweig in die Video-Metadaten übernommen.
async function readTags(file) {
  try {
    const raw = await ffprobe(['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file]);
    const parsed = JSON.parse(raw);
    const t = (parsed.format && parsed.format.tags) || {};
    return { title: t.title || '', artist: t.artist || t.album_artist || '', album: t.album || '' };
  } catch { return { title: '', artist: '', album: '' }; }
}

// Album-Cover aus der MP3 als Bilddatei extrahieren (erster Video-Stream).
function extractCover(srcPath, id) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `smoky-cover-${id}.jpg`);
    const p = spawn(ffmpegCmd.cmd, ['-y', '-i', srcPath, '-an', '-map', '0:v:0', '-c:v', 'copy', out], { windowsHide: true });
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) resolve(out);
      else { try { fs.unlinkSync(out); } catch {} resolve(null); }
    });
    p.on('error', () => resolve(null));
  });
}

// Fallback-Bild (dunkel + Titel-Text), wenn die MP3 kein Cover hat.
function makeFallbackImage(id, title) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `smoky-fallback-${id}.png`);
    const text = String(title || 'Smoky').replace(/[':]/g, '').slice(0, 36) || 'Smoky';
    const vf = `drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${text}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`;
    const p = spawn(ffmpegCmd.cmd, ['-y', '-f', 'lavfi', '-i', 'color=c=0x1b2030:s=1280x1280:r=1', '-frames:v', '1', '-vf', vf, out], { windowsHide: true });
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) resolve(out);
      else {
        // Fallback ohne Text, falls drawtext scheitert
        const p2 = spawn(ffmpegCmd.cmd, ['-y', '-f', 'lavfi', '-i', 'color=c=0x1b2030:s=1280x1280:r=1', '-frames:v', '1', out], { windowsHide: true });
        p2.on('close', () => resolve(fs.existsSync(out) && fs.statSync(out).size > 0 ? out : null));
        p2.on('error', () => resolve(null));
      }
    });
    p.on('error', () => resolve(null));
  });
}

// --------------------------------------------------------------- clips ----
// Ein Clip: yt-dlp lädt nur den Zeitausschnitt ([start,end)) herunter
// (--download-sections), dann schneidet/remuxt ffmpeg das Segment. Optional
// wird das Video auf 9:16 (1080×1920) umgebaut — Crop (ausfüllen) oder
// Blur-Background (ganzes Video sichtbar) — plus optional ein Caption-Text.
function toSeconds(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^\d+([.,]\d+)?$/.test(v)) {
    const n = parseFloat(v.replace(',', '.'));
    return isFinite(n) && n >= 0 ? n : null;
  }
  const m = v.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/);
  if (m) {
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const min = parseInt(m[2], 10);
    const sec = parseFloat(m[3].replace(',', '.'));
    if (min >= 60 || sec >= 60) return null;
    return h * 3600 + min * 60 + sec;
  }
  return null;
}

function fmtTime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function startClipJob(body) {
  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    url: String(body.url || ''),
    title: 'Resolving video…',
    start: toSeconds(body.start),
    end: toSeconds(body.end),
    quality: HEIGHTS[String(body.quality).trim()] ? String(body.quality).trim() : '1080',
    format: FORMATS[body.format] && FORMATS[body.format].kind === 'video' ? body.format : 'mp4',
    vertical: body.vertical === true || body.vertical === 'crop' || body.vertical === 'blur' ? (body.vertical === 'blur' ? 'blur' : 'crop') : false,
    caption: String(body.caption || '').trim().slice(0, 60),
    status: 'preparing',
    percent: 0,
    output: null,
    error: null,
    startedAt: now(),
    finishedAt: null,
  };
  clips.unshift(item);

  (async () => {
    try {
      if (!YTDLP_OK) throw new Error(`yt-dlp is not installed. Run: ${YTDLP_INSTALL_HINT}`);
      if (item.start === null || item.end === null || item.end <= item.start) throw new Error('Invalid time range — set a valid start and end.');
      if (item.end - item.start > 15 * 60) throw new Error('Clips are limited to 15 minutes.');
      if (!FFMPEG_OK) throw new Error('ffmpeg is not installed — the clip cutter needs it.');

      const tmpDir = path.join(os.tmpdir(), 'smoky-clips', item.id);
      fs.mkdirSync(tmpDir, { recursive: true });
      item.status = 'downloading';

      // Nur den Zeitausschnitt herunterladen (bestes verfügbares Video, kein Re-Encode beim Laden)
      const titleFile = path.join(tmpDir, 'title.txt');
      const dlArgs = [
        ...ytdlp.args, '--newline', '--no-warnings', '--no-playlist',
        '--print-to-file', '%(title)s', titleFile,
        '--download-sections', `*${item.start}-${item.end}`,
        '--force-keyframes-at-cuts',
        '-f', 'bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        '-o', path.join(tmpDir, 'src.%(ext)s'),
        '--no-part',
        ...(FFMPEG_DIR ? ['--ffmpeg-location', FFMPEG_DIR] : []),
        item.url,
      ];
      await new Promise((resolve, reject) => {
        const child = spawn(ytdlp.cmd, dlArgs, { windowsHide: true, env: TOOL_ENV });
        child.stdout.on('data', () => {});
        child.stderr.on('data', () => {});
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Could not fetch the video section (yt-dlp exited ' + code + ').'))));
      });
      try {
        const t = fs.readFileSync(titleFile, 'utf8').trim();
        if (t) item.title = t;
      } catch {}

      const srcCandidates = ['src.mp4', 'src.webm', 'src.mkv', 'src.mov'];
      const srcPath = srcCandidates.map((f) => path.join(tmpDir, f)).find((p) => fs.existsSync(p) && fs.statSync(p).size > 0);
      if (!srcPath) throw new Error('The video section could not be found after download.');

      const dur = await ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', srcPath]);
      const duration = parseFloat(dur) || (item.end - item.start);
      item.status = 'cutting';

      const outDir = path.join(settings.folder, 'Clips');
      fs.mkdirSync(outDir, { recursive: true });
      const base = safeName((item.title !== 'Resolving video…' ? item.title : 'clip').replace(/\.[^.]+$/, '')) || 'clip';
      // ffmpeg kann auf Windows keine eckigen Klammern oder Doppelpunkte in
      // Ausgabepfaden — daher Zeitstempel mit Bindestrichen statt m:ss.
      const t1 = `${Math.floor(item.start / 60)}-${String(Math.floor(item.start % 60)).padStart(2, '0')}`;
      const t2 = `${Math.floor(item.end / 60)}-${String(Math.floor(item.end % 60)).padStart(2, '0')}`;
      const outPath = clipOutPath(outDir, base, t1, t2, item.format);

      // Text für den Caption-Overlay (falls gewünscht): als Datei, damit auch
      // Sonderzeichen wie Doppelpunkte sicher durchkommen.
      let captionFile = null;
      if (item.caption) {
        captionFile = path.join(tmpDir, 'caption.txt');
        fs.writeFileSync(captionFile, item.caption.replace(/\r?\n/g, ' '), 'utf8');
      }

      // Die Quelle ist bereits von yt-dlp auf [start,end) zugeschnitten —
      // ffmpeg schneidet also nicht erneut, sondern re-encodiert nur das
      // Segment (Länge = end-start, kein weiteres Seek).
      const trim = ['-t', String(item.end - item.start)];
      let args;
      if (item.vertical) {
        // 9:16 vertikal — Crop oder Blur-Background (ganzes Video sichtbar)
        const target = '1080:1920';
        const overlay = captionFile
          ? `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':textfile='${captionFile.replace(/\\/g, '/').replace(/:/g, '\\:')}':fontsize=52:fontcolor=white:borderw=3:bordercolor=black@0.7:x=(w-text_w)/2:y=h-th-140`
          : null;
        if (item.vertical === 'blur') {
          const parts = [
            '[0:v]split=2[bg][fg]',
            `[bg]scale=${target}:force_original_aspect_ratio=increase,crop=${target},boxblur=30:4[bg2]`,
            `[fg]scale=${target}:force_original_aspect_ratio=decrease[fg2]`,
            '[bg2][fg2]overlay=(W-w)/2:(H-h)/2[base]',
          ];
          if (overlay) parts.push(`[base]${overlay}[out]`);
          else parts.push('[base]null[out]');
          args = ['-y', ...trim, '-i', srcPath, '-filter_complex', parts.join(';'), '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', outPath];
        } else {
          const parts = [`[0:v]scale=${target}:force_original_aspect_ratio=increase,crop=${target}[v]`];
          if (overlay) parts.push(`[v]${overlay}[out]`);
          else parts.push('[v]null[out]');
          args = ['-y', ...trim, '-i', srcPath, '-filter_complex', parts.join(';'), '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', outPath];
        }
      } else {
        // Querformat: höchstens die gewählte Qualität, Audio sauber auf AAC
        const scaleH = `scale=-2:${item.quality}:force_original_aspect_ratio=decrease`;
        const vf = captionFile
          ? `${scaleH},drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':textfile='${captionFile.replace(/\\/g, '/').replace(/:/g, '\\:')}':fontsize=42:fontcolor=white:borderw=3:bordercolor=black@0.7:x=(w-text_w)/2:y=h-th-80`
          : scaleH;
        args = ['-y', ...trim, '-i', srcPath, '-vf', vf, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', outPath];
      }

      await new Promise((resolve, reject) => {
        const child = spawn(ffmpegCmd.cmd, ['-nostdin', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true, env: TOOL_ENV });
        let errTail = '';
        child.stdout.on('data', (d) => {
          const text = d.toString();
          const m = text.match(/out_time_ms=(\d+)/);
          if (m) {
            const t = parseInt(m[1], 10) / 1e6;
            item.percent = duration ? Math.min(100, Math.round((t / duration) * 100)) : 0;
          }
        });
        child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-600); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error((errTail.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')) || `ffmpeg exited with code ${code}`));
        });
      });

      item.status = 'finished';
      item.percent = 100;
      item.output = outPath;
      invalidateLibraryCache();
      // Temp-Dateien aufräumen (SMOKY_KEEP_TMP=1 behält sie fürs Debuggen)
      if (!process.env.SMOKY_KEEP_TMP) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
    } catch (err) {
      item.status = 'failed';
      item.error = String(err.message || err);
      try { fs.rmSync(path.join(os.tmpdir(), 'smoky-clips', item.id), { recursive: true, force: true }); } catch {}
    } finally {
      item.finishedAt = now();
    }
  })();

  return item;
}

function convertFile(id, srcPath, origName, format) {
  const item = {
    id,
    name: safeName(origName),
    format,
    status: 'preparing',
    percent: 0,
    output: null,
    error: null,
    startedAt: now(),
    finishedAt: null,
  };
  conversions.unshift(item);

  // only delete sources that were uploaded as temp files — never the user's originals
  const inDir = path.join(DATA_DIR, 'convert-in');
  let artPath = null;
  const cleanupSource = () => {
    try {
      if (path.normalize(srcPath).startsWith(inDir)) fs.unlinkSync(srcPath);
      if (artPath) fs.unlinkSync(artPath);
    } catch {}
  };

  (async () => {
    try {
      const { duration, hasVideo } = await probeMedia(srcPath);
      item.duration = duration;
      item.status = 'converting';

      const base = safeName(origName.replace(/\.[^.]+$/, ''));
      const outDir = path.join(settings.folder, 'Converted');
      fs.mkdirSync(outDir, { recursive: true });
      let outPath = path.join(outDir, `${base}.${format}`);
      for (let i = 2; fs.existsSync(outPath); i++) outPath = path.join(outDir, `${base} (${i}).${format}`);

      let args;
      if (format === 'mp4' && hasVideo) {
        args = ['-y', '-i', srcPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath];
      } else if (format === 'mp4') {
        // Audio → MP4 mit Cover als Video-Track: Das Album-Cover (oder ein
        // generiertes Bild) wird zum Video, Tags bleiben in den Metadaten.
        const [cover, tags] = await Promise.all([extractCover(srcPath, id), readTags(srcPath)]);
        artPath = cover || await makeFallbackImage(id, tags.title);
        args = ['-y', '-i', srcPath];
        if (artPath) {
          args.push('-loop', '1', '-i', artPath, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-b:a', '192k', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease,pad=1280:1280:(ow-iw)/2:(oh-ih)/2:color=black', '-shortest');
        } else {
          args.push('-vn', '-c:a', 'aac', '-b:a', '192k');
        }
        for (const [k, v] of Object.entries(tags)) if (v) args.push('-metadata', `${k}=${v}`);
        args.push('-movflags', '+faststart', outPath);
      } else {
        args = ['-y', '-i', srcPath, '-vn', ...(AUDIO_TARGETS[format] || AUDIO_TARGETS.mp3), outPath];
      }

      const child = spawn(ffmpegCmd.cmd, ['-nostdin', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
      let errTail = '';
      child.stdout.on('data', (d) => {
        const text = d.toString();
        const m = text.match(/out_time_ms=(\d+)/);
        if (m) {
          const t = parseInt(m[1], 10) / 1e6;
          item.percent = duration ? Math.min(100, Math.round((t / duration) * 100)) : 0;
        }
        if (/progress=end/.test(text)) item.status = 'finalizing';
      });
      child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-500); });
      child.on('close', (code) => {
        item.finishedAt = now();
        if (code === 0) {
          item.status = 'finished';
          item.percent = 100;
          item.output = outPath;
          invalidateLibraryCache();
        } else {
          item.status = 'failed';
          item.error = (errTail.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')) || `ffmpeg exited with code ${code}`;
        }
        cleanupSource();
      });
      child.on('error', (err) => {
        item.status = 'failed';
        item.error = String(err.message || err);
        item.finishedAt = now();
        cleanupSource();
      });
    } catch (err) {
      item.status = 'failed';
      item.error = String(err.message || err);
      item.finishedAt = now();
      cleanupSource();
    }
  })();

  return item;
}

// --------------------------------------------------------- Empfehlungen ----
// Variante A: Der „Empfehlungen“-Tab generiert Vorschläge aus der eigenen
// Download-History — ganz ohne API-Key. yt-dlp (gebündelt) liefert pro Seed
// die Top-Treffer (ytsearch + --flat-playlist = schnell, lädt nichts herunter),
// die Thumbnails kommen direkt von i.ytimg.com. Ergebnisse werden 30 Minuten
// gecacht, damit der Tab nicht bei jedem Öffnen Netzwerk-Anfragen feuert.
const REC_SEEDS_MAX = 6;            // Seeds gesamt (History + Bibliothek)
const REC_HISTORY_SEEDS_MAX = 4;    // davon maximal aus der History
const REC_LIBRARY_SEEDS_MAX = 2;    // davon maximal aus der Bibliothek
const REC_PER_SEED = 6;             // Treffer pro Seed
const REC_RESULTS_MAX = 18;         // Gesamtzahl nach Dedupe
const REC_SIMILAR_MAX = 12;         // Treffer bei „Ähnliche Videos“
const REC_CACHE_MS = 30 * 60 * 1000;

// Seeds aus der Download-History (zuletzt zuerst, dedupliziert, > 2 Zeichen).
// Wichtig: displayTitle() entfernt den [videoId]-Suffix — bliebe er im Query,
// liefert yt-dlp oft nur exakt das Originalvideo zurück, das dann als „schon
// geladen“ gefiltert würde (→ leere Empfehlungen).
function recommendationSeeds() {
  const seen = new Set();
  const out = [];
  for (const h of history) {
    if (!h || !h.title) continue;
    const q = displayTitle(String(h.title)).replace(/\s+/g, ' ').trim();
    if (q.length < 3 || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push(q);
    if (out.length >= REC_HISTORY_SEEDS_MAX) break;
  }
  return out;
}

// Einen Suchlauf ausführen → Treffer-Liste (Titel/Channel/URL/ID/Thumb/Dauer).
// `fetcher` ist ein Test-Hook (Unit-Tests stuben den Netzwerk-Teil).
async function recSearch(query, fetcher) {
  if (fetcher) return fetcher(query);
  if (!YTDLP_OK) throw new Error('yt-dlp is not installed');
  const json = await runCmdOut(ytdlp.cmd, [...ytdlp.args, '--flat-playlist', '--no-warnings', '-J', `ytsearch${REC_PER_SEED}:${query}`], 30000);
  const parsed = JSON.parse(json);
  const entries = (parsed && parsed.entries) || [];
  return entries.map((e) => {
    const id = e.id;
    let thumb = '';
    try { const t = (e.thumbnails || []).find((x) => x && x.url); if (t) thumb = t.url; } catch {}
    if (id && /^[A-Za-z0-9_-]{6,}$/.test(id) && !thumb) thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    return {
      title: e.title || '',
      channel: e.channel || e.uploader || '',
      url: e.url || (id ? `https://www.youtube.com/watch?v=${id}` : ''),
      id: id || '',
      duration: e.duration ? parseFloat(e.duration) : 0,
      thumb,
    };
  }).filter((t) => /^https?:\/\//i.test(t.url) && !/\/playlist\?/i.test(t.url));
}

// Bereits bekannte Einträge (History) — IDs und Titel, case-insensitiv.
function knownFromHistory() {
  const known = new Set();
  for (const h of history) {
    if (!h) continue;
    const m = h.url && String(h.url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,})/);
    if (m) known.add(m[1]);
    if (h.title) known.add('t:' + String(h.title).toLowerCase().trim());
  }
  return known;
}

// Seeds aus der Bibliothek: echte Tags (Künstler + Titel) — ergänzt die
// History-Seeds um die komplette Sammlung (artist - title = bessere Treffer).
async function librarySeeds() {
  const out = [];
  try {
    const tracks = await scanLibrary();
    for (const t of tracks) {
      if (!t) continue;
      const q = [t.artist, t.title].filter(Boolean).join(' - ').replace(/\s+/g, ' ').trim();
      if (q.length >= 3) out.push(q);
      if (out.length >= REC_LIBRARY_SEEDS_MAX) break;
    }
  } catch {}
  return out;
}

// Zwei Seed-Listen zu einer deduplizierten Liste der max. Länge zusammenführen
// (Reihenfolge: primär zuerst). Rein — gut unit-testbar.
function mergeSeedLists(primary, secondary, max) {
  const seen = new Set();
  const out = [];
  for (const q of [...(primary || []), ...(secondary || [])]) {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (s.length < 3 || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= (max || REC_SEEDS_MAX)) break;
  }
  return out;
}

// Empfehlungen aus den Seeds bauen — parallel (max. 4 gleichzeitig), dedupliziert
// nach Video-ID, bereits bekannte Einträge (History) werden herausgefiltert.
// Ein fehlschlagender Seed (Netzwerk/yt-dlp) überspringt nur diesen Seed.
async function buildRecommendations(seeds, fetcher) {
  const known = knownFromHistory();
  const results = await Promise.all(seeds.slice(0, REC_SEEDS_MAX).map(async (seed) => {
    try { return { seed, hits: await recSearch(seed, fetcher) }; }
    catch { return { seed, hits: [] }; }
  }));
  const items = [];
  const seen = new Set();
  for (const { seed, hits } of results) {
    for (const hit of hits) {
      const key = hit.id || hit.url;
      const titleKey = 't:' + String(hit.title).toLowerCase().trim();
      if (seen.has(key) || known.has(hit.id) || known.has(titleKey)) continue;
      seen.add(key);
      items.push({ ...hit, seed });
      if (items.length >= REC_RESULTS_MAX) break;
    }
    if (items.length >= REC_RESULTS_MAX) break;
  }
  return items;
}

// „Ähnliche Videos“ zu einem Titel (aus einer Empfehlungs-Karte): ein Suchlauf
// auf den Titel, ohne die Video-ID selbst und ohne bereits bekannte Einträge.
async function buildSimilar(title, excludeId, fetcher) {
  const q = String(title || '').replace(/\s+/g, ' ').trim();
  if (q.length < 3) return [];
  const known = knownFromHistory();
  let hits = [];
  try { hits = await recSearch(q, fetcher); } catch { return []; }
  const items = [];
  const seen = new Set();
  for (const hit of hits) {
    const key = hit.id || hit.url;
    const titleKey = 't:' + String(hit.title).toLowerCase().trim();
    if (hit.id === excludeId || seen.has(key) || known.has(hit.id) || known.has(titleKey)) continue;
    seen.add(key);
    items.push({ ...hit, similarOf: q });
    if (items.length >= REC_SIMILAR_MAX) break;
  }
  return items;
}

// Server-seitiger Cache (30 min): der Tab fragt nicht bei jedem Öffnen Netzwerk
// an; ?refresh=1 erzwingt einen neuen Lauf. Fehler werden als leere Liste mit
// Meldung geliefert — der Tab bleibt bedienbar, statt zu crashen.
let recCache = { at: 0, payload: null };
async function recommendationsPayload(force) {
  if (!force && recCache.payload && Date.now() - recCache.at < REC_CACHE_MS) return recCache.payload;
  const hist = recommendationSeeds();
  const lib = await librarySeeds();
  const seeds = mergeSeedLists(hist, lib, REC_SEEDS_MAX);
  if (!seeds.length) return { items: [], reason: 'no-history' };
  try {
    const items = await buildRecommendations(seeds);
    recCache = { at: Date.now(), payload: { items, seeds: seeds.length, fromHistory: hist.length, fromLibrary: lib.length, generatedAt: Date.now() } };
    return recCache.payload;
  } catch (e) {
    return { items: [], reason: 'error', message: String(e && e.message || e).slice(0, 200) };
  }
}

// Eigenes Cover beim Tag-Editor: base64-Bild → temporäre Datei → mit ffmpeg in
// die Audiodatei einbetten. Nur Container mit Cover-Slot unterstützen das —
// verifiziert per ffmpeg: MP3 (ID3-APIC), M4A und FLAC (attached_pic) gehen,
// OGG/OPUS schlagen im Copy-Pfad fehl und sind bewusst NICHT dabei.
const COVER_SLOT_EXTS = new Set(['.mp3', '.m4a', '.flac']);
const COVER_MAX_BYTES = 8 * 1024 * 1024;

function writeCoverTemp(cover) {
  try {
    let b64 = String(cover || '');
    const m = b64.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
    if (m) b64 = m[1];
    b64 = b64.replace(/\s+/g, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.length > COVER_MAX_BYTES) return null;
    const tmpDir = path.join(DATA_DIR, 'cover-in');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `cover-${crypto.randomBytes(4).toString('hex')}.img`);
    fs.writeFileSync(tmp, buf);
    if (!isValidImage(tmp)) { try { fs.unlinkSync(tmp); } catch {} return null; }
    return tmp;
  } catch { return null; }
}

// Square-Cover-Cache der Datei verwerfen → /api/cover regeneriert aus dem
// neuen eingebetteten Bild (statt des alten Caches oder Schwester-Thumbnails).
function invalidateCoverCache(file) {
  const hash = crypto.createHash('md5').update(file).digest('hex');
  for (const f of [hash + '.sq.jpg', hash + '.sq.png', hash + '.jpg', hash + '.png', hash + '.done']) {
    try { const p = path.join(coverDir, f); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

// ------------------------------------------------------------- HTTP app ----
function sendJson(res, code, obj) {
  // Defensiv: Der Request kann schon zerstört sein (z. B. „body too large"),
  // dann darf hier nichts mehr werfen — ein Fehler in diesem Pfad würde die
  // Exception aus dem Handler-Catch entkommen lassen und den Server crashen.
  try {
    // 204 hat keinen Body — JSON.stringify(undefined) wäre undefined und
    // Buffer.byteLength würde werfen; die Response müsste dann nie gesendet
    // werden und der Client (z. B. ein <img> mit Cover-URL) hinge ewig.
    if (code === 204 || obj === undefined) {
      res.writeHead(204, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end();
      return;
    }
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  } catch {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveFile(req, res, full, mime, extraHeaders = {}) {
  const stat = fs.statSync(full);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start)) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': mime, 'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${stat.size}`, ...extraHeaders,
    });
    pipeFile(res, full, { start, end });
  } else {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', ...extraHeaders });
    pipeFile(res, full);
  }
}

// Streamt eine Datei zum Response und schluckt Fehler (Datei wurde zwischen
// stat und read gelöscht/gesperrt) — ohne Error-Handler würde ein unhandled
// 'error' auf dem Stream den kompletten Server-Prozess crashen.
function pipeFile(res, full, opts) {
  const stream = fs.createReadStream(full, opts || {});
  stream.on('error', () => { try { res.destroy(); } catch {} });
  res.on('close', () => { try { stream.destroy(); } catch {} });
  stream.pipe(res);
}

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  try { file = decodeURIComponent(file); } catch {}
  const full = path.normalize(path.join(PUBLIC, file));
  // Echter Pfad-Check statt startsWith: startsWith(PUBLIC) ließe Sibling-Ordner
  // mit gleichem Präfix durch (z. B. „public2“). relative() kann nie "aus-
  // brechen", ohne mit .. zu beginnen oder absolut zu werden.
  const rel = path.relative(PUBLIC, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { sendJson(res, 403, { error: 'forbidden' }); return; }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) { sendJson(res, 404, { error: 'not found' }); return; }
    try { serveFile(req, res, full, MIME[path.extname(full)] || 'application/octet-stream'); }
    catch { sendJson(res, 404, { error: 'not found' }); }
  });
}

// ---------------------------------------------------------- media API ----
function isInsideFolder(file, folder) {
  const f = path.resolve(file);
  const base = path.resolve(folder);
  return f === base || f.startsWith(base + path.sep);
}

// -------------------------------------------------------- phone share ----
// Muster für virtuelle/VPN-Adapter, deren IP vom Handy aus NICHT erreichbar
// ist (NordVPN/NordLynx, WireGuard, ZeroTier, Tailscale, Hamachi, Docker,
// Hyper-V, VirtualBox, WSL …). Ohne diesen Filter würde z. B. die erste
// NordLynx-IP (100.66.x) statt der echten WLAN-IP in den QR-Code geraten und
// das Handy liefe ins Leere („Seite lädt nicht“).
const VIRTUAL_IF_RE = /virtual|vbox|vmware|hyper-?v|vethernet|loopback|tunnel|\btap\b|\btun\b|vpn|nord|lynx|wireguard|zerotier|tailscale|hamachi|radmin|proton|wsl|docker|utun|llw/i;

// CGNAT-Tunnelbereich (100.64.0.0/10): fast immer ein VPN-/Carrier-Tunnel,
// nie die Adresse, unter der ein Handy im selben WLAN den PC erreicht.
function isCgnatIPv4(ip) {
  const p = String(ip || '').split('.').map(Number);
  return p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

// RFC-1918-Heimnetz-Bereiche: 10.x, 172.16–31.x, 192.168.x.
function isPrivateIPv4(ip) {
  const p = String(ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

// Alle nicht-internen IPv4-Adressen inkl. Adaptername. `interfaces` ist nur
// für Tests injizierbar (Standard: echte os.networkInterfaces()).
function lanIPv4Candidates(interfaces) {
  const ifs = interfaces || os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni && ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

function rankIPv4(ip) {
  const p = String(ip || '').split('.').map(Number);
  if (p[0] === 192 && p[1] === 168) return 0;   // häufigstes Heim-WLAN
  if (p[0] === 10) return 1;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return 2;
  return 3;
}

// Beste IPv4 für den QR-/Link-URL: VPN-/virtuelle Adapter und CGNAT-Tunnel
// werden übersprungen, private Heimnetz-IPs (192.168.x zuerst) bevorzugt.
function lanIPv4(interfaces) {
  const all = lanIPv4Candidates(interfaces);
  const real = all.filter((c) => !VIRTUAL_IF_RE.test(c.name) && !isCgnatIPv4(c.address));
  const pool = real.length ? real : all;
  const ranked = pool.slice().sort((a, b) => rankIPv4(a.address) - rankIPv4(b.address));
  return ranked.length ? ranked[0].address : null;
}

function pruneShareTokens() {
  const nowMs = Date.now();
  for (const [t, s] of shareTokens) if (s.expiresAt <= nowMs) shareTokens.delete(t);
}

// Legt einen kurzlebigen Token für eine Datei im Download-Ordner an.
// Rückgabe: { token, filename, url, expiresAt } oder { error }.
function createShareToken(filePath) {
  const full = path.resolve(String(filePath || ''));
  if (!full || !isInsideFolder(full, settings.folder) || !fs.existsSync(full)) {
    return { error: 'Datei nicht gefunden oder liegt außerhalb des Download-Ordners.' };
  }
  let st;
  try { st = fs.statSync(full); } catch { return { error: 'Kein Datei-Zugriff möglich.' }; }
  if (!st.isFile()) return { error: 'Kein Datei-Zugriff möglich.' };
  pruneShareTokens();
  const token = crypto.randomBytes(8).toString('hex');
  const filename = path.basename(full);
  shareTokens.set(token, { path: full, filename, expiresAt: Date.now() + SHARE_TTL_MS });
  const ip = lanIPv4();
  if (!ip) return { error: 'Keine LAN-IP gefunden — PC und Handy müssen im selben WLAN sein.' };
  const port = sharePort || SHARE_PORT;
  return { token, filename, url: `http://${ip}:${port}/share/${token}`, expiresAt: Date.now() + SHARE_TTL_MS };
}

function revokeShareToken(token) {
  const existed = shareTokens.delete(String(token || ''));
  return existed;
}

function shareLandingPage(share, token) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const name = esc(share.filename);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Smoky — Senden</title>`
    + `<body style="margin:0;background:#0e111a;color:#e8eaf2;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">`
    + `<div style="text-align:center;padding:32px;max-width:440px">`
    + `<h2 style="margin:0 0 8px">🚬 Smoky</h2>`
    + `<p style="margin:0 0 24px;opacity:.85">Eine Datei von deinem PC — direkt aufs Handy.</p>`
    + `<p style="margin:0 0 20px;font-weight:600;word-break:break-all">${name}</p>`
    + `<a href="/share/${encodeURIComponent(token)}/dl" style="display:inline-block;padding:14px 30px;background:#6558e8;color:#fff;text-decoration:none;border-radius:10px;font-weight:600">Herunterladen</a>`
    + `<p style="margin:20px 0 0;opacity:.5;font-size:12px">Dieser Link läuft nach 10 Minuten ab.</p>`
    + `</div></body>`;
}

// Startet den LAN-Server (0.0.0.0). Falls SHARE_PORT belegt ist, wird auf
// einen freien Port ausgewichen; scheitert auch das, läuft Smoky ohne Share
// weiter (resolve(null)) statt den Start zu blockieren. Idempotent: parallele
// Aufrufe teilen sich dasselbe Promise, damit nie zwei Server um den Port
// konkurrieren und ein verspäteter Fehler den anderen Server zurücksetzt.
let shareServerPromise = null;
function startShareServer() {
  if (shareServer) return Promise.resolve(sharePort);
  if (shareServerPromise) return shareServerPromise;
  shareServerPromise = new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, `http://${req.headers.host}`);
        const m = /^\/share\/([0-9a-f]+)(?:\/(dl))?$/.exec(u.pathname);
        const token = m ? m[1] : null;
        const isDl = m ? m[2] === 'dl' : false;
        const share = token ? shareTokens.get(token) : null;
        if (!share || share.expiresAt <= Date.now()) {
          sendJson(res, 404, { error: 'Link abgelaufen oder ungültig.' });
          return;
        }
        if (!fs.existsSync(share.path)) { sendJson(res, 404, { error: 'Datei nicht mehr vorhanden.' }); return; }
        if (isDl) {
          const mime = MIME[path.extname(share.path).toLowerCase()] || 'application/octet-stream';
          const safeName = String(share.filename || 'file').replace(/["\\\r\n]/g, '_');
          serveFile(req, res, share.path, mime, { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}` });
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(shareLandingPage(share, token));
        }
      } catch { try { sendJson(res, 500, { error: 'Server-Fehler' }); } catch {} }
    });
    let done = false;
    const finish = (port) => {
      if (done) return;
      done = true;
      shareServerPromise = null;
      resolve(port);
    };
    const onError = (err) => {
      if (done) return;
      if (err && err.code === 'EADDRINUSE' && !srv.__fallback) {
        srv.__fallback = true;
        // Port belegt → auf einen freien Port ausweichen (0 = zufällig).
        srv.listen(0, '0.0.0.0', () => {
          sharePort = srv.address().port;
          shareServer = srv;
          try { srv.unref(); } catch {}
          finish(sharePort);
        });
      } else {
        finish(null);
      }
    };
    srv.on('error', onError);
    srv.listen(SHARE_PORT, '0.0.0.0', () => {
      sharePort = srv.address().port;
      shareServer = srv;
      // Der LAN-Server darf den Prozess nicht am Beenden hindern (Tests, die
      // nur den Haupt-Server schließen). In Electron hält die App den Loop
      // selbst am Leben, in `node server.js` der Haupt-Server.
      try { srv.unref(); } catch {}
      finish(sharePort);
    });
  });
  return shareServerPromise;
}

function probeTags(file) {
  return new Promise((resolve) => {
    if (!ffprobeCmd) return resolve({});
    const p = spawn(ffprobeCmd.cmd, ['-v', 'error', '-show_entries', 'format=duration:format_tags', '-of', 'json', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve({}));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        const t = j.format.tags || {};
        resolve({ title: t.title, artist: t.artist, album: t.album, duration: j.format.duration ? parseFloat(j.format.duration) : 0 });
      } catch { resolve({}); }
    });
  });
}

// Library-Scan cachen (10 s): Der Scan läuft mit ffprobe pro Datei — bei
// großen Bibliotheken (viele Videos) würde jeder /api/library-Aufruf Sekunden
// dauern. Downloads/Conversions invalidieren den Cache explizit.
let libraryCache = null;
let libraryCacheAt = 0;
const LIBRARY_CACHE_MS = 10000;
function invalidateLibraryCache() { libraryCache = null; libraryCacheAt = 0; }

async function scanLibrary() {
  const cached = libraryCache;
  if (cached && Date.now() - libraryCacheAt < LIBRARY_CACHE_MS) return cached;
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (AUDIO_EXTS.has(path.extname(e.name).toLowerCase()) || VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) files.push(p);
    }
  };
  await walk(settings.folder, 0);
  files.sort();
  const tracks = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const isVideo = VIDEO_EXTS.has(ext);
    const tags = await probeTags(f);
    let size = 0;
    try { size = fs.statSync(f).size; } catch {}
    tracks.push({
      path: f,
      kind: isVideo ? 'video' : 'audio',
      title: tags.title || path.basename(f, path.extname(f)),
      artist: tags.artist || '',
      album: tags.album || '',
      duration: tags.duration || 0,
      size,
    });
  }
  libraryCache = tracks;
  libraryCacheAt = Date.now();
  return tracks;
}

const coverDir = path.join(DATA_DIR, 'covers');
// Einmalige Migration: vor 1.8.3 wurde das .done-Flag auch bei fehlgeschlagenem
// Backfill geschrieben und blockierte die Cover-Nachrüstung dauerhaft. Neue
// Flags entstehen nur noch bei Erfolg — alte werden hier entfernt.
try {
  if (fs.existsSync(coverDir)) {
    for (const f of fs.readdirSync(coverDir)) {
      if (f.endsWith('.done')) { try { fs.unlinkSync(path.join(coverDir, f)); } catch {} }
      // Legacy-Cover-Caches aus der Zeit vor dem Quadrat-Fix (16:9) — sie
      // regenerieren sich lazy und quadratisch beim nächsten Request.
      else if (!f.includes('.sq.') && /\.(jpe?g|png|webp|bmp)$/i.test(f)) { try { fs.unlinkSync(path.join(coverDir, f)); } catch {} }
    }
  }
} catch {}
const SIBLING_IMG_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
// Sucht ein Bild mit gleichem Basisnamen neben der Audiodatei (yt-dlp
// --write-thumbnail legt z. B. "Titel [id].webp" neben "Titel [id].wav").
function siblingCover(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const stem = base.slice(0, base.length - path.extname(base).length).toLowerCase();
  try {
    for (const f of fs.readdirSync(dir)) {
      const l = f.toLowerCase();
      if (!SIBLING_IMG_EXTS.some((e) => l.endsWith(e))) continue;
      const fStem = f.slice(0, f.length - path.extname(f).length).toLowerCase();
      if (fStem === stem || fStem.startsWith(stem)) return path.join(dir, f);
    }
  } catch {}
  return null;
}

// Echte Bilddatei? (JPEG/PNG/WebP) — verhindert, dass kaputte Cache-Einträge
// (0 Bytes, abgeschnitten) dauerhaft als Cover ausgeliefert werden.
function isValidImage(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 12) return false;
    const b = fs.readFileSync(p).subarray(0, 4);
    return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||                    // JPEG
           (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||  // PNG
           (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46);    // WebP (RIFF)
  } catch { return false; }
}

// Cover-Extraktion mit begrenzter Parallelität: Die Player-Liste feuert für
// jeden Track ein <img> → ohne Limit würden beim ersten Öffnen Dutzende
// ffmpeg-Prozesse gleichzeitig starten. Max. COVER_CONCURRENCY gleichzeitig,
// der Rest wartet kurz in der Schlange.
const COVER_CONCURRENCY = 3;
let coverActive = 0;
const coverWaiters = [];
async function withCoverSlot(fn) {
  if (coverActive >= COVER_CONCURRENCY) await new Promise((resolve) => coverWaiters.push(resolve));
  coverActive++;
  try { return await fn(); } finally {
    coverActive--;
    const next = coverWaiters.shift();
    if (next) next();
  }
}

// ffmpeg-Frame-Extraktion mit Timeout — ein hängender Prozess darf einen
// Cover-Request nie endlos blockieren. Das Ergebnis wird immer quadratisch
// zentriert: YouTube-Thumbnails sind 16:9, Player/Bibliothek zeigen aber
// Quadrate (Spotify-Optik) — ein quadratischer Crop in der Quelle verhindert
// Letterboxing und das „♪"-Fallback im Player.
function extractCoverFrame(file, out, codec) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegCmd.cmd, ['-y', '-i', file, '-an', '-c:v', codec, '-vf', 'crop=min(iw\\,ih):min(iw\\,ih)', '-frames:v', '1', out], { windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 15000);
    p.on('error', () => { clearTimeout(timer); resolve(); });
    p.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

// Video-Thumbnail: einen Frame kurz nach Start ziehen (1 s — vermeidet den
// oft schwarzen allerersten Frame) und quadratisch croppen wie Covers.
function videoFrame(file, out) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegCmd.cmd, ['-y', '-ss', '1', '-i', file, '-an', '-c:v', 'mjpeg', '-q:v', '4', '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=320:320', '-frames:v', '1', out], { windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 15000);
    p.on('error', () => { clearTimeout(timer); resolve(); });
    p.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

// Beliebige Bilddatei quadratisch zentriert zuschneiden (z. B. das 16:9-WebP,
// das yt-dlp als Schwester-Datei neben WAV/AAC schreibt).
function squareCrop(src, out) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegCmd.cmd, ['-y', '-i', src, '-vf', 'crop=min(iw\\,ih):min(iw\\,ih)', '-c:v', 'mjpeg', '-q:v', '4', '-frames:v', '1', out], { windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 15000);
    p.on('error', () => { clearTimeout(timer); resolve(); });
    p.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

// Bestehende Downloads nachrüsten: Video-ID aus dem Dateinamen ([id]) holen
// und das YouTube-Thumbnail einmalig neben die Datei schreiben. Seriell, damit
// nicht 14 yt-dlp-Prozesse gleichzeitig auf YouTube hämmern.
let coverBackfillChain = Promise.resolve();
async function backfillCover(file) {
  if (!YTDLP_OK) return null;
  const m = path.basename(file).match(/\[([A-Za-z0-9_-]{6,})\]\.[^.]+$/);
  if (!m) return null;
  const id = m[1];
  const hash = crypto.createHash('md5').update('thumb:' + file).digest('hex');
  const doneFlag = path.join(coverDir, hash + '.done');
  if (fs.existsSync(doneFlag)) return siblingCover(file);
  try { fs.mkdirSync(coverDir, { recursive: true }); } catch { return null; }
  const dir = path.dirname(file);
  const run = () => new Promise((resolve) => {
    const p = spawn(ytdlp.cmd, [...ytdlp.args, '--skip-download', '--write-thumbnail', '--no-warnings', '-o', path.join(dir, '%(title)s [%(id)s].%(ext)s'), `https://www.youtube.com/watch?v=${id}`], { windowsHide: true, env: TOOL_ENV });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 30000);
    p.on('error', () => { clearTimeout(timer); resolve(); });
    p.on('close', () => { clearTimeout(timer); resolve(); });
  });
  coverBackfillChain = coverBackfillChain.then(run, run);
  await coverBackfillChain;
  // doneFlag nur bei Erfolg setzen — sonst bliebe der Track nach einem einzigen
  // fehlgeschlagenen Versuch (z. B. Netz-Aussetzer) dauerhaft ohne Cover.
  const found = siblingCover(file);
  if (found) { try { fs.writeFileSync(doneFlag, '1'); } catch {} }
  return found;
}

async function coverFor(file) {
  if (!ffmpegCmd) return null;
  const hash = crypto.createHash('md5').update(file).digest('hex');
  // Quadrat-Cache: seit dem 16:9-Fix (v1.8.8) heißen Caches .sq.* — alte
  // 16:9-Caches (ohne Marker) werden beim Regenerieren entfernt.
  const outJpg = path.join(coverDir, hash + '.sq.jpg');
  const outPng = path.join(coverDir, hash + '.sq.png');
  // Cache-Treffer nur, wenn wirklich ein gültiges Bild vorliegt.
  if (isValidImage(outJpg)) return outJpg;
  if (isValidImage(outPng)) return outPng;
  try { fs.mkdirSync(coverDir, { recursive: true }); } catch { return null; }
  // Kaputte ODER veraltete (16:9) Cache-Einträge entfernen, damit sie nie
  // wieder als Cover dienen.
  for (const stale of [outJpg, outPng, path.join(coverDir, hash + '.jpg'), path.join(coverDir, hash + '.png')]) {
    try { if (fs.existsSync(stale)) fs.unlinkSync(stale); } catch {}
  }
  const isVideo = VIDEO_EXTS.has(path.extname(file).toLowerCase());
  if (isVideo) {
    // Video-Dateien haben kein eingebettetes Cover — stattdessen einen Frame
    // aus dem Video als Thumbnail ziehen (16:9-Quadrat-Crop wie bei Covers).
    await withCoverSlot(() => videoFrame(file, outJpg));
    if (isValidImage(outJpg)) return outJpg;
    await withCoverSlot(() => extractCoverFrame(file, outPng, 'png'));
    if (isValidImage(outPng)) return outPng;
    return null;
  }
  await withCoverSlot(() => extractCoverFrame(file, outJpg, 'mjpeg'));
  if (isValidImage(outJpg)) return outJpg;
  // Zweiter Versuch als PNG — verträgt Alpha- und WebP-Quellen zuverlässig.
  await withCoverSlot(() => extractCoverFrame(file, outPng, 'png'));
  if (isValidImage(outPng)) return outPng;
  // Kein eingebettetes Cover (z. B. WAV/AAC) → Schwester-Bild neben der Datei?
  let sibling = siblingCover(file);
  if (!sibling) sibling = await backfillCover(file);
  if (sibling) {
    // Auch das Schwester-Bild (yt-dlp-Thumbnail, 16:9) quadratisch croppen,
    // damit Player/Bibliothek überall Spotify-Optik zeigen.
    await withCoverSlot(() => squareCrop(sibling, outJpg));
    if (isValidImage(outJpg)) return outJpg;
    return sibling;
  }
  return null;
}

// Ordner-Größe wird max. alle 10 s neu berechnet — /api/status wird von
// Elektron (1 s) und der UI (1,2 s) gepollt; ein Walk über eine große
// Bibliothek bei jedem Poll würde Status-Updates unnötig verzögern.
let storageBytes = 0;
let storageAt = 0;
async function computeStorage() {
  const t = Date.now();
  if (t - storageAt > 10000) {
    storageAt = t;
    storageBytes = await dirSize(settings.folder);
  }
  return storageBytes;
}

async function statusPayload() {
  let storage = { folder: settings.folder, bytes: 0, percent: 0, ready: true };
  try { storage.bytes = await computeStorage(); } catch {}
  storage.percent = Math.min(100, Math.round((storage.bytes / VAULT_QUOTA) * 100));
  if (storage.bytes === 0) storage.percent = 0;
  return {
    version: APP_VERSION,
    queue: queue.map(({ child, _retrying, _finished, ...q }) => q),
    history,
    conversions: conversions.map((c) => c),
    clips: clips.map((c) => c),
    settings: publicSettings(),
    storage,
    player: playerState,
    tools: { ytdlp: YTDLP_OK, spotdl: SPOTDL_OK, ffmpeg: FFMPEG_OK, ffprobe: FFPROBE_OK, versions: toolVersions },
  };
}

// ------------------------------------------------------ Discord -------
// Optionaler Discord-Login (OAuth2 Authorization Code Grant) + Profil-Anzeige
// und Rich Presence. Benötigt eine Discord-App (discord.com/developers):
// Client-ID + Client-Secret, Redirect-URI:
//   http://127.0.0.1:<PORT>/api/discord/callback   (Scope: identify)

// Settings OHNE Geheimnisse — Secret + Token verlassen nie den Server.
function publicSettings() {
  const { discordClientSecret, discordToken, ...pub } = settings;
  return pub;
}

function discordRedirectUri() {
  return `http://127.0.0.1:${serverPort}/api/discord/callback`;
}

function discordAvatarUrl(profile) {
  if (!profile || !profile.id || !profile.avatar) return null;
  const ext = String(profile.avatar).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${ext}?size=128`;
}

function discordPublicStatus() {
  const id = String(settings.discordClientId || '').trim();
  return {
    rpcConfigured: /^\d+$/.test(id),
    rpcEnabled: !!settings.discordRpc,
    loginConfigured: !!(id && String(settings.discordClientSecret || '').trim()),
    redirectUri: discordRedirectUri(),
    connected: !!(settings.discordProfile && settings.discordProfile.id),
    profile: settings.discordProfile
      ? {
          id: settings.discordProfile.id,
          username: settings.discordProfile.username,
          avatarUrl: discordAvatarUrl(settings.discordProfile),
        }
      : null,
  };
}

let pendingDiscordState = null;

function discordAuthorizeUrl() {
  const state = crypto.randomBytes(12).toString('hex');
  pendingDiscordState = state;
  const q = new URLSearchParams({
    client_id: settings.discordClientId,
    redirect_uri: discordRedirectUri(),
    response_type: 'code',
    scope: 'identify',
    prompt: 'consent',
    state,
  });
  return `https://discord.com/oauth2/authorize?${q.toString()}`;
}

async function discordExchangeCode(code) {
  const body = new URLSearchParams({
    client_id: settings.discordClientId,
    client_secret: settings.discordClientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: discordRedirectUri(),
  });
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(String(data.error_description || data.error || ('HTTP ' + res.status)));
  }
  return data.access_token;
}

async function discordFetchProfile(token) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new Error('Profil nicht geladen (HTTP ' + res.status + ')');
  return {
    id: String(data.id),
    username: String(data.username || ''),
    avatar: data.avatar ? String(data.avatar) : null,
    discriminator: data.discriminator ? String(data.discriminator) : '0',
  };
}

// Kleine HTML-Antwort für den Browser-Tab, den Discord nach dem Login öffnet.
function discordCallbackPage(ok, message) {
  const color = ok ? '#3ba55d' : '#ed4245';
  const title = ok ? 'Discord verbunden ✓' : 'Discord-Login fehlgeschlagen';
  return `<!doctype html><meta charset="utf-8"><title>Smoky — Discord</title>
<body style="margin:0;background:#0e111a;color:#e8eaf2;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="text-align:center;padding:32px"><h2 style="color:${color};margin:0 0 12px">${title}</h2>
<p style="opacity:.8;margin:0">${message}</p><p style="opacity:.55;margin:16px 0 0">Du kannst diesen Tab jetzt schließen und zurück zu Smoky wechseln.</p></div></body>`;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  try {
    if (req.method === 'GET' && p === '/api/playlist') {
      const url = String(u.searchParams.get('url') || '');
      if (!url || !/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: 'missing url' });
      // Host-Whitelist: Der lokale Server soll keine beliebigen URLs fetchen
      // (fremde Webseiten könnten ihn sonst als Proxy missbrauchen).
      try {
        const host = new URL(url).hostname;
        if (!/^([^.]+\.)*(youtube\.com|youtu\.be|open\.spotify\.com|soundcloud\.com)$/i.test(host)) {
          return sendJson(res, 400, { error: 'unsupported host' });
        }
      } catch {
        return sendJson(res, 400, { error: 'invalid url' });
      }
      try {
        const tracks = await listPlaylistTracks(url);
        return sendJson(res, 200, { tracks });
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e) });
      }
    }

    if (req.method === 'POST' && p === '/api/download') {
      const body = await readBody(req);
      if (!body.url || !/^https?:\/\//i.test(body.url)) return sendJson(res, 400, { error: 'Please paste a valid link.' });
      const folder = body.outputDir || body.folder || settings.folder;
      settings.folder = folder;
      settings.format = body.format || settings.format;
      settings.quality = body.quality || settings.quality;
      saveJson(SETTINGS_FILE, settings);
      const item = enqueue(body.url, body.format || 'mp4', body.quality || '1080', folder, body.browserName || 'none', body.tracks);
      const { child, ...safe } = item;
      return sendJson(res, 200, { item: safe });
    }

    if (req.method === 'POST' && p === '/api/cancel') {
      const body = await readBody(req);
      const q = queue.find((x) => x.id === body.id);
      if (q) {
        q.status = 'cancelled';
        q.error = null;
        if (q.child && q.child.kill) { try { q.child.kill(); } catch {} }
        const ri = running.indexOf(q); if (ri !== -1) running.splice(ri, 1);
        setTimeout(pump, 300);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/delete-finished') {
      const body = await readBody(req);
      const ids = new Set(body.ids || []);
      for (let i = queue.length - 1; i >= 0; i--) {
        const q = queue[i];
        if (['finished', 'failed', 'cancelled'].includes(q.status) && (ids.size === 0 || ids.has(q.id))) queue.splice(i, 1);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/delete-file') {
      const body = await readBody(req);
      if (!body.path) return sendJson(res, 400, { error: 'missing path' });
      try {
        // idempotent delete: a file that no longer exists is already deleted
        if (!fs.existsSync(body.path)) return sendJson(res, 200, { ok: true });
        const st = fs.statSync(body.path);
        if (!st.isFile()) return sendJson(res, 200, { ok: true });
        fs.unlinkSync(body.path);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === 'POST' && p === '/api/open-folder') {
      const body = await readBody(req);
      const dir = body.path || settings.folder;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const { spawn: openSpawn } = require('node:child_process');
        openSpawn(process.platform === 'win32' ? 'explorer' : 'xdg-open', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: String(e.message || e) });
      }
    }

    if (req.method === 'POST' && p === '/api/player-state') {
      const body = await readBody(req);
      const pos = Number(body.position);
      const dur = Number(body.duration);
      playerState = {
        title: String(body.title || '').slice(0, 120),
        artist: String(body.artist || '').slice(0, 80),
        album: String(body.album || '').slice(0, 120),
        playing: !!body.playing,
        position: Number.isFinite(pos) && pos >= 0 ? pos : null,
        duration: Number.isFinite(dur) && dur > 0 ? dur : null,
        updatedAt: now(),
      };
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/settings') {
      const body = await readBody(req);
      if (body.theme && !THEMES.includes(body.theme)) return sendJson(res, 400, { error: 'unknown theme' });
      settings = { ...settings, ...body };
      saveJson(SETTINGS_FILE, settings);
      return sendJson(res, 200, { settings: publicSettings() });
    }

    // ----- Discord (Login + Rich-Presence-Konfiguration) -----
    if (req.method === 'GET' && p === '/api/discord/status') {
      return sendJson(res, 200, discordPublicStatus());
    }

    if (req.method === 'POST' && p === '/api/discord/authorize') {
      const id = String(settings.discordClientId || '').trim();
      const secret = String(settings.discordClientSecret || '').trim();
      if (!/^\d+$/.test(id) || !secret) {
        return sendJson(res, 400, { error: 'Trage zuerst Client-ID und Client-Secret in den Einstellungen ein.' });
      }
      return sendJson(res, 200, { url: discordAuthorizeUrl(), redirectUri: discordRedirectUri() });
    }

    if (req.method === 'GET' && p === '/api/discord/callback') {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      if (!code || !state || state !== pendingDiscordState) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(discordCallbackPage(false, 'Ungültiger oder abgelaufener Login-Versuch.'));
        return;
      }
      pendingDiscordState = null;
      try {
        const token = await discordExchangeCode(code);
        const profile = await discordFetchProfile(token);
        settings = { ...settings, discordProfile: profile, discordToken: token };
        saveJson(SETTINGS_FILE, settings);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(discordCallbackPage(true, `Angemeldet als <b>${String(profile.username).replace(/[<>&]/g, '')}</b>.`));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(discordCallbackPage(false, String(e.message || e).replace(/[<>&]/g, '')));
      }
      return;
    }

    if (req.method === 'POST' && p === '/api/discord/disconnect') {
      settings = { ...settings, discordProfile: null, discordToken: null };
      saveJson(SETTINGS_FILE, settings);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/upload') {
      const name = decodeURIComponent(req.headers['x-file-name'] || 'file');
      const size = parseInt(req.headers['content-length'] || '0', 10);
      if (size > 500 * 1024 * 1024) return sendJson(res, 413, { error: 'file too large (max 500 MB)' });
      const id = crypto.randomBytes(4).toString('hex');
      const inDir = path.join(DATA_DIR, 'convert-in');
      fs.mkdirSync(inDir, { recursive: true });
      const srcPath = path.join(inDir, `${id}-${safeName(name)}`);
      const ws = fs.createWriteStream(srcPath);
      req.pipe(ws);
      const uploaded = await new Promise((resolve) => {
        ws.on('finish', () => resolve(true));
        ws.on('error', () => { try { fs.unlinkSync(srcPath); } catch {} resolve(false); });
        req.on('error', () => { try { fs.unlinkSync(srcPath); } catch {} resolve(false); });
        req.on('aborted', () => { try { fs.unlinkSync(srcPath); } catch {} resolve(false); });
      });
      if (!uploaded) return sendJson(res, 400, { error: 'upload interrupted' });
      return sendJson(res, 200, { id, path: srcPath });
    }

    if (req.method === 'POST' && p === '/api/convert') {
      const body = await readBody(req);
      const format = String(body.format || 'mp3').toLowerCase();
      if (!FFMPEG_OK || !FFPROBE_OK) return sendJson(res, 400, { error: 'ffmpeg is not installed — install it first (choco install ffmpeg or winget install ffmpeg).' });
      if (!AUDIO_TARGETS[format] && format !== 'mp4') return sendJson(res, 400, { error: 'unsupported target format' });
      const srcPath = path.normalize(String(body.path || ''));
      let st;
      try { st = fs.statSync(srcPath); } catch {}
      if (!st || !st.isFile()) return sendJson(res, 404, { error: 'source file not found' });
      const id = crypto.randomBytes(4).toString('hex');
      const item = convertFile(id, srcPath, path.basename(srcPath).replace(/^[0-9a-f]+-/, ''), format);
      return sendJson(res, 200, { item });
    }

    if (req.method === 'POST' && p === '/api/convert-delete') {
      const body = await readBody(req);
      const ids = new Set(body.ids || []);
      for (let i = conversions.length - 1; i >= 0; i--) {
        const c = conversions[i];
        if ((c.status === 'finished' || c.status === 'failed') && (ids.size === 0 || ids.has(c.id))) conversions.splice(i, 1);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/clip') {
      const body = await readBody(req);
      if (!body.url || !/^https?:\/\//i.test(body.url)) return sendJson(res, 400, { error: 'Please paste a valid link.' });
      const item = startClipJob(body);
      return sendJson(res, 200, { item });
    }

    if (req.method === 'POST' && p === '/api/clips-delete') {
      const body = await readBody(req);
      const ids = new Set(body.ids || []);
      for (let i = clips.length - 1; i >= 0; i--) {
        const c = clips[i];
        if ((c.status === 'finished' || c.status === 'failed') && (ids.size === 0 || ids.has(c.id))) clips.splice(i, 1);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/history-clear') {
      history = [];
      saveJson(HISTORY_FILE, history);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/history-repair') {
      // Einträge, deren Datei nicht (mehr) existiert, aus der History entfernen.
      const before = history.length;
      let removed = 0;
      history = history.filter((h) => {
        let exists = false;
        try { exists = !!h.file && fs.existsSync(h.file); } catch {}
        if (!exists) removed++;
        return exists;
      });
      saveJson(HISTORY_FILE, history);
      return sendJson(res, 200, { removed, kept: history.length, before, after: history.length });
    }

    if (req.method === 'POST' && p === '/api/tools-update') {
      const body = await readBody(req);
      // dryRun: nur Versionen melden, nichts herunterladen (Tests, UI-Vorschau).
      if (body && body.dryRun) {
        return sendJson(res, 200, { ok: true, dryRun: true, ytdlp: toolVersions.ytdlp, ffmpeg: toolVersions.ffmpeg });
      }
      const result = await updateBundledTools();
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && p === '/api/status') {
      return sendJson(res, 200, await statusPayload());
    }

    if (req.method === 'GET' && p === '/api/clips') {
      return sendJson(res, 200, { clips: clips.map((c) => ({ ...c })) });
    }

    if (req.method === 'GET' && p === '/api/history') {
      return sendJson(res, 200, { history });
    }

    if (req.method === 'GET' && p === '/api/version') {
      return sendJson(res, 200, { version: APP_VERSION });
    }

    if (req.method === 'GET' && p === '/api/library') {
      return sendJson(res, 200, { tracks: await scanLibrary() });
    }

    if (req.method === 'POST' && p === '/api/edit-tags') {
      const body = await readBody(req);
      const file = body && body.file;
      if (!file || !isInsideFolder(file, settings.folder) || !fs.existsSync(file)) return sendJson(res, 400, { error: 'not found' });
      if (!ffmpegCmd) return sendJson(res, 400, { error: 'ffmpeg missing' });
      const title = String(body.title || '').trim();
      const artist = String(body.artist || '').trim();
      const album = String(body.album || '').trim();
      const ext = path.extname(file).toLowerCase();
      // Eigenes Cover (optional): base64-Bild → Temp-Datei → mit ffmpeg einbetten.
      let coverTmp = null;
      if (body.cover) {
        if (!COVER_SLOT_EXTS.has(ext)) {
          return sendJson(res, 400, { error: `no cover slot for ${ext}` });
        }
        coverTmp = writeCoverTemp(body.cover);
        if (!coverTmp) return sendJson(res, 400, { error: 'invalid cover image' });
      }
      const tmp = file.slice(0, -ext.length) + '.tagfix' + ext;
      const args = ['-y', '-i', file];
      if (coverTmp) args.push('-i', coverTmp);
      args.push('-map', '0:a');
      if (coverTmp) args.push('-map', '1:v');
      args.push('-c', 'copy');
      if (coverTmp) {
        if (ext === '.mp3') {
          args.push('-id3v2_version', '3', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
        } else {
          args.push('-disposition:v', 'attached_pic');
        }
      }
      if (title) args.push('-metadata', `title=${title}`);
      if (artist) args.push('-metadata', `artist=${artist}`);
      if (album) args.push('-metadata', `album=${album}`);
      args.push(tmp);
      let ok = false;
      await new Promise((resolve) => {
        const p = spawn(ffmpegCmd.cmd, args, { windowsHide: true });
        p.on('error', () => resolve());
        p.on('close', (code) => {
          try {
            if (code === 0 && fs.existsSync(tmp)) { fs.renameSync(tmp, file); ok = true; }
            else fs.rmSync(tmp, { force: true });
          } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
          resolve();
        });
      });
      try { if (coverTmp) fs.unlinkSync(coverTmp); } catch {}
      if (ok && coverTmp) invalidateCoverCache(file);
      return sendJson(res, ok ? 200 : 500, ok ? { ok: true, coverEmbedded: !!coverTmp } : { error: 'ffmpeg failed' });
    }

    if (req.method === 'GET' && p === '/api/recommendations') {
      const force = u.searchParams.get('refresh') === '1';
      return sendJson(res, 200, await recommendationsPayload(force));
    }

    if (req.method === 'GET' && p === '/api/recommendations/similar') {
      const title = u.searchParams.get('title') || '';
      const exclude = u.searchParams.get('exclude') || '';
      const items = await buildSimilar(title, exclude);
      return sendJson(res, 200, { items });
    }

    if (req.method === 'GET' && p === '/api/stats') {
      const h = history;
      const total = h.length;
      const bytes = h.reduce((a, x) => a + (x.size || 0), 0);
      const weekAgo = Date.now() - 7 * 864e5;
      const week = h.filter(x => x.finishedAt >= weekAgo);
      const weekBytes = week.reduce((a, x) => a + (x.size || 0), 0);
      const hosts = {};
      for (const x of h) { let host = ''; try { host = new URL(x.url).hostname.replace(/^www\./, ''); } catch {} if (host) hosts[host] = (hosts[host] || 0) + 1; }
      const topHost = Object.entries(hosts).sort((a, b) => b[1] - a[1])[0] || null;
      const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B';
      return sendJson(res, 200, { total, bytesFmt: fmt(bytes), weekCount: week.length, weekBytesFmt: fmt(weekBytes), topHost: topHost ? { host: topHost[0], count: topHost[1] } : null, avgFmt: total ? fmt(bytes / total) : '—' });
    }

    if (req.method === 'GET' && p === '/api/playlist-export') {
      const tracks = await scanLibrary();
      if (!tracks.length) return sendJson(res, 404, { error: 'no tracks' });
      const lines = ['#EXTM3U'];
      for (const t of tracks) {
        const name = [t.artist, t.title].filter(Boolean).join(' - ') || path.basename(t.path);
        lines.push(`#EXTINF:${Math.round(t.duration || 0)},${name}`);
        lines.push(t.path);
      }
      const body = lines.join('\r\n');
      res.writeHead(200, {
        'Content-Type': 'audio/x-mpegurl',
        'Content-Length': Buffer.byteLength(body),
        'Content-Disposition': 'attachment; filename="Smoky-Playlist.m3u"',
      });
      return res.end(body);
    }

    if (req.method === 'GET' && p === '/api/play') {
      const file = u.searchParams.get('file');
      if (!file || !isInsideFolder(file, settings.folder) || !fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
      return serveFile(req, res, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    }

    if (req.method === 'GET' && p === '/api/cover') {
      const file = u.searchParams.get('file');
      if (!file || !isInsideFolder(file, settings.folder) || !fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
      const cover = await coverFor(file);
      if (!cover) return sendJson(res, 204);
      // Schwester-Bilder können .png/.webp sein — passenden MIME-Type liefern
      return serveFile(req, res, cover, MIME[path.extname(cover).toLowerCase()] || 'image/jpeg');
    }

    // ----- „Senden ans Handy“ (Token anlegen / widerrufen) -----
    if (req.method === 'POST' && p === '/api/share/create') {
      const body = await readBody(req);
      const r = createShareToken(body.path);
      if (r.error) return sendJson(res, 400, r);
      return sendJson(res, 200, r);
    }

    if (req.method === 'POST' && p === '/api/share/revoke') {
      const body = await readBody(req);
      const token = String(body.token || '');
      if (!/^[0-9a-f]{16}$/.test(token)) return sendJson(res, 400, { error: 'Ungültiger Token.' });
      return sendJson(res, 200, { ok: true, removed: revokeShareToken(token) });
    }

    serveStatic(req, res, p);
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

function startServer(port = PORT, silent = false) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      serverPort = server.address().port;
      if (!silent) {
        console.log('');
        console.log('  ┌───────────────────────────────────────┐');
        console.log('  │   🚬 Smoky — multi media downloader   │');
        console.log('  └───────────────────────────────────────┘');
        console.log(`  →  http://127.0.0.1:${port}`);
        console.log(`  →  yt-dlp: ${YTDLP_OK ? '✓ ready' : '✗ missing'}   spotDL: ${SPOTDL_OK ? '✓ ready' : '✗ missing (Spotify)'}   ffmpeg: ${FFMPEG_OK ? '✓ ready' : '✗ missing (converter)'}`);
        console.log(`  →  Downloads folder: ${settings.folder}`);
        console.log('');
      }
      resolve(server.address().port);
      // LAN-Server für „Senden ans Handy“ parallel starten (feuern & vergessen).
      startShareServer().catch(() => {});
    });
  });
}

// Format, das spotDL für die gewählte UI-Format-Key erzeugen soll; nur
// unterstützte Ziele durchreichen, sonst mp3 (aac, mp4, …).
function spotFormatFor(formatKey) {
  return SPOT_FORMATS.has(formatKey) ? formatKey : 'mp3';
}

// Eindeutiger Clip-Ausgabepfad: derselbe Titel + dasselbe Zeitfenster erneut
// schneiden überschreibt die fertige Datei nicht stillschweigend, sondern
// bekommt einen Aufzählungs-Suffix („… (0-00-0-04) (2).mp4").
function clipOutPath(outDir, base, t1, t2, format) {
  let out = path.join(outDir, `${base} (${t1}-${t2}).${format}`);
  let n = 2;
  while (fs.existsSync(out)) {
    out = path.join(outDir, `${base} (${t1}-${t2}) (${n}).${format}`);
    n++;
  }
  return out;
}

module.exports = { startServer, startShareServer, settings, queue, history, conversions, server, shareTokens, sharePort, SHARE_PORT, SHARE_TTL_MS, createShareToken, revokeShareToken, lanIPv4, lanIPv4Candidates, isPrivateIPv4, isCgnatIPv4, resolveOrganizePath, findExistingSpotFiles, displayTitle, spotFormatFor, moveFile, findFileRecursive, clipOutPath, recommendationSeeds, buildRecommendations, recSearch, librarySeeds, mergeSeedLists, buildSimilar };

if (require.main === module) {
  startServer();
}
