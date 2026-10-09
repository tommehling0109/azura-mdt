# Hinweise für KI-Assistenten (SevenV / Azura MDT)

## Design ist verbindlich
Bevor du Oberflächen (Menüs, Panels, Dialoge, Apps, HUD, Website) erstellst oder änderst, lies `docs/DESIGN-KONZEPT.md` und `docs/design/tokens.css`.
Kurzfassung:
- Nur Variablen aus den Tokens verwenden (keine Hex-Farben, eigenen Radien, Schatten, Schriften). Raster 4 px.
- Vorhandene Komponenten nutzen: `public/js/ui/kit.js` und `public/css/components.css` (`btn`, `card`, `badge`, `modal`, `toast`, `field`, `tabs`, `empty`, `note` …). Nichts nachbauen.
- Pro Ansicht höchstens ein primärer Button. Dialog: Titel + ✕, Fuß mit Löschen links, Abbrechen + Hauptaktion rechts. Gefährliches immer mit `confirmDialog`.
- Icons nur aus `public/js/ui/icons.js` (24×24, Linie, 1,8). Fehlt eins, im selben Stil ergänzen. Keine Emojis in der UI, keine Fremd-Frameworks, keine neuen Schriften.
- Texte Deutsch, Du-Form, sachlich. Status nie nur per Farbe. Tastatur, Fokus, Mobil (≤ 760 px) und `prefers-reduced-motion` beachten.
- Abweichungen nur mit Begründung im Commit und Eintrag in `docs/DESIGN-KONZEPT.md` Abschnitt 14.
- Nach dem Bau Checkliste (Abschnitt 13) abhaken und die Ansicht prüfen.

## Projekt
- Node ≥ 22.13, `node:sqlite`, keine Abhängigkeiten. Module in `server/modules`, Oberflächen in `public/js/views`. Tests: `node scripts/smoke-test.js`.
- Neue Rechte in `server/core/seed-ranks.js` (LEVELS) einordnen und `node scripts/gen-rights.mjs` ausführen.
