# MDT – Desktop-Oberfläche – Phase 1 (Foundation)

Generisches, vollständig konfigurierbares Web-MDT. Keine festen Organisationen, Benutzer, Rollen, Preise oder Lager im Code.

> **Windows 11:** siehe [deploy/windows/README-WINDOWS.md](deploy/windows/README-WINDOWS.md) (Docker Desktop mit Install-/Update-Skript). **Updates allgemein:** [docs/UPDATE-ANLEITUNG.md](docs/UPDATE-ANLEITUNG.md).

## Docker / Portainer (plug and play)

`docker-compose.yml` im Repo-Hauptverzeichnis ist ein fertiger Stack (Volume `mdt-data`, Healthcheck, Neustart-Policy) – **ohne Variablen** lauffähig. In Portainer: *Stacks → Add stack → Repository* (URL dieses Repos, Compose-Pfad `docker-compose.yml`) → Deploy → `http://<server>:3847` → Ersteinrichtung. Alternativ ohne Build mit dem fertigen GHCR-Image (`deploy/portainer/stack-ghcr.yml`, gebaut von GitHub Actions). Details, Updates, Reverse-Proxy und Backups: [deploy/portainer/README-PORTAINER.md](deploy/portainer/README-PORTAINER.md).

## Starten

Voraussetzung: Node.js ≥ 22.13 (nutzt das eingebaute `node:sqlite`, **keine npm-Abhängigkeiten**).

```bash
npm start          # http://127.0.0.1:3847   (PORT / HOST / MDT_DB per Umgebungsvariable)
npm test           # API-Smoketest (133 Prüfungen, temporäre DB)
npm run seed:demo  # optionale Dummydaten: Demo-Ränge, Abteilungen, mexikanische RP-Namen (nach der Ersteinrichtung)
```

Beim ersten Aufruf erscheint die **Ersteinrichtung**: Systemname, Name der Administrator-Rolle und erster Administrator.
Es gibt keine voreingestellten Zugangsdaten.

## Architektur

```
server/
  app.js              HTTP-Server, Routing, Auth-/Permission-Prüfung, statische Dateien
  core/               db, schema (Migrationen), auth, permissions, config, audit, http-Helfer
  modules/            system · auth · users · roles · org · audit · dashboard · lookups · partners · market   (je: name, permissions, config, routes)
public/
  index.html, css/    theme (Tokens) · shell (Desktop, Fenster, Taskleiste, Layout) · components
  js/modules.js       Navigations-Registry – neue Module tragen sich hier ein
  js/ui/              dom, icons, kit (Buttons, Badges, Tabellen, Modals, Toasts …)
  js/views/           auth, dashboard, admin/{users,roles,config,audit}
```

* **Module** registrieren Permissions und Konfigurationsschlüssel beim Start; Permissions werden in die DB synchronisiert.
* **Serverseitige Durchsetzung:** jede Route deklariert `auth`/`perm`; das Frontend blendet nur aus.
* **Manuelle Freischaltung:** Registrierung ⇒ Status `pending` ⇒ der Server verweigert alle Daten-Routen, bis ein Admin freischaltet.
* **Rechte:** Rollen (mehrere pro Benutzer) + direkte Rechte; Administrator-Rolle = alle Rechte. Eskalationsschutz: Nicht-Admins können weder Admin-Rollen noch eigene fehlende Rechte vergeben; der letzte aktive Admin ist geschützt.
* **Konfiguration:** Definitionen im Code, Werte in der DB, im Admin-Bereich änderbar (Systemname, Akzentfarbe, Registrierung, Sitzungsdauer, Dashboard-Layout).
* **Audit-Log:** alle sicherheitsrelevanten Aktionen mit vorher/nachher-Werten.
* **Sicherheit:** scrypt-Passwörter, HttpOnly/SameSite=Strict-Sitzungscookie (Hash in DB), CSRF-Header, Login-Rate-Limit, CSP, Eingabevalidierung, XSS-sicheres DOM-Rendering.

## Organisation (Ergänzung)

* **Mitgliedsnummern:** fortlaufend, Standard `AZ-220`, `AZ-221` … (Präfix/Startnummer im Admin-Bereich). Vergabe bei erster Freischaltung bzw. Anlage, in einer Transaktion, zusätzlich per UNIQUE-Index abgesichert; Nummern werden nie wiederverwendet und nachträglich nie verändert.
* **Ränge & Abteilungen:** frei konfigurierbar (Farbe, Reihenfolge, Abteilung, Vorgesetzter Rang, optionale Rechte), Hierarchie-Ansicht als Organigramm. Rang und Rechte sind getrennt.
* **Vorbereitet:** generische Verknüpfungen (`entity_links`) und externe Referenzen/Provider (`external_refs`) für Karte, Mitarbeiter, Fahrzeuge, Aufgaben, Operationen und FiveM – siehe `docs/ARCHITEKTUR-ROADMAP.md`.

## Phase 2 – Administration (Ergänzungen)

* **Kategorien & Status** (`lookups`): zentrale Auswahllisten. Freie Listen (z. B. Item-Kategorien, Übergabeorte) pflegt der Admin selbst; feste Listen (Geschäfts-Status) haben Schlüssel im Code, aber änderbare Beschriftung/Farbe.
* **Eigene Rechte** anlegen/löschen (Rollen-App), **Dashboard-Widgets** ein-/ausblenden und sortieren, **Audit-Log** mit Benutzer-/Zeitraum-Filter und CSV-Export, **Datensicherung** (`VACUUM INTO` nach `data/backups`), **Konto & Sicherheit** (Passwort ändern, Sitzungen ansehen/abmelden).

## Externe Zugänge (Partner) & Börse

* **Externe Zugänge** (App „Externe Zugänge“): pro Person ein permanenter Link `/p/<token>` + Zugangscode (6 Ziffern zufällig oder selbst gewählt, nur als Hash gespeichert). Link jederzeit deaktivierbar oder erneuerbar, Code erneuerbar. Nach 5 Fehlversuchen 15 Minuten Sperre. Pro Zugang werden die freigeschalteten Apps gewählt – Partner haben keinen Benutzer-Account und erreichen keine internen Bereiche (eigenes Cookie, eigene API `/api/p/…`).
* **Börse** („kriminelles eBay“, beidseitig): Admin pflegt **Katalog** (Items, Kategorien, Einheit, interner Richtpreis). Partner stellen **Angebote** ein oder melden sich auf unsere **Gesuche** („Wir suchen“). **Verhandlung** mit Preisen/Mengen abwechselnd (annehmen · ablehnen · Gegenangebot), danach **Übergabe** (Ort aus konfigurierbarer Liste + Anweisung + Auszahlungsinfo), Lieferung → Zahlung → Abschluss. Verlauf pro Geschäft, interne Notizen unsichtbar für Partner, Gesamtbetrag wird serverseitig berechnet.
* Weitere Partner-Apps melden sich über `core/partner-apps.js` an.

## Oberfläche & Branding

Desktop-Look: obere Leiste (Logo/App-Menü, Uhr, Benutzer), schwebendes Dock mit allen Apps, Uhr-Widget und Verlaufs-Hintergrund. Farben (Akzent + zweite Farbe), Desktop-Symbole, **Logo** und **Hintergrundbild** stellt der Admin unter „Konfiguration“ ein (Upload nur PNG/JPEG/WebP, serverseitig anhand der Dateikopfdaten geprüft, kein SVG; Dateien liegen in `data/branding`).

## Echtzeit & Benachrichtigungen

* **Live-Sync (SSE):** Jede protokollierte Änderung wird zu einem Ereignis mit fortlaufender ID (Tabelle `events`) und sofort an alle berechtigten, offenen Sitzungen gesendet – Panel und Partner-Portal über dasselbe System (`/api/events`, `/api/p/events`). Der Server meldet nur „X hat sich geändert“; die Ansichten laden über die normalen, berechtigungsgeprüften Endpunkte nach (Backend = einzige Wahrheit). Gesendet wird erst nach dem Commit.
* **Reconnect:** Der Browser verbindet automatisch neu und schickt `Last-Event-ID`; verpasste Ereignisse werden genau einmal nachgeliefert, bei zu großem Abstand folgt ein vollständiger Neuabgleich. Der Verbindungsstatus wird oben in der Leiste angezeigt.
* **Benachrichtigungen:** Jede echte Änderung (Statuswechsel, Gegenangebot, Übergabe, Nachricht …) erzeugt pro Empfänger eine eigene Benachrichtigung mit eindeutigem Ereignis-Schlüssel (UNIQUE ⇒ nie doppelt, nie zusammengefasst). Glocke mit Zähler und Liste, **System-Hinweis** als Pop-up oben rechts im virtuellen Desktop (Klick öffnet den Datensatz) und **Ton** (WebAudio, je Ereignis nur ein Tab, abschaltbar). Es werden bewusst keine echten Browser-/Betriebssystem-Benachrichtigungen verwendet.
* **AZ-Nummern:** Geschäfte `AZ-G-…`, Geschäftspartner `AZ-P-…` (Präfix/Startnummer konfigurierbar). Das Partner-Portal zeigt nie Namen.
* **Anonymität:** Namen interner Mitglieder sehen nur sie selbst – alle anderen (auch Administratoren, Audit-Log, Geschäftsverlauf) nur die Personalnummer.
* **Chat:** Kanäle (Admin legt sie an, optional auf Rollen beschränkt), Nachrichten mit Datum/Uhrzeit, Antworten, Bearbeiten, Löschen (eigene; fremde mit `chat.moderate`), Anpinnen (`chat.pin`), Erwähnungen (`@AZ-220` ⇒ Benachrichtigung), Ungelesen-Zähler, alles live. Absender erscheinen ausschließlich als Personalnummer.
* **Sperrbildschirm:** manuell (Schloss oben) oder nach Inaktivität – Timeout unter *Konfiguration → Zugang* (0 = aus). Entsperren per Passwort (Mitarbeiter) bzw. Zugangscode (Partner); der gesperrte Zustand überlebt einen Reload.
* **Design:** Standard „Anthrazit“; unter *Konfiguration → Darstellung* Vorlage (Anthrazit/Schwarz/Mitternacht/Ozean), Akzentfarben, Hintergrund-Stil, Eckenradius, Darstellungsgröße, Dock-Größe, Transparenz, Animationen, Widget, Wasserzeichen, Logo und Hintergrundbild – mit Live-Vorschau.

## Fahrzeuge & Karte

- **Fahrzeuge** (App „Fahrzeuge“): Name, Kennzeichen, Fahrgestellnummer, Klasse, Farbe, Sitzplätze, Kraftstoff (Diesel / Benzin / Strom), Tank-/Akkustand, Zustand, Kilometerstand, HU, Standort (Text, Stellplatz, Koordinaten), Abteilung, zugewiesenes Mitglied (nur Personalnummer), Bild, Notizen und Änderungsverlauf. Fahrzeugnummer `AZ-V-…` (Präfix in der Konfiguration).
  Rechte: `vehicles.view` (nur ansehen), `vehicles.view_location`, `vehicles.create`, `vehicles.edit`, `vehicles.delete`, `vehicles.assign` – so lassen sich reine „Nur ansehen“-Zugriffe vergeben. Klassen: Admin → Kategorien & Status.
- **Karte** (App „Karte“): interaktive GTA-5-Karte mit Postleitzahlen. `map.view` = ansehen, `map.edit` = Waypoints setzen/verschieben/bearbeiten/löschen (Name, Kategorie, Symbol, Farbe, Stichpunkt-Notizen, Sichtbarkeit „alle“/„nur Bearbeiter“). Fahrzeuge erscheinen als Ebene (nur mit Fahrzeug- und Standortrecht), Suche z. B. „7085“ springt zur Postal.
- **Kartenquelle:** Standard sind die öffentlichen Kacheln von Viruxe (gtav-map-tiles) (Hotlinking, Lizenz liegt beim Anbieter). Unter Konfiguration → Karte lässt sich die Kachel-URL ersetzen; eigene Kacheln liegen unter `data/maptiles/{z}/{x}/{y}.png` und werden als `/maptiles/{z}/{x}/{y}.png` ausgeliefert. Die Umrechnung Spielkoordinaten → Karte ist kalibrierbar (näherungsweise).
- **Karten-Ebenen für Module:** Module (z. B. ein späteres Lager) melden ihre Orte mit `registerMapLayer({ key, label, icon, color, perm, topic, items })` in `server/modules/map.js` an. Jeder Ort hat Koordinaten (x, y) **oder** eine Postleitzahl (wird serverseitig umgerechnet) und erscheint automatisch mit eigenem Schalter in der Kartenleiste.
- Postleitzahl-Daten: Projekt „nearest-postal“ (MIT, © 2019 BlockBa5her). Leaflet 1.9.4 (BSD-2) liegt lokal unter `public/vendor/leaflet`.

## Privatnachrichten & Lager

- **Privatnachrichten:** Im Chat gibt es neben den Kanälen Privatchats zwischen zwei Mitgliedern („+“ neben „Privatnachrichten“). Empfänger sind alle aktiven Mitglieder mit Chat-Zugang – ausschließlich als Personalnummer. Privatchats sind nur für die beiden Beteiligten les- und schreibbar (auch Moderatoren/Admins sehen sie nicht), mit Ungelesen-Zähler, Benachrichtigung und Live-Update.
- **Chat für externe Partner:** Partner bekommen den Chat als eigene Partner-App „Chat“ (Admin → Externe Zugänge → Apps). Sie können (a) Privatnachrichten mit Mitgliedern führen, die das Recht `chat.partners` („Ansprechpartner für Partner“) besitzen, und (b) in Kanälen schreiben, die ihnen ausdrücklich freigegeben wurden (Chat → Kanäle verwalten → „Für externe Partner freigeben“). Mitarbeiter mit `chat.partners` starten Privatchats über „+“ → Externe Partner. Anonymität: Partner sehen Mitglieder nur als Personalnummer, Mitarbeiter sehen Partner als Partnernummer (in der Privatchat-Liste zusätzlich den Partnernamen); Partner können nicht pinnen und nicht an Mitarbeiter-Kanäle, die nicht für sie freigegeben sind. Entziehst du die App, ist der Zugriff sofort weg.
- **Angebote an Partner (Verkauf aus dem Lager):** In der Börse → „Angebot an Partner“: Partner wählen, Lager wählen, einen dort eingelagerten Artikel mit Menge und Preis. Der Partner sieht das Angebot und kann annehmen, ablehnen oder ein Gegenangebot machen (das Team antwortet manuell). **Bei Annahme (egal von welcher Seite) wird die Ware automatisch aus dem Lager abgebucht** – im Lager-Verlauf als „Verkauf an Partner (Börse)“ mit Geschäftsnummer, im Geschäft als interner Eintrag. Reicht der Bestand bei Annahme nicht mehr, passiert nichts (der Partner erfährt keine Bestandszahlen). Wird ein angenommenes Geschäft vor der Übergabe storniert, wird die Ware automatisch zurückgebucht. Nötig: Börsen-Verwaltung (`market.deals.manage`) plus Buchungsrecht im Lager (`warehouse.stock`, Stufe „Verwalten“).
- **Finanz-Journal (Vormerkung fürs Finanzsystem):** Jedes angenommene Geschäft schreibt einen Eintrag in `finance_ledger` – Verkauf = erwarteter Eingang, Ankauf = erwartete Ausgabe (Betrag, Partner, Artikel, Menge, Preis, Lager, Geschäftsnummer). „Abschließen“ setzt ihn auf *verbucht*, Storno auf *storniert*; Einträge werden nie gelöscht. Lesbar mit `finance.view` über `/api/finance/ledger` und `/api/finance/summary`; das spätere Finanzsystem baut darauf auf.
- **Lager** (App „Lager“): mehrere Lagerstandorte mit Koordinaten **oder** Postleitzahl (erscheinen automatisch als Kartenebene), Größe/Kapazität in Platzeinheiten, Zugangsinfo, Bestand je Artikel mit Verlauf, Ein-/Auslagern, Korrigieren und Umlagern.
  Rechte: `warehouse.view`, `warehouse.view_access` (Zugangsinfo), `warehouse.stock` (buchen), `warehouse.manage` (Lager verwalten + Zugriffe), `warehouse.items` (Artikel), `warehouse.prices` (Preisspannen). Zusätzlich je Lager: „beschränkt“ + Rollen mit Stufe *Ansehen* oder *Verwalten*.
- **Preisspanne → Börse:** Jeder Artikel hat optional Mindest-/Höchstpreis und einen Zielbestand. Stellt ein Partner ein Angebot ein (Artikel + Stückzahl), sieht er automatisch unseren **Preisvorschlag** (nie die Spanne) und kann ihn direkt annehmen oder einen eigenen Preis nennen. Beides wird vom Team manuell geprüft (annehmen / Gegenangebot / ablehnen). Die Regel steht unter Konfiguration → Lager: nach Bestand (je voller das Lager gegenüber dem Zielbestand, desto niedriger der Preis), Mittelwert, Mindest- oder Höchstpreis. Bei „Ware eingegangen“ kann die Lieferung direkt in ein Lager eingebucht werden.

## Deckel-System (externe Firmen)

App „Deckel“ (Bereich Finanzen) – **nur für externe Firmen**. Wir geben keine Summen ein und gleichen nichts ab; es gibt deshalb **keine Buchungen und keine Differenz**. Eine Firma wird mit **Firmenname, Firmensitz** (z. B. „PC1234 Test Drive“) und **Kontonummer** (z. B. „LS28180705“, wird großgeschrieben) angelegt, hat ein **wöchentliches/monatliches** Intervall und bekommt automatisch einen **eigenen Portal-Link** `/deckel/firma/<Token>` (neu erzeugbar, alter Link ungültig).

- **Firmenportal:** Die Firma wählt Woche/Monat (nur Zeiträume ohne Abrechnung), trägt den fälligen Betrag ein (+ Kommentar), bekommt die Bestätigung und sieht ihre Historie live. Standard: nur abgeschlossene Zeiträume (Konfiguration → Deckel).
- **Abrechnung beim Team:** Jede eingereichte Abrechnung zeigt **Firma, Firmensitz, Kontonummer und Betrag** (auch in der Benachrichtigung). Beim Bestätigen steht, wie viel auf welches Konto gezahlt wird; ein abweichender Betrag braucht eine Begründung.
- **Ablauf:** Eingereicht → In Prüfung → Bestätigt → Zahlung ausstehend → Bezahlt (oder Abgelehnt, dann kann die Firma erneut einreichen). Zahlung per **Überweisung** (Datum, Referenz) oder **Rechnung** (erhalten, Nummer, Betrag, Datum, PDF/Bild). Jeder Schritt landet im Verlauf, im Audit-Log und als Finanzvorgang (Ausgabe auf das Konto der Firma) im Journal.
- **Löschen:** Firmen und einzelne Abrechnungen lassen sich mit `tab.delete` (und als Superadmin) endgültig löschen – samt Verlauf, Rechnungsdatei und Finanz-Eintrag.
- **Rechte:** `tab.view`, `tab.manage_companies` (Firmen anlegen/bearbeiten/Links), `tab.statements` (prüfen, bestätigen, Zahlung), `tab.delete`.

## Kreditsystem

App „Kredit“ (Finanzen) für Mitarbeiter und – als Partner-App – für externe Zugänge. Unter *Externe Zugänge* wird einem Zugang (Link + Code wie gehabt) die App **Kredit** freigeschaltet; er wird damit zum Kreditnehmer.

- **Anfrage:** Der Kreditnehmer schlägt **Summe, Laufzeit (Anzahl Raten) und Rhythmus (wöchentlich/monatlich)** vor und sieht vorab eine Raten-Vorschau.
- **Verhandlung wie in der Börse:** Das Team **nimmt an** oder macht einen **Gegenvorschlag** und legt dabei **Zinsen** (zinsfrei oder Zinssatz pro Tag/Woche/Monat) sowie das **Zahlungsziel** („Wohin zahlen?“) fest; der Kreditnehmer kann annehmen, ablehnen oder Summe/Laufzeit gegenvorschlagen (der Zinssatz bleibt Sache des Teams). Wer am Zug ist, ist immer sichtbar.
- **Transparenz:** Der Kreditnehmer sieht Kreditsumme, Zinssatz, **Zinsen gesamt**, **Gesamtrückzahlung**, Rate, Laufzeit und Zahlungsziel – bevor er annimmt. Berechnung: einfache Zinsen auf die Kreditsumme; Laufzeit = Raten × (7 bzw. 30 Tage); Tag/Woche/Monat = 1/7/30 Tage; gleiche Raten, Rundungsrest in der letzten Rate.
- **Nach der Annahme:** Das Team bestätigt die **Auszahlung** → Tilgungsplan mit Fälligkeiten (wöchentlich +7 Tage, monatlich gleicher Tag im Folgemonat). Der Kreditnehmer sieht jede Rate (Betrag, Fälligkeit, Status, „in x Tagen“), kann Zahlungen **melden**, das Team erfasst Zahlungen (auch Teilzahlungen). Erinnerungen vor Fälligkeit und bei Überfälligkeit gehen an beide Seiten; „Überfällig“ wird hervorgehoben.
- **Abschluss:** Sind alle Raten bezahlt, gilt der Kredit als **abbezahlt**; er bleibt im Verlauf und es lassen sich neue beantragen. Ausfälle lassen sich markieren (offene Raten werden im Journal storniert).
- **Finanz-Journal:** Auszahlung = Ausgang (verbucht), jede Rate = erwartete Einnahme (verbucht bei Zahlung) – später auswertbar (Zinsanteil im Vermerk).
- **Grenzen & Rechte:** Kreditrahmen je Kreditnehmer, Min/Max-Summe, längste Laufzeit und Zahl offener Anfragen (Konfiguration → Kredit). Rechte: `credit.view`, `credit.manage` (verhandeln, auszahlen), `credit.payments` (Zahlungen/Ausfall), `credit.limits` (Kreditrahmen).

## Profilbilder & Live-Synchronisation

- **Profilbild:** Jedes Mitglied lädt unter Konto & Sicherheit → *Profilbild* ein eigenes Bild hoch (wird quadratisch zugeschnitten, PNG/JPEG/WebP, Typ per Dateikopf geprüft, kein SVG). Es erscheint in der Kopfzeile, in der Benutzerverwaltung und im Chat – immer neben der Personalnummer, nie mit Namen. Mitglieder mit dem Recht `users.avatar_remove` (Admins immer) können fremde Bilder in der Benutzerverwaltung entfernen. Änderungen erscheinen bei allen sofort.
- **Live überall:** Jede Änderung (Deckel, Kredit, Börse, Lager, Chat, Benutzer …) wird als Ereignis gemeldet und in allen offenen Fenstern ohne Neuladen aktualisiert – auch im **Firmenportal** (Statuswechsel erscheinen dort sofort, Eingaben im Formular bleiben erhalten) und im Partner-Portal. Ein automatischer Test prüft, dass jede schreibende Aktion ein Live-Ereignis auslöst und Firmen nie Ereignisse anderer Firmen erhalten.

## Superadmin, Rechte & Hierarchie

Bei der Ersteinrichtung wird nur der Superadmin angelegt (keine Frage nach einer Administrator-Rolle mehr; die frei vergebbare Rolle „Administrator“ wird automatisch erzeugt) und die 13 Standard-Ränge (Aspirante … El Azur Supremo) angelegt, die danach frei änderbar sind.

- **Superadmin:** Die feste Rolle „Superadmin“ entsteht bei der Einrichtung des Systems (erster Benutzer) und ist **weder veränderbar noch vergebbar**. Sie darf wirklich **alles**, auch alles endgültig löschen – egal in welchem Status: Kredite (auch abgeschlossene), Börsen-Geschäfte/Angebote, Deckel-Abrechnungen und -Firmen, externe Zugänge samt Geschäften/Krediten/Dokumenten, Artikel samt Geschäften und Beständen, Lager samt Inhalt, Tickets, Journal-Einträge – und das Panel zurücksetzen. Daneben gibt es frei vergebbare Rollen wie **Administrator**. Andere löschen nur mit den jeweiligen Rechten (`credit.delete`, `market.delete`, `tab.delete`, `partners.delete`, `finance.delete`, `tickets.delete`); `partners.delete` genügt dafür allein (auch ohne `partners.manage`).
- **Personalnummern** (z. B. AZ-221) kann nur der Superadmin ändern und beim Anlegen vergeben (eindeutig).
- **Namen nach Hierarchie:** Den echten Namen eines Mitglieds sieht man bei sich selbst, als Superadmin und bei allen, die in der Hierarchie **unter** einem stehen (übergeordneter Rang oder Vorgesetzten-Kette). Alle anderen sehen nur die Personalnummer.
- **Genaue Rechte:** Jede Route verlangt ein eindeutiges Recht; Rechte lassen sich nur vergeben, wenn man sie selbst besitzt. Die vollständige, **aus dem Code erzeugte** Matrix aller Rechte und Routen steht in [docs/RECHTE.md](docs/RECHTE.md) (`node scripts/gen-rights.mjs` aktualisiert sie). Neu: `users.password_reset`, `audit.export`, `stats.view`, `finance.manual`/`finance.export`/`finance.delete`, `partners.documents`/`partners.delete`, `users.avatar_edit`.

## Externe Zugänge: Lieferant oder Ankäufer

Beim Anlegen wird zuerst die **Art** gewählt – davon hängt ab, welche Angaben nötig sind:

- **Lieferant** (liefert uns Ware): Vorname, Nachname, Street/Straße, Postal Code, Telefonnummer, UMail (Endung `@umail.com` fest), Kontonummer – alles Pflicht – sowie die Dokumente **Ausweis, Führerschein, Waffenschein** (Pflicht) und **Führungszeugnis** (optional). Die Telefonnummer wird schon beim Tippen ins Format `(555) 123-4567` gebracht.
- **Ankäufer** (kauft von uns): Name oder Bezeichnung, Ansprechpartner, Tel (optional).

Dokumente (PDF/PNG/JPEG/WebP, Typ per Dateikopf geprüft, max. 5 MB) sieht und ändert nur, wer `partners.documents` hat. Löschen eines Zugangs mit Geschäften/Krediten: erst Hinweis, dann (mit `partners.delete` oder als Superadmin) samt aller Daten.

## Personalakte der Mitglieder

Beim Anlegen/Bearbeiten eines Benutzers: Vorname, Nachname, Street/Straße, Postal Code, Telefonnummer, UMail, Kontonummer sowie die Dokumente **Ausweis, Führerschein, Waffenschein, Führungszeugnis (optional)**. Die Akte sieht das Mitglied selbst und wer `users.personnel_view` hat (frei zuweisbar); ändern/hochladen mit `users.personnel_edit`. Die Angaben erscheinen nirgends sonst – die Anonymität (Personalnummer) bleibt bestehen.

## Tickets (Fehler melden)

Jedes Mitglied meldet über den Käfer-Button in der Kopfzeile, die App „Tickets“ oder den Chat (Seitenleiste „Meine Tickets“) einen Fehler, eine Idee oder Frage – mit **Screenshot** (Datei oder Einfügen per Strg+V). Der Melder verfolgt Status und Antworten (auch im Chat), das Team (`tickets.manage`) sieht alle Tickets, setzt Status/Priorität/Zuständigkeit und antwortet; Benachrichtigungen laufen in beide Richtungen. Löschen: `tickets.delete` bzw. Superadmin.

## Finanzen & Statistik

- **Finanzen:** Überblick (Saldo, verbuchte/erwartete Ein- und Ausgänge, Verlauf je Monat, Aufteilung nach Börse/Deckel/Kredit/manuell) und **Journal** mit Filtern (Status, Richtung, Art, Zeitraum, Suche), **manuellen Buchungen** (`finance.manual`), **CSV-Export** (`finance.export`) und Löschen einzelner Einträge (`finance.delete`; eingebundene Einträge nur Superadmin).
- **Statistik:** Kennzahlen und Diagramme zu Finanzen, Börse, Kredit, Deckel, Lager, Fahrzeugen, Mitgliedern, Chat und Systemaktivität. `stats.view` öffnet die App; jeder Abschnitt erscheint nur mit dem Ansichtsrecht des Bereichs; es werden nur aggregierte Zahlen geliefert.

## Panel zurücksetzen

Konfiguration → *Gefahrenzone* (nur Superadmin): leert **alle Daten** und hochgeladenen Dateien, ohne dass etwas neu installiert oder gepullt werden muss – Programm, Schema, Datensicherungen und Kartenkacheln bleiben, danach erscheint wieder die Ersteinrichtung. Nur mit Bestätigungstext „ALLES LÖSCHEN“ **und** Passwort; vorher wird automatisch eine Datensicherung angelegt.

## Oberfläche

Desktop-Symbole (Konfiguration → *Desktop-Symbole anzeigen*) lassen sich frei verschieben (Position wird pro Benutzer im Browser gemerkt); das Dock hebt Symbole über die Leiste hinaus an; außerhalb der Karte ist der Hintergrund meerblau.

## Updates, Rollen & Anzeige

- **Update-Prüfung:** Das MDT fragt alle 6 Stunden (und auf Knopfdruck unter Konfiguration → Updates) bei GitHub den neuesten Commit ab und vergleicht ihn mit dem installierten Stand. Ist er neuer, erhalten **Superadmin und Administratoren** einmal je Version eine Benachrichtigung. Abschaltbar; ohne Git-Stand (ZIP-Download, Anzeige „lokal-…“) ist kein Vergleich möglich.
- **Rollen passend zu den Rängen:** Bei der Einrichtung werden 13 Rollen (Aspirante … El Azur Supremo) mit aufsteigenden Rechten angelegt (jede Stufe enthält die darunter; die oberste ist Administrator-Rolle) sowie die frei vergebbare Rolle „Administrator“. Der Superadmin braucht keine Rolle.
- **Karte:** Grundlage ist jetzt die mitgelieferte **Postal-Karte** (`public/img/map.webp`, Postleitzahlen aufgedruckt, kalibriert auf die Postal-Daten des Servers). Unter Konfiguration → Karte lässt sich zwischen Bild und Kacheln (Satellit) umschalten bzw. ein eigenes Bild samt Kalibrierung eintragen.
- **Cache-Schutz:** Skripte, Styles und alle Importe werden mit Versions-Adresse (`?v=…`) ausgeliefert, dazu `no-store` und ein einmaliger Cache-Reset (`Clear-Site-Data`) beim ersten Aufruf nach einem Update – kein STRG+F5 mehr nötig. Details: [docs/UPDATE-ANLEITUNG.md](docs/UPDATE-ANLEITUNG.md).
- **Build-Anzeige:** unten rechts, abschaltbar unter Konfiguration → Darstellung.

## Nächste Phasen

Weitere Module (Fahrzeuge, Lager, Ankauf, Chat …) werden als `server/modules/<name>.js` (Permissions + Routen + Migration) und
Eintrag in `public/js/modules.js` ergänzt. Die Integrationsschicht (Stash/Inventar) kommt mit Phase 5/9.
