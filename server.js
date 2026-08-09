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
const DATA_DIR = __dirname.includes('app.asar')
  ? path.join(process.env.APPDATA || process.env.HOME || process.cwd(), 'Smoky')
  : path.join(ROOT, 'data');
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
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac', '.webm': 'video/webm', '.mp4': 'video/mp4',
};
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.aac']);

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
};
const running = [];          // derzeit aktive Downloads (parallel, max. settings.maxParallel)
let conversions = [];        // ffmpeg conversions (in memory)
let clips = [];              // clip jobs (yt-dlp section download + ffmpeg)
let playerState = null;      // { title, artist, playing, updatedAt } — für Discord Rich Presence

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
// raw AAC have no standard cover-art slot, so they get tags only.) The album
// tag is filled in after the download by ensureAlbumTag (only when missing,
// so real albums from YouTube Music / spotDL are never overwritten).
const EMBED = ['--embed-metadata'];
const EMBED_ART = [...EMBED, '--embed-thumbnail'];
const AUDIO_ARGS = {
  mp3:  ['-x', '--audio-format', 'mp3', '--audio-quality', '0', ...EMBED_ART],
  m4a:  ['-x', '--audio-format', 'm4a', ...EMBED_ART],
  flac: ['-x', '--audio-format', 'flac', ...EMBED_ART],
  wav:  ['-x', '--audio-format', 'wav', ...EMBED],
  ogg:  ['-x', '--audio-format', 'ogg', ...EMBED_ART],
  opus: ['-x', '--audio-format', 'opus', ...EMBED_ART],
  aac:  ['-x', '--audio-format', 'aac', ...EMBED],
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
      require('node:child_process').execFileSync(p, [flag], { stdio: 'ignore', windowsHide: true });
      return { cmd: p, args: [] };
    } catch { /* try next flag */ }
  }
  return null;
}

// Resolve the best yt-dlp: bundled exe first (ships with the app), then the
// pip-installed `py -m yt_dlp` (usually much newer than a standalone exe on
// PATH, which gets HTTP 403 from YouTube when outdated), then PATH.
function resolveYtdlp() {
  const bundled = bundledCmd('yt-dlp.exe');
  if (bundled) return bundled;
  try {
    require('node:child_process').execFileSync('py', ['-m', 'yt_dlp', '--version'], { stdio: 'ignore', windowsHide: true });
    return { cmd: 'py', args: ['-m', 'yt_dlp'] };
  } catch {}
  if (hasCommand('yt-dlp')) return { cmd: 'yt-dlp', args: [] };
  return null;
}

// Same idea for spotDL: prefer the pip-installed `py -m spotdl`, fall back to PATH.
function resolveSpotdl() {
  try {
    require('node:child_process').execFileSync('py', ['-m', 'spotdl', '--version'], { stdio: 'ignore', windowsHide: true });
    return { cmd: 'py', args: ['-m', 'spotdl'] };
  } catch {}
  if (hasCommand('spotdl')) return { cmd: 'spotdl', args: [] };
  return null;
}

const ytdlp = resolveYtdlp();
const spotdl = resolveSpotdl();
const ffmpegCmd = bundledCmd('ffmpeg.exe') || (hasCommand('ffmpeg') ? { cmd: 'ffmpeg', args: [] } : null);
const ffprobeCmd = bundledCmd('ffprobe.exe') || (hasCommand('ffprobe') ? { cmd: 'ffprobe', args: [] } : null);
// Directory of the ffmpeg/ffprobe we resolved to — passed to yt-dlp via
// --ffmpeg-location so friends without ffmpeg on their PATH can still merge.
// Only set when it's a real file path (bundled exe); PATH-resolved ffmpeg
// needs no hint.
const FFMPEG_DIR = ffmpegCmd && ffmpegCmd.cmd.includes(path.sep) && fs.existsSync(ffmpegCmd.cmd)
  ? path.dirname(ffmpegCmd.cmd)
  : null;
// Prepending the bundled tools dir to PATH guarantees that yt-dlp and spotDL
// (which spawn ffmpeg/ffprobe themselves for postprocessing) find the bundled
// copy — belt and braces on top of --ffmpeg-location, and the only mechanism
// spotDL honours.
const TOOL_ENV = FFMPEG_DIR
  ? { ...process.env, PATH: `${FFMPEG_DIR}${path.delimiter}${process.env.PATH || ''}` }
  : process.env;
const YTDLP_OK = !!ytdlp;
const SPOTDL_OK = !!spotdl;
const FFMPEG_OK = !!ffmpegCmd;
const FFPROBE_OK = !!ffprobeCmd;

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
async function newestFileIn(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    let best = null, bestTime = 0;
    for (const e of entries) {
      if (e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      const st = await fsp.stat(p);
      if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = p; }
    }
    return best;
  } catch { return null; }
}


// -------------------------------------------------------------- download ---
function isPlaylistUrl(url) {
  // YouTube playlists carry a list= param (also /playlist?list= and /playlists/…);
  // Spotify playlists/albums are explicit path segments.
  if (/youtube\.com|youtu\.be/i.test(url)) return /[?&]list=[^&]+/.test(url);
  if (/open\.spotify\.com/i.test(url)) return /\/(playlist|album)\/[A-Za-z0-9]+/.test(url);
  return false;
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
    item.title = base.replace(/\.[^.]+$/, '');
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
    const item = queue.find((q) => q.status === 'queued');
    if (!item) break;
    running.push(item);
    launchItem(item);
  }
}

function launchItem(item) {
  item.status = 'downloading';
  item.startedAt = now();
  item.percent = 0;

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
      item.error = 'spotDL is not installed. Run: py -m pip install -U spotdl';
      finish(item);
      return;
    }
    cmd = spotdl.cmd;
    args = [...spotdl.args, ...(picked || [item.url]), '--output', folder, '--format', 'mp3', '--overwrite', 'skip'];
    if (picked) item.title = 'Spotify playlist…';
  } else {
    if (!YTDLP_OK) {
      item.status = 'failed';
      item.error = 'yt-dlp is not installed. Run: py -m pip install -U yt-dlp';
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
    finish(item);
  });

  child.on('close', async (code) => {
    if (item.status === 'failed' || item.status === 'cancelled') { finish(item); return; }
    if (code === 0) {
      item.status = 'finished';
      item.percent = 100;
      item.speed = null;
      item.eta = null;
      // spotDL (and friends) never announce their destination — resolve the
      // output file from the folder so delete/open buttons can work.
      if (!item.file) {
        const found = await newestFileIn(folder);
        if (found) {
          item.file = found;
          if (!item.title || item.title === 'Resolving link…' || item.title === 'Spotify track…') {
            item.title = path.basename(found).replace(/\.[^.]+$/, '');
          }
        }
      }
      // Album-Tag nachziehen, wenn die Quelle keins liefert (z. B. YouTube).
      if (item.file && AUDIO_ARGS[item.formatKey]) {
        try { await ensureAlbumTag(item.file, item.title); } catch {}
      }
    } else {
      item.status = 'failed';
      const last = tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
      item.error = last || `yt-dlp exited with code ${code}`;
    }
    finish(item);
  });
}

function fileHasTag(file, name) {
  return new Promise((resolve) => {
    const p = spawn(ffprobeCmd.cmd, ['-v', 'error', '-show_entries', `format_tags=${name}`, '-of', 'default=noprint_wrappers=1:nokey=1', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(out.trim().length > 0));
  });
}

// Sets the album tag to the title when the file has no album tag yet (stream
// copy — fast, never re-encodes, never overwrites a real album).
async function ensureAlbumTag(file, title) {
  if (!file || !title || !ffmpegCmd || !ffprobeCmd) return;
  if (await fileHasTag(file, 'album')) return;
  title = String(title).replace(/\s*\[[^\]]*]\s*$/, '').trim() || title; // ohne "[videoId]"-Suffix
  const ext = path.extname(file);
  const tmp = file.slice(0, -ext.length) + '.tagfix' + ext;
  await new Promise((resolve) => {
    const p = spawn(ffmpegCmd.cmd, ['-y', '-i', file, '-c', 'copy', '-metadata', `album=${title}`, tmp], { windowsHide: true });
    p.on('error', () => { try { fs.rmSync(tmp, { force: true }); } catch {} resolve(); });
    p.on('close', (code) => {
      try {
        if (code === 0 && fs.existsSync(tmp)) fs.renameSync(tmp, file);
        else fs.rmSync(tmp, { force: true });
      } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
      resolve();
    });
  });
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
// Spotify nutzt spotDL save, alles andere yt-dlp --flat-playlist (schnell).
async function listPlaylistTracks(url) {
  if (isSpotify(url)) {
    if (!SPOTDL_OK) throw new Error('spotDL is not installed. Run: py -m pip install -U spotdl');
    const tmp = path.join(os.tmpdir(), 'smoky-playlist-' + crypto.randomBytes(4).toString('hex') + '.spotdl');
    try {
      await runCmdOut(spotdl.cmd, [...spotdl.args, 'save', url, '--save-file', tmp], 120000);
      const raw = fs.readFileSync(tmp, 'utf8');
      const tracks = JSON.parse(raw);
      return (Array.isArray(tracks) ? tracks : []).map((t, i) => ({
        index: i + 1,
        title: t.name || ('Track ' + (i + 1)),
        artist: t.artist || (Array.isArray(t.artists) ? t.artists.join(', ') : ''),
        url: t.url || '',
      })).filter((t) => /^https?:\/\//i.test(t.url));
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  if (!YTDLP_OK) throw new Error('yt-dlp is not installed. Run: py -m pip install -U yt-dlp');
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
  item.finishedAt = now();
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
      if (!YTDLP_OK) throw new Error('yt-dlp is not installed. Run: py -m pip install -U yt-dlp');
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
      const outPath = path.join(outDir, `${base} (${t1}-${t2}).${item.format}`);

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

// ------------------------------------------------------------- HTTP app ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
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
    fs.createReadStream(full, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', ...extraHeaders });
    fs.createReadStream(full).pipe(res);
  }
}

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  try { file = decodeURIComponent(file); } catch {}
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) { sendJson(res, 403, { error: 'forbidden' }); return; }
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

async function scanLibrary() {
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) files.push(p);
    }
  };
  await walk(settings.folder, 0);
  files.sort();
  const tracks = [];
  for (const f of files) {
    const tags = await probeTags(f);
    let size = 0;
    try { size = fs.statSync(f).size; } catch {}
    tracks.push({
      path: f,
      title: tags.title || path.basename(f, path.extname(f)),
      artist: tags.artist || '',
      album: tags.album || '',
      duration: tags.duration || 0,
      size,
    });
  }
  return tracks;
}

const coverDir = path.join(DATA_DIR, 'covers');
async function coverFor(file) {
  if (!ffmpegCmd) return null;
  const hash = crypto.createHash('md5').update(file).digest('hex');
  const out = path.join(coverDir, hash + '.jpg');
  if (fs.existsSync(out)) return out;
  try { fs.mkdirSync(coverDir, { recursive: true }); } catch { return null; }
  await new Promise((resolve) => {
    const p = spawn(ffmpegCmd.cmd, ['-y', '-i', file, '-an', '-c:v', 'mjpeg', '-frames:v', '1', out], { windowsHide: true });
    p.on('error', () => resolve());
    p.on('close', () => resolve());
  });
  return fs.existsSync(out) ? out : null;
}

async function statusPayload() {
  let storage = { folder: settings.folder, bytes: 0, percent: 0, ready: true };
  try { storage.bytes = await dirSize(settings.folder); } catch {}
  storage.percent = Math.min(100, Math.round((storage.bytes / VAULT_QUOTA) * 100));
  if (storage.bytes === 0) storage.percent = 0;
  return {
    version: APP_VERSION,
    queue: queue.map(({ child, ...q }) => q),
    history,
    conversions: conversions.map((c) => c),
    clips: clips.map((c) => c),
    settings,
    storage,
    player: playerState,
    tools: { ytdlp: YTDLP_OK, spotdl: SPOTDL_OK, ffmpeg: FFMPEG_OK, ffprobe: FFPROBE_OK },
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  try {
    if (req.method === 'GET' && p === '/api/playlist') {
      const url = String(u.searchParams.get('url') || '');
      if (!url || !/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: 'missing url' });
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
      playerState = {
        title: String(body.title || '').slice(0, 120),
        artist: String(body.artist || '').slice(0, 80),
        playing: !!body.playing,
        updatedAt: now(),
      };
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/settings') {
      const body = await readBody(req);
      if (body.theme && !THEMES.includes(body.theme)) return sendJson(res, 400, { error: 'unknown theme' });
      settings = { ...settings, ...body };
      saveJson(SETTINGS_FILE, settings);
      return sendJson(res, 200, { settings });
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
      await new Promise((resolve, reject) => {
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
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
      return serveFile(req, res, cover, 'image/jpeg');
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
    });
  });
}

module.exports = { startServer, settings, queue, history, conversions };

if (require.main === module) {
  startServer();
}
