# Gießkalender

Eine kleine Web-App (PWA), die dich erinnert, wann deine Pflanzen Wasser brauchen. Läuft im Browser auf iPhone und Android, lässt sich auf den Home-Bildschirm legen und funktioniert offline. Alle Daten bleiben auf dem Gerät (IndexedDB).

## Funktionen
- Pflanzen mit Name, Foto, Raum, Gießintervall und Notizen
- „Heute gießen“-Liste, Wasserstand-Balken, Gießen mit einem Tipp (inkl. Rückgängig)
- Anderes Gießdatum nachtragen, „Morgen erinnern“
- Gießprotokoll mit Auswertung („du gießt im Schnitt alle X Tage“) und Vorschlag zum Anpassen
- Winterruhe: Intervalle von November bis Februar automatisch verlängern
- Erinnerungen: Benachrichtigungen + Zahl am App-Symbol, regelmäßige Hintergrundprüfung (Android/Chrome), Kalenderexport (.ics) mit Alarm
- Sicherung als JSON exportieren/importieren

## Erinnerungen – was wo funktioniert
Ohne eigenen Server kann eine Web-App nicht zuverlässig im Hintergrund wecken.
- **Android (Chrome, installiert):** prüft periodisch im Hintergrund und benachrichtigt.
- **iPhone:** Benachrichtigungen nur bei installierter App; im Hintergrund pausiert iOS die App. Zuverlässig ist dort der **Kalenderexport** (Einstellungen → „Kalenderdatei laden“).

## Veröffentlichen über GitHub Pages
1. Repository auf GitHub anlegen und diesen Ordner pushen.
2. Repository → Settings → Pages → „Deploy from a branch“ → `main` / `(root)`.
3. Nach ca. einer Minute ist die App unter `https://<name>.github.io/<repo>/` erreichbar.

Bei Änderungen an Dateien `VERSION` in `sw.js` hochzählen, damit installierte Apps den neuen Stand laden.

## Lokal testen
```bash
python3 -m http.server 8765
```
