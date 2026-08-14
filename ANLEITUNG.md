# Smoky — Komplette Anleitung 🚬

Alles an einem Ort: Discord einrichten, Versionen bauen & veröffentlichen,
Installation für dich und deine Freunde, Features und häufige Fehler.

---

## 1. Discord einrichten (Rich Presence + Login)

Smoky kann zwei Dinge mit Discord — **unabhängig voneinander**:

| Funktion | Was du brauchst |
|---|---|
| **Rich Presence** (laufender Track/Downloads im Discord-Profil) | Nur die **Application ID** |
| **Login + Profil** (Name + Avatar in Smoky anzeigen) | Application ID **+ Client-Secret** + Redirect-URI |

### 1.1 Discord-App anlegen (einmalig, ~3 Minuten)

1. Öffne **https://discord.com/developers/applications** (mit deinem Discord-Account einloggen).
2. Klicke **„New Application"** (oben rechts).
3. Name eingeben (z. B. `Smoky`) → **Create**.
4. **Application ID kopieren** — die steht oben auf der Seite „General Information".
   Das ist deine **Client-ID**.

### 1.2 Für den Login zusätzlich

5. Links im Menü auf **„OAuth2"** klicken.
6. Dort findest du das **Client Secret** → auf **„Reset Secret"** klicken und den Wert kopieren.
   ⚠️ Den Secret nie öffentlich teilen.
7. Unter **„OAuth2 → Redirects"** auf **„Add Redirect"** klicken und genau diese URL eintragen:
   ```
   http://127.0.0.1:4290/api/discord/callback
   ```
   > Tipp: Smoky zeigt dir die exakte Redirect-URI auch in den **Einstellungen → Discord** an
   > (unter „Discord-App"). Trag die ein, die dort steht — sie passt sich dem Port an.
8. **„Save Changes"** nicht vergessen.

### 1.3 In Smoky eintragen

1. Smoky öffnen → **Einstellungen → Discord**.
2. **Client-ID** einfügen (für RPC reicht das schon).
3. **Discord Rich Presence**-Schalter anlassen.
4. Für den **Login**: zusätzlich das **Client-Secret** einfügen → **Verbinden** klicken.
5. Der Browser öffnet die Discord-Freigabe → **Autorisieren**.
6. Danach kurz warten — Smoky zeigt deinen **Avatar + Namen** an. Fertig. ✅

- **Trennen** entfernt das Profil wieder (lokal, jederzeit).
- Ohne eigene Discord-App bleiben RPC und Login einfach aus — die App läuft normal weiter.

### 1.4 Großes Cover-Bild (Art-Asset, optional)

Das **echte Album-Cover** kann Discord nicht anzeigen: Smoky ist lokal, und Discord
lädt RPC-Bilder nur von öffentlichen HTTPS-URLs — `http://127.0.0.1/…` funktioniert
nicht (würde als kaputtes Fragezeichen erscheinen).

Stattdessen kannst du **ein eigenes Bild** als großes RPC-Cover zeigen:

1. Discord-Developer-Portal → deine App → links **„Rich Presence"** → **„Art Assets"**.
2. Ein quadratisches Bild hochladen (am besten **1024×1024**, z. B. das Smoky-Logo).
3. Den **Asset-Key** merken (der Dateiname, automatisch kleingeschrieben — z. B. `smoky`).
4. In Smoky: **Einstellungen → Discord → Art-Asset-Key** eintragen (z. B. `smoky`).
5. Beim Musik-Hören zeigt Discord dann dieses Bild neben Titel/Künstler/Fortschritt.

Ohne Art-Asset-Key bleibt die Presence sauber **text-only** (kein kaputtes Bild).

---

## 2. Version bauen & als Release veröffentlichen

Das ist der komplette Ablauf, den auch ich benutze. Einmal eingerichtet, dauert er
nur ein paar Minuten (+ ~10 Min für den automatischen Mac-Build).

### 2.1 Voraussetzungen (einmalig)

- **Node.js** installiert
- **GitHub CLI** (`gh`) installiert und eingeloggt: `gh auth login`
- Repo: `jami60/smoky-downloader`

### 2.2 Schritt für Schritt

```bash
# 1) Backup-Tag setzen (Punkt, zu dem du immer zurück kannst)
git tag backup-v$(node -p "require('./package.json').version")-$(date +%Y%m%d-%H%M%S)

# 2) Version bumpen (package.json → "version": "1.14.0")
#    Achtung: auch die DMG-Nummer in README.md aktualisieren (Smoky-X.Y.Z-arm64.dmg)

# 3) Committen
git add package.json README.md && git commit -m "Bump Version auf X.Y.Z"

# 4) Alle Tests
npm test

# 5) Electron-Smoke (Smoky vorher schließen — sonst blockt der Single-Instance-Lock)
npx electron . --smoke

# 6) Windows bauen (Setup.exe + win.zip)
npm run dist:build

# 7) In-App-Update-Paket bauen
node scripts/make-update.js

# 8) Release-Notes schreiben → dist/release-notes-X.Y.Z.md

# 9) Pushen
git push origin main

# 10) Release erstellen (Windows-Assets anhängen)
gh release create vX.Y.Z \
  --title "Smoky vX.Y.Z" \
  --notes-file dist/release-notes-X.Y.Z.md \
  dist/Smoky-Setup-X.Y.Z.exe \
  dist/Smoky-X.Y.Z-update.zip \
  dist/update.json
```

### 2.3 Mac-Version

Sobald das Release angelegt ist (Schritt 10 erzeugt den Tag), baut **GitHub Actions
automatisch** die Mac-Version (`.github/workflows/mac-release.yml`) und hängt
**DMG + ZIP** an das Release. Das dauert **~8–10 Minuten**.

- Fortschritt prüfen: `gh run list --workflow "Mac Release"`
- Manuell anstoßen: `gh workflow run "Mac Release" -f release_tag=vX.Y.Z`

### 2.4 Update-Flow testen (empfohlen)

Nach dem Release prüfen, dass die App das Update wirklich findet (wie der App-Updater):
latest-Release abrufen → `*-update.zip` herunterladen → entpacken → `app.asar` enthält
die neue Version. Ich mache das mit einem kleinen Skript, das `checkForGitHubUpdate()`
aus `electron/updater.js` nachspielt.

---

## 3. Installation & Updates

### Windows (Freunde)
- **Installer:** `Smoky-Setup-X.Y.Z.exe` → doppelklicken → installieren.
- **Update:** läuft **automatisch in der App** (beim Start wird auf GitHub geprüft → „Update now").
  Keine Setup-Datei mehr nötig.

### macOS (Apple Silicon)
1. `Smoky-X.Y.Z-arm64.dmg` laden → Smoky nach `/Applications` ziehen.
2. **Einmalig** im Terminal (Build ist nicht notarized, Gatekeeper blockt sonst den Start):
   ```bash
   xattr -cr "/Applications/Smoky.app"
   ```
3. Smoky starten. Beim ersten Mal **Einstellungen → Tools aktualisieren**, damit
   yt-dlp + ffmpeg geladen werden (oder vorher `brew install yt-dlp ffmpeg`).

---

## 4. Features im Überblick

- **Downloader:** YouTube, Spotify, SoundCloud, TikTok, Instagram +1.200 weitere
  (über yt-dlp). Playlists vorher auswählen, parallele Downloads (1–5), Link aus
  Zwischenablage wird automatisch erkannt.
- **Player:** Audio-Bibliothek mit Cover + Tags + Visualizer; **Musik/Videos-Umschalter**
  mit echtem Video-Player; **Ambient-Modus** (großes Cover + rotierende Schallplatte);
  **Alben-Ansicht** statt einzelner Songs.
- **Hotkeys (global):** `F4` zurück · `F5` Play/Pause · `F6` weiter — auch wenn die App
  nicht im Fokus ist.
- **Clips:** Zeitausschnitte aus Videos schneiden (bis 15 Min).
- **Converter:** Dateien zwischen Formaten umwandeln.
- **Empfehlungen:** passende Videos/Songs aus deiner Download-History, ohne API-Key.
- **In-App-Browser:** Webseiten öffnen und Medien direkt daraus übernehmen.
- **Tags & Cover:** Tags bearbeiten + **eigenes Cover** einbetten.
- **Themes:** 19 Themes + Partikel-Effekte, eigenes Theme, Zufalls-Theme beim Start.
- **Mita:** Begleiter-Sticker (in den Einstellungen abschaltbar).
- **Discord:** Rich Presence für Track/Downloads + optionaler Login.

---

## 5. Häufige Fehler & Lösungen

### „Sign in to confirm your age" (YouTube)
Altersbeschränkte Videos brauchen Cookies. In **Einstellungen → Browser-Sitzung** einen
Browser wählen (Chrome/Edge/Firefox …), dann erneut laden.

### Spotify lädt langsam / gar nicht
- Einmalig: `py -m pip install -U spotdl` (Windows) bzw. `python3 -m pip install -U spotdl` (Mac).
- Album-Listen sind von Spotify eingeschränkt — Playlist-Links oder einzelne Tracks nutzen.

### „Access denied" beim Update (ältere Versionen)
Behoben ab v1.13.x. Falls es doch auftritt: Smoky einmal als Administrator starten
und das Update erneut ausführen.

### yt-dlp fehlt auf dem Mac
**Einstellungen → Tools aktualisieren** klicken (lädt yt-dlp + ffmpeg automatisch).
Alternativ im Terminal: `brew install yt-dlp ffmpeg`.

### Cover sehen bei YouTube anders aus als bei Spotify
YouTube liefert 16:9-Thumbnails, Spotify quadratische Cover. Smoky beschneidet
YouTube-Cover auf ein quadratisches Format — falls ein Track trotzdem daneben liegt,
einfach per „Tags bearbeiten" ein eigenes Cover einbetten.

---

*Smoky — deine Medien. Dein Safe Space.* 🖤
