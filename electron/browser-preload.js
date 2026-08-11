// Smoky — Browser-Window preload.
// Exposes exactly one capability to the browser chrome page: send the current
// URL to the main window, where Smoky's downloader picks it up (Clip-Banner).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smokyBrowser', {
  sendDownload: (url) => ipcRenderer.send('browser:download-url', String(url || '')),
});
