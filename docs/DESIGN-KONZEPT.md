# SevenV – Designkonzept (Einheitliches Interface für den ganzen Server)

Stand 09.10.2026 · Gilt für: Ingame-Oberflächen (NUI), Tablet-Apps, MDT und alle Browser-Panels, Whitelist-Portal, Website, Discord-Auftritt, Ladebildschirm.

Grundlage ist das Serverkonzept „SevenV“ (Kapitel 3.3 „Panels und eigene Systeme“, 16.4 „UI-Grundbibliothek“, 16.2 „Qualitätsregeln“). Die Werte unten sind aus dem laufenden MDT übernommen (`public/css/theme.css`, `components.css`). Wer nach diesem Dokument baut, bekommt also dasselbe Aussehen wie das, was schon steht.

Kennzeichnung wie im Konzept: **Entschieden** = steht so im MDT und gilt. **Vorschlag** = ergänzt, noch zu bestätigen.

---

## 1. Leitidee

**Ruhig, dunkel, nüchtern – wie ein professionelles Dienstsystem.** Der Server spielt in einer glaubwürdigen Welt. Die Oberflächen sind Werkzeuge, kein Showeffekt. Ein Spieler soll in jedem Menü sofort wissen: *Das ist SevenV.*

Die fünf Grundsätze:

1. **Eine Sprache.** Gleiche Dinge sehen überall gleich aus: ein Button ist immer derselbe Button, ein Warnhinweis immer derselbe Warnhinweis.
2. **Ruhe vor Effekt.** Eine Akzentfarbe, wenige Flächenstufen, dezente Bewegung. Nichts blinkt ohne Grund.
3. **Inhalt zuerst.** Dichte, gut lesbare Daten (Listen, Karten, Formulare). Dekoration nur, wenn sie etwas ordnet.
4. **Vorhersagbar.** Gleiche Aktion, gleicher Platz: Speichern rechts unten im Dialog, Löschen links und rot, Schließen oben rechts.
5. **Zugänglich.** Kontrast, Tastatur, Fokus sichtbar, Bewegung abschaltbar.

---

## 2. Marke

| Element | Festlegung |
|---|---|
| Name | **SevenV** (Schreibweise immer so, nie „Sevenv“ oder „SEVENV“ im Fließtext) |
| Logo | Wortmarke im Kopfbereich links, einfarbig (Text-Weiß oder Akzent), nie verzerrt, Mindesthöhe 20 px, Schutzraum = Höhe des „S“ |
| Tonfall (Vorschlag) | Sachlich, direkt, deutsch. Du-Form im Spiel und im Panel, keine Floskeln. Fachbegriffe der Lore (Dienstbezeichnungen, Ränge) dürfen englisch bleiben. |
| Fiktion | Das Spiel ist fiktiv. Hinweis „fiktives System für den Unity Life Roleplay Server“ bzw. servereigener Wortlaut bleibt dezent, aber immer sichtbar, wo ein Panel echten Behörden ähnelt. |
| Externe/Neutrale Oberflächen | Seiten für Externe (z. B. `coop.`-Subdomain, Hack-Terminal) tragen **kein** Logo und keinen Panelnamen. Das ist die einzige Ausnahme von „Marke überall“. |

---

## 3. Farben (Entschieden)

Alle Farben kommen **ausschließlich** aus den Variablen in `docs/design/tokens.css`. Neue Hex-Werte im Code sind nicht erlaubt.

### 3.1 Flächen (Standardvorlage „Anthrazit“)

| Token | Wert | Verwendung |
|---|---|---|
| `--bg-0` | `#0f1012` | Seitenhintergrund, tiefste Ebene, Eingabefelder-Hintergrund |
| `--bg-1` | `#16171a` | Kopfleiste, Dock, Seitenleisten |
| `--bg-2` | `#1d1f23` | Karten, Fensterinhalt |
| `--bg-3` | `#26292e` | Buttons, Dialoge, erhöhte Flächen |
| `--bg-4` | `#32363d` | Hover, aktive Flächen, Scrollbalken |

Die Stufen sind **hell nach oben**: Je weiter vorn ein Element liegt, desto heller seine Fläche. Es werden nie mehr als drei Stufen in einer Ansicht übereinander gelegt.

Wählbare Vorlagen (`theme-black`, `theme-midnight`, `theme-ocean`) tauschen nur diese fünf Werte plus Linien- und Textfarbe. Neue Vorlagen folgen demselben Schema.

### 3.2 Text und Linien

| Token | Wert | Verwendung |
|---|---|---|
| `--text` | `#e8eaed` | Haupttext, Überschriften |
| `--text-2` | `#b0b5bd` | Beschriftungen, Nebentext |
| `--text-3` | `#7b818b` | Hinweise, deaktiviert, Platzhalter |
| `--line` | `rgba(255,255,255,.08)` | Trennlinien, Kartenränder |
| `--line-strong` | `rgba(255,255,255,.16)` | Ränder von Buttons, Dialogen, Feldern |

### 3.3 Akzent

`--accent: #5b82b8` (gedämpftes Stahlblau). Alles andere (`--accent-hi`, `--accent-lo`, `--accent-soft`, `--accent-line`, `--accent-glow`) wird per `color-mix` daraus abgeleitet. Der Akzent ist **pro Server einstellbar**, deshalb nie als festen Wert verwenden.

Akzent bedeutet: *Hier kannst du handeln* (primärer Button, Auswahl, Fokus, Links, aktive Navigation). Er wird nicht als Dekofarbe für Überschriften oder Hintergründe verwendet.

### 3.4 Statusfarben

| Token | Wert | Bedeutung |
|---|---|---|
| `--ok` | `#34d399` | Erfolg, aktiv, bestätigt |
| `--warn` | `#fbbf24` | Achtung, wartet, Frist läuft |
| `--err` | `#f87171` | Fehler, gesperrt, löschen |
| `--info` | `#60a5fa` | Hinweis, neutral informativ |
| `--mute` | `#8b93a7` | Inaktiv, archiviert |

Status wird **nie nur über Farbe** gezeigt, immer zusätzlich Text oder Symbol (Badge mit Wort, Icon).

### 3.5 Eigenfarben für Daten

Fraktionen, Ränge, Kategorien und Abteilungen haben eine frei wählbare Farbe, die nur als **Punkt, Rand oder Badge** erscheint (`--c`), nie als Flächenfarbe eines ganzen Bereichs. Farben für Diagramme: siehe 9.4.

---

## 4. Typografie (Entschieden)

| Eigenschaft | Wert |
|---|---|
| Schrift | `Inter`, Fallback `Segoe UI Variable Text`, `Segoe UI`, `system-ui` (Token `--font`) |
| Festbreite | `ui-monospace`, `Cascadia Code`, `Consolas` (Token `--mono`) für Nummern, Kennzeichen, Codes, Tastenkürzel |
| Grundgröße | 14 px, Zeilenhöhe 1,45 |
| Fließtext/Listen | 13–14 px, `--text` bzw. `--text-2` |
| Beschriftungen (Feld-Labels) | 12 px, Gewicht 600, `--text-2` |
| Hinweise | 12 px, `--text-3` |
| Buttons | 13,5 px, Gewicht 600 |
| Überschriften | Gewicht 600–700, keine Versalien außer Tabellenköpfe/Abschnitts-Labels |
| Zahlen | Dezimalkomma, Tausenderpunkt, Währungsformat über **eine** Funktion (`fmtC`), nie von Hand |

Nur zwei Schriftfamilien. Keine Zierschriften. Max. 3 Schriftgrößen pro Ansicht außer Titeln.

---

## 5. Abstände, Radien, Schatten, Bewegung (Entschieden)

- **Raster: 4 px.** Abstände sind Vielfache (4, 8, 12, 16, 20, 24). Standard: 12 px zwischen Feldern/Zeilen, 16 px Kartenpolster, 20–24 px zwischen Abschnitten.
- **Radien:** `--r-sm` 8 px (Badges, kleine Elemente), `--r-md` 12 px (Buttons, Felder, Karten), `--r-lg` 16 px (große Karten, Panels), `--r-xl` 22 px (Dialoge). Es gibt keine eigenen Radien. Die Varianten *eckig* und *rund* verschieben alle Werte gemeinsam.
- **Schatten:** `--shadow-1` für Karten, `--shadow-2` für Dialoge, Menüs, Toasts. Kein weiterer Schatten.
- **Glas** (Unschärfe) nur für Kopfleiste, Dock, Startmenü, Benachrichtigungen, Sperrbildschirm. Muss abschaltbar sein (`no-glass`).
- **Bewegung:** Easing `--ease`, 0,10–0,30 s. Erlaubt: Ein-/Ausblenden, leichtes Verschieben (bis 8 px), Druck-Effekt auf Buttons. Verboten: Dauerblinken, Pulsieren ohne Anlass, Bewegung größer als 1 s. `prefers-reduced-motion` und „Animationen aus“ müssen alles ruhigstellen.

---

## 6. Komponenten (Entschieden)

Die Komponenten existieren bereits in `public/js/ui/kit.js` und `public/css/components.css`. **Neue Module nutzen sie, sie bauen sie nicht nach.**

| Baustein | Regel |
|---|---|
| **Button** | Höhe 38 px, Radius `--r-md`. *Primär* (Akzentverlauf): höchstens einer pro Dialog/Ansicht, die Hauptaktion. *Normal* (`--bg-3`): Standard. *Ghost*: Nebenaktionen, Icons. *Danger*: Löschen/Sperren, immer mit Bestätigung. Klein = 30 px. Mit Icon links vom Text. |
| **Eingabefeld** | Label darüber (12 px), Hilfetext darunter (12 px, `--text-3`), Fehler direkt unter dem Feld. Fokus = Akzentrahmen. Pflichtfelder im Label markiert. |
| **Auswahl/Checkbox/Schalter** | Gleiche Höhe wie Felder. Schalter für sofort wirksame Einstellungen, Checkbox für Formulare mit „Speichern“. |
| **Karte** (`card`) | `--bg-2`, Rand `--line`, Radius `--r-lg`, Polster 16 px. Keine Karte in der Karte mit demselben Look, innen nur Linien oder `--bg-1`. |
| **Tabelle** | Kopfzeile klein und gedämpft, Zeilenhöhe luftig, Hover `--bg-3`, klickbare Zeile öffnet Details. Zahlen rechtsbündig. Leerzustand mit Text und Icon („Noch keine …“). |
| **Badge** | Kleiner Pillen-Rand in Statusfarbe oder Eigenfarbe, immer mit Text. |
| **Dialog** (`modal`) | Breite 560 px (breit: größer), Radius `--r-xl`, Kopf mit Titel und ✕, Fuß: links destruktive Aktion, rechts „Abbrechen“ + Primäraktion. Esc schließt. |
| **Toast** | Unten rechts, links farbiger Balken (Statusfarbe), verschwindet selbst, Fehler bleiben länger. |
| **Tabs** | Oben im Inhalt, aktiver Tab Akzent-Unterstrich, optional Zähler. |
| **Leerzustand** (`empty`) | Icon, Titel, ein Satz Erklärung, wenn sinnvoll eine Aktion. |
| **Hinweisbox** (`note`) | Info-Block in `--info`-Ton für Erklärungen vor Formularen. |
| **Bestätigung** | Gefährliche Aktionen immer über `confirmDialog` mit dem Namen des Objekts im Text. |

---

## 7. Icons (Entschieden)

- **Ein Set**, eigene SVG-Sammlung (`public/js/ui/icons.js`): 24×24, Linienstil, **Strichstärke 1,8**, runde Enden und Ecken, `currentColor`.
- Größen: 16 px im Button/Fließtext, 18–20 px in Listen und Toasts, 24+ px nur in Menüs/Dock.
- Keine Emojis, keine gefüllten Fremd-Icons, keine Mischung aus verschiedenen Icon-Sets.
- Ein fehlendes Icon wird **im Set ergänzt** (gleicher Stil), nicht aus einer fremden Quelle eingefügt.
- Jedes Icon hat Text oder `title`/`aria-label`.

---

## 8. Layout und Navigation

### 8.1 Browser-Panels (MDT, Fraktions-/Admin-Panels)

- **Desktop-Metapher** (Entschieden): Kopfleiste oben, Dock unten, Fenster dazwischen, Startmenü gruppiert nach Bereichen (Übersicht, Handel, Einsatz, Finanzen, Kommunikation, Administration, Apps).
- Eine **App = ein Fenster** mit Titelleiste, optionalen Aktionen rechts im Fenster-Kopf (`ctx.setActions`) und Tabs im Inhalt.
- Inhalte füllen das Fenster, scrollen innen, nie die ganze Seite.
- Mindestens bedienbar bis 760 px Breite (Mobilansicht: Spalten untereinander).

### 8.2 Ingame (NUI, FiveM)

- **Dieselben Tokens, dieselben Komponenten.** Die UI-Grundbibliothek (Konzept 16.4) übernimmt `tokens.css` und baut Menüs, Benachrichtigungen, Eingabefenster und HUD darauf. `ox_lib`-Standarddialoge werden mit diesem Stil überschrieben oder ersetzt, damit sie nicht wie ein fremdes Produkt aussehen.
- **HUD (Vorschlag):** Schmal, am Rand, halbtransparente `--bg-1`-Flächen (80–90 %), Statuswerte als dünne Balken in einer Farbe pro Wert (Hunger = `--warn`-Ton, Durst = `--info`, Gesundheit = `--ok`, kritisch = `--err`). Nichts in der Bildschirmmitte. Alles per Einstellung ausblendbar.
- **Tablet-/Handy-Apps (Vorschlag):** Selbes Fenster-Prinzip wie das MDT, nur im Gerätahmen: Statusleiste oben, Inhalt, Navigationsleiste unten. App-Icons als Kacheln mit Linien-Icon auf `--bg-3`, Radius `--r-lg`.
- **Interaktion (`ox_target`):** Auswahlpunkte im selben Stil (Linien-Icon + Text, Akzent bei Hover).
- **Benachrichtigungen:** Gleiche Toast-Optik (Farbbalken links), oben rechts oder an der konfigurierten Stelle, max. 3 gleichzeitig.

### 8.3 Website, Whitelist-Portal, Ladebildschirm (Vorschlag)

- Gleiche Tokens, dunkler Grund (`--bg-0`), Inhaltsbreite max. 1100 px, Karten wie im Panel.
- Ladebildschirm: Wortmarke, Fortschrittsbalken (Akzent), ein kurzer Tipp-Text. Keine wechselnden grellen Hintergründe.
- Formulare (Bewerbung, Regelwerk-Test) nutzen die Panel-Formularkomponenten.

### 8.4 Discord (Vorschlag)

- Embed-Farbe = Akzent (Hex von `--accent`), Statusmeldungen in `--ok`/`--warn`/`--err`.
- Embed-Aufbau immer: Titel, kurze Beschreibung, Felder, Fußzeile „SevenV“. Kein Emoji-Überfluss; wenn Symbole, dann immer dieselben pro Bedeutung.

---

## 9. Muster für typische Situationen

### 9.1 Listen und Details
Links Liste mit Suche und Filtern, rechts Detail (Muster Kontaktbuch). Auf schmalen Bildschirmen untereinander.

### 9.2 Formulare
Eine Spalte, bei Platz zwei (`form-row`). Gruppiert durch Trennlinie und kleine Zwischenüberschrift. Validierungsfehler als Hinweisbox oben im Dialog **und** am Feld.

### 9.3 Rechte, Berechtigungen, Sperren
Fehlt ein Recht, wird die Funktion **ausgeblendet**, nicht ausgegraut, außer der Nutzer soll erfahren, dass es sie gibt (dann deaktiviert mit Erklärung). Gesperrte Inhalte tragen ein Schloss-Symbol und eine Kennzeichnung.

### 9.4 Diagramme (Vorschlag)
Dezent, auf `--bg-2`. Pro Diagramm höchstens 5 Datenfarben, gewählt aus den Status- und Akzenttönen, bei mehr Daten Gruppieren statt Regenbogen. Achsen in `--text-3`, Gitterlinien `--line`. Immer Beschriftung oder Legende.

### 9.5 Leere, Lade- und Fehlerzustände
- Laden: Skeletons in Kartenform, kein Vollbild-Spinner.
- Leer: Leerzustand-Baustein.
- Fehler: Klartext, was passiert ist und was der Nutzer tun kann. Keine technischen Meldungen.

### 9.6 Texte
Kurze Sätze, Verben auf Buttons („Speichern“, „Rang anlegen“), keine Ausrufezeichen, keine Großschreibung zur Betonung. Datumsformat `TT.MM.JJJJ`, Zeit 24 h. Anrede im ganzen System **Du**.

---

## 10. Barrierefreiheit und Bedienbarkeit

- Kontrast Text auf Fläche mindestens 4,5:1 (die Tokens erfüllen das).
- Alles per Tastatur erreichbar, Fokusrahmen `2px solid var(--accent)` nie entfernen.
- Zielgröße mindestens 30 px, bevorzugt 38 px.
- Animationen abschaltbar, Glas abschaltbar, Dichte (kompakt/komfortabel) und Radius einstellbar.
- Status nie nur über Farbe.

---

## 11. Umsetzung im Code (technisch)

1. **Eine Quelle:** `docs/design/tokens.css` enthält alle Variablen (gespiegelt aus `public/css/theme.css` des MDT, bei Änderungen beide Dateien anpassen). Jedes neue Projekt (NUI, Website, Portal) bindet diese Datei unverändert ein. Das Design wird nur dort geändert, nirgends sonst.
2. **Komponentenbibliothek:** MDT-Komponenten in `public/js/ui/kit.js` + `components.css`. FiveM-NUI bekommt eine Kopie als „UI-Grundbibliothek“ (Konzept 16.4), gleiche Klassennamen (`btn`, `btn-primary`, `card`, `badge`, `modal`, `toast`, `field`).
3. **Keine Fremd-UI-Frameworks** (kein Bootstrap, Material, Tailwind-Themes) und keine Webfonts-Mischung, sonst entsteht der „zusammengekleisterte“ Eindruck.
4. **Keine festen Farben, Radien, Schatten oder Schriften** im Modul-CSS. Immer Variable. Ausnahme: Weiß/Schwarz für Text auf Akzentflächen.
5. **Namenskonvention:** CSS-Klassen kurz und sprechend, pro Modul ein Präfix (z. B. `.ct-` für Kontaktbuch), nie globale Klassen überschreiben.
6. **Texte** in einer Sprachdatei bzw. an einer Stelle pro Modul (Konzept 16.2), Deutsch.
7. **Prüfen vor dem Merge:** Checkliste in Abschnitt 13.

---

## 12. Regeln für die KI (Verbindlich)

Dieser Abschnitt ist als Anweisung gedacht und steht gekürzt in der `CLAUDE.md` im Projekt. Jede KI, die ein neues System, Menü, Panel oder eine Oberfläche für SevenV baut, hält sich daran:

1. **Zuerst lesen:** `docs/DESIGN-KONZEPT.md` und `docs/design/tokens.css`, bevor Oberflächen entstehen oder geändert werden.
2. **Vorhandenes nutzen:** Komponenten aus `public/js/ui/kit.js` und Klassen aus `components.css` verwenden. Nichts nachbauen, was es gibt.
3. **Nur Tokens:** Keine Hex-Farben, keine eigenen Radien, Schatten, Schriften oder Abstände außerhalb des 4-px-Rasters.
4. **Gleiche Muster:** Dialog-Fuß, Button-Rangfolge, Leerzustände, Tabs, Listen/Detail wie in den vorhandenen Apps (z. B. Kontaktbuch, Legal, Deckel).
5. **Icons nur aus dem eigenen Set;** fehlt eins, im selben Stil ergänzen.
6. **Keine Fremd-Frameworks, keine Emojis in der UI, keine neuen Schriftarten.**
7. **Texte auf Deutsch, Du-Form,** sachlich, ohne Ausrufezeichen.
8. **Mobil und Tastatur** prüfen, Animationen respektieren `prefers-reduced-motion`.
9. **Abweichung nur mit Begründung:** Will die KI oder ein Entwickler vom Konzept abweichen, steht im Pull-Request/Commit ein Absatz „Designabweichung: was, warum“, und die Abweichung wird hier in Abschnitt 14 eingetragen, wenn sie bleibt.
10. **Nach dem Bau:** Selbstkontrolle mit der Checkliste (Abschnitt 13) und Ansicht in Browser/Screenshot, nicht nur Code lesen.

**Prompt-Baustein für Aufträge an eine KI (kopieren):**

> Baue [System] für SevenV. Halte dich strikt am Designkonzept in `docs/DESIGN-KONZEPT.md` und nutze `docs/design/tokens.css` sowie die vorhandenen Komponenten aus `public/js/ui/kit.js`. Keine eigenen Farben, Schriften, Radien oder Icon-Sets. Wenn du etwas brauchst, das es noch nicht gibt, erweitere das Set im selben Stil und nenne es mir. Prüfe am Ende die Checkliste aus Abschnitt 13 und zeige mir einen Screenshot.

---

## 13. Checkliste vor der Abnahme

- [ ] Es kommen nur Variablen aus `tokens.css` vor (Suche nach `#` und `rgb(` im neuen CSS).
- [ ] Höchstens ein primärer Button je Ansicht.
- [ ] Dialoge: Titel, ✕, Fuß mit Abbrechen links der Hauptaktion, Esc schließt.
- [ ] Leerzustand, Ladezustand und Fehlerzustand vorhanden.
- [ ] Status mit Text/Icon, nicht nur Farbe.
- [ ] Tastaturbedienung und sichtbarer Fokus.
- [ ] Mobil (≤ 760 px) lesbar, nichts läuft über den Rand.
- [ ] Animationen respektieren Reduktion.
- [ ] Texte deutsch, Du-Form, Formate (Datum, Zahl, Währung) über die gemeinsamen Funktionen.
- [ ] Icons aus dem eigenen Set.
- [ ] Sieht neben bestehenden Apps (z. B. Kontaktbuch) aus wie dasselbe Produkt.

---

## 14. Ausnahmen und Änderungen

Ausnahmen vom Konzept sind selten und werden hier festgehalten:

| Datum | Bereich | Abweichung | Grund |
|---|---|---|---|
| 09.10.2026 | Neutrale Oberflächen für Externe (coop-Subdomain, Hack-Terminal) | Kein Logo, kein Panelname, eigenes Terminal-Aussehen beim Hack-Zugang | Soll keinen Rückschluss auf das System erlauben (bewusst) |

Änderungen am Konzept selbst (neue Farbe, neues Muster) werden hier ergänzt und im Commit erwähnt.

---

## 15. Offene Entscheidungen

- Wortmarke/Logo final festlegen (Datei, Varianten hell/dunkel, Favicon).
- Soll der Akzent für den Spielserver (Ingame, Website) derselbe sein wie im MDT, oder je Bereich eine feste Variante (Vorschlag: **derselbe**, einstellbar nur an einer Stelle)?
- HUD-Layout (Position, Elemente) nach Test mit Spielern bestätigen.
- Zielauflösungen für Ingame-NUI (Vorschlag: 1080p als Basis, skalierend bis 4K und 16:10).
- Webfont mitliefern (Inter) oder Systemschrift als Fallback akzeptieren? Vorschlag: Inter lokal mitliefern, damit alles gleich aussieht.
