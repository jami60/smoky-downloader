/* ============================================================
   Smoky — desktop bridge (browser implementation)
   Replaces the Electron/Tauri bridge that the original UI
   expected, wiring every tab to the local Node backend.
   ============================================================ */
window.smokyDesktop = (() => {
  const native = window.smokyDesktopNative || null; // Electron preload
  const downloadListeners = [];
  const convertListeners = [];
  const seenTitles = new Map();       // id -> last emitted title
  const terminalEmitted = new Map();  // id -> Set('complete'|'error'|'cancelled')
  const convertTerminal = new Map();  // conversion id -> Set
  let polling = false;

  const api = async (path, opts) => {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  const emit = (list, update) => { list.forEach((cb) => { try { cb(update); } catch {} }); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // ------------------------------------------------------------- API ----
  const desktop = {
    // window chrome — native in Electron, no-op in the browser preview
    minimizeWindow() { return native && native.minimizeWindow(); },
    toggleMaximize() { return native && native.toggleMaximize(); },
    closeWindow() { return native && native.closeWindow(); },

    async chooseFolder() {
      if (native && native.chooseFolder) {
        return native.chooseFolder();
      }
      const label = document.getElementById('folderLabel');
      const current = (label && label.textContent && label.textContent !== 'Downloads folder') ? label.textContent : '';
      const value = window.prompt('Downloads folder (full path):', current || '');
      return value && value.trim() ? value.trim() : null;
    },

    async chooseFile() {
      if (native && native.chooseFile) {
        return native.chooseFile(); // real local path from the native dialog
      }
      const input = document.createElement('input');
      input.type = 'file';
      const file = await new Promise((resolve) => {
        input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
        input.click();
      });
      if (!file) return null;
      try {
        const data = await api('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
          body: file,
        });
        return data.path;
      } catch (e) {
        window.smokyToast && window.smokyToast('Could not upload file: ' + esc(e.message));
        return null;
      }
    },

    async chooseFiles() {
      if (native && native.chooseFiles) {
        return native.chooseFiles(); // multi-select native dialog
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      const files = await new Promise((resolve) => {
        input.onchange = () => resolve(input.files ? [...input.files] : []);
        input.click();
      });
      if (!files.length) return [];
      const out = [];
      for (const file of files) {
        try {
          const data = await api('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
            body: file,
          });
          out.push(data.path);
        } catch (e) {
          window.smokyToast && window.smokyToast('Could not upload ' + esc(file.name) + ': ' + esc(e.message));
        }
      }
      return out;
    },

    async startDownload({ url, format, quality, outputDir, browserName, tracks }) {
      const data = await api('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url, format: format || 'mp4', quality: quality || '1080', outputDir: outputDir || null, browserName: browserName || 'none',
          tracks: Array.isArray(tracks) && tracks.length ? tracks : null,
        }),
      });
      return { id: data.item.id };
    },

    async cancelDownload(id) {
      await api('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    },

    async openFolder(dir) {
      if (native && native.openFolder) {
        return native.openFolder(dir || null);
      }
      await api('/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir || null }) });
    },

    async deleteFile(filePath) {
      if (native && native.deleteFile) {
        return native.deleteFile(filePath);
      }
      await api('/api/delete-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }) });
    },

    async startConvert({ inputPath, format }) {
      const data = await api('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: inputPath, format: format || 'mp3' }),
      });
      return { id: data.item.id };
    },

    async checkForUpdates() {
      if (native && native.checkForUpdates) return native.checkForUpdates();
      return { error: 'Updates are only available in the desktop app.' };
    },
    async applyUpdate(url) {
      if (native && native.applyUpdate) return native.applyUpdate(url);
      return { error: 'Updates are only available in the desktop app.' };
    },

    onDownloadUpdate(cb) { downloadListeners.push(cb); startPolling(); },
    onConvertUpdate(cb) { convertListeners.push(cb); startPolling(); },
    onClipboardUrl(cb) {
      if (native && native.onClipboardUrl) native.onClipboardUrl(cb);
      // Dev-Hook für Tests ohne Electron
      (window.__clipboardCbs = window.__clipboardCbs || []).push(cb);
    },
    onUpdateProgress(cb) {
      if (native && native.onUpdateProgress) native.onUpdateProgress(cb);
    },
  };

  // ---------------------------------------------- download event mapping --
  const mapDownload = (item) => {
    const id = item.id;
    const once = (state) => {
      const set = terminalEmitted.get(id) || new Set();
      if (set.has(state)) return false;
      set.add(state);
      terminalEmitted.set(id, set);
      return true;
    };

    if (item.title && item.title !== 'Resolving link…' && item.title !== 'Spotify track…' && item.title !== 'Spotify playlist…' && seenTitles.get(id) !== item.title) {
      seenTitles.set(id, item.title);
      emit(downloadListeners, { id, state: 'metadata', title: item.title });
    }

    switch (item.status) {
      case 'queued':
        return { id, state: 'resolving', message: 'Waiting in queue…' };
      case 'downloading':
        return { id, state: 'downloading', percent: item.percent || 0, speed: item.speed, eta: item.eta, trackIndex: item.trackIndex, trackCount: item.trackCount };
      case 'processing':
        return { id, state: 'downloading', percent: item.percent || 0, speed: item.speed, eta: item.eta, trackIndex: item.trackIndex, trackCount: item.trackCount };
      case 'finished':
        if (!once('complete')) return null;
        return { id, state: 'complete', outputDir: item.folder, filePath: item.file || null, bytes: item.bytes || null };
      case 'failed':
        if (!once('error')) return null;
        return { id, state: 'error', message: item.error || 'Download failed' };
      case 'cancelled':
        if (!once('cancelled')) return null;
        return { id, state: 'cancelled' };
      default:
        return null;
    }
  };

  const mapConvert = (c) => {
    const id = c.id;
    const once = (state) => {
      const set = convertTerminal.get(id) || new Set();
      if (set.has(state)) return false;
      set.add(state);
      convertTerminal.set(id, set);
      return true;
    };
    if (c.status === 'finished') {
      if (!once('complete')) return null;
      return { state: 'complete', outputPath: c.output || '' };
    }
    if (c.status === 'failed') {
      if (!once('error')) return null;
      return { state: 'error', message: c.error || 'Conversion failed' };
    }
    return { state: 'starting' };
  };

  // ----------------------------------------------------- history rendering --
  const historyCard = () => {
    const view = document.getElementById('historyView');
    return view ? view.querySelector('.workspace-card') : null;
  };
  const recentCard = () => {
    const side = document.querySelector('.side-stack');
    const cards = side ? side.querySelectorAll('.side-card') : [];
    return cards.length > 1 ? cards[1] : null;
  };

  const fmtTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const renderHistory = (history) => {
    const card = historyCard();
    if (!card) return;
    if (!history.length) {
      card.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></div><span>Your local history will appear here after the first download.</span></div>';
      return;
    }
    card.innerHTML = history.slice(0, 60).map((h) => `
      <div class="recent-row" style="align-items:center">
        <div class="recent-avatar">${esc((h.format || 'M').charAt(0))}</div>
        <div class="recent-copy"><b>${esc(h.title)}</b><span>${esc(h.format)} · ${esc(h.folder || '')}</span></div>
        <span style="font-size:10px;color:var(--muted-2)">${fmtTime(h.finishedAt)}</span>
      </div>`).join('');
  };

  const renderRecent = (history) => {
    const card = recentCard();
    if (!card) return;
    const items = history.slice(0, 4);
    if (!items.length) return; // keep the built-in empty state
    card.innerHTML = items.map((h) => `
      <div class="recent-row">
        <div class="recent-avatar">${esc((h.format || 'M').charAt(0))}</div>
        <div class="recent-copy"><b>${esc(h.title)}</b><span>${esc(h.format)}</span></div>
        <span>✓</span>
      </div>`).join('');
  };

  const wireLinks = () => {
    const go = (view) => {
      const nav = document.querySelector(`.nav-item[data-view="${view}"]`);
      if (nav) nav.click();
    };
    document.querySelectorAll('.section-link').forEach((b) => {
      if (b.textContent.trim() === 'View all') b.addEventListener('click', () => go('History'));
      if (b.textContent.trim() === 'Customize') b.addEventListener('click', () => go('Settings'));
    });
    const clearBtn = document.getElementById('clearHistory');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        try { await api('/api/history-clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
        const card = historyCard();
        if (card) card.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></div><span>Your local history will appear here after the first download.</span></div>';
      });
    }
  };

  // ------------------------------------------------------------- poll -----
  const startPolling = () => {
    if (polling) return;
    polling = true;
    const tick = async () => {
      try {
        const s = await api('/api/status');
        // storage meter
        const pct = Math.min(100, s.storage.percent || 0);
        const meter = document.querySelector('.meter i');
        if (meter) meter.style.width = pct + '%';
        const meta = document.querySelector('.storage-meta span:last-child');
        if (meta && meta.textContent.trim().endsWith('%')) meta.textContent = pct + '%';
        // downloads + conversions
        (s.queue || []).forEach((item) => {
          // Nach einem UI-Reload fehlende Queue-Einträge rekonstruieren, damit
          // aktive Downloads nicht unsichtbar weiterlaufen.
          if (window.__ensureQueueItem) { try { window.__ensureQueueItem(item); } catch {} }
          const u = mapDownload(item); if (u) emit(downloadListeners, u);
        });
        (s.conversions || []).forEach((c) => { const u = mapConvert(c); if (u) emit(convertListeners, u); });
        // Dedup-Maps aufräumen, sobald ein Eintrag die Server-Queue verlassen hat
        // (sonst wachsen sie über lange Sessions unbegrenzt).
        const liveIds = new Set((s.queue || []).map((q) => q.id));
        for (const id of [...terminalEmitted.keys()]) if (!liveIds.has(id)) terminalEmitted.delete(id);
        for (const id of [...seenTitles.keys()]) if (!liveIds.has(id)) seenTitles.delete(id);
        // history views
        if (document.body.dataset.view === 'History') renderHistory(s.history || []);
        if (s.history && s.history.length) renderRecent(s.history);
      } catch { /* server briefly unreachable */ }
    };
    tick();
    setInterval(tick, 1200);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireLinks);
  else wireLinks();

  return desktop;
})();
