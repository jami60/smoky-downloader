/* ============================================================
   Smoky — frontend logic
   ============================================================ */

// ---------------------------------------------------------------- icons ---
const ICONS = {
  home: '<path d="m3 10.5 9-7.5 9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9-6.2-3.3L5.8 21 7 14.2l-5-4.9 6.9-1z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1.2"/><rect x="14" y="4" width="4" height="16" rx="1.2"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  'arrow-down': '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  'circle-down': '<circle cx="12" cy="12" r="9"/><path d="M12 8v8"/><path d="m8.5 12.5 3.5 3.5 3.5-3.5"/>',
  'upload': '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 21h16"/>',
  'play': '<path d="M7 4.5v15l13-7.5z"/>',
  'music': '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  'camera': '<rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="M8.5 6 10 3.5h4L15.5 6"/>',
  'cloud': '<path d="M17.5 19H6a4 4 0 0 1-.8-7.9A5.5 5.5 0 0 1 16 8.6a3.5 3.5 0 0 1 1.5 10.4z"/>',
};

// brand-style icons (filled)
const BRAND_ICONS = {
  yt: '<rect x="1.5" y="5" width="21" height="14" rx="4" fill="#ff4b3e"/><path d="M10 9.2v5.6l5-2.8z" fill="#fff"/>',
  tiktok: '<path d="M14.5 3v10.4a3.6 3.6 0 1 1-3.6-3.6" fill="none" stroke="#22d3ee" stroke-width="2" stroke-linecap="round"/><path d="M14.5 3c.3 2.5 1.8 4.3 4.5 4.6V10c-1.9 0-3.4-.7-4.5-1.9" fill="#ff3d77"/>',
  ig: '<rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="url(#igGrad)" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="url(#igGrad)" stroke-width="2"/><circle cx="17" cy="7" r="1.3" fill="url(#igGrad)"/>',
  vimeo: '<path d="M3 8.2 4.4 10c.6-.5 1.1-1 1.6-1.2.7-.2 1.3.3 1.8 1.2.5 1.1 1.2 3.6 1.8 5 .6 1.4 1.5 1.6 2.5.4.9-1.1 2.6-3.5 3.6-5.2 1.2-2 2-2.6 2.9-2 .8.6-.6 3.5-.8 4-.3.7-.4 1.2-.1 1.7.5.8 1.4.7 2.2.2.6-.4 1.6-1.3 2-1.9" fill="none" stroke="#35c3ff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  soundcloud: '<path d="M2 14.5h1.5v3.6H2zM5 13.2h1.5v5H5zM8 12h1.5v6.2H8zM11 11h1.5v7.4H11z" fill="#ff8c42"/><path d="M14 13.4a3 3 0 0 1 5.6-1.4 2.7 2.7 0 0 1-.4 5.4H14z" fill="#ff8c42"/>',
  spotify: '<circle cx="12" cy="12" r="9.5" fill="#1db954"/><path d="M7.5 9.5c3.2-1 6.4-.6 9 .9" stroke="#0b2414" stroke-width="1.6" stroke-linecap="round" fill="none"/><path d="M7.8 12.2c2.6-.8 5.1-.5 7.3.8" stroke="#0b2414" stroke-width="1.6" stroke-linecap="round" fill="none"/><path d="M8.1 14.8c2-.6 3.9-.4 5.6.6" stroke="#0b2414" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
};

function injectIcons() {
  const defs = '<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="igGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#feda75"/><stop offset=".5" stop-color="#d62976"/><stop offset="1" stop-color="#962fbf"/></linearGradient></defs></svg>';
  document.body.insertAdjacentHTML('afterbegin', defs);
  document.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.dataset.icon;
    const svg = BRAND_ICONS[name] || ICONS[name];
    if (!svg) return;
    const stroke = !(name in BRAND_ICONS);
    el.outerHTML = `<svg viewBox="0 0 24 24" fill="${stroke ? 'none' : ''}" stroke="${stroke ? 'currentColor' : ''}" stroke-width="${stroke ? 2 : 0}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg}</svg>`;
  });
}

// ---------------------------------------------------------------- state ---
const state = {
  queue: [],
  history: [],
  conversions: [],
  settings: { folder: '', format: 'mp4-1080', quality: 'best', ambientSnow: true, theme: 'smoky' },
  storage: { percent: 34, folder: '' },
  tools: { ytdlp: true, spotdl: false, ffmpeg: true },
  paused: false,
  page: 'home',
};

const THEMES = ['smoky', 'midnight', 'amethyst', 'ember', 'paper'];

function applyTheme(name) {
  const theme = THEMES.includes(name) ? name : 'smoky';
  document.documentElement.dataset.theme = theme;
  $$('.theme-swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// -------------------------------------------------------------- routing ---
const PAGE_CRUMBS = {
  home: ['Home', 'Workspace'],
  downloader: ['Downloader', 'Workspace'],
  queue: ['Queue', 'Workspace'],
  converter: ['Converter', 'Workspace'],
  history: ['History', 'Workspace'],
  credits: ['Credits', 'Workspace'],
  settings: ['Settings', 'Workspace'],
};

function go(page) {
  state.page = page;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  const [a, b] = PAGE_CRUMBS[page];
  $('#crumbs').innerHTML = `${a} <span class="sep">/</span> <b>${b}</b>`;
  window.scrollTo({ top: 0 });
  refresh();
}

// -------------------------------------------------------------- toasts ---
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

// ------------------------------------------------------- ambient snow -----
// Canvas particle engine: depth layers, drift, twinkle, soft glow.
const snowLayer = document.getElementById('snow-layer');
let snowCanvas = null, snowCtx = null, snowParts = [], snowOn = true, snowRAF = null;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function initSnow() {
  snowCanvas = document.createElement('canvas');
  snowLayer.appendChild(snowCanvas);
  snowCtx = snowCanvas.getContext('2d');
  window.addEventListener('resize', sizeSnow);
  sizeSnow();
}

function sizeSnow() {
  if (!snowCanvas || !snowCtx) return;
  const dpr = window.devicePixelRatio || 1;
  snowCanvas.width = Math.floor(window.innerWidth * dpr);
  snowCanvas.height = Math.floor(window.innerHeight * dpr);
  snowCanvas.style.width = window.innerWidth + 'px';
  snowCanvas.style.height = window.innerHeight + 'px';
  snowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawnFlake(fromTop) {
  const depth = Math.random(); // 0 = far (small, slow) … 1 = near (big, fast)
  return {
    x: Math.random() * window.innerWidth,
    y: fromTop ? -10 - Math.random() * 50 : Math.random() * window.innerHeight,
    r: 0.6 + depth * 2.6,
    v: 0.3 + depth * 0.85,
    swayAmp: 6 + depth * 22,
    swaySpeed: 0.5 + Math.random() * 0.9,
    phase: Math.random() * Math.PI * 2,
    o: 0.22 + depth * 0.45,
    tw: Math.random() * Math.PI * 2,
  };
}

function makeSnow(on) {
  snowOn = !!on;
  if (!snowOn) {
    if (snowRAF) { cancelAnimationFrame(snowRAF); snowRAF = null; }
    if (snowCtx) snowCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    return;
  }
  if (!snowCanvas) initSnow();
  if (REDUCED_MOTION) return;
  const count = Math.min(90, Math.max(40, Math.floor(window.innerWidth / 16)));
  snowParts = Array.from({ length: count }, () => spawnFlake(true));
  if (!snowRAF) tickSnow();
}

function tickSnow() {
  snowRAF = requestAnimationFrame(tickSnow);
  if (!snowCtx || !snowOn) return;
  snowCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const t = performance.now() / 1000;
  for (const p of snowParts) {
    if (!state.paused) {
      p.y += p.v;
      p.x += Math.sin(t * p.swaySpeed + p.phase) * 0.35;
      if (p.y > window.innerHeight + 10) Object.assign(p, spawnFlake(false));
    }
    const twinkle = 0.7 + 0.3 * Math.sin(t * 1.7 + p.tw);
    const a = Math.max(0, Math.min(1, p.o * twinkle));
    if (p.r > 2) {
      snowCtx.beginPath();
      snowCtx.arc(p.x, p.y, p.r * 2.8, 0, Math.PI * 2);
      snowCtx.fillStyle = `rgba(255,255,255,${(a * 0.12).toFixed(3)})`;
      snowCtx.fill();
    }
    snowCtx.beginPath();
    snowCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    snowCtx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    snowCtx.fill();
  }
}

// ---------------------------------------------------------------- fetch ---
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function startDownload(url, format, quality, ambientSnow) {
  const res = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, format, quality, ambientSnow }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Download failed');
  return data.item;
}

// ------------------------------------------------------------- helpers ----
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtBytes(b) {
  if (b == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
}

const STATUS_LABEL = {
  queued: 'Queued',
  downloading: 'Downloading',
  processing: 'Processing',
  finished: 'Finished',
  failed: 'Failed',
};

// --------------------------------------------------------- queue render ---
function qItemHtml(q, live = false) {
  const pct = Math.round(q.percent || 0);
  const badgeCls = q.status === 'failed' ? 'failed' : (q.status === 'finished' ? 'finished' : '');
  const meta = [];
  if (q.speed) meta.push(`<span>Speed <b>${q.speed}</b></span>`);
  if (q.eta) meta.push(`<span>ETA <b>${q.eta}</b></span>`);
  if (q.format) meta.push(`<span>${q.format}</span>`);
  let body = '';
  if (q.status === 'failed') {
    body = `<div class="q-meta" style="color:var(--danger)">${escapeHtml(q.error || 'Download failed')}</div>`;
  } else if (q.status === 'finished') {
    body = `<div class="q-meta">${meta.join('')}${q.file ? `<span><b>Saved</b> to downloads folder</span>` : ''}</div>`;
  } else {
    body = `
      <div class="track" style="height:7px"><div class="fill" style="width:${pct}%"></div></div>
      <div class="q-meta"><span><b>${pct}%</b></span>${meta.join('')}</div>`;
  }
  return `
    <div class="q-item" data-id="${q.id}">
      <div class="q-top">
        <span class="q-title">${escapeHtml(q.title || q.url)}</span>
        <span class="q-badge ${badgeCls}">${STATUS_LABEL[q.status] || q.status}</span>
        <span class="q-actions">
          <button class="icon-btn" data-act="remove" title="Remove"><i data-icon="x"></i></button>
        </span>
      </div>
      ${body}
    </div>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function activeEmpty() {
  return `
    <div class="empty-box">
      <div class="icon-circle"><i data-icon="circle-down"></i></div>
      <p>Your queue is clear. Paste a link above to begin.</p>
    </div>`;
}

function recentEmpty() {
  return `
    <div class="empty-box" style="min-height:150px">
      <div class="icon-circle"><i data-icon="file"></i></div>
      <p>No local downloads yet.</p>
    </div>`;
}

function renderActive() {
  const box = $('#active-list');
  const active = state.queue.filter((q) => ['queued', 'downloading', 'processing'].includes(q.status));
  const done = state.queue.filter((q) => ['finished', 'failed'].includes(q.status));
  $('#active-count').textContent = active.length ? `${active.length} active download${active.length > 1 ? 's' : ''}` : 'No active downloads';
  const html = active.map((q) => qItemHtml(q, true)).join('') + (active.length ? '' : activeEmpty());
  box.innerHTML = html;
  if (active.length === 0 && done.length) {
    // show a small finished summary below the empty state? No — keep queue clean on home.
  }
  injectIcons();
}

function renderRecent() {
  const box = $('#recent-list');
  const items = state.history.slice(0, 4);
  if (!items.length) { box.innerHTML = recentEmpty(); return; }
  box.innerHTML = items.map((h) => `
    <div class="recent-item">
      <div class="r-icon"><i data-icon="file"></i></div>
      <div style="min-width:0">
        <div class="r-title">${escapeHtml(h.title)}</div>
        <div class="r-sub">${escapeHtml(h.format)}</div>
      </div>
      <span class="r-time">${fmtTime(h.finishedAt)}</span>
    </div>`).join('');
  injectIcons();
}

function renderQueue() {
  const box = $('#queue-list');
  const active = state.queue.filter((q) => ['queued', 'downloading', 'processing'].includes(q.status));
  const done = state.queue.filter((q) => ['finished', 'failed'].includes(q.status));
  $('#queue-sub').textContent = active.length
    ? `${active.length} active · ${done.length} finished`
    : (done.length ? `${done.length} finished — clean up with “Delete finished”` : 'Nothing in the queue right now.');
  $('#queue-badge').textContent = state.queue.length;
  if (!state.queue.length) {
    box.innerHTML = `
      <div class="card">
        <div class="empty-box" style="min-height:280px">
          <div class="icon-circle"><i data-icon="list"></i></div>
          <p><b style="color:var(--text)">Your queue is clear.</b></p>
          <small>Paste a link in the Downloader to add your first download.</small>
        </div>
      </div>`;
    injectIcons();
    return;
  }
  box.innerHTML = state.queue.map((q) => qItemHtml(q)).join('');
  injectIcons();
}

function renderHistory() {
  const box = $('#history-list');
  $('#history-sub').textContent = state.history.length ? `${state.history.length} downloads saved` : 'Everything you saved with Smoky.';
  if (!state.history.length) {
    box.innerHTML = `
      <div class="empty-box" style="min-height:240px">
        <div class="icon-circle"><i data-icon="clock"></i></div>
        <p>No downloads yet.</p>
        <small>Finished downloads will show up here.</small>
      </div>`;
    injectIcons();
    return;
  }
  box.innerHTML = state.history.map((h) => `
    <div class="history-item">
      <div class="h-icon"><i data-icon="file"></i></div>
      <div style="min-width:0">
        <div class="h-title">${escapeHtml(h.title)}</div>
        <div class="h-sub">${escapeHtml(h.format)} · ${escapeHtml(h.folder || '')}</div>
      </div>
      <span class="h-time">${fmtTime(h.finishedAt)}</span>
    </div>`).join('');
  injectIcons();
}

// ------------------------------------------------------------ converter ---
const cvtState = { file: null, format: 'mp3' };
const CVT_STATUS = { preparing: 'Preparing', converting: 'Converting', finalizing: 'Finalizing', finished: 'Finished', failed: 'Failed' };

function renderConversions() {
  const box = $('#cvt-list');
  const list = state.conversions || [];
  const done = list.filter((c) => c.status === 'finished');
  $('#cvt-count').textContent = list.length ? `${done.length} done` : 'No conversions yet.';
  if (!list.length) {
    box.innerHTML = `<div class="empty-box" style="min-height:150px">
      <div class="icon-circle"><i data-icon="refresh"></i></div>
      <p>No conversions yet.</p>
      <small>Drop a file above, pick an output format, and convert.</small>
    </div>`;
    injectIcons();
    return;
  }
  box.innerHTML = list.map((c) => {
    const pct = Math.round(c.percent || 0);
    const badgeCls = c.status === 'failed' ? 'failed' : (c.status === 'finished' ? 'finished' : '');
    let body;
    if (c.status === 'failed') {
      body = `<div class="q-meta" style="color:var(--danger)">${escapeHtml(c.error || 'Conversion failed')}</div>`;
    } else if (c.status === 'finished') {
      body = `<div class="q-meta"><span><b>${escapeHtml(c.output || 'done')}</b></span></div>`;
    } else {
      body = `<div class="track" style="height:7px"><div class="fill" style="width:${pct}%"></div></div>
      <div class="q-meta"><span><b>${pct}%</b></span><span>${CVT_STATUS[c.status] || c.status}</span></div>`;
    }
    return `<div class="cvt-item" data-id="${c.id}">
      <div class="q-top">
        <span class="q-title">${escapeHtml(c.name)} → ${escapeHtml(c.format).toUpperCase()}</span>
        <span class="q-badge ${badgeCls}">${CVT_STATUS[c.status] || c.status}</span>
        <span class="q-actions"><button class="icon-btn" data-act="remove" title="Remove"><i data-icon="x"></i></button></span>
      </div>${body}</div>`;
  }).join('');
  injectIcons();
}

function setCvtFile(f) {
  cvtState.file = f || null;
  $('#cvt-go').disabled = !f;
  if (f) {
    $('#dz-text').innerHTML = `<b>${escapeHtml(f.name)}</b>`;
    $('#dz-file').textContent = `${fmtBytes(f.size)} · ready to convert`;
  } else {
    $('#dz-text').innerHTML = '<b>Drop a file here</b> or click to browse';
    $('#dz-file').textContent = 'Video and audio files — MP4, MKV, WebM, MP3, FLAC, WAV, M4A, OGG, OPUS and more.';
  }
}

async function doConvert() {
  if (!cvtState.file) return;
  const btn = $('#cvt-go');
  btn.disabled = true;
  try {
    const res = await fetch('/api/convert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(cvtState.file.name),
        'X-Format': cvtState.format,
      },
      body: cvtState.file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Conversion failed');
    setCvtFile(null);
    toast(`Konvertierung gestartet → ${data.item.format.toUpperCase()}`);
    refresh();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function bindConverter() {
  const dz = $('#drop-zone'), fi = $('#file-input');
  if (!dz) return;
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  fi.addEventListener('change', () => setCvtFile(fi.files[0] || null));
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) setCvtFile(f); });
  $$('#cvt-pills .cvt-pill').forEach((pill) => pill.addEventListener('click', () => {
    $$('#cvt-pills .cvt-pill').forEach((p) => p.classList.toggle('active', p === pill));
    cvtState.format = pill.dataset.format;
  }));
  $('#cvt-go').addEventListener('click', doConvert);
  $('#cvt-clear').addEventListener('click', () => {
    api('/api/convert-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [] }) })
      .then(refresh).catch(() => {});
  });
  $('#cvt-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn && btn.dataset.act === 'remove') {
      const id = btn.closest('.cvt-item') && btn.closest('.cvt-item').dataset.id;
      if (id) {
        api('/api/convert-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) })
          .then(refresh).catch(() => {});
      }
    }
  });
}

// -------------------------------------------------------------- refresh ---
let lastStatus = null;
async function refresh() {
  try {
    const s = await api('/api/status');
    state.queue = s.queue;
    state.history = s.history;
    state.conversions = s.conversions || [];
    state.settings = s.settings;
    state.storage = s.storage;
    state.tools = s.tools;

    applyTheme(s.settings.theme);
    if (snowOn !== !!s.settings.ambientSnow) makeSnow(!!s.settings.ambientSnow);

    // sidebar storage
    const pct = Math.min(100, s.storage.percent);
    $('#storage-fill').style.width = pct + '%';
    $('#storage-pct').textContent = pct + '%';

    // folder labels
    const folderShort = (s.storage.folder || '').split(/[\\/]/).pop() || 'Smoky';
    $$('.folder-path').forEach((el) => { el.textContent = '…\\' + folderShort; el.title = s.storage.folder; });

    // tools status (credits + settings rows)
    const setTool = (rowSel, ok) => {
      const row = $(rowSel);
      if (!row) return;
      row.innerHTML = ok
        ? '<span class="dot green"></span><span class="ok">Installed</span>'
        : '<span class="dot orange"></span><span class="missing">Not installed</span>';
    };
    const yt = $('#yt-status'), spot = $('#spot-status'), spotDot = $('#spot-dot');
    if (yt) { yt.textContent = s.tools.ytdlp ? 'Installed' : 'Missing'; yt.className = s.tools.ytdlp ? 'ok' : 'missing'; }
    if (spot) {
      spot.textContent = s.tools.spotdl ? 'Installed' : 'Not installed';
      spot.className = s.tools.spotdl ? 'ok' : 'missing';
      spotDot.className = 'dot ' + (s.tools.spotdl ? 'green' : 'orange');
    }
    setTool('#yt-row', s.tools.ytdlp);
    setTool('#spot-row', s.tools.spotdl);
    setTool('#ff-row', s.tools.ffmpeg);

    if (state.page === 'home') { renderActive(); renderRecent(); }
    if (state.page === 'queue') renderQueue();
    if (state.page === 'history') renderHistory();
    if (state.page === 'settings') syncSettingsUI();
    if (state.page === 'converter') renderConversions();

    // wave animation when downloading
    const busy = state.queue.some((q) => ['queued', 'downloading', 'processing'].includes(q.status));
    $('#tb-wave').classList.toggle('paused', state.paused || !busy);
    lastStatus = s;
  } catch (e) {
    // server briefly unreachable — ignore, retry on next tick
  }
}

function syncSettingsUI() {
  const s = state.settings;
  if (s.folder) $('#set-folder').value = s.folder;
  $('#set-format').value = s.format || 'mp4-1080';
  $('#set-quality').value = s.quality || 'best';
  $('#set-snow').checked = !!s.ambientSnow;
}

// -------------------------------------------------------------- events ---
function bindEvents() {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

  async function onSubmit(btn) {
    const card = btn.closest('.dl-card');
    const input = $('.dl-url', card);
    const url = input.value.trim();
    if (!url) { toast('Bitte zuerst einen Link einfügen.', 'error'); input.focus(); return; }
    if (!/^https?:\/\//i.test(url)) { toast('Das sieht nicht nach einer gültigen URL aus.', 'error'); return; }
    const format = $('.dl-format', card).value;
    const quality = $('.dl-quality', card).value;
    const snow = $('.dl-snow', card).checked;
    btn.disabled = true;
    try {
      await startDownload(url, format, quality, snow);
      input.value = '';
      go('queue');
      toast('Download gestartet — läuft jetzt in der Queue.');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }
  $$('.dl-submit').forEach((b) => b.addEventListener('click', () => onSubmit(b)));
  $$('.dl-url').forEach((i) => i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSubmit($('.dl-submit', i.closest('.dl-card')));
  }));
  $$('.dl-paste').forEach((b) => b.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      const card = b.closest('.dl-card');
      const input = $('.dl-url', card);
      input.value = t.trim();
      input.focus();
    } catch { toast('Zwischenablage nicht erreichbar — bitte manuell einfügen (Strg+V).', 'error'); }
  }));
  $$('.dl-snow').forEach((c) => c.addEventListener('change', () => {
    makeSnow(c.checked);
    fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ambientSnow: c.checked }) }).catch(() => {});
  }));

  $$('.dl-folder-btn').forEach((b) => b.addEventListener('click', () => {
    const p = prompt('Downloads folder (full path):', state.settings.folder || '');
    if (!p) return;
    saveFolder(p.trim());
  }));
  $('#set-folder-save')?.addEventListener('click', () => saveFolder($('#set-folder').value.trim()));
  $('#set-format')?.addEventListener('change', (e) => saveSettings({ format: e.target.value }));
  $('#set-quality')?.addEventListener('change', (e) => saveSettings({ quality: e.target.value }));
  $('#set-snow')?.addEventListener('change', (e) => { makeSnow(e.target.checked); saveSettings({ ambientSnow: e.target.checked }); });

  async function saveFolder(folder) {
    if (!folder) return;
    try {
      await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
      toast('Downloads folder updated.');
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function saveSettings(patch) {
    try {
      await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  // theme swatches
  $$('.theme-swatch').forEach((b) => b.addEventListener('click', () => saveSettings({ theme: b.dataset.theme })));

  async function deleteFinished(ids = []) {
    try {
      await api('/api/delete-finished', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
  $('#delete-finished')?.addEventListener('click', () => deleteFinished());
  $('#queue-delete-finished')?.addEventListener('click', () => deleteFinished());

  // queue item actions (event delegation)
  $('#queue-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const item = btn.closest('.q-item');
    const id = item?.dataset.id;
    if (!id) return;
    if (btn.dataset.act === 'remove') deleteFinished([id]);
  });

  $('#tb-pause')?.addEventListener('click', () => {
    state.paused = !state.paused;
    $('#tb-pause').style.color = state.paused ? 'var(--accent)' : '';
    $('#tb-wave').classList.toggle('paused', state.paused);
  });

  $('#tb-pause')?.addEventListener('dblclick', () => {});
}

// ---------------------------------------------------------------- boot ----
injectIcons();
bindEvents();
bindConverter();
initSnow();
makeSnow(true);
go('home');
setInterval(refresh, 1400);
refresh();
