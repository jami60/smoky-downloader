// Smoky — Electron preload.
// Exposes native capabilities to the page; desktop-shim.js merges them into
// window.smokyDesktop when present.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smokyDesktopNative', {
  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('win:maximize'),
  closeWindow: () => ipcRenderer.invoke('win:close'),
  chooseFolder: async () => {
    const r = await ipcRenderer.invoke('dialog:chooseFolder');
    return r && r.path ? r.path : null;
  },
  chooseFile: async () => {
    const r = await ipcRenderer.invoke('dialog:chooseFile');
    return r && r.path ? r.path : null;
  },
  chooseFiles: async () => {
    const r = await ipcRenderer.invoke('dialog:chooseFiles');
    return r && r.paths ? r.paths : [];
  },
  openFolder: (dir) => ipcRenderer.invoke('shell:openPath', dir),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  deleteFile: (filePath) => ipcRenderer.invoke('fs:deleteFile', filePath),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  applyUpdate: (url) => ipcRenderer.invoke('updates:apply', url),
  // Clipboard-Erkennung: main.js meldet erkannte Download-Links an die Seite.
  onClipboardUrl: (cb) => ipcRenderer.on('clipboard:url', (_e, url) => { try { cb(url); } catch {} }),
  // Update-Fortschritt: main.js meldet Download-% / Entpacken / Fehler an die Seite.
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => { try { cb(p); } catch {} }),
  // Globale Hotkeys (F4/F5/F6): main.js meldet Tastendrücke an die Seite —
  // funktionieren auch, wenn die App nicht im Fokus ist.
  onGlobalHotkey: (cb) => ipcRenderer.on('player:hotkey', (_e, action) => { try { cb(action); } catch {} }),
  // In-App-Browser: Fenster öffnen + Downloads aus dem Browser-Fenster empfangen.
  openBrowser: () => ipcRenderer.invoke('browser:open'),
  onBrowserDownload: (cb) => ipcRenderer.on('browser:download', (_e, url) => { try { cb(url); } catch {} }),
  browserTestFire: (url) => ipcRenderer.invoke('browser:test-fire', url),
  // Smoke/Dev: Registrierungsstatus der globalen Hotkeys + Test-Feuer über
  // denselben IPC-Pfad wie ein echter Tastendruck.
  hotkeyState: () => ipcRenderer.invoke('hotkeys:state'),
  hotkeyTestFire: (actions) => ipcRenderer.invoke('hotkeys:test-fire', actions),
});
