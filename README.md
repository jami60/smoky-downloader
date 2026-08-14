# Smoky 🚬

Ein ruhiger, lokaler Multi-Media-Downloader für Windows. Videos, Musik, Playlists und Alben — alles landet **auf deinem Gerät**, nichts geht in die Cloud.

---

## Installation (2 Minuten)

1. **`Smoky-Setup-1.8.2.exe`** doppelklicken
2. Installationsordner wählen → **Installieren**
3. Fertig — Smoky startet mit einer Desktop-Verknüpfung

> Alternativ: Die portable Version `Smoky-1.8.2-win.zip` entpacken und `Smoky.exe` starten (z. B. vom USB-Stick, keine Installation nötig).

### macOS (Apple Silicon)

1. **`Smoky-1.14.1-arm64.dmg`** herunterladen und Smoky nach `/Applications` ziehen
2. Einmal im Terminal ausführen (der Build ist nicht notarized, Gatekeeper blockt sonst den Start):

   ```
   xattr -cr "/Applications/Smoky.app"
   ```

3. Smoky starten — fertig

---

## Erste Schritte

1. **Link einfügen** — YouTube, SoundCloud, Spotify, TikTok, Instagram und 1.200+ weitere Seiten
2. **Format wählen** — MP3/M4A für Musik, MP4/WebM für Videos (Smoky merkt sich dein letztes Format)
3. **Download** drücken — mehrere Links gleichzeitig einfügen geht auch (eine pro Zeile)
4. Fertige Dateien liegen in `Dokumente`-Ordner → `Downloads\Smoky` (oder wo du es einstellst)

**Tipps:**
- 📎 **Link kopieren reicht**: Smoky erkennt kopierte Links und bietet den Download direkt an
- 📋 **Playlists**: Bei Playlist-Links kannst du vorher auswählen, welche Tracks geladen werden sollen
- ⚡ **Parallele Downloads**: In den Einstellungen einstellbar (1–5 gleichzeitig)
- 🎵 **Musik-Player**: Alle Audio-Downloads landen in der Player-Bibliothek mit Cover, Tags und Live-Visualizer

---

## Spotify (einmalig einrichten)

Spotify braucht einen einmaligen Befehl im Terminal:

```
py -m pip install -U spotdl
```

Danach funktionieren Spotify-Links (Tracks, Alben, Playlists) direkt. Ohne Spotify-Account-Cookies sucht spotDL die Songs über YouTube-Quellen — funktioniert, aber manche Tracks sind dann nicht verfügbar.

> Hinweis: Es muss **Python** installiert sein (python.org). Der Befehl oben ist derselbe, den Smoky dir bei Bedarf auch anzeigt.

---

## Themes & Musik

- **19 Themes** inkl. Jahreszeiten (Winter/Frühling/Sommer/Herbst) und Partikel-Effekten (Schnee, Blüten, Sterne, Funken …) — oben in der Leiste oder in den Einstellungen
- **Eigenes Theme**: In den Einstellungen Akzent- und Hintergrundfarbe frei wählen
- **Ambient-Musik**: Drei Hintergrund-Tracks, Lautstärke einstellbar (oben rechts)

---

## Updates

Smoky aktualisiert sich **automatisch**: Beim Start wird auf GitHub nach einer neuen Version geschaut. Ist eine da, klick einfach auf **„Update now"** — fertig.

- Du brauchst nie wieder eine Setup-Datei herunterzuladen
- Alles läuft lokal und bleibt erhalten

---

## Discord (optional)

Smoky kann deinen **laufenden Track als Discord Rich Presence** anzeigen und dich optional **mit Discord verbinden** (Avatar + Name in den Einstellungen). Beides braucht eine eigene Discord-App-ID — die komplette Schritt-für-Schritt-Anleitung steht in **[ANLEITUNG.md](ANLEITUNG.md)**.

---

## Datenschutz

- Alle Downloads, Einstellungen und die Musik-Bibliothek liegen **nur auf deinem Gerät**
- Keine Pflicht-Accounts, keine Cloud, kein Tracking — der Discord-Login ist rein optional
- **Private by default. Nothing leaves your device.** 🔒

---

## Unterstützte Plattformen (Auszug)

YouTube · Spotify · SoundCloud · TikTok · Instagram · Vimeo · Twitter/X · Facebook · +1.200 weitere über yt-dlp

---

---

## Komplette Anleitung

**Discord einrichten, Versionen bauen & veröffentlichen, Installation für Freunde, alle Features und Troubleshooting** — alles ausführlich in **[ANLEITUNG.md](ANLEITUNG.md)**.

---

*Smoky — deine Medien. Dein Safe Space.* 🖤
