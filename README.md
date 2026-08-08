# Smoky 🚬 — Multi Media Downloader

Dark, calm, private by default. Paste a link, pick a format, choose a folder —
Smoky downloads videos and audio straight to your device. Nothing leaves your machine.

## Start

```bash
npm start
```

Then open **http://127.0.0.1:4173** (or double-click `start.bat` on Windows — it opens the browser automatically).

## Requirements

- **Node.js 18+** — runs the app (already installed on this machine).
- **yt-dlp** — engine for 1,200+ platforms. Check with `yt-dlp --version`,
  install with `py -m pip install -U yt-dlp` if missing.
- **spotDL** *(only for Spotify links)* — `py -m pip install -U spotdl`

## What works

- Download videos & audio from YouTube, TikTok, Instagram, Vimeo, SoundCloud and 1,200+ more via yt-dlp
- Formats: MP4 (1080p/4K/Best), WebM/MKV, MP3, M4A, FLAC, WAV, OPUS, AAC
- **Converter**: drop any local file in, pick a target (MP3, M4A, FLAC, WAV, OGG, OPUS, AAC, MP4) — ffmpeg does the rest, output goes to `<Downloads>/Smoky/Converted`
- **5 themes**: Smoky (green), Midnight, Amethyst, Ember, Paper — switch in Settings, persisted locally
- Live progress in the queue, download history, storage meter, canvas-based ambient snow
- Spotify links (via spotDL, if installed)

## Requirements (converter)

- **ffmpeg** + **ffprobe** — `winget install ffmpeg` or `choco install ffmpeg`. Check with `ffmpeg -version`.
- yt-dlp and spotDL are Python tools: `py -m pip install -U yt-dlp` / `py -m pip install -U spotdl`

## Project layout

```
server.js          Node backend (zero dependencies): API + yt-dlp/spotDL runner
public/index.html  UI shell — all pages
public/styles.css  Dark green / mint theme
public/app.js      Routing, downloads, live updates
data/              Settings + history (created at runtime, stays local)
```
