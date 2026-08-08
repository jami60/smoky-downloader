// Smoky — multi media downloader backend.
// Zero-dependency Node server: serves the UI and runs yt-dlp / spotDL downloads.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
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
};

// ---------------------------------------------------------------- state ----
const queue = [];            // active + waiting items (in memory)
let history = [];            // persisted finished items
const THEMES = ['smoky', 'midnight', 'aurora', 'ember', 'ocean', 'rose', 'cyber', 'forest', 'slate', 'solar', 'rain', 'horror', 'light'];
let settings = {
  folder: path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads', 'Smoky'),
  format: 'mp4-1080',
  quality: 'best',
  ambientSnow: true,
  theme: 'midnight',
  musicVolume: 22,
  guideSeen: false,
};
let current = null;          // the download currently running
let conversions = [];        // ffmpeg conversions (in memory)

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

const AUDIO_ARGS = {
  mp3:  ['-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  m4a:  ['-x', '--audio-format', 'm4a'],
  flac: ['-x', '--audio-format', 'flac'],
  wav:  ['-x', '--audio-format', 'wav'],
  ogg:  ['-x', '--audio-format', 'ogg'],
  opus: ['-x', '--audio-format', 'opus'],
  aac:  ['-x', '--audio-format', 'aac'],
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

const YTDLP_OK = hasCommand('yt-dlp');
const SPOTDL_OK = hasCommand('spotdl');
const FFMPEG_OK = hasCommand('ffmpeg');
const FFPROBE_OK = hasCommand('ffprobe');

async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else if (e.isFile()) { const st = await fsp.stat(p); total += st.size; }
    }
  } catch {}
  return total;
}

// -------------------------------------------------------------- download ---
function parseProgress(line, item) {
  // 1) final file naming — [download] Destination / Merger / Remuxer / ExtractAudio
  let m = line.match(/\[download\]\s+Destination:\s+(.+)/i)
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
  return false;
}

function enqueue(url, formatKey, quality, folder, browserName) {
  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    url,
    format: FORMATS[formatKey] ? FORMATS[formatKey].label : FORMATS['mp4-1080'].label,
    formatKey: FORMATS[formatKey] ? formatKey : 'mp4-1080',
    quality,
    folder,
    browserName: browserName || 'none',
    title: isSpotify(url) ? 'Spotify track…' : 'Resolving link…',
    status: 'queued',
    percent: 0,
    speed: null,
    eta: null,
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
  if (current || queue.length === 0) return;
  const item = queue.find((q) => q.status === 'queued');
  if (!item) return;
  current = item;
  item.status = 'downloading';
  item.startedAt = now();
  item.percent = 0;

  const folder = item.folder || settings.folder;
  try { fs.mkdirSync(folder, { recursive: true }); } catch {}

  const isSpot = isSpotify(item.url);
  const outTpl = path.join(folder, '%(title)s [%(id)s].%(ext)s');

  let cmd, args;
  if (isSpot) {
    if (!SPOTDL_OK) {
      item.status = 'failed';
      item.error = 'spotDL is not installed. Run: py -m pip install -U spotdl';
      finish(item);
      return;
    }
    cmd = 'spotdl';
    args = [item.url, '--output', folder, '--format', 'mp3', '--overwrite', 'skip'];
  } else {
    if (!YTDLP_OK) {
      item.status = 'failed';
      item.error = 'yt-dlp is not installed. Run: py -m pip install -U yt-dlp';
      finish(item);
      return;
    }
    const fmt = FORMATS[item.formatKey] || FORMATS['mp4-1080'];
    cmd = 'yt-dlp';
    args = [
      '--newline', '--no-warnings', '--no-playlist',
      '-o', outTpl,
      ...fmt.args(item.quality),
      ...browserFlag(item.browserName),
      item.url,
    ];
  }

  const child = spawn(cmd, args, { windowsHide: true });
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

  child.on('close', (code) => {
    if (item.status === 'failed' || item.status === 'cancelled') { finish(item); return; }
    if (code === 0) {
      item.status = 'finished';
      item.percent = 100;
      item.speed = null;
      item.eta = null;
    } else {
      item.status = 'failed';
      const last = tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
      item.error = last || `yt-dlp exited with code ${code}`;
    }
    finish(item);
  });
}

function finish(item) {
  item.finishedAt = now();
  if (item.status === 'finished') {
    history.unshift({
      id: item.id,
      title: item.title,
      url: item.url,
      format: item.format,
      file: item.file,
      folder: item.folder,
      finishedAt: item.finishedAt,
      size: null,
    });
    history = history.slice(0, 200);
    saveJson(HISTORY_FILE, history);
  }
  current = null;
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
    const p = spawn('ffprobe', args, { windowsHide: true });
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  });
}

async function probeMedia(file) {
  const dur = await ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const streams = await ffprobe(['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
  const duration = parseFloat(dur);
  return {
    duration: isFinite(duration) ? duration : null,
    hasVideo: /\bvideo\b/.test(streams),
  };
}

function safeName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';
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
  const cleanupSource = () => {
    try {
      if (path.normalize(srcPath).startsWith(inDir)) fs.unlinkSync(srcPath);
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
        args = ['-y', '-i', srcPath, '-vn', '-c:a', 'aac', '-b:a', '192k', outPath];
      } else {
        args = ['-y', '-i', srcPath, '-vn', ...(AUDIO_TARGETS[format] || AUDIO_TARGETS.mp3), outPath];
      }

      const child = spawn('ffmpeg', ['-nostdin', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
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

function serveStatic(res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  try { file = decodeURIComponent(file); } catch {}
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) { sendJson(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { sendJson(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function statusPayload() {
  let storage = { folder: settings.folder, bytes: 0, percent: 0, ready: true };
  try { storage.bytes = await dirSize(settings.folder); } catch {}
  storage.percent = Math.min(100, Math.round((storage.bytes / VAULT_QUOTA) * 100));
  if (storage.bytes === 0) storage.percent = 0;
  return {
    queue: queue.map(({ child, ...q }) => q),
    history,
    conversions: conversions.map((c) => c),
    settings,
    storage,
    tools: { ytdlp: YTDLP_OK, spotdl: SPOTDL_OK, ffmpeg: FFMPEG_OK, ffprobe: FFPROBE_OK },
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  try {
    if (req.method === 'POST' && p === '/api/download') {
      const body = await readBody(req);
      if (!body.url || !/^https?:\/\//i.test(body.url)) return sendJson(res, 400, { error: 'Please paste a valid link.' });
      const folder = body.outputDir || body.folder || settings.folder;
      settings.folder = folder;
      settings.format = body.format || settings.format;
      settings.quality = body.quality || settings.quality;
      saveJson(SETTINGS_FILE, settings);
      const item = enqueue(body.url, body.format || 'mp4', body.quality || '1080', folder, body.browserName || 'none');
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
        if (current && current.id === q.id) current = null;
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
        const st = fs.statSync(body.path);
        if (!st.isFile()) return sendJson(res, 400, { error: 'not a file' });
        fs.unlinkSync(body.path);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 404, { error: 'file not found' });
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

    if (req.method === 'POST' && p === '/api/history-clear') {
      history = [];
      saveJson(HISTORY_FILE, history);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/status') {
      return sendJson(res, 200, await statusPayload());
    }

    if (req.method === 'GET' && p === '/api/history') {
      return sendJson(res, 200, { history });
    }

    serveStatic(res, p);
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
