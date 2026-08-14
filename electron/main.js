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
const DISCORD_CLIENT_ID = process.env.SMOKY_DISCORD_ID || '';
const discord = new DiscordRPC(DISCORD_CLIENT_ID);
discord.start(); // verbindet nur, wenn die ID gültig ist (siehe hasValidId)
const APP_VERSION = (() => { try { return require('../package.json').version; } catch { return '0.0.0'; } })();

const SMOKE = process.argv.includes('--smoke');
// Klassische (nicht Overlay-)Scrollbars erzwingen, damit der Smoke die
// echte User-Umgebung abbildet (Overlay-Scrollbars nehmen keinen Platz und
// würden den Tab-Shift unsichtbar machen).
if (SMOKE) { try { app.commandLine.appendSwitch('disable-features', 'OverlayScrollbar'); } catch {} }
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
    width: SMOKE ? 1920 : 1440,
    height: SMOKE ? 1080 : 900,
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
  let discordConfigId = null; // letzte an Discord übergebene App-ID
  setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      const s = await res.json();
      // Discord Rich Presence konfigurieren: Client-ID aus den Einstellungen
      // (Server-Settings), RPC nur wenn aktiviert. Nur bei Änderung neu verbinden.
      const sid = (s.settings && s.settings.discordClientId) ? String(s.settings.discordClientId).trim() : '';
      const rpcOn = !(s.settings && s.settings.discordRpc === false);
      const effId = rpcOn ? (sid || DISCORD_CLIENT_ID) : '';
      if (effId !== discordConfigId) { discordConfigId = effId; discord.setClientId(effId); }

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
      } else if (s.player && s.player.title) {
        const p = s.player;
        const act = { details: `🎵 ${p.title}` };
        if (p.artist) act.state = p.album && p.album !== p.title ? `${p.artist} · ${p.album}` : p.artist;
        else if (p.album && p.album !== p.title) act.state = p.album;
        else act.state = 'Musik-Player';
        if (p.playing) {
          // Start/Ende aus Server-Zeit + Position/Dauer ableiten (ohne
          // sekündliche Renderer-Posts). updatedAt ist die letzte Meldung.
          if (p.updatedAt && Number.isFinite(p.position) && p.position >= 0) {
            const start = p.updatedAt - Math.round(p.position * 1000);
            const t = { start };
            if (p.duration) t.end = start + Math.round(p.duration * 1000);
            act.timestamps = t;
          }
        } else {
          act.state = `⏸ ${act.state}`;
        }
        // Großes Bild: Discord kann lokale http://127.0.0.1-URLs nicht laden
        // (es braucht öffentliche HTTPS-URLs). Deshalb nur ein statisches
        // Art-Asset aus dem Portal (Rich Presence → Art Assets → Key).
        // Ohne Key bleibt die Presence text-only — kein kaputtes Fragezeichen.
        const assetKey = (s.settings && s.settings.discordAssetKey) ? String(s.settings.discordAssetKey).trim() : '';
        if (assetKey) act.assets = { large_image: assetKey, large_text: p.title };
        discord.setActivity(act);
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
  loadUI(win, port);

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
          // Discord: Settings-Felder + GitHub-Button + openExternal-Bridge
          discordUi: (() => {
            const ids = ['discordClientId', 'discordClientSecret', 'discordRpcToggle', 'discordConnect', 'discordProfile'];
            const missing = ids.filter((id) => !document.getElementById(id));
            const repo = !!document.getElementById('openGithub');
            const bridge = typeof (window.smokyDesktopNative && window.smokyDesktopNative.openExternal) === 'function';
            return !missing.length && repo && bridge ? 'ok' : 'fail(missing=' + missing.join(',') + ',repo=' + repo + ',bridge=' + bridge + ')';
          })(),
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
              const titleEl = el && document.getElementById('ambientTrackTitle');
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
              // Regression: Beim echten Skip muss der Overlay-Titel mitziehen.
              // Früher kollidierte die id="ambientTitle" mit dem Settings-Label
              // und die Titel-Updates landeten dort — der Overlay-Titel blieb
              // beim Öffnen stehen. Das Settings-Label darf nie Track-Titel
              // bekommen und die neue ID darf nur einmal existieren.
              const oLib = library, oIdx = currentIndex, oShuffle = shuffleOn;
              library = [
                { path: 'X:\\smoky-reg\\a.mp3', title: 'Regression A', artist: 'A', album: 'A' },
                { path: 'X:\\smoky-reg\\b.mp3', title: 'Regression B', artist: 'B', album: 'B' },
              ];
              currentIndex = 0; shuffleOn = false;
              nextTrack();
              await new Promise((r) => setTimeout(r, 700));
              const ovTitle = document.querySelector('.ambient-mode #ambientTrackTitle');
              const stLabel = document.querySelector('strong#ambientTitle');
              const overlayText = ovTitle ? ovTitle.textContent : null;
              const settingsText = stLabel ? stLabel.textContent : null;
              const regOk = overlayText === 'Regression B' && settingsText !== 'Regression B' && document.querySelectorAll('#ambientTrackTitle').length === 1;
              library = oLib; currentIndex = oIdx; shuffleOn = oShuffle;
              renderLibrary();
              hook.close();
              const closed = !document.querySelector('.ambient-mode');
              const ok = okEl && !!disc && !!cover && !!info && controls && wiring && spinOn && spinOff && hadTitle && regOk && closed;
              return ok ? 'ok' : 'fail(el=' + !!okEl + ',disc=' + !!disc + ',cover=' + !!cover + ',info=' + !!info + ',ctrls=' + !!controls + ',wire=' + wiring + ',spinOn=' + spinOn + ',spinOff=' + spinOff + ',title=' + !!hadTitle + ',reg=' + regOk + ',closed=' + closed + ')';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // Alben-Ansicht: Toggle Songs/Alben, Cover-Grid gruppiert nach Album-Tag,
          // Drill-Down mit Back + Play-Album, Einzeltracks-Gruppe (Album == Titel
          // bzw. fehlender Album-Tag) und die Album-Queue (Next/Prev bleiben im Album).
          albums: await (async () => {
            try {
              const oLib = library, oQuery = playerQuery, oView = libraryView, oOpen = albumOpen, oQueue = playQueue, oIdx = currentIndex, oShuffle = shuffleOn;
              library = [
                { path: 'X:\\smoky-reg\\a1.mp3', title: 'Alpha One', artist: 'X', album: 'Greatest Hits' },
                { path: 'X:\\smoky-reg\\a2.mp3', title: 'Alpha Two', artist: 'X', album: 'Greatest Hits' },
                { path: 'X:\\smoky-reg\\b1.mp3', title: 'Beta One', artist: 'Y', album: 'Other Side' },
                { path: 'X:\\smoky-reg\\s1.mp3', title: 'Solo One', artist: 'Z', album: 'Solo One' },
                { path: 'X:\\smoky-reg\\s2.mp3', title: 'Solo Two', artist: 'Z', album: '' },
              ];
              playerQuery = ''; currentIndex = -1; shuffleOn = false;
              document.querySelector('#libraryViewToggle [data-mode="albums"]').click();
              await new Promise((r) => setTimeout(r, 60));
              const cards = [...document.querySelectorAll('.album-card')];
              const info = (c) => (c.querySelector('.album-card-info b') || {}).textContent || '';
              const names = cards.map(info).join('|');
              const counts = cards.map((c) => (c.querySelector('.album-card-info span') || {}).textContent || '').join('|');
              const gridOk = cards.length === 3 && names.includes('Greatest Hits') && names.includes('Other Side') && (names.includes('Einzeltracks') || names.includes('Singles'));
              const singlesPos = names.split('|').indexOf('Einzeltracks') >= 0 ? names.split('|').indexOf('Einzeltracks') : names.split('|').indexOf('Singles');
              const singlesHas2 = singlesPos >= 0 && counts.split('|')[singlesPos].startsWith('2');
              const gh = cards.find((c) => info(c) === 'Greatest Hits');
              gh.click();
              await new Promise((r) => setTimeout(r, 60));
              const drillOk = !!document.querySelector('.album-back-btn') && !!document.querySelector('.album-play-all') && (document.querySelector('.album-open-title') || {}).textContent === 'Greatest Hits';
              const rows = [...document.querySelectorAll('.player-track')];
              const rowsOk = rows.length === 2 && rows[0].textContent.includes('Alpha One') && rows[1].textContent.includes('Alpha Two');
              const calls = [];
              const oPT = playTrack;
              playTrack = (i) => calls.push(i);
              document.querySelector('.album-play-all').click();
              nextTrack();
              playTrack = oPT;
              const queueOk = calls.length === 2 && calls[0] === 0 && calls[1] === 1;
              document.querySelector('.album-back-btn').click();
              await new Promise((r) => setTimeout(r, 60));
              const backOk = !!document.querySelector('.album-grid');
              const sInp = document.getElementById('playerSearch');
              const oVal = sInp.value;
              sInp.value = 'beta';
              playerQuery = 'beta';
              renderLibrary();
              const filteredOk = document.querySelectorAll('.album-card').length === 1 && info(document.querySelector('.album-card')) === 'Other Side';
              sInp.value = oVal;
              document.querySelector('#libraryViewToggle [data-mode="songs"]').click();
              library = oLib; playerQuery = oQuery; libraryView = oView; albumOpen = oOpen; playQueue = oQueue; playQueuePos = -1; currentIndex = oIdx; shuffleOn = oShuffle;
              renderLibrary();
              const ok = gridOk && singlesHas2 && drillOk && rowsOk && queueOk && backOk && filteredOk;
              return ok ? 'ok' : 'fail(grid=' + gridOk + ',singles=' + singlesHas2 + ',drill=' + drillOk + ',rows=' + rowsOk + ',queue=' + queueOk + ',back=' + backOk + ',filter=' + filteredOk + ',names=' + names + ')';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // Hintergrundmusik: 5 Tracks im Shuffle (3 bestehende + 2 neue:
          // Piedkies – landfall, leadwave – memories). Zufälliger Start, beim
          // Trackende ein zufälliger Nächster — nie zweimal derselbe direkt.
          bgmusic: (() => {
            try {
              const list = typeof bgTracks !== 'undefined' ? bgTracks : [];
              const hasAll = list.length === 5
                && list.includes('assets/bg-music.wav') && list.includes('assets/bg-2.wav') && list.includes('assets/bg-3.wav')
                && list.includes('assets/bg-4.mp3') && list.includes('assets/bg-5.mp3');
              const srcName = (typeof bgAudio !== 'undefined' && bgAudio.src) ? bgAudio.src.split('/').pop() : null;
              const srcOk = srcName !== null && list.some((t) => t.endsWith(srcName));
              let shuffleOk = typeof pickNextBgTrack === 'function';
              if (shuffleOk) {
                for (let cur = 0; cur < list.length && shuffleOk; cur++) {
                  for (let i = 0; i < 200; i++) { if (pickNextBgTrack(cur) === cur) { shuffleOk = false; break; } }
                }
              }
              const ok = hasAll && srcOk && shuffleOk;
              return ok ? 'ok' : 'fail(list=' + list.length + ',src=' + srcName + ',shuffle=' + shuffleOk + ')';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // Video-Player: Musik/Videos-Toggle, kind-Filter, <video>-Element bei
          // Video-Tracks (Cover/Waveform aus), Next/Prev bleiben bei Videos.
          videos: await (async () => {
            try {
              const oLib = library, oQuery = playerQuery, oKind = mediaKind, oView = libraryView, oIdx = currentIndex;
              library = [
                { path: 'X:\\smoky-reg\\s1.mp3', title: 'Song One', artist: 'A', album: '', kind: 'audio' },
                { path: 'X:\\smoky-reg\\s2.mp3', title: 'Song Two', artist: 'B', album: '', kind: 'audio' },
                { path: 'X:\\smoky-reg\\v1.mp4', title: 'Video One', artist: '', album: '', kind: 'video' },
                { path: 'X:\\smoky-reg\\v2.mp4', title: 'Video Two', artist: '', album: '', kind: 'video' },
              ];
              playerQuery = ''; currentIndex = -1;
              const audioBtn = document.querySelector('#mediaKindToggle [data-kind="audio"]');
              const videoBtn = document.querySelector('#mediaKindToggle [data-kind="video"]');
              if (audioBtn) audioBtn.click();
              await new Promise((r) => setTimeout(r, 60));
              const audioRows = [...document.querySelectorAll('.player-track')].map((r) => r.textContent);
              const audioOnly = audioRows.length === 2 && audioRows.join('|').includes('Song One') && audioRows.join('|').includes('Song Two') && !audioRows.join('|').includes('Video');
              const albumToggleVisible = !!document.getElementById('libraryViewToggle') && document.getElementById('libraryViewToggle').style.display !== 'none';
              if (videoBtn) videoBtn.click();
              await new Promise((r) => setTimeout(r, 60));
              const videoRows = [...document.querySelectorAll('.player-track')].map((r) => r.textContent);
              const videoOnly = videoRows.length === 2 && videoRows.join('|').includes('Video One') && videoRows.join('|').includes('Video Two') && !videoRows.join('|').includes('Song');
              const albumToggleHidden = document.getElementById('libraryViewToggle').style.display === 'none';
              // Video-Track abspielen → <video> sichtbar, <audio> pausiert
              const calls = [];
              const oPT = playTrack;
              playTrack = (i) => calls.push(i);
              const rowsAfter = [...document.querySelectorAll('.player-track')];
              const vIdx = library.findIndex((t) => t.title === 'Video One');
              playTrack = oPT;
              playTrack(vIdx);
              await new Promise((r) => setTimeout(r, 80));
              const pv = document.getElementById('playerVideo');
              const pa = document.getElementById('playerAudio');
              const pc = document.getElementById('playerCover');
              const pw = document.getElementById('playerWave');
              const videoShown = pv.style.display !== 'none' && !!pv.src && pc.style.display === 'none' && pw.style.display === 'none';
              const mediaEl = (typeof currentMedia === 'function') ? currentMedia() : null;
              const mediaIsVideo = mediaEl === pv;
              // Zurück zu Audio → <audio> wieder aktiv
              const sIdx = library.findIndex((t) => t.title === 'Song One');
              playTrack(sIdx);
              await new Promise((r) => setTimeout(r, 80));
              const audioShown = pa.src && pv.style.display === 'none' && pc.style.display !== 'none';
              const mediaIsAudio = currentMedia() === pa;
              // Next/Prev bleiben bei Videos (Stub aktiv lassen — nextTrack
              // ruft playTrack auf, das in calls landet)
              playTrack = (i) => calls.push(i);
              nextTrack();
              const nextStayedVideo = calls.length > 0 && library[calls[calls.length - 1]].kind === 'video';
              // Zurücksetzen
              document.querySelector('#mediaKindToggle [data-kind="audio"]').click();
              library = oLib; playerQuery = oQuery; mediaKind = oKind; libraryView = oView; currentIndex = oIdx;
              renderLibrary();
              const ok = audioOnly && albumToggleVisible && videoOnly && albumToggleHidden && videoShown && mediaIsVideo && audioShown && mediaIsAudio && nextStayedVideo;
              return ok ? 'ok' : 'fail(audioOnly=' + audioOnly + ',albumToggle=' + albumToggleVisible + ',videoOnly=' + videoOnly + ',albumHidden=' + albumToggleHidden + ',videoShown=' + videoShown + ',mediaVideo=' + mediaIsVideo + ',audioShown=' + audioShown + ',mediaAudio=' + mediaIsAudio + ',nextVideo=' + nextStayedVideo + ',rows=' + videoRows.length + ')';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          mita: (() => {
            try {
              const sticker = document.getElementById('mitaSticker');
              const toastEl = document.getElementById('mitaToast');
              const toggle = document.getElementById('mitaToggle');
              const before = localStorage.getItem('smoky-mita-disabled');
              // User-Flow: Toggle in Settings aktivieren → Change-Event →
              // Storage gesetzt, Sticker versteckt, mitaSay ist no-op
              toggle.checked = true;
              toggle.dispatchEvent(new Event('change'));
              const hidden = sticker.style.display === 'none';
              const stored = localStorage.getItem('smoky-mita-disabled') === '1';
              mitaSay('PROBE-TEXT');
              const noToast = !toastEl.classList.contains('show');
              // Zurück: Toggle deaktivieren → Sticker wieder da, mitaSay zeigt Toast
              toggle.checked = false;
              toggle.dispatchEvent(new Event('change'));
              const shown = sticker.style.display !== 'none';
              mitaSay('PROBE-TEXT');
              const withToast = toastEl.classList.contains('show');
              // Zurücksetzen
              toastEl.classList.remove('show');
              if (before === null) localStorage.removeItem('smoky-mita-disabled'); else localStorage.setItem('smoky-mita-disabled', before);
              const ok = hidden && stored && noToast && shown && withToast;
              return ok ? 'ok' : 'fail(hidden=' + hidden + ',stored=' + stored + ',noToast=' + noToast + ',shown=' + shown + ',withToast=' + withToast + ')';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // Layout-Stabilität: klassische Scrollbar darf den Inhalt NICHT
          // verschieben (Karten-Shift beim Tab-Wechsel). Mit scrollbar-gutter
          // stable bleibt innerWidth + main konstant, egal ob die vertikale
          // Scrollbar sichtbar ist oder nicht.
          layout: (() => {
            try {
              const html = document.documentElement;
              const mainEl = document.querySelector('main');
              const m = () => ({ w: window.innerWidth, l: Math.round(mainEl.getBoundingClientRect().left), mw: Math.round(mainEl.getBoundingClientRect().width) });
              html.style.overflowY = 'hidden';
              const a = m();
              html.style.overflowY = 'scroll';
              const b = m();
              html.style.overflowY = '';
              const gutter = getComputedStyle(html).scrollbarGutter;
              const ok = gutter === 'stable' && a.w === b.w && a.l === b.l && a.mw === b.mw;
              return ok ? 'ok' : 'fail(gutter=' + gutter + ',w=' + a.w + '\u2192' + b.w + ',left=' + a.l + '\u2192' + b.l + ',mw=' + a.mw + '\u2192' + b.mw + ')';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // Tab-Wechsel end-to-end (klassische Scrollbars im echten Fenster):
          // Durch alle Views schalten und main.left/innerWidth messen. Jede
          // Verschiebung (z. B. durch Scrollbar-Toggle auf Home/Downloader)
          // schlägt hier fehl. Zusätzlich wird der Fix selbst verifiziert:
          // scrollbar-gutter:stable entfernen → der Shift MUSS auftreten
          // (sonst wäre die Probe blind für den Bug).
          tabs: await (async () => {
            try {
              const html = document.documentElement;
              const mainEl = document.querySelector('main');
              // Hohe Seiten erzwingen (Home/Downloader sind im echten Betrieb
              // lang — Queue, History, Downloads). Ohne Länge kein Scrollbar-Toggle.
              const tall = document.getElementById('homeGrid');
              const prevMin = tall ? tall.style.minHeight : '';
              if (tall) tall.style.minHeight = Math.max(2400, window.innerHeight * 2.2) + 'px';
              const m = () => ({ w: window.innerWidth, l: Math.round(mainEl.getBoundingClientRect().left), mw: Math.round(mainEl.getBoundingClientRect().width) });
              const snap = () => {
                const pick = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width) }; };
                return {
                  innerW: window.innerWidth, clientW: document.documentElement.clientWidth,
                  bodyScrollW: document.body.scrollWidth, docScrollW: document.documentElement.scrollWidth,
                  dsw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
                  main: pick(mainEl), hero: pick(document.getElementById('homeHero')),
                  dlPanel: pick(document.getElementById('downloadPanel')), grid: pick(document.getElementById('homeGrid')),
                  queue: pick(document.querySelector('.queue-card')), side: pick(document.querySelector('.side-card')),
                  wsCard: pick(document.querySelector('.workspace-card')), viewHeader: pick(document.querySelector('.view-header')),
                };
              };
              const views = ['Home', 'Browser', 'Player', 'Queue', 'Converter', 'History'];
              const results = {};
              for (const v of views) {
                if (typeof showView === 'function') showView(v); else { document.querySelector('.nav-item[data-view="' + v + '"]')?.click(); }
                await new Promise((r) => setTimeout(r, 420));
                results[v] = snap();
              }
              // A) Mit Gutter-Fix: main + innerW müssen über ALLE Views identisch
              // sein (die einzigen überall vorhandenen Vergleichsgrößen).
              const base = results[views[0]];
              const bad = views.filter((k) => (results[k].main && results[k].main.l) !== (base.main && base.main.l) || results[k].innerW !== base.innerW);
              // B) Ohne Gutter-Fix (auf 'auto' setzen — '' würde nur die
              // Inline-Deklaration entfernen und die Stylesheet-Regel stable
              // wieder greifen lassen): der Shift MUSS auftreten, sonst ist die
              // Probe blind. Kurze Seite + lange Seite vergleichen.
              const gutterBefore = getComputedStyle(html).scrollbarGutter;
              html.style.scrollbarGutter = 'auto';
              showView('Home');
              await new Promise((r) => setTimeout(r, 420));
              const noGutterHome = m();
              showView('Browser');
              await new Promise((r) => setTimeout(r, 420));
              const noGutterBrowser = m();
              html.style.scrollbarGutter = gutterBefore;
              const noGutterShift = noGutterHome.l !== noGutterBrowser.l || noGutterHome.w !== noGutterBrowser.w;
              // Scrollbar-Breite messen: klassische Scrollbars → clientWidth < innerWidth.
              // WICHTIG: bei der LANGEN Seite messen (Home ist künstlich hoch).
              showView('Home');
              await new Promise((r) => setTimeout(r, 420));
              const sbWidth = window.innerWidth - document.documentElement.clientWidth;
              const gutterOk = getComputedStyle(html).scrollbarGutter === 'stable';
              if (tall) tall.style.minHeight = prevMin;
              // noGutterShift nur fordern, wenn klassische Scrollbars existieren
              // (sbW>0). Bei Overlay-Scrollbars (sbW=0) gibt es keinen Platz-
              // Shift — dann ist die Probe nicht blind, sondern nicht anwendbar.
              const ok = bad.length === 0 && gutterOk && (sbWidth === 0 || noGutterShift);
              // Kompakte Diagnose: pro View nur die 3 wichtigsten left-Werte.
              const brief = {};
              for (const k of views) { const r = results[k]; brief[k] = { i: r.innerW, m: r.main && r.main.l, d: r.dlPanel && r.dlPanel.l, q: r.queue && r.queue.l, dsw: r.dsw, cw: r.cw }; }
              return ok ? 'ok' : 'fail(shift=' + bad.map((k) => k + '(m' + (results[k].main && results[k].main.l) + ')').join(';') + ',gutter=' + gutterOk + ',noGutterShift=' + noGutterShift + ',sbW=' + sbWidth + ',brief=' + JSON.stringify(brief).replace(/"/g, '') + ')';
            } catch (e) { return 'err-' + String(e && e.message || e); }
          })(),
          // „Aufs Handy senden“: Button + Overlay + QR-Encoder müssen da sein;
          // der Encoder liefert eine gültige Matrix (Größe 21–41, 2D-Array).
          share: (() => {
            try {
              const btn = document.getElementById('shareToPhone');
              const overlay = document.getElementById('shareOverlay');
              const canvas = document.getElementById('shareQr');
              const urlInput = document.getElementById('shareUrl');
              const qrOk = typeof smokyQR === 'function' && (() => { const m = smokyQR('http://192.168.1.1:4174/share/test'); return !!m && m.size >= 21 && m.size <= 41 && Array.isArray(m.matrix); })();
              const ok = !!btn && !!overlay && !!canvas && !!urlInput && qrOk;
              return ok ? 'ok' : 'fail(btn=' + !!btn + ',overlay=' + !!overlay + ',canvas=' + !!canvas + ',url=' + !!urlInput + ',qr=' + qrOk + ')';
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

// Öffnet externe Links (GitHub-Repo, Discord-Entwicklerportal, OAuth-Authorize)
// im Standard-Browser. Nur http/https — nie file:// o. ä.
ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'invalid url' };
  try {
    await shell.openExternal(String(url));
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

// ------------------------------------------------------------------ window --
// loadUI(win, port): UI robust laden. Nach einem Update-Relaunch kann der
// allererste Navigationsversuch scheitern (ERR_EMPTY_RESPONSE — z. B. wenn
// der alte Server-Socket die Verbindung noch schluckt oder der AV-Scan den
// frischen Asar bremst). Statt das Fenster unsichtbar zu lassen (ready-to-show
// feuert nie), wird die URL mit Pause wiederholt, bis die Seite wirklich lädt.
// Retry ist bewusst zäh (25 × 800 ms ≈ 20 s), damit auch ein träger Start
// nach dem Update-Relanch zuverlässig durchkommt.
function loadUI(win, port) {
  let attempts = 0;
  const MAX_ATTEMPTS = 25;
  const RETRY_MS = 800;
  const attempt = () => {
    if (attempts >= MAX_ATTEMPTS) {
      log('loadUI: giving up after ' + MAX_ATTEMPTS + ' attempts');
      return;
    }
    attempts++;
    win.loadURL(`http://127.0.0.1:${port}`).catch(() => {
      if (attempts < MAX_ATTEMPTS) {
        log('loadUI: attempt ' + attempts + ' failed, retrying in ' + RETRY_MS + ' ms');
        setTimeout(attempt, RETRY_MS);
      } else {
        log('loadUI: attempt ' + attempts + ' failed, giving up');
      }
    });
  };
  attempt();
}

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
