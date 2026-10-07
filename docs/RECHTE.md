# Rechte-Matrix

*Diese Datei wird aus dem Code erzeugt (`node scripts/gen-rights.mjs`) – nicht von Hand ändern.*

## Grundregeln

- **Superadmin**: feste Rolle, entsteht bei der Einrichtung (erster Benutzer), **nicht veränderbar und nicht vergebbar**. Hat automatisch **alle** Rechte und darf alles endgültig löschen (jeder Status) sowie das Panel zurücksetzen. Nur der Superadmin ändert Personalnummern.
- **Administrator-Rollen** (`is_admin`): haben automatisch alle fachlichen Rechte, dürfen aber nur von Administratoren/Superadmins vergeben und bearbeitet werden. Superadmins dürfen nur von Superadmins verwaltet werden.
- Alle anderen: ausschließlich die Rechte aus **Rolle(n)**, **Rang** und **direkten Rechten**. Rechte vergeben darf nur, wer sie selbst besitzt (keine Rechteausweitung).
- Mehrere Rechte bei einer Route (`a | b`) bedeuten: **eines davon genügt** (z. B. Lesezugriff für verschiedene Rollen). Schreibende Routen verlangen immer genau das Recht der Aktion.
- Namen von Mitgliedern sieht man nur bei sich selbst, als Superadmin und bei Mitgliedern **unterhalb** der eigenen Hierarchie (übergeordneter Rang / Vorgesetzten-Kette); sonst nur die Personalnummer.
- Statistik: `stats.view` öffnet die App, jeder Abschnitt erscheint zusätzlich nur mit dem Ansichtsrecht des jeweiligen Bereichs.

## Rechte (69)

### audit

| Recht | Bedeutung |
|---|---|
| `audit.export` | Audit-Log als Datei exportieren |
| `audit.view` | Audit-Log einsehen |

### chat

| Recht | Bedeutung |
|---|---|
| `chat.manage` | Chat: Kanäle erstellen, bearbeiten, löschen |
| `chat.moderate` | Chat: Nachrichten anderer löschen |
| `chat.partners` | Chat: mit externen Partnern schreiben (Ansprechpartner für Partner) |
| `chat.pin` | Chat: Nachrichten anpinnen |
| `chat.send` | Chat: Nachrichten schreiben, eigene bearbeiten/löschen |
| `chat.view` | Chat öffnen und lesen |

### credit

| Recht | Bedeutung |
|---|---|
| `credit.delete` | Kredit: Kredite endgültig löschen (jeder Status) |
| `credit.limits` | Kredit: Kreditrahmen der Kreditnehmer festlegen |
| `credit.manage` | Kredit: Anfragen annehmen, Gegenvorschläge machen, Zinsen festlegen, auszahlen |
| `credit.payments` | Kredit: Ratenzahlungen erfassen, Ausfälle melden |
| `credit.view` | Kredit: Kredite, Anfragen und Kreditnehmer ansehen |

### finance

| Recht | Bedeutung |
|---|---|
| `finance.delete` | Finanzen: Journal-Einträge endgültig löschen |
| `finance.export` | Finanzen: Journal als CSV exportieren |
| `finance.manual` | Finanzen: manuelle Buchungen anlegen, verbuchen und stornieren |
| `finance.view` | Finanzen: Geldbewegungen (Journal) und Auswertungen ansehen |

### hack

| Recht | Bedeutung |
|---|---|
| `hack.manage` | Exekutive-Zugang: Link ansehen/erneuern, Einstellungen und Zugriffsprotokoll |

### lookups

| Recht | Bedeutung |
|---|---|
| `lookups.manage` | Kategorien und Status verwalten |
| `lookups.view` | Kategorien und Status ansehen |

### map

| Recht | Bedeutung |
|---|---|
| `map.edit` | Karte: Waypoints setzen, bearbeiten und löschen |
| `map.view` | Karte öffnen und Waypoints ansehen |

### market

| Recht | Bedeutung |
|---|---|
| `market.catalog.manage` | Börse: Item-Katalog verwalten |
| `market.deals.manage` | Börse: Geschäfte bearbeiten (annehmen, ablehnen, Gegenangebot, Übergabe) |
| `market.delete` | Börse: Geschäfte und Angebote endgültig löschen (jeder Status) |
| `market.view` | Börse: Geschäfte, Gesuche und Katalog ansehen |
| `market.wanted.manage` | Börse: Gesuche („Wir suchen“) verwalten |

### org

| Recht | Bedeutung |
|---|---|
| `org.manage` | Ränge und Abteilungen verwalten |
| `org.view` | Ränge, Abteilungen und Hierarchie ansehen |

### partners

| Recht | Bedeutung |
|---|---|
| `partners.delete` | Externe Zugänge samt aller Geschäfte, Kredite und Daten endgültig löschen |
| `partners.documents` | Externe Zugänge: Ausweis/Waffenschein ansehen und hochladen |
| `partners.manage` | Externe Zugänge erstellen, bearbeiten, Links und Codes verwalten |
| `partners.view` | Externe Zugänge ansehen |

### personnel

| Recht | Bedeutung |
|---|---|
| `users.personnel_edit` | Personalakte bearbeiten (Angaben ändern, Dokumente hochladen) |
| `users.personnel_view` | Personalakte ansehen (persönliche Angaben und Dokumente der Mitglieder) |

### profile

| Recht | Bedeutung |
|---|---|
| `users.avatar_edit` | Profilbilder anderer Mitglieder hochladen/ändern |
| `users.avatar_remove` | Profilbilder anderer Mitglieder entfernen |

### roles

| Recht | Bedeutung |
|---|---|
| `roles.manage` | Rollen erstellen, bearbeiten und löschen |
| `roles.view` | Rollen ansehen |

### stats

| Recht | Bedeutung |
|---|---|
| `stats.view` | Statistik: Kennzahlen und Diagramme ansehen (je Bereich zusätzlich das jeweilige Ansichtsrecht nötig) |

### system

| Recht | Bedeutung |
|---|---|
| `admin.access` | Administrationsbereich öffnen |
| `config.edit` | Systemkonfiguration ändern |
| `config.view` | Systemkonfiguration ansehen |
| `permissions.manage` | Eigene Rechte anlegen, ändern und löschen |
| `system.backup` | Datensicherungen erstellen und einsehen |

### tab

| Recht | Bedeutung |
|---|---|
| `tab.delete` | Deckel: Firmen und Abrechnungen endgültig löschen |
| `tab.manage_companies` | Deckel: Firmen anlegen/bearbeiten und Portal-Links verwalten |
| `tab.statements` | Deckel: Abrechnungen prüfen, bestätigen und Zahlungen abwickeln (Finanz) |
| `tab.view` | Deckel: Firmen und Abrechnungen ansehen |

### tickets

| Recht | Bedeutung |
|---|---|
| `tickets.delete` | Tickets: endgültig löschen |
| `tickets.manage` | Tickets: alle Tickets sehen, Status/Priorität/Zuständigkeit ändern und antworten |

### users

| Recht | Bedeutung |
|---|---|
| `users.approve` | Benutzer freischalten, ablehnen, sperren |
| `users.create` | Benutzer anlegen |
| `users.delete` | Benutzer löschen |
| `users.edit` | Benutzer bearbeiten (Rang, Abteilung, Vorgesetzter, Rollen, direkte Rechte) |
| `users.password_reset` | Passwörter anderer Mitglieder zurücksetzen |
| `users.view` | Benutzer ansehen |

### vehicles

| Recht | Bedeutung |
|---|---|
| `vehicles.assign` | Fahrzeuge Mitgliedern zuweisen |
| `vehicles.create` | Fahrzeuge anlegen |
| `vehicles.delete` | Fahrzeuge löschen |
| `vehicles.edit` | Fahrzeuge bearbeiten |
| `vehicles.view` | Fahrzeuge ansehen (nur lesen) |
| `vehicles.view_location` | Fahrzeug-Standorte und Positionen sehen |

### warehouse

| Recht | Bedeutung |
|---|---|
| `warehouse.items` | Lager: Artikel (Items) anlegen und bearbeiten |
| `warehouse.manage` | Lager anlegen, bearbeiten, löschen und Zugriffe festlegen |
| `warehouse.prices` | Lager: Preisspannen (Min/Max) sehen und festlegen |
| `warehouse.stock` | Lager: Bestand ein-/auslagern, korrigieren und umlagern |
| `warehouse.view` | Lager ansehen (Standorte, Größe, Bestand) |
| `warehouse.view_access` | Lager: Zugangsinformationen sehen |

## Routen und benötigte Rechte (Mitarbeiter)

| Methode | Pfad | Recht (eines davon) |
|---|---|---|
| GET | `/api/audit/export` | `audit.export` |
| GET | `/api/audit` | `audit.view` |
| POST | `/api/auth/login` | *öffentlich* |
| POST | `/api/auth/logout` | *öffentlich* |
| GET | `/api/auth/me` | *angemeldet (eigene Daten)* |
| POST | `/api/auth/register` | *öffentlich* |
| POST | `/api/auth/unlock` | *angemeldet (eigene Daten)* |
| GET | `/api/auth/sessions` | *angemeldet (eigene Daten)* |
| POST | `/api/auth/sessions/revoke-others` | *angemeldet (eigene Daten)* |
| POST | `/api/auth/password` | *angemeldet (eigene Daten)* |
| GET | `/api/chat/channels` | `chat.view` |
| GET | `/api/chat/unread` | `chat.view` |
| GET | `/api/chat/people` | `chat.view` |
| GET | `/api/chat/dms` | `chat.view` |
| POST | `/api/chat/dms` | `chat.send` |
| GET | `/api/chat/channels/:id/messages` | `chat.view` |
| POST | `/api/chat/channels/:id/messages` | `chat.send` |
| PATCH | `/api/chat/messages/:id` | `chat.send` |
| DELETE | `/api/chat/messages/:id` | `chat.view` |
| POST | `/api/chat/messages/:id/pin` | `chat.pin` |
| DELETE | `/api/chat/messages/:id/pin` | `chat.pin` |
| POST | `/api/chat/channels/:id/read` | `chat.view` |
| POST | `/api/chat/channels` | `chat.manage` |
| PATCH | `/api/chat/channels/:id` | `chat.manage` |
| DELETE | `/api/chat/channels/:id` | `chat.manage` |
| GET | `/api/credit/options` | `credit.view` |
| GET | `/api/credit/summary` | `credit.view` |
| GET | `/api/credit/loans` | `credit.view` |
| GET | `/api/credit/loans/:id` | `credit.view` |
| POST | `/api/credit/loans/:id/:action` | `credit.view` |
| DELETE | `/api/credit/loans/:id` | `credit.delete` |
| GET | `/api/credit/borrowers` | `credit.view` |
| PATCH | `/api/credit/borrowers/:id` | `credit.limits` |
| GET | `/api/dashboard/layout` | `config.view` |
| PUT | `/api/dashboard/layout` | `config.edit` |
| GET | `/api/dashboard` | *angemeldet (eigene Daten)* |
| GET | `/api/finance/options` | `finance.view` |
| GET | `/api/finance/summary` | `finance.view` |
| GET | `/api/finance/report` | `finance.view` |
| GET | `/api/finance/ledger` | `finance.view` |
| GET | `/api/finance/export.csv` | `finance.export` |
| POST | `/api/finance/entries` | `finance.manual` |
| POST | `/api/finance/entries/:id/settle` | `finance.manual` |
| POST | `/api/finance/entries/:id/cancel` | `finance.manual` |
| DELETE | `/api/finance/entries/:id` | `finance.delete` |
| GET | `/api/hack/admin` | `hack.manage` |
| POST | `/api/hack/admin/regenerate` | `hack.manage` |
| POST | `/api/hack/admin/reset-cooldown` | `hack.manage` |
| GET | `/api/h/:token/status` | *öffentlich* |
| POST | `/api/h/:token/start` | *öffentlich* |
| POST | `/api/h/:token/answer` | *öffentlich* |
| GET | `/api/lookups` | `lookups.view` \| `market.view` |
| POST | `/api/lookups/:list` | `lookups.manage` |
| PATCH | `/api/lookups/:list/:id` | `lookups.manage` |
| POST | `/api/lookups/:list/order/set` | `lookups.manage` |
| DELETE | `/api/lookups/:list/:id` | `lookups.manage` |
| GET | `/api/map/config` | `map.view` |
| GET | `/api/map/layers` | `map.view` |
| GET | `/api/map/postals` | `map.view` |
| GET | `/api/map/points` | `map.view` |
| POST | `/api/map/points` | `map.edit` |
| PATCH | `/api/map/points/:id` | `map.edit` |
| DELETE | `/api/map/points/:id` | `map.edit` |
| GET | `/api/map/vehicles` | `map.view` |
| GET | `/api/market/summary` | `market.view` |
| GET | `/api/market/deals` | `market.view` |
| GET | `/api/market/deals/:id` | `market.view` |
| POST | `/api/market/deals/:id/:action` | `market.deals.manage` |
| DELETE | `/api/market/deals/:id` | `market.delete` |
| GET | `/api/market/partners` | `market.deals.manage` |
| POST | `/api/market/offers` | `market.deals.manage` |
| GET | `/api/market/items` | `market.view` |
| POST | `/api/market/items` | `market.catalog.manage` |
| PATCH | `/api/market/items/:id` | `market.catalog.manage` |
| DELETE | `/api/market/items/:id` | `market.catalog.manage` |
| GET | `/api/market/wanted` | `market.view` |
| POST | `/api/market/wanted` | `market.wanted.manage` |
| PATCH | `/api/market/wanted/:id` | `market.wanted.manage` |
| DELETE | `/api/market/wanted/:id` | `market.wanted.manage` |
| GET | `/api/org` | `org.view` \| `users.view` |
| POST | `/api/ranks` | `org.manage` |
| PATCH | `/api/ranks/:id` | `org.manage` |
| POST | `/api/ranks/order` | `org.manage` |
| DELETE | `/api/ranks/:id` | `org.manage` |
| POST | `/api/departments` | `org.manage` |
| PATCH | `/api/departments/:id` | `org.manage` |
| DELETE | `/api/departments/:id` | `org.manage` |
| GET | `/api/partners` | `partners.view` |
| POST | `/api/partners` | `partners.manage` |
| PATCH | `/api/partners/:id` | `partners.manage` |
| POST | `/api/partners/:id/code` | `partners.manage` |
| POST | `/api/partners/:id/link` | `partners.manage` |
| POST | `/api/partners/:id/docs/:kind` | `partners.documents` |
| GET | `/api/partners/:id/docs/:kind` | `partners.documents` |
| DELETE | `/api/partners/:id` | `partners.manage` \| `partners.delete` |
| GET | `/api/users/:id/personnel` | *angemeldet (eigene Daten)* |
| PUT | `/api/users/:id/personnel` | `users.personnel_edit` |
| POST | `/api/users/:id/docs/:kind` | `users.personnel_edit` |
| GET | `/api/users/:id/docs/:kind` | *angemeldet (eigene Daten)* |
| DELETE | `/api/users/:id/docs/:kind` | `users.personnel_edit` |
| GET | `/api/avatars/:id` | *angemeldet (eigene Daten)* |
| POST | `/api/account/avatar` | *angemeldet (eigene Daten)* |
| DELETE | `/api/account/avatar` | *angemeldet (eigene Daten)* |
| POST | `/api/users/:id/avatar` | `users.avatar_edit` |
| DELETE | `/api/users/:id/avatar` | `users.avatar_remove` |
| GET | `/api/events` | *angemeldet (eigene Daten)* |
| GET | `/api/notifications` | *angemeldet (eigene Daten)* |
| POST | `/api/notifications/read` | *angemeldet (eigene Daten)* |
| POST | `/api/notifications/delete` | *angemeldet (eigene Daten)* |
| GET | `/api/roles` | `roles.view` \| `users.view` |
| POST | `/api/roles` | `roles.manage` |
| PATCH | `/api/roles/:id` | `roles.manage` |
| DELETE | `/api/roles/:id` | `roles.manage` |
| GET | `/api/stats` | `stats.view` |
| GET | `/api/bootstrap` | *öffentlich* |
| GET | `/api/admin/update` | `config.view` |
| POST | `/api/admin/update/check` | `config.view` |
| GET | `/api/version` | *öffentlich* |
| POST | `/api/setup` | *öffentlich* |
| POST | `/api/admin/branding/:kind` | `config.edit` |
| DELETE | `/api/admin/branding/:kind` | `config.edit` |
| GET | `/api/config` | `config.view` \| `hack.manage` |
| PUT | `/api/config` | `config.edit` \| `hack.manage` |
| GET | `/api/permissions` | `roles.view` \| `users.view` \| `org.view` \| `permissions.manage` |
| POST | `/api/permissions` | `permissions.manage` |
| PATCH | `/api/permissions/:key` | `permissions.manage` |
| DELETE | `/api/permissions/:key` | `permissions.manage` |
| GET | `/api/admin/backups` | `system.backup` |
| POST | `/api/admin/reset` | *angemeldet (eigene Daten)* |
| POST | `/api/admin/backups` | `system.backup` |
| GET | `/api/tab/options` | `tab.view` \| `tab.statements` \| `tab.manage_companies` |
| GET | `/api/tab/companies` | `tab.view` \| `tab.manage_companies` \| `tab.statements` |
| GET | `/api/tab/companies/:id` | `tab.view` \| `tab.manage_companies` \| `tab.statements` |
| POST | `/api/tab/companies` | `tab.manage_companies` |
| PATCH | `/api/tab/companies/:id` | `tab.manage_companies` |
| POST | `/api/tab/companies/:id/reset-link` | `tab.manage_companies` |
| DELETE | `/api/tab/companies/:id` | `tab.manage_companies` \| `tab.delete` |
| GET | `/api/tab/summary` | `tab.view` \| `tab.statements` |
| GET | `/api/tab/statements` | `tab.view` \| `tab.statements` |
| GET | `/api/tab/statements/:id` | `tab.view` \| `tab.statements` |
| POST | `/api/tab/statements/:id/invoice-file` | `tab.statements` |
| GET | `/api/tab/statements/:id/invoice-file` | `tab.statements` \| `tab.view` |
| DELETE | `/api/tab/statements/:id` | `tab.delete` |
| POST | `/api/tab/statements/:id/:action` | `tab.statements` |
| GET | `/api/tickets/options` | *angemeldet (eigene Daten)* |
| GET | `/api/tickets` | *angemeldet (eigene Daten)* |
| POST | `/api/tickets` | *angemeldet (eigene Daten)* |
| GET | `/api/tickets/:id` | *angemeldet (eigene Daten)* |
| GET | `/api/tickets/:id/screenshot` | *angemeldet (eigene Daten)* |
| GET | `/api/tickets/:id/comments/:cid/screenshot` | *angemeldet (eigene Daten)* |
| POST | `/api/tickets/:id/comments` | *angemeldet (eigene Daten)* |
| PATCH | `/api/tickets/:id` | *angemeldet (eigene Daten)* |
| DELETE | `/api/tickets/:id` | `tickets.delete` |
| GET | `/api/users` | `users.view` |
| GET | `/api/users/:id` | `users.view` |
| POST | `/api/users` | `users.create` |
| PATCH | `/api/users/:id` | `users.edit` |
| POST | `/api/users/:id/status` | `users.approve` |
| POST | `/api/users/:id/password` | `users.password_reset` |
| DELETE | `/api/users/:id` | `users.delete` |
| GET | `/api/vehicles/options` | `vehicles.view` |
| GET | `/api/vehicles` | `vehicles.view` |
| GET | `/api/vehicles/:id` | `vehicles.view` |
| POST | `/api/vehicles` | `vehicles.create` |
| PATCH | `/api/vehicles/:id` | `vehicles.edit` |
| DELETE | `/api/vehicles/:id` | `vehicles.delete` |
| POST | `/api/vehicles/:id/image` | `vehicles.edit` |
| DELETE | `/api/vehicles/:id/image` | `vehicles.edit` |
| GET | `/api/vehicles/:id/image` | `vehicles.view` |
| GET | `/api/warehouse/options` | `warehouse.view` |
| GET | `/api/warehouses` | `warehouse.view` |
| GET | `/api/warehouses/:id` | `warehouse.view` |
| POST | `/api/warehouses` | `warehouse.manage` |
| PATCH | `/api/warehouses/:id` | `warehouse.manage` |
| DELETE | `/api/warehouses/:id` | `warehouse.manage` |
| POST | `/api/warehouses/:id/stock` | `warehouse.stock` |
| POST | `/api/warehouses/:id/transfer` | `warehouse.stock` |
| GET | `/api/warehouse/items` | `warehouse.view` |
| POST | `/api/warehouse/items` | `warehouse.items` |
| PATCH | `/api/warehouse/items/:id` | `warehouse.items` |
| DELETE | `/api/warehouse/items/:id` | `warehouse.items` |

## Externe Zugänge (Partner-Portal) und Firmenportal

| Methode | Pfad | Voraussetzung |
|---|---|---|
| GET | `/api/p/chat/channels` | externer Zugang, App „chat“ freigeschaltet |
| GET | `/api/p/chat/dms` | externer Zugang, App „chat“ freigeschaltet |
| GET | `/api/p/chat/people` | externer Zugang, App „chat“ freigeschaltet |
| GET | `/api/p/chat/unread` | externer Zugang, App „chat“ freigeschaltet |
| POST | `/api/p/chat/dms` | externer Zugang, App „chat“ freigeschaltet |
| GET | `/api/p/chat/channels/:id/messages` | externer Zugang, App „chat“ freigeschaltet |
| POST | `/api/p/chat/channels/:id/messages` | externer Zugang, App „chat“ freigeschaltet |
| PATCH | `/api/p/chat/messages/:id` | externer Zugang, App „chat“ freigeschaltet |
| DELETE | `/api/p/chat/messages/:id` | externer Zugang, App „chat“ freigeschaltet |
| POST | `/api/p/chat/channels/:id/read` | externer Zugang, App „chat“ freigeschaltet |
| GET | `/api/p/credit/config` | externer Zugang, App „credit“ freigeschaltet |
| GET | `/api/p/credit/loans` | externer Zugang, App „credit“ freigeschaltet |
| GET | `/api/p/credit/loans/:id` | externer Zugang, App „credit“ freigeschaltet |
| POST | `/api/p/credit/requests` | externer Zugang, App „credit“ freigeschaltet |
| POST | `/api/p/credit/loans/:id/:action` | externer Zugang, App „credit“ freigeschaltet |
| GET | `/api/p/market/catalog` | externer Zugang, App „market“ freigeschaltet |
| GET | `/api/p/market/quote` | externer Zugang, App „market“ freigeschaltet |
| GET | `/api/p/market/wanted` | externer Zugang, App „market“ freigeschaltet |
| POST | `/api/p/market/offers` | externer Zugang, App „market“ freigeschaltet |
| POST | `/api/p/market/wanted/:id/respond` | externer Zugang, App „market“ freigeschaltet |
| GET | `/api/p/market/deals` | externer Zugang, App „market“ freigeschaltet |
| GET | `/api/p/market/deals/:id` | externer Zugang, App „market“ freigeschaltet |
| POST | `/api/p/market/deals/:id/:action` | externer Zugang, App „market“ freigeschaltet |
| GET | `/api/p/:token/session` | Zugangs-Link / Code |
| POST | `/api/p/:token/login` | Zugangs-Link / Code |
| POST | `/api/p/logout` | Zugangs-Link / Code |
| POST | `/api/p/unlock` | externer Zugang |
| GET | `/api/p/me` | externer Zugang |
| GET | `/api/p/events` | externer Zugang |
| GET | `/api/p/notifications` | externer Zugang |
| POST | `/api/p/notifications/read` | externer Zugang |
| POST | `/api/p/notifications/delete` | externer Zugang |
| GET | `/api/c/:token` | persönlicher Firmen-Link |
| GET | `/api/c/:token/events` | persönlicher Firmen-Link |
| POST | `/api/c/:token/statements` | persönlicher Firmen-Link |
| GET | `/api/p/tickets/options` | externer Zugang |
| GET | `/api/p/tickets` | externer Zugang |
| POST | `/api/p/tickets` | externer Zugang |
| GET | `/api/p/tickets/:id` | externer Zugang |
| GET | `/api/p/tickets/:id/screenshot` | externer Zugang |
| GET | `/api/p/tickets/:id/comments/:cid/screenshot` | externer Zugang |
| POST | `/api/p/tickets/:id/comments` | externer Zugang |
| PATCH | `/api/p/tickets/:id` | externer Zugang |
