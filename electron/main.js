// Smoky — Electron main process.
// Runs the local Node backend in-process and opens the UI in a frameless window.
const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { startServer } = require('../server.js');

const SMOKE = process.argv.includes('--smoke');
let win = null;

app.whenReady().then(async () => {
  // Stable port so localStorage (theme, music, guide flag) persists across launches.
  // Fall back to the next candidate if one is taken, then to a random free port.
  let port = null;
  for (const candidate of [4290, 4291, 4292, 4293, 4294]) {
    try { port = await startServer(candidate, true); break; } catch { /* try next */ }
  }
  if (!port) port = await startServer(0, true); // random free local port

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
  win.webContents.setWindowOpenHandler(({ url }) => {
    // open external links (e.g. the YouTube channel) in the system browser
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://127.0.0.1:${port}`);

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
