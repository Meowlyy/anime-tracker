# Anime Tracker – Deployment

Statische Web-App (HTML/CSS/JS), läuft komplett im Browser. Kein Server nötig.

## 1. Auf GitHub hochladen

1. Auf [github.com](https://github.com) einloggen und ein **neues Repository** erstellen
   (z.B. `anime-tracker`) – **public**, ohne README/gitignore anzuhaken.
2. Auf deinem Rechner im entpackten Ordner (`anime-tracker/`) ein Terminal öffnen und:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/DEIN-USERNAME/anime-tracker.git
git push -u origin main
```

(Bei `DEIN-USERNAME` deinen GitHub-Namen einsetzen. Falls `git` noch nicht installiert ist:
[git-scm.com/downloads](https://git-scm.com/downloads))

## 2. Cloudflare Pages verbinden

1. Auf [dash.cloudflare.com](https://dash.cloudflare.com) einloggen (Account ist kostenlos).
2. Links **Workers & Pages** → **Create application** → Tab **Pages** → **Connect to Git**.
3. Dein GitHub-Konto autorisieren und das `anime-tracker`-Repo auswählen.
4. Build-Einstellungen:
   - **Framework preset:** None
   - **Build command:** (leer lassen)
   - **Build output directory:** `/` (Root)
5. **Save and Deploy** klicken.

Nach ein paar Sekunden ist die Seite live unter
`https://anime-tracker-xyz.pages.dev` (Cloudflare vergibt den genauen Namen,
du kannst ihn in den Projekteinstellungen ändern).

Jedes Mal, wenn du danach Änderungen machst und `git push` ausführst,
baut Cloudflare die Seite automatisch neu – kein manueller Schritt nötig.

## 3. (Optional) Eigene Domain

Falls du eine eigene Domain hast (oder kaufen willst):
Pages-Projekt → **Custom domains** → Domain eintragen → fertig.
Die Verwaltung selbst ist kostenlos, nur die Domain-Registrierung kostet
(meist 1–15 €/Jahr, je nach Anbieter/Endung).

## Hinweis zu den Assets

Zwei unbenutzte Hintergrundbilder (`background-desktop.webp`,
`1background-desktop.webp`, zusammen ~40 MB) wurden hier weggelassen,
da sie im Code nirgends referenziert werden. Falls du sie doch brauchst,
einfach in den `assets/`-Ordner kopieren.
