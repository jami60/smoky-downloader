# Smoky 🚬

A calm, polished local media app. Dark, private, nothing leaves your device.
Paste a link, pick a format, choose a folder — Smoky downloads videos and
audio straight to your machine.

## Start

**Desktop app (recommended)** — double-click `Smoky App.bat` (or the
**Smoky** shortcut on your desktop). A frameless app window opens with the
native folder/file dialogs. First run installs Electron automatically.

**In the browser** — `npm start`, then open http://127.0.0.1:4173
(this machine: `PORT=4280 node server.js` if 4173 is taken).

Everything runs locally either way. `npm run app:smoke` starts the app,
verifies the UI + bridge, and quits.

## What's inside

- **Downloader** — paste any video/audio link (1,200+ platforms via yt-dlp),
  choose format (MP4 / WebM / MKV / MOV / MP3 / M4A / FLAC / WAV / OGG / OPUS /
  AAC) and quality (360p → 4K), watch live progress in the queue with
  thumbnails, speed and ETA. Spotify links use spotDL.
- **Converter** — pick a local file, choose a target container; ffmpeg converts
  it on-device into `<Downloads>/Smoky/Converted`.
- **12 themes** — Midnight, Aurora, Ember, Ocean, Rose, Cyber, Forest, Slate,
  Solar, Rain, Horror, Light (topbar dots + Settings).
- **Mita guide** — a walkthrough overlay with local artwork.
- **Background music** — plays a local track, volume persisted per browser.
- **Ambient snow** — canvas snowfall (rain/notes variants per theme).
- **Queue / History** — jobs with cancel/retry/open/delete; a local history
  that stays on this device.

## How it's wired

The UI (originally written for an Electron bridge) runs in any browser via
`public/desktop-shim.js`, which implements the `window.smokyDesktop` API
against the local Node backend in `server.js` (zero npm dependencies).
Local files (guide art, credits photo, music) live in `public/assets/`.

## Requirements

- Node.js 18+
- `yt-dlp` — `py -m pip install -U yt-dlp`
- `ffmpeg` + `ffprobe` (converter + merging) — `winget install ffmpeg`
- `spotDL` (only for Spotify) — `py -m pip install -U spotdl`
- Optional: a browser session in Settings for cookie-protected videos

## Files

```
server.js               Node backend: API, yt-dlp/spotDL runners, ffmpeg converter
public/index.html       The Smoky UI (self-contained, original design)
public/desktop-shim.js  Bridge (window.smokyDesktop) → local API / native IPC
public/assets/          Guide art, credits photo, background music
electron/               Electron main + preload (frameless window, native dialogs)
electron/icon.ico       App icon
scripts/make-icon.js    Regenerates the icon (npm run icon)
data/                   Settings + history (created at runtime, stays local)
```

## Dev scripts

- `npm start` — browser mode (Node server only)
- `npm run app` — desktop app (Electron)
- `npm run app:smoke` — boot + self-check, then quit
- `npm run icon` — regenerate the app icon
