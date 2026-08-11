// Smoky — Electron main process.
// Runs the local Node backend in-process and opens the UI in a frameless window.
const { app, BrowserWindow, dialog, shell, ipcMain, clipboard, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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
let browserWin = null; // separates In-App-Browser-Fenster (Variante B)

// Globale Player-Hotkeys (F4/F5/F6) — wie in Spotify, funktionieren auch,
// wenn Smoky nicht im Fokus ist (Electron globalShortcut). Der Tastendruck
// wird per IPC an die Seite geschickt, die den Player steuert.
const GLOBAL_HOTKEYS = { F4: 'prev', F5: 'toggle', F6: 'next' };
const fireHotkey = (action) => {
  if (win && !win.isDestroyed()) win.webContents.send('player:hotkey', action);
};

// Nur eine Instanz gleichzeitig: ein zweiter Start fokussiert das offene Fenster
// statt ein zweites zu öffnen (der Update-Relaunch startet erst nach taskkill).
// Auch die Smoke-Instanz nimmt am Lock teil — sonst bootet sie neben der
// laufenden App und crasht sich mit ihr über den gemeinsamen Cache.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  if (SMOKE) console.log('SMOKE_FAIL another instance is running');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

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

  // Globale Hotkeys registrieren — funktionieren auch ohne App-Fokus.
  // Scheitert eine einzelne Taste (von einer anderen App belegt), bleibt der
  // Rest aktiv; das wird nur geloggt, nicht als Fehler behandelt.
  for (const [key, action] of Object.entries(GLOBAL_HOTKEYS)) {
    try {
      if (globalShortcut.register(key, () => fireHotkey(action))) {
        if (SMOKE) console.log('HOTKEY_REGISTERED ' + key);
      } else {
        log('globalShortcut register failed:', key);
      }
    } catch (e) { log('globalShortcut error:', key, e && e.message || e); }
  }
  app.on('will-quit', () => {
    try { globalShortcut.unregisterAll(); } catch {}
    try { if (browserWin && !browserWin.isDestroyed()) browserWin.destroy(); } catch {}
  });

  // Fehlgeschlagenes Update melden: Der Update-Batch schreibt bei einem Fehler
  // update-failed.txt in userData und startet die App (alter Stand) neu.
  // Beim nächsten Start sagen wir hier Bescheid — und der Auto-Check bietet
  // das Update danach erneut an (self-healing).
  try {
    const failFile = path.join(app.getPath('userData'), 'update-failed.txt');
    if (fs.existsSync(failFile)) {
      fs.rmSync(failFile, { force: true });
      dialog.showMessageBoxSync(win, {
        type: 'warning',
        title: 'Smoky update',
        message: 'The last update could not be installed',
        detail: 'The previous version is still working. Smoky will offer the update again shortly — if it fails repeatedly, install the latest Setup from the GitHub releases page instead.',
        buttons: ['OK'],
        noLink: true,
      });
    }
    // Alte Update-Batches aufräumen: Der Update-Batch löscht sich bewusst
    // nicht selbst (cmd hängt, wenn ein laufender Batch sich selbst löscht) —
    // stattdessen räumen wir hier beim Start auf.
    const tmpDir = os.tmpdir();
    for (const f of fs.readdirSync(tmpDir)) {
      if (/^smoky-update.*\.bat$/i.test(f)) {
        try { fs.rmSync(path.join(tmpDir, f), { force: true }); } catch {}
      }
    }
  } catch { /* userData / tmp not readable — ignore */ }

  // Taskbar progress: the Windows icon shows a bar while a download runs.
  let discordDlId = null, discordDlStart = null, discordDlPct = -1;
  setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      const s = await res.json();
      const active = (s.queue || []).find((q) => q.status === 'downloading' || q.status === 'processing' || q.status === 'queued');
      if (!active) { win.setProgressBar(-1); discordDlId = null; discordDlStart = null; discordDlPct = -1; }
      else if (active.status === 'queued') win.setProgressBar(0.05);
      else win.setProgressBar(Math.max(0.02, Math.min(1, (active.percent || 0) / 100)));
      // Discord Rich Presence: Download > laufender Track > Idle.
      if (active) {
        if (discordDlId !== active.id) { discordDlId = active.id; discordDlStart = Date.now(); discordDlPct = -1; }
        // Nicht jede Sekunde einen neuen Frame an Discord schicken — nur wenn
        // sich der Fortschritt sichtbar ändert (~5%-Schritte) oder der Track
        // wechselt. Sonst droppt die Presence durchgehend neue Pakete.
        const pct = Math.round((active.percent || 0) / 5) * 5;
        if (pct !== discordDlPct) {
          discordDlPct = pct;
          const track = active.trackIndex && active.trackCount ? `Track ${active.trackIndex} von ${active.trackCount} · ` : '';
          discord.setActivity({
            details: `⬇ ${active.title || 'Download läuft'}`,
            state: `${track}${pct}%`,
            timestamps: { start: discordDlStart || Date.now() },
          });
        }
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
        const result = await win.webContents.executeJavaScript(`(async () => {
          const historySingleCard = await (async () => {
            try {
              document.querySelector('.nav-item[data-view="History"]').click();
              await new Promise((r) => setTimeout(r, 1600));
              const cards = [...document.querySelectorAll('#historyView .workspace-card')];
              const stats = cards[0];
              // Sprachunabhängig prüfen: Stats-Karte ist sichtbar (loadStats lief)
              // und hat ihr Statistik-Grid — kein Text-Vergleich nötig.
              const statsIntact = stats && stats.id === 'statsCard' && stats.style.display !== 'none' && !!document.getElementById('statTotal');
              const list = document.getElementById('historyListCard');
              const ok = statsIntact && !!list && cards.length === 2 && cards[1] === list;
              return ok ? 'ok' : 'fail(cards=' + cards.length + ',stats=' + !!statsIntact + ',list=' + !!list + ')';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })();
          // Globale Hotkeys (F4/F5/F6): IPC-Kette Main→Renderer — derselbe
          // Pfad wie ein echter Tastendruck, nur ohne die OS-Taste zu drücken.
          // registered ist ein Report (kann je nach belegten Tasten auf dem
          // Rechner variieren und darf deshalb nicht failen).
          const globalHotkeys = await (async () => {
            try {
              const calls = [];
              const oN = nextTrack, oP = prevTrack, oT = togglePlay;
              nextTrack = () => calls.push('next');
              prevTrack = () => calls.push('prev');
              togglePlay = () => calls.push('toggle');
              await window.smokyDesktopNative.hotkeyTestFire(['next', 'toggle', 'prev']);
              await new Promise((r) => setTimeout(r, 300));
              nextTrack = oN; prevTrack = oP; togglePlay = oT;
              const wiring = calls.join(',') === 'next,toggle,prev' ? 'ok' : 'fail(calls=' + calls.join(',') + ')';
              const registered = await window.smokyDesktopNative.hotkeyState();
              return { wiring, registered };
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })();
          return {
          // Alle Seiten durchklicken: jede View muss aktiv werden, Home zeigt
          // die Sektionen, und die neuen Elemente (Empfehlungen, Cover-Picker)
          // müssen existieren.
          pages: await (async () => {
            try {
              const failures = [];
              for (const nav of [...document.querySelectorAll('.nav-item')]) {
                const v = nav.dataset.view;
                nav.click();
                await new Promise((r) => setTimeout(r, 90));
                if (v === 'Home') {
                  const grid = document.getElementById('homeGrid');
                  const anyView = document.querySelectorAll('.page-view.active').length;
                  if (!grid || grid.style.display === 'none' || anyView > 0) failures.push(v + ':home');
                } else {
                  const view = document.getElementById(v.toLowerCase() + 'View');
                  if (!view) { failures.push(v + ':missing'); continue; }
                  if (!view.classList.contains('active')) failures.push(v + ':not-active');
                }
              }
              if (!document.getElementById('recList') || !document.getElementById('recRefresh')) failures.push('rec:missing');
              for (const id of ['tagCoverPick', 'tagCoverFile', 'tagCoverPreview', 'tagCoverClear', 'tagCoverName']) {
                if (!document.getElementById(id)) failures.push('tag:' + id);
              }
              if (!document.getElementById('browserView') || !document.getElementById('browserOpen')) failures.push('browser:missing-view');
              return failures.length ? 'fail(' + failures.join(',') + ')' : 'ok';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          title: document.title,
          bridge: typeof window.smokyDesktop === 'object',
          nativeBridge: typeof window.smokyDesktopNative === 'object',
          views: document.querySelectorAll('.page-view').length,
          viewsInMain: [...document.querySelectorAll('.page-view')].filter(v => document.querySelector('main').contains(v)).length,
          mediaSession: typeof navigator.mediaSession === 'object',
          updateProgressEl: !!document.getElementById('updateProgress'),
          updateProgressBridge: typeof (window.smokyDesktop && window.smokyDesktop.onUpdateProgress) === 'function',
          ensureQueueItem: typeof window.__ensureQueueItem === 'function',
          // Queue-Reload-Fix: der Hook muss fehlende Einträge wirklich ins DOM bauen
          queueRebuild: (() => {
            try {
              window.__ensureQueueItem({ id: 'faketest1', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', status: 'downloading', formatKey: 'mp3', quality: '1080' });
              return document.querySelectorAll('.queue-item[data-download-id="faketest1"]').length > 0 ? 'ok' : 'no-nodes';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // Player-Polish: Subtitle versteckt, wenn Album == Titel
          playerAlbumHide: (() => {
            try {
              const titleEl = document.getElementById('playerTitle');
              const albumEl = document.getElementById('playerAlbum');
              const oldTitle = titleEl.textContent;
              titleEl.textContent = 'X';
              setPlayerAlbum('X');
              const a = albumEl.style.display === 'none';
              setPlayerAlbum('Y');
              const b = albumEl.style.display !== 'none' && albumEl.textContent === 'Y';
              titleEl.textContent = oldTitle;
              return a && b ? 'ok' : 'fail';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // URL-Icon wechselt live aufs Plattform-Logo und zurück
          urlIconSwitch: (() => {
            try {
              const inp = document.getElementById('urlInput');
              const icon = document.getElementById('urlIcon');
              const old = inp.value;
              inp.value = 'https://open.spotify.com/track/x';
              updateUrlIcon(inp.value);
              const a = icon.style.color !== '';
              inp.value = 'https://example.com';
              updateUrlIcon(inp.value);
              const b = icon.style.color === '';
              inp.value = old;
              return a && b ? 'ok' : 'fail';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // History-Repair + Tools-Update Buttons existieren
          repairBtn: !!document.getElementById('repairHistory'),
          toolsBtn: !!document.getElementById('toolsUpdate'),
          // Toast mit data-goto-Link navigiert zu den Settings
          toastGoto: (() => {
            try {
              const el = document.getElementById('toast');
              el.innerHTML = '<a href="#" data-goto="Settings">go</a>';
              el.classList.add('show');
              const link = el.querySelector('a[data-goto]');
              link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              const nav = document.querySelector('.nav-item[data-view="Settings"]');
              const ok = nav && nav.classList.contains('active');
              el.classList.remove('show');
              return ok ? 'ok' : 'fail';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // Hotkeys wie Spotify/Browser: F4 zurück, F5 Play/Pause, F6 weiter.
          // Stubt die drei Funktionen und prüft die Zuordnung per dispatchEvent,
          // inkl. Ignorieren von unbekannten Tasten und Modifier-Kombis (Ctrl+F5).
          hotkeys: (() => {
            try {
              const calls = [];
              const oNext = nextTrack, oPrev = prevTrack, oToggle = togglePlay;
              nextTrack = () => calls.push('next');
              prevTrack = () => calls.push('prev');
              togglePlay = () => calls.push('toggle');
              const fire = (key, mods = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...mods }));
              fire('F6'); fire('F5'); fire('F4'); fire('F7'); fire('F5', { ctrlKey: true });
              nextTrack = oNext; prevTrack = oPrev; togglePlay = oToggle;
              const mapping = calls.join(',');
              const settingsHint = [...document.querySelectorAll('#settingsView .kbd')].map(k => k.textContent).join(',');
              const ok = mapping === 'next,toggle,prev' && settingsHint === 'F4,F5,F6';
              return ok ? 'ok' : 'fail(calls=' + mapping + ',kbd=' + settingsHint + ')';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          historySingleCard,
          globalHotkeys,
          // In-App-Browser: Bridge vorhanden + IPC-Kette Main→Renderer (derselbe
          // Pfad wie der echte „Download“-Knopf im Browser-Fenster), plus die
          // Browser-Chrome-Seite mit <webview> wird vom Server ausgeliefert.
          browserBridge: await (async () => {
            try {
              const native = window.smokyDesktopNative;
              const bridge = native && typeof native.openBrowser === 'function' && typeof native.onBrowserDownload === 'function' && typeof native.browserTestFire === 'function';
              const received = [];
              window.smokyDesktop.onBrowserDownload((url) => received.push(url));
              await native.browserTestFire('https://example.com/test-video-123');
              await new Promise((r) => setTimeout(r, 300));
              const wiring = received.includes('https://example.com/test-video-123') ? 'ok' : 'fail(received=' + received.join(',') + ')';
              let page = null;
              try {
                const res = await fetch('/browser.html');
                const html = await res.text();
                page = (res.status === 200 && html.includes('<webview') && html.includes('sendDownload')) ? 'ok' : 'fail(status=' + res.status + ')';
              } catch (e) { page = 'err-' + String(e && e.message || e); }
              return { bridge, wiring, page };
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // Ambient-Player: großes Layout mit Schallplatte, Cover, Tags und
          // Controls. Die Schallplatte dreht nur bei laufender Musik; die
          // Buttons rufen die echten Player-Funktionen (stubbed).
          ambient: await (async () => {
            try {
              const hook = window.__ambient;
              if (!hook || typeof hook.open !== 'function') return 'fail(no-hook)';
              hook.open();
              await new Promise((r) => setTimeout(r, 200));
              const el = document.querySelector('.ambient-mode');
              const okEl = !!el;
              const disc = hook.disc();
              const cover = el && el.querySelector('#ambientCover');
              const titleEl = el && document.getElementById('ambientTitle');
              const info = el && el.querySelector('.ambient-info');
              const controls = el && ['ambientPlay', 'ambientNext', 'ambientPrev', 'ambientSeek', 'ambientVolume'].every((id) => !!document.getElementById(id));
              const calls = [];
              const oT = togglePlay, oN = nextTrack, oP = prevTrack;
              togglePlay = () => calls.push('toggle');
              nextTrack = () => calls.push('next');
              prevTrack = () => calls.push('prev');
              document.getElementById('ambientPlay').click();
              document.getElementById('ambientNext').click();
              document.getElementById('ambientPrev').click();
              togglePlay = oT; nextTrack = oN; prevTrack = oP;
              const wiring = calls.join(',') === 'toggle,next,prev';
              window.__ambientForcePlaying = true;
              await new Promise((r) => setTimeout(r, 500));
              const spinOn = disc && disc.classList.contains('spinning');
              window.__ambientForcePlaying = false;
              await new Promise((r) => setTimeout(r, 500));
              const spinOff = disc && !disc.classList.contains('spinning');
              const hadTitle = !!titleEl; // Element muss existieren (Inhalt hängt von der Bibliothek ab)
              hook.close();
              const closed = !document.querySelector('.ambient-mode');
              const ok = okEl && !!disc && !!cover && !!info && controls && wiring && spinOn && spinOff && hadTitle && closed;
              return ok ? 'ok' : 'fail(el=' + !!okEl + ',disc=' + !!disc + ',cover=' + !!cover + ',info=' + !!info + ',ctrls=' + !!controls + ',wire=' + wiring + ',spinOn=' + spinOn + ',spinOff=' + spinOff + ',title=' + !!hadTitle + ',closed=' + closed + ')';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })()
        };
        })()`);
        console.log('SMOKE_OK ' + JSON.stringify(result));
      } catch (err) {
        console.log('SMOKE_FAIL ' + String(err && err.message || err));
      }
      try { globalShortcut.unregisterAll(); } catch {}
      app.exit(0);
    });
  }
});
}

app.on('window-all-closed', () => app.quit());

// --------------------------------------------------- In-App-Browser ----
// Variante B: ein separates Browser-Fenster mit Toolbar (zurück/vor/neu
// laden, Adresszeile) und „Download“-Knopf. Der Knopf schickt die aktuelle
// URL an das Hauptfenster → dort erscheint das bekannte Download-Banner
// (derselbe Pfad wie die Clipboard-Erkennung).
function openBrowser() {
  if (browserWin && !browserWin.isDestroyed()) {
    browserWin.show();
    browserWin.focus();
    return;
  }
  browserWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: 'Smoky Browser',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0b0e16',
    webPreferences: {
      preload: path.join(__dirname, 'browser-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  browserWin.loadFile(path.join(__dirname, '..', 'public', 'browser.html'));
  browserWin.on('closed', () => { browserWin = null; });
}

// ------------------------------------------------------------- IPC --------
ipcMain.handle('browser:open', () => { openBrowser(); return true; });

// URL aus dem Browser-Fenster → Hauptfenster (Download-Banner).
ipcMain.on('browser:download-url', (_event, url) => {
  if (/^https?:/i.test(String(url || '')) && win && !win.isDestroyed()) {
    win.webContents.send('browser:download', String(url));
  }
});

// Smoke/Dev: denselben IPC-Pfad wie ein echter Download-Knopf testen.
ipcMain.handle('browser:test-fire', (_event, url) => {
  if (win && !win.isDestroyed()) win.webContents.send('browser:download', String(url || ''));
  return true;
});

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

// Update-Fortschritt an die Seite melden (Download-%, Entpacken, Fehler).
function sendUpdateProgress(p) {
  try { if (win && !win.isDestroyed()) win.webContents.send('update:progress', p); } catch {}
}

async function runUpdate(url) {
  if (updating) return { ok: false, error: 'Update already in progress' };
  updating = true;
  try {
    // Kein blockierender Modal mehr — die Seite zeigt einen echten Fortschrittsbalken.
    sendUpdateProgress({ phase: 'download', received: 0, total: 0, percent: 0 });
    await updater.applyUpdate(url, {
      appDir: path.dirname(process.execPath),
      execPath: process.execPath,
      userData: app.getPath('userData'),
      log,
      onProgress: sendUpdateProgress,
    });
    app.exit(0);
    return { ok: true };
  } catch (e) {
    updating = false;
    log('update failed:', e && e.stack || e);
    sendUpdateProgress({ phase: 'error', message: String(e && e.message || e) });
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

// Registrierungsstatus der globalen Hotkeys (für Settings-UI/Smoke-Report).
ipcMain.handle('hotkeys:state', () => {
  try {
    const out = {};
    for (const key of Object.keys(GLOBAL_HOTKEYS)) out[key] = globalShortcut.isRegistered(key);
    return out;
  } catch { return {}; }
});

// Test-Hook für den Smoke-Test: feuert denselben Pfad wie ein echter globaler
// Tastendruck (IPC an die Seite) — ohne wirklich F4/F5/F6 zu drücken.
ipcMain.handle('hotkeys:test-fire', (_event, actions) => {
  for (const a of actions || []) fireHotkey(a);
  return true;
});
