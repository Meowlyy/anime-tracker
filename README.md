# ˚ʚ Meowly ₊✧ — Anime Tracker

Eine persönliche Anime-Watchlist-App – verfolge deinen Fortschritt, bekomme
Benachrichtigungen für neue Episoden, entdecke passende Empfehlungen und
importiere deine Liste direkt aus MyAnimeList, HiAnime oder AnimeKai.

🔗 **Live:** [anime-tracker-9nl.pages.dev](https://anime-tracker-9nl.pages.dev)

---

## ✦ Features

- 📺 Anime-Liste mit Status (geplant, läuft, abgeschlossen, pausiert, abgebrochen)
- 🔔 Benachrichtigungen bei neuen Episoden (via [Jikan API](https://jikan.moe/))
- 📊 Eigene Statistik-Seite: Genre-Verteilung, Bewertungen, Top-Studios,
  abgeschlossene Anime pro Jahr/Monat/Woche
- 🪄 Personalisierte Empfehlungen basierend auf deinen Genres & Bewertungen
- 🔍 Erweiterte Suche mit größeren Vorschaubildern und Alternativtiteln
- 🧩 Automatische Gruppierung von Staffeln, Filmen & Spin-offs einer Serie
- 📦 "Alle Staffeln hinzufügen" – eine ganze Serie inkl. Filme/Specials auf einen Klick
- 🛠️ Daten-Reparatur-Tool für unvollständige/fehlende Einträge
- 📤 Export als JSON oder als ZIP inkl. aller Cover-Bilder (für Backups)
- 🖼️ Anime-Karten als Bild teilen (für Discord & Co.)
- 📥 Import aus MyAnimeList (XML), HiAnime/AnimeKai (JSON/TXT)
- 🎨 Eigenes, minimalistisches Design

## ✦ Tech-Stack

`HTML` · `CSS` · `JavaScript` (Vanilla, kein Framework) · [Chart.js](https://www.chartjs.org/) für Statistiken · [JSZip](https://stuk.github.io/jszip/) für ZIP-Exporte

Daten werden lokal im Browser gespeichert (`localStorage`), externe Anime-Infos
kommen live von der [Jikan API](https://jikan.moe/) (inoffizielle MyAnimeList-API).

## ✦ Contributing

Das Projekt ist closed-source (alle Rechte vorbehalten) – der Code darf also
**nicht** kopiert, weiterverbreitet oder als eigenes Projekt veröffentlicht
werden. Verbesserungsvorschläge sind aber gerne willkommen:

1. Repo forken
2. Änderung/Feature umsetzen
3. Pull Request öffnen – ich schau's mir an 🌸

Bugs oder Ideen gerne auch einfach als [Issue](../../issues) melden.

## ✦ Lizenz

© Meowly – alle Rechte vorbehalten. Die Nutzung der gehosteten Website ist
selbstverständlich frei möglich, der Quellcode darf jedoch nicht ohne
Erlaubnis weiterverwendet werden.
