# Smoky — run doc

## Reproduce artifacts
No environment files or build artifacts are required. The project has zero
dependencies (plain Node, no npm install). Everything needed is committed in
the repo: `server.js`, `public/`, `package.json`, `start.bat`.

Runtime state (`data/settings.json`, `data/history.json`) is created on first
run and stays local — do not commit it (gitignored).

## Run the server
```bash
PORT=4280 node server.js
```
or `npm start` (uses `PORT` env or defaults to 4173 — 4173 may be taken by the
environment, so prefer `PORT=4280`).

Wait until `curl http://127.0.0.1:4280/api/status` answers, then register the
preview at `http://127.0.0.1:4280/` with the server PID.

Tools are detected at startup and shown in the banner:
- `yt-dlp` (downloads) — required; `py -m pip install -U yt-dlp`
- `spotDL` (Spotify) — optional; `py -m pip install -U spotdl`
- `ffmpeg` + `ffprobe` (converter) — required for the Converter page

Known quirk: this machine's ffmpeg build only accepts `-version` (not
`--version`), which `hasCommand()` handles by trying both flags.
