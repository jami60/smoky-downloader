// Smoky — Electron main process.
// Runs the local Node backend in-process and opens the UI in a frameless window.
const { app, BrowserWindow, dialog, shell, ipcMain, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { startServer } = require('../server.js');
const updater = require('./updater.js');
const { DiscordRPC } = require('./discord-rpc.js');

// --------------------------------------------------------------------------
// Updates — checked against the latest GitHub release of this public repo.
// The env override exists for testing and power users.
const UPDATE_REPO = process.env.SMOKY_UPDATE_REPO || 'jami60/smoky-downloader';
// Discord Rich Presence — träg deine App-ID hier ein (discord.com/developers).
// Ohne gültige ID bleibt Smoky still und verbindet sich nicht.
const DISCORD_CLIENT_ID = process.env.SMOKY_DISCORD_ID || 'DEINE_DISCORD_APP_ID';
const discord = new DiscordRPC(DISCORD_CLIENT_ID);
discord.start();
const APP_VERSION = (() => { try { return require('../package.json').version; } catch { return '0.0.0'; } })();

const SMOKE = process.argv.includes('--smoke');
let win = null;

// Crash diagnostics: GUI apps show no console, so log to a file in userData.
let logPath = '';
try { logPath = path.join(app.getPath('userData'), 'smoky.log'); } catch {}
function log(...args) {
  try { fs.appendFileSync(logPath, new Date().toISOString() + ' ' + args.join(' ') + '\n'); } catch {}
}
process.on('uncaughtException', (err) => log('UNCAUGHT:', err && err.stack || err));
process.on('unhandledRejection', (err) => log('UNHANDLED:', err && err.stack || err));

app.whenReady().then(async () => {
  // Stable port so localStorage (theme, music, guide flag) persists across launches.
  // Fall back to the next candidate if one is taken, then to a random free port.
  let port = null;
  for (const candidate of [4290, 4291, 4292, 4293, 4294]) {
    try { port = await startServer(candidate, true); break; } catch (e) { log('port ' + candidate + ' failed:', e && e.message || e); }
  }
  if (!port) port = await startServer(0, true); // random free local port
  log('server on port', port);
  // Silent auto-check a few seconds after launch; only interrupts when an
  // update is actually available.
  setTimeout(async () => {
    if (!app.isPackaged) return;
    try {
      const r = await updater.checkForGitHubUpdate(UPDATE_REPO, APP_VERSION);
      if (!r.available) return;
      const choice = dialog.showMessageBoxSync(win, {
        type: 'info',
        title: 'Smoky update',
        message: `Smoky ${r.version} is available`,
        detail: (r.notes || 'A new version is ready.') + '\n\nCurrent: ' + APP_VERSION,
        buttons: ['Update now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (choice === 0) await runUpdate(r.url);
    } catch { /* offline / unreachable → stay silent */ }
  }, 8000);

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    frame: false,
    backgroundColor: '#090b11',
    title: 'Smoky',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Taskbar progress: the Windows icon shows a bar while a download runs.
  let discordDlId = null, discordDlStart = null;
  setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      const s = await res.json();
      const active = (s.queue || []).find((q) => q.status === 'downloading' || q.status === 'processing' || q.status === 'queued');
      if (!active) { win.setProgressBar(-1); discordDlId = null; discordDlStart = null; }
      else if (active.status === 'queued') win.setProgressBar(0.05);
      else win.setProgressBar(Math.max(0.02, Math.min(1, (active.percent || 0) / 100)));
      // Discord Rich Presence: Download > laufender Track > Idle.
      if (active) {
        if (discordDlId !== active.id) { discordDlId = active.id; discordDlStart = Date.now(); }
        const track = active.trackIndex && active.trackCount ? `Track ${active.trackIndex} von ${active.trackCount} · ` : '';
        discord.setActivity({
          details: `⬇ ${active.title || 'Download läuft'}`,
          state: `${track}${Math.round(active.percent || 0)}%`,
          timestamps: { start: discordDlStart || Date.now() },
        });
      } else if (s.player && s.player.playing && s.player.title) {
        discord.setActivity({
          details: `🎵 ${s.player.title}`,
          state: s.player.artist || 'Musik-Player',
        });
      } else {
        discord.setActivity({ details: 'Smoky Desktop', state: 'Verwaltet seine Media-Bibliothek' });
      }
    } catch { /* server briefly unreachable */ }
  }, 1000);

  win.webContents.setWindowOpenHandler(({ url }) => {
    // open external links (e.g. the YouTube channel) in the system browser
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://127.0.0.1:${port}`);

  // Clipboard-Erkennung: kopierte Download-Links werden der Seite gemeldet.
  // Nur neue URLs bekannte Plattformen — kein Spam, keine Tracking-Pfade.
  const CLIP_RE = /(https?:\/\/[^\s"'<>]+)/i;
  const CLIP_HOSTS = /(youtube\.com|youtu\.be|open\.spotify\.com|soundcloud\.com|twitter\.com|x\.com|instagram\.com|tiktok\.com|vimeo\.com|facebook\.com)/i;
  let lastClipUrl = '';
  setInterval(() => {
    try {
      const text = clipboard.readText();
      const m = text.match(CLIP_RE);
      if (!m) return;
      const url = m[1].replace(/[),.;]+$/, '');
      if (!CLIP_HOSTS.test(url) || url === lastClipUrl) return;
      lastClipUrl = url;
      if (win && !win.isDestroyed()) win.webContents.send('clipboard:url', url);
    } catch {}
  }, 2000);

  if (SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const result = await win.webContents.executeJavaScript(`({
          title: document.title,
          bridge: typeof window.smokyDesktop === 'object',
          nativeBridge: typeof window.smokyDesktopNative === 'object',
          views: document.querySelectorAll('.page-view').length,
          viewsInMain: [...document.querySelectorAll('.page-view')].filter(v => document.querySelector('main').contains(v)).length
        })`);
        console.log('SMOKE_OK ' + JSON.stringify(result));
      } catch (err) {
        console.log('SMOKE_FAIL ' + String(err && err.message || err));
      }
      app.exit(0);
    });
  }
});

app.on('window-all-closed', () => app.quit());

// ------------------------------------------------------------- IPC --------
ipcMain.handle('win:minimize', () => win && win.minimize());
ipcMain.handle('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle('win:close', () => win && win.close());

ipcMain.handle('dialog:chooseFolder', async () => {
  if (!win) return { path: null };
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose downloads folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return { path: result.canceled || !result.filePaths.length ? null : result.filePaths[0] };
});

ipcMain.handle('dialog:chooseFile', async () => {
  if (!win) return { path: null };
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a media file to convert',
    properties: ['openFile'],
    filters: [
      { name: 'Media', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4a', 'mp3', 'flac', 'wav', 'ogg', 'opus', 'aac', 'wma'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return { path: result.canceled || !result.filePaths.length ? null : result.filePaths[0] };
});

ipcMain.handle('dialog:chooseFiles', async () => {
  if (!win) return { paths: [] };
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose media files to convert',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4a', 'mp3', 'flac', 'wav', 'ogg', 'opus', 'aac', 'wma'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return { paths: result.canceled ? [] : result.filePaths };
});

ipcMain.handle('shell:openPath', async (_event, dir) => {
  try {
    if (!dir || !fs.existsSync(dir)) dir = require('node:path').dirname(dir || '') || '.';
    await shell.openPath(dir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('fs:deleteFile', async (_event, filePath) => {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, error: 'not a file' };
    fs.unlinkSync(filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ------------------------------------------------------------------ updates --
let updating = false;

async function runUpdate(url) {
  if (updating) return { ok: false, error: 'Update already in progress' };
  updating = true;
  try {
    dialog.showMessageBoxSync(win, {
      type: 'info',
      title: 'Smoky update',
      message: 'Downloading update…',
      detail: 'Smoky will close itself, install the update and restart. This can take a few minutes.',
      buttons: ['OK'],
      noLink: true,
    });
    await updater.applyUpdate(url, {
      appDir: path.dirname(process.execPath),
      execPath: process.execPath,
      log,
    });
    app.exit(0);
    return { ok: true };
  } catch (e) {
    updating = false;
    log('update failed:', e && e.stack || e);
    dialog.showMessageBoxSync(win, {
      type: 'error',
      title: 'Smoky update',
      message: 'The update could not be installed',
      detail: String(e && e.message || e),
      buttons: ['OK'],
      noLink: true,
    });
    return { ok: false, error: String(e && e.message || e) };
  }
}

ipcMain.handle('updates:check', async () => {
  if (!app.isPackaged) return { error: 'Updates are only available in the desktop app.' };
  try {
    const r = await updater.checkForGitHubUpdate(UPDATE_REPO, APP_VERSION);
    return r;
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

ipcMain.handle('updates:apply', async (_event, url) => {
  if (!app.isPackaged) return { error: 'Updates are only available in the desktop app.' };
  return runUpdate(url);
});
