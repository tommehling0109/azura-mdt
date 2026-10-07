// API-Smoketest: Setup, manuelle Freischaltung, Rollen/Rechte, Eskalationsschutz, Audit. Nutzt eine temporäre DB.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { periodKey as tabPeriodKey, periodInfo as tabPeriodInfo } from '../server/core/periods.js';

const dir = mkdtempSync(join(tmpdir(), 'mdt-'));
process.env.MDT_DB = join(dir, 'test.db');
process.env.TRUST_PROXY = '1'; // wie hinter nginx
const { buildApp } = await import('../server/app.js');
const server = buildApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

class Client {
  cookie = '';
  async call(method, path, body) {
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mdt', cookie: this.cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return { status: res.status, ...(await res.json()) };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Öffnet einen SSE-Stream (wie der Browser-EventSource) und sammelt die Ereignisse. */
async function openSse(cookie, path, lastId) {
  const ac = new AbortController();
  const res = await fetch(base + path, { headers: { cookie, ...(lastId != null ? { 'last-event-id': String(lastId) } : {}) }, signal: ac.signal });
  const events = [];
  let buf = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(':') || block.startsWith('retry')) continue;
          const ev = {};
          for (const line of block.split('\n')) { const j = line.indexOf(': '); if (j > 0) ev[line.slice(0, j)] = line.slice(j + 2); }
          if (ev.data) ev.data = JSON.parse(ev.data);
          events.push(ev);
        }
      }
    } catch { /* abgebrochen */ }
  })();
  const waitFor = async (pred, ms = 1500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const f = events.find(pred); if (f) return f; await sleep(15); } return null; };
  return { status: res.status, events, close: () => ac.abort(), waitFor, lastId: () => Number(events.at(-1)?.id ?? 0) };
}
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

try {
  const admin = new Client(), user = new Client(), mod = new Client();

  assert.equal((await admin.call('GET', '/api/bootstrap')).setupRequired, true); ok('Setup erforderlich bei leerer DB');
  assert.equal((await admin.call('GET', '/api/users')).status, 401); ok('API ohne Login → 401');
  let r = await admin.call('POST', '/api/setup', { systemName: 'Test', adminRoleName: 'Boss', displayName: 'Admin', username: 'admin', password: 'passwort123' });
  assert.equal(r.status, 201); assert.equal(r.user.isAdmin, true); ok('Setup legt Admin an');
  assert.equal((await new Client().call('POST', '/api/setup', { systemName: 'X', adminRoleName: 'Yyy', displayName: 'Evil', username: 'evil', password: 'passwort123' })).status, 409); ok('Zweites Setup wird abgelehnt');

  // CSRF-Header
  const raw = await fetch(base + '/api/auth/logout', { method: 'POST' });
  assert.equal(raw.status, 403); ok('POST ohne X-Requested-With → 403');

  // Registrierung → pending
  r = await user.call('POST', '/api/auth/register', { displayName: 'Neuer', username: 'neuer', password: 'passwort123' });
  assert.equal(r.status, 201); assert.equal(r.user.status, 'pending'); assert.deepEqual(r.user.permissions, []); ok('Registrierung → ausstehend, keine Rechte');
  assert.equal((await user.call('GET', '/api/dashboard')).code, 'not_active'); ok('Ausstehender Benutzer: Dashboard gesperrt (serverseitig)');
  assert.equal((await user.call('GET', '/api/users')).status, 403); ok('Ausstehender Benutzer: Benutzerliste gesperrt');
  assert.equal((await user.call('GET', '/api/auth/me')).user.status, 'pending'); ok('/me für ausstehende Benutzer erlaubt');

  // Rolle mit Rechten anlegen, Benutzer freischalten
  r = await admin.call('POST', '/api/roles', { name: 'Moderator', permissions: ['users.view', 'users.approve', 'audit.view'] });
  assert.equal(r.status, 201); const modRole = r.role.id;
  const roles = (await admin.call('GET', '/api/roles')).roles; const adminRole = roles.find((x) => x.isAdmin);
  const users = (await admin.call('GET', '/api/users')).users; const neuer = users.find((u) => u.username === 'neuer');
  r = await admin.call('POST', `/api/users/${neuer.id}/status`, { status: 'active', roleIds: [modRole] });
  assert.equal(r.user.status, 'active'); ok('Admin schaltet Benutzer mit Rolle frei');
  assert.equal((await user.call('GET', '/api/dashboard')).status, 200); ok('Freigeschalteter Benutzer sieht Dashboard');
  assert.equal((await user.call('GET', '/api/users')).status, 200); ok('Rolle gewährt users.view');
  assert.equal((await user.call('GET', '/api/config')).status, 403); ok('Fehlendes Recht config.view → 403');

  // Eskalationsschutz
  assert.equal((await user.call('POST', `/api/users/${neuer.id}/status`, { status: 'blocked' })).status, 403); ok('Eigenen Status ändern verboten');
  r = await user.call('PATCH', `/api/users/${neuer.id}`, { roleIds: [adminRole.id] });
  assert.equal(r.status, 403); ok('Kein Zugriff auf users.edit → 403');
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view'] });
  r = await user.call('PATCH', `/api/users/${neuer.id}`, { roleIds: [modRole, adminRole.id] });
  assert.equal(r.status, 403); ok('Nicht-Admin kann keine Admin-Rolle vergeben');
  r = await user.call('PATCH', `/api/users/${neuer.id}`, { permissions: ['config.edit'] });
  assert.equal(r.status, 403); ok('Nicht-Admin kann kein Recht vergeben, das er nicht besitzt');
  const adminUser = users.find((u) => u.username === 'admin');
  assert.equal((await user.call('POST', `/api/users/${adminUser.id}/status`, { status: 'blocked' })).status, 403); ok('Admin kann nicht von Nicht-Admin gesperrt werden');

  // Letzter Admin
  assert.equal((await admin.call('PATCH', `/api/users/${adminUser.id}`, { roleIds: [] })).status, 409); ok('Letzter Admin kann Rolle nicht verlieren');
  assert.equal((await admin.call('DELETE', `/api/users/${adminUser.id}`)).status, 403); ok('Admin kann sich nicht selbst löschen');
  assert.equal((await admin.call('DELETE', `/api/roles/${adminRole.id}`)).status, 403); ok('Systemrolle nicht löschbar');
  assert.equal((await admin.call('DELETE', `/api/roles/${modRole}`)).status, 409); ok('Rolle mit Mitgliedern nicht löschbar');

  // Sperren beendet Sitzung
  r = await admin.call('POST', `/api/users/${neuer.id}/status`, { status: 'blocked', reason: 'Test' });
  assert.equal(r.user.status, 'blocked');
  assert.equal((await user.call('GET', '/api/dashboard')).status, 401); ok('Sperren beendet bestehende Sitzung');
  assert.equal((await new Client().call('POST', '/api/auth/login', { username: 'neuer', password: 'passwort123' })).code, 'blocked'); ok('Gesperrter Benutzer kann sich nicht anmelden');
  await admin.call('POST', `/api/users/${neuer.id}/status`, { status: 'active' });
  assert.equal((await mod.call('POST', '/api/auth/login', { username: 'neuer', password: 'passwort123' })).status, 200); ok('Entsperrter Benutzer kann sich anmelden');
  assert.equal((await new Client().call('POST', '/api/auth/login', { username: 'neuer', password: 'falsch!!!' })).status, 401); ok('Falsches Passwort → 401');

  // Konfiguration
  r = await admin.call('PUT', '/api/config', { values: { 'ui.accent': '#ff00aa', 'system.name': 'Neu' } });
  assert.deepEqual(r.changed.sort(), ['system.name', 'ui.accent']); ok('Konfiguration ändern');
  assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.accent': 'rot' } })).status, 400); ok('Ungültige Konfiguration → 400');
  assert.equal((await admin.call('GET', '/api/bootstrap')).config['ui.accent'], '#ff00aa'); ok('Öffentliche Konfiguration spiegelt Änderung');

  // Mitgliedsnummern
  assert.equal((await admin.call('GET', `/api/users/${adminUser.id}`)).user.memberNumber, 'AZ-220'); ok('Erstes Mitglied erhält AZ-220 (nicht AZ-01)');
  assert.equal((await admin.call('GET', `/api/users/${neuer.id}`)).user.memberNumber, 'AZ-221'); ok('Freigeschaltetes Mitglied erhält AZ-221');
  r = await new Client().call('POST', '/api/auth/register', { displayName: 'Wartender', username: 'wartender', password: 'passwort123' });
  assert.equal(r.user.memberNumber, null); ok('Ausstehende Benutzer haben noch keine Nummer');
  r = await admin.call('POST', '/api/users', { displayName: 'Dritter', username: 'dritter', password: 'passwort123' });
  assert.equal(r.user.memberNumber, 'AZ-222'); const dritter = r.user.id;
  await admin.call('DELETE', `/api/users/${dritter}`);
  r = await admin.call('POST', '/api/users', { displayName: 'Vierter', username: 'vierter', password: 'passwort123' });
  assert.equal(r.user.memberNumber, 'AZ-223'); ok('Nummer eines gelöschten Mitglieds wird nicht wiederverwendet');
  await admin.call('PUT', '/api/config', { values: { 'members.number_prefix': 'XY-' } });
  r = await admin.call('POST', '/api/users', { displayName: 'Fünfter', username: 'fuenfter', password: 'passwort123' });
  assert.equal(r.user.memberNumber, 'XY-224');
  assert.equal((await admin.call('GET', `/api/users/${adminUser.id}`)).user.memberNumber, 'AZ-220'); ok('Präfix-Änderung lässt vergebene Nummern unberührt');
  await admin.call('PUT', '/api/config', { values: { 'members.number_start': 500 } });
  r = await admin.call('POST', '/api/users', { displayName: 'Sechster', username: 'sechster', password: 'passwort123' });
  assert.equal(r.user.memberNumber, 'XY-500'); ok('Erhöhte Startnummer wird übernommen');
  const { run: dbRun } = await import('../server/core/db.js');
  assert.throws(() => dbRun('UPDATE users SET member_number = ? WHERE id = ?', 'AZ-220', neuer.id), /UNIQUE/); ok('Eindeutigkeit zusätzlich auf Datenbankebene (UNIQUE-Index)');

  // Ränge, Abteilungen, Hierarchie
  r = await admin.call('POST', '/api/departments', { name: 'Legal', color: '#a78bfa' });
  assert.equal(r.status, 201); const legal = r.department.id;
  r = await admin.call('POST', '/api/ranks', { name: 'Consejero', color: '#f5a524' }); const rConsejero = r.rank.id;
  r = await admin.call('POST', '/api/ranks', { name: 'Jefe Jurídico', departmentId: legal, parentRankId: rConsejero }); const rJefe = r.rank.id;
  r = await admin.call('POST', '/api/ranks', { name: 'Abogado', departmentId: legal, parentRankId: rJefe }); const rAbogado = r.rank.id;
  ok('Abteilung und Ränge mit Vorgesetzten-Hierarchie anlegen');
  assert.equal((await admin.call('PATCH', `/api/ranks/${rConsejero}`, { parentRankId: rAbogado })).status, 400); ok('Zyklen in der Rang-Hierarchie werden abgelehnt');
  assert.equal((await mod.call('POST', '/api/ranks', { name: 'Hacker' })).status, 403); ok('Rang anlegen ohne org.manage → 403');
  r = await admin.call('POST', '/api/ranks/order', { ids: [rAbogado, rJefe, rConsejero] });
  assert.equal(r.status, 200);
  assert.equal((await admin.call('POST', '/api/ranks/order', { ids: [rAbogado] })).status, 400); ok('Rangfolge ändern (nur vollständige Liste erlaubt)');
  r = await admin.call('PATCH', `/api/users/${neuer.id}`, { rankId: rAbogado, departmentId: legal, supervisorId: adminUser.id });
  assert.equal(r.user.rank.name, 'Abogado'); assert.equal(r.user.supervisor.displayName, 'Du'); ok('Rang, Abteilung und Vorgesetzten zuweisen');
  assert.equal((await admin.call('PATCH', `/api/users/${adminUser.id}`, { supervisorId: neuer.id })).status, 400); ok('Zyklen in der Vorgesetzten-Kette werden abgelehnt');
  assert.equal((await admin.call('DELETE', `/api/ranks/${rAbogado}`)).status, 409); ok('Rang mit Mitgliedern nicht löschbar');
  // Rang ≠ Rechte: Rang ohne Rechte gewährt nichts, konfigurierte Rang-Rechte wirken zusätzlich
  assert.equal((await mod.call('GET', '/api/config')).status, 403);
  await admin.call('PATCH', `/api/ranks/${rAbogado}`, { permissions: ['config.view'] });
  assert.equal((await mod.call('GET', '/api/config')).status, 200); ok('Rang-Rechte wirken, getrennt vom Rang selbst konfigurierbar');
  r = await admin.call('POST', '/api/ranks', { name: 'Hochrang', permissions: ['config.edit'] }); const rHoch = r.rank.id;
  assert.equal((await mod.call('PATCH', `/api/users/${neuer.id}`, { rankId: rHoch })).status, 403); ok('Kein Rang-Vergeben mit Rechten, die man selbst nicht hat');

  // Verknüpfungen & Integrationsschicht (nur Grundlage)
  const { link, linksOf, hasLink, unlink } = await import('../server/core/links.js');
  link({ type: 'operation', id: 1 }, { type: 'vehicle', id: 7 }, { relation: 'uses' });
  assert.equal(hasLink({ type: 'operation', id: 1 }, { type: 'vehicle', id: 7 }, 'uses'), true);
  assert.equal(linksOf({ type: 'vehicle', id: 7 })[0].direction, 'in'); unlink({ type: 'operation', id: 1 }, { type: 'vehicle', id: 7 }, 'uses');
  ok('Generische Verknüpfungen zwischen Modulen');
  const { setExternalRef, findByExternal, externalIdOf } = await import('../server/core/integrations.js');
  setExternalRef({ provider: 'fivem', entityType: 'user', entityId: neuer.id, externalId: 'char:42' });
  assert.equal(findByExternal('fivem', 'user', 'char:42'), neuer.id); assert.equal(externalIdOf('fivem', 'user', neuer.id), 'char:42');
  ok('Externe Referenzen (Character/Fahrzeug-IDs) ohne feste Server-IDs im Code');

  // ── Phase 2: Kategorien & Status, eigene Rechte ──
  r = await admin.call('GET', '/api/lookups');
  const statusList = r.lists.find((l) => l.key === 'market.deal_status');
  assert.equal(statusList.entries.length, 10); assert.equal(statusList.isFixed, true); ok('Feste Status-Liste mit 10 Zuständen vorhanden');
  r = await admin.call('POST', '/api/lookups/market.item_category', { label: 'Rohstoffe', color: '#22c4a8' });
  assert.equal(r.status, 201); const catId = r.entry.id;
  assert.equal((await admin.call('POST', '/api/lookups/market.item_category', { label: 'rohstoffe' })).status, 409); ok('Kategorie anlegen, Duplikate werden abgelehnt');
  assert.equal((await admin.call('POST', '/api/lookups/market.deal_status', { label: 'Neu' })).status, 403); ok('Feste Liste nicht erweiterbar');
  const submitted = statusList.entries.find((e) => e.key === 'submitted');
  r = await admin.call('PATCH', `/api/lookups/market.deal_status/${submitted.id}`, { label: 'Neu eingegangen', color: '#00ffaa' });
  assert.equal(r.entry.label, 'Neu eingegangen'); ok('Status-Beschriftung und -Farbe anpassbar');
  assert.equal((await admin.call('DELETE', `/api/lookups/market.deal_status/${submitted.id}`)).status, 403); ok('Feste Status-Einträge nicht löschbar');
  r = await admin.call('POST', '/api/lookups/market.handover_place', { label: 'Lager Nord', description: 'Hintereingang, Tor 3' });
  const placeId = r.entry.id;

  assert.equal((await admin.call('POST', '/api/permissions', { key: 'legal.view', description: 'Legal ansehen' })).status, 201);
  assert.equal((await admin.call('POST', '/api/permissions', { key: 'Ungültig' })).status, 400);
  assert.equal((await admin.call('PATCH', '/api/permissions/users.view', { description: 'Posten x' })).status, 403);
  assert.equal((await admin.call('DELETE', '/api/permissions/legal.view')).status, 200); ok('Eigene Rechte: anlegen, validieren, Systemrechte geschützt, löschen');

  // ── Externe Zugänge (Partner): Link + Code ──
  const partnerClient = new Client(), other = new Client();
  r = await admin.call('POST', '/api/partners', { name: 'Händler Eins', apps: ['market'] });
  assert.equal(r.status, 201); assert.match(r.code, /^\d{6}$/); const pid = r.partner.id; let linkTok = r.partner.linkPath.split('/').pop(); let pcode = r.code;
  assert.equal((await admin.call('POST', '/api/partners', { name: 'X', apps: ['gibtsnicht'] })).status, 400); ok('Partner-Zugang mit Link und 6-stelligem Code anlegen');
  r = await partnerClient.call('GET', `/api/p/${linkTok}/session`);
  assert.equal(r.authenticated, false); assert.equal((await partnerClient.call('GET', '/api/p/ungueltig/session')).status, 404); ok('Link prüfen (unbekannte Links → 404)');
  assert.equal((await partnerClient.call('GET', '/api/p/market/catalog')).status, 401); ok('Partner-API ohne Anmeldung gesperrt');
  assert.equal((await partnerClient.call('POST', `/api/p/${linkTok}/login`, { code: '000000' })).status, 401);
  r = await partnerClient.call('POST', `/api/p/${linkTok}/login`, { code: pcode });
  assert.equal(r.status, 200); assert.deepEqual(r.partner.apps, ['market']); ok('Anmeldung nur mit richtigem Code');
  assert.equal((await partnerClient.call('GET', '/api/users')).status, 401); assert.equal((await partnerClient.call('GET', '/api/market/deals')).status, 401); ok('Partner-Sitzung öffnet keine internen Bereiche');
  assert.equal((await partnerClient.call('GET', `/api/p/${linkTok}/session`)).authenticated, true);

  // Brute-Force-Schutz
  const brute = new Client();
  for (let i = 0; i < 4; i++) assert.equal((await brute.call('POST', `/api/p/${linkTok}/login`, { code: '111111' })).status, 401);
  assert.equal((await brute.call('POST', `/api/p/${linkTok}/login`, { code: '111111' })).status, 401);
  assert.equal((await brute.call('POST', `/api/p/${linkTok}/login`, { code: pcode })).status, 429); ok('Sperre nach 5 Fehlversuchen (auch mit richtigem Code)');
  r = await admin.call('POST', `/api/partners/${pid}/code`, { code: 'Abc12345' }); pcode = r.code;
  assert.equal((await partnerClient.call('GET', '/api/p/market/catalog')).status, 401); ok('Neuer Code beendet alte Sitzungen');
  assert.equal((await partnerClient.call('POST', `/api/p/${linkTok}/login`, { code: pcode })).status, 200); ok('Neuer Code hebt Sperre auf');

  // Partner ohne Markt-App
  r = await admin.call('POST', '/api/partners', { name: 'Ohne App', apps: [] }); const noApp = r;
  const noAppClient = new Client();
  await noAppClient.call('POST', `/api/p/${noApp.partner.linkPath.split('/').pop()}/login`, { code: noApp.code });
  assert.equal((await noAppClient.call('GET', '/api/p/market/catalog')).status, 403); ok('Nur freigeschaltete Apps sind erreichbar');

  // ── Börse ──
  assert.equal((await mod.call('GET', '/api/market/deals')).status, 403); ok('Börse-Verwaltung ohne Recht → 403');
  r = await admin.call('POST', '/api/market/items', { name: 'Eisen', unit: 'Stück', categoryId: catId, referencePrice: 50 });
  assert.equal(r.status, 201); const eisen = r.item.id;
  assert.equal((await admin.call('POST', '/api/market/items', { name: 'eisen' })).status, 409);
  r = await partnerClient.call('GET', '/api/p/market/catalog'); assert.equal(r.items[0].name, 'Eisen'); ok('Katalog-Item im Admin-Bereich anlegen, Partner sieht es');

  r = await partnerClient.call('POST', '/api/p/market/offers', { itemId: eisen, quantity: 250, unitPrice: 60, note: 'Frisch geliefert' });
  assert.equal(r.status, 201); assert.equal(r.deal.total, 15000); assert.equal(r.deal.turn, 'staff'); const deal = r.deal.id;
  assert.equal((await partnerClient.call('POST', '/api/p/market/offers', { itemId: eisen, quantity: 0, unitPrice: 5 })).status, 400);
  assert.equal((await admin.call('GET', '/api/market/summary')).awaitingStaff, 1); ok('Partner stellt Angebot ein, Preis wird serverseitig berechnet');
  assert.equal((await partnerClient.call('POST', `/api/p/market/deals/${deal}/accept`)).status, 409); ok('Am Zug ist nur die jeweils andere Seite');
  r = await admin.call('POST', `/api/market/deals/${deal}/counter`, { unitPrice: 50, text: 'Mehr ist nicht drin' });
  assert.equal(r.deal.status, 'negotiating'); assert.equal(r.deal.turn, 'partner'); assert.equal(r.deal.total, 12500);
  assert.equal((await admin.call('POST', `/api/market/deals/${deal}/accept`)).status, 409); ok('Gegenangebot → Partner am Zug');
  await admin.call('POST', `/api/market/deals/${deal}/message`, { text: 'Interner Hinweis', internal: true });
  r = await partnerClient.call('GET', `/api/p/market/deals/${deal}`);
  assert.equal(r.events.some((e) => e.internal || e.text === 'Interner Hinweis'), false); assert.equal(r.deal.handover, null); ok('Interne Notizen sind für Partner unsichtbar');
  assert.equal((await partnerClient.call('POST', `/api/p/market/deals/${deal}/handover`, { info: 'x' })).status, 403); ok('Partner kann keine Staff-Aktionen ausführen');
  assert.equal((await admin.call('POST', `/api/market/deals/${deal}/handover`, { info: 'x' })).status, 409);
  r = await partnerClient.call('POST', `/api/p/market/deals/${deal}/accept`);
  assert.equal(r.deal.status, 'accepted'); assert.equal(r.deal.unitPrice, 50); ok('Partner nimmt Gegenangebot an → Preis fixiert');
  assert.equal((await admin.call('POST', `/api/market/deals/${deal}/handover`, {})).status, 400);
  r = await admin.call('POST', `/api/market/deals/${deal}/handover`, { placeId, info: 'Beim Tor 3 klingeln', payoutInfo: '12.500 $ bar bei Übergabe' });
  assert.equal(r.deal.status, 'delivery'); ok('Übergabeort und Auszahlung festlegen');
  r = await partnerClient.call('GET', `/api/p/market/deals/${deal}`);
  assert.equal(r.deal.handover.place.label, 'Lager Nord'); assert.equal(r.deal.handover.payoutInfo.includes('12.500'), true); ok('Partner sieht Übergabe-Infos erst nach Annahme');
  for (const step of ['delivered', 'payout', 'completed']) {
    r = await admin.call('POST', `/api/market/deals/${deal}/advance`, { to: step }); assert.equal(r.deal.status, step);
  }
  assert.equal((await admin.call('POST', `/api/market/deals/${deal}/cancel`)).status, 409); ok('Lieferung → Zahlung → Abschluss; beendete Geschäfte sind gesperrt');

  // Datenisolation zwischen Partnern
  const second = await admin.call('POST', '/api/partners', { name: 'Händler Zwei', apps: ['market'] });
  const secondClient = new Client();
  await secondClient.call('POST', `/api/p/${second.partner.linkPath.split('/').pop()}/login`, { code: second.code });
  assert.equal((await secondClient.call('GET', `/api/p/market/deals/${deal}`)).status, 404);
  assert.equal((await secondClient.call('GET', '/api/p/market/deals')).deals.length, 0); ok('Partner sehen nur ihre eigenen Geschäfte');

  // Gesuche („Wir suchen“)
  r = await admin.call('POST', '/api/market/wanted', { itemId: eisen, quantity: 100, unitPrice: 70, note: 'Dringend' });
  assert.equal(r.status, 201); const wanted = r.wanted.id;
  r = await secondClient.call('GET', '/api/p/market/wanted'); assert.equal(r.wanted.length, 1); assert.equal(r.wanted[0].unitPrice, 70); ok('Gesuch ist für Partner sichtbar');
  assert.equal((await secondClient.call('POST', `/api/p/market/wanted/${wanted}/respond`, { quantity: 500 })).status, 400);
  r = await secondClient.call('POST', `/api/p/market/wanted/${wanted}/respond`, { quantity: 50 });
  assert.equal(r.status, 201); assert.equal(r.deal.unitPrice, 70); assert.equal(r.deal.origin, 'wanted'); const resp = r.deal.id; ok('Partner meldet sich auf ein Gesuch (Preis vom Gesuch)');
  assert.equal((await admin.call('GET', '/api/market/wanted')).wanted[0].responseCount, 1);
  r = await secondClient.call('POST', `/api/p/market/deals/${resp}/withdraw`); assert.equal(r.deal.status, 'withdrawn'); ok('Partner kann zurückziehen');
  await admin.call('PATCH', `/api/market/wanted/${wanted}`, { status: 'closed' });
  assert.equal((await secondClient.call('GET', '/api/p/market/wanted')).wanted.length, 0); ok('Geschlossene Gesuche verschwinden');
  assert.equal((await admin.call('DELETE', `/api/partners/${pid}`)).status, 409);
  assert.equal((await admin.call('DELETE', `/api/market/items/${eisen}`)).status, 409); ok('Zugänge und Items mit Geschäften nicht löschbar');

  // Link deaktivieren / neu erzeugen
  r = await admin.call('PATCH', `/api/partners/${pid}`, { status: 'disabled' });
  assert.equal((await partnerClient.call('GET', '/api/p/market/catalog')).status, 401);
  assert.equal((await new Client().call('GET', `/api/p/${linkTok}/session`)).status, 404); ok('Deaktivierter Link: sofort abgemeldet, Link ungültig');
  await admin.call('PATCH', `/api/partners/${pid}`, { status: 'active' });
  r = await admin.call('POST', `/api/partners/${pid}/link`); const oldTok = linkTok; linkTok = r.linkPath.split('/').pop();
  assert.equal((await new Client().call('GET', `/api/p/${oldTok}/session`)).status, 404);
  assert.equal((await new Client().call('GET', `/api/p/${linkTok}/session`)).status, 200); ok('Neuer Link macht den alten ungültig');

  // ── Dashboard-Layout, Audit-Filter/-Export, Backup, Sitzungen ──
  r = await admin.call('GET', '/api/dashboard/layout'); assert.equal(r.widgets.some((w) => w.id === 'market-open'), true);
  await admin.call('PUT', '/api/dashboard/layout', { widgets: r.widgets.map((w) => ({ id: w.id, enabled: w.id !== 'welcome' })) });
  assert.equal((await admin.call('GET', '/api/dashboard')).widgets.some((w) => w.id === 'welcome'), false);
  assert.equal((await admin.call('PUT', '/api/dashboard/layout', { widgets: [{ id: 'nope', enabled: true }] })).status, 400); ok('Dashboard-Widgets konfigurierbar (ein/aus, Reihenfolge)');
  r = await admin.call('GET', '/api/audit?user=AZ-220&from=2000-01-01&to=2999-12-31'); assert.ok(r.total > 0);
  assert.equal((await admin.call('GET', '/api/audit?user=gibtsnicht')).total, 0);
  const csv = await fetch(`${base}/api/audit/export?module=market`, { headers: { cookie: admin.cookie } });
  const csvText = await csv.text();
  assert.equal(csv.headers.get('content-type').startsWith('text/csv'), true); assert.ok(csvText.includes('Zeitpunkt') && csvText.includes('market.deal_')); ok('Audit-Log: Filter nach Benutzer/Zeitraum und CSV-Export');
  assert.equal((await fetch(`${base}/api/audit/export`, { headers: { cookie: mod.cookie } })).status, 200); // mod hat audit.view
  r = await admin.call('POST', '/api/admin/backups'); assert.equal(r.status, 201);
  assert.equal(r.backups.length >= 1, true); assert.equal((await mod.call('POST', '/api/admin/backups')).status, 403); ok('Datenbank-Backup erstellen (nur mit Recht)');
  r = await mod.call('GET', '/api/auth/sessions'); assert.equal(r.sessions.some((s) => s.current), true);
  r = await mod.call('POST', '/api/auth/sessions/revoke-others'); assert.equal(typeof r.revoked, 'number'); ok('Eigene Sitzungen einsehen und andere abmelden');

  // ── Betrieb hinter Reverse-Proxy ──
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mdt', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ username: 'nobody', password: 'x' }) });
  r = await admin.call('GET', '/api/audit?action=auth.login_failed');
  assert.equal(r.rows[0].ip, '203.0.113.9'); ok('Health-Check und Client-IP hinter Proxy (TRUST_PROXY)');


  // ══ Echtzeit, Benachrichtigungen, AZ-Nummern, Anonymität ══
  const rtPartner = await admin.call('POST', '/api/partners', { name: 'Streng Geheim GmbH', apps: ['market'] });
  assert.match(rtPartner.partner.number, /^AZ-P-\d{6}$/); ok('Partner erhält Nummer im Format AZ-P-123456');
  const rt = new Client();
  await rt.call('POST', `/api/p/${rtPartner.partner.linkPath.split('/').pop()}/login`, { code: rtPartner.code });
  r = await rt.call('GET', '/api/p/me');
  assert.equal(r.partner.number, rtPartner.partner.number); assert.equal(JSON.stringify(r).includes('Streng Geheim'), false); ok('Partner-Portal zeigt nur die AZ-P-Nummer, nie den Namen');

  // Live-Streams: Mitarbeiter (admin), Mitarbeiter ohne Börsenrecht (mod), Partner
  const sAdmin = await openSse(admin.cookie, '/api/events');
  const sMod = await openSse(mod.cookie, '/api/events');
  const sPartner = await openSse(rt.cookie, '/api/p/events');
  assert.equal(sAdmin.status, 200);
  assert.ok(await sAdmin.waitFor((e) => e.event === 'hello')); assert.ok(await sPartner.waitFor((e) => e.event === 'hello')); ok('Live-Verbindung (SSE) für Mitarbeiter und Partner-Portal');
  assert.equal((await new Client().call('GET', '/api/events')).status, 401); ok('Live-Verbindung nur mit Anmeldung');

  const publicNames = ['Streng Geheim', '"Admin"', '"neuer"', '"Neuer"'];
  const seen = []; // alle Antworten des Partner-Portals für die Namensprüfung
  const P = async (method, path, body) => { const x = await rt.call(method, path, body); seen.push(JSON.stringify(x)); return x; };

  // Partner stellt Angebot ein → Mitarbeiter: Live-Änderung + Benachrichtigung
  r = await P('POST', '/api/p/market/offers', { itemId: eisen, quantity: 100, unitPrice: 55, note: 'Test' });
  assert.match(r.deal.number, /^AZ-G-\d{6}$/); const rtDeal = r.deal.id; const rtNumber = r.deal.number;
  assert.equal(r.deal.partner, undefined);
  assert.ok(await sAdmin.waitFor((e) => e.event === 'change' && e.data.topic === 'market' && e.data.entityId === String(rtDeal))); ok('Neues Geschäft erscheint live beim Mitarbeiter (AZ-G-Nummer)');
  const n1 = await sAdmin.waitFor((e) => e.event === 'notification' && e.data.target?.dealId === rtDeal);
  assert.ok(n1 && n1.data.title.includes(rtNumber)); ok('Mitarbeiter erhalten sofort eine Benachrichtigung zum neuen Geschäft');
  assert.equal(sMod.events.some((e) => e.event === 'change' && e.data.topic === 'market'), false);
  assert.equal(sMod.events.some((e) => e.event === 'notification'), false); ok('Mitglieder ohne Börsenrecht bekommen keine Börsen-Ereignisse');

  // Mehrere schnelle Statuswechsel hintereinander: jede Änderung = eigene Benachrichtigung
  const startPartnerNotifs = (await rt.call('GET', '/api/p/notifications')).notifications.length;
  await admin.call('POST', `/api/market/deals/${rtDeal}/counter`, { unitPrice: 50 });            // Verhandlung          → Partner-Benachrichtigung 1
  await rt.call('POST', `/api/p/market/deals/${rtDeal}/counter`, { unitPrice: 52 });
  await admin.call('POST', `/api/market/deals/${rtDeal}/accept`);                                 // Angenommen           → 2
  await admin.call('POST', `/api/market/deals/${rtDeal}/handover`, { placeId, info: 'Tor 3' });  // Lieferung ausstehend → 3
  await admin.call('POST', `/api/market/deals/${rtDeal}/advance`, { to: 'delivered' });          // Ware eingegangen     → 4
  await admin.call('POST', `/api/market/deals/${rtDeal}/advance`, { to: 'payout' });             // Zahlung ausstehend   → 5
  await admin.call('POST', `/api/market/deals/${rtDeal}/advance`, { to: 'completed' });          // Abgeschlossen        → 6
  await sleep(150);
  r = await rt.call('GET', '/api/p/notifications');
  const created = r.notifications.length - startPartnerNotifs;
  assert.equal(created, 6); assert.equal(new Set(r.notifications.map((n) => n.key)).size, r.notifications.length); ok('6 schnelle Statuswechsel → 6 eigene Benachrichtigungen, keine verloren, keine doppelt');
  const partnerNotifEvents = sPartner.events.filter((e) => e.event === 'notification' && e.data.kind === 'new' && e.data.target?.dealId === rtDeal);
  assert.equal(partnerNotifEvents.length, 6); assert.equal(new Set(partnerNotifEvents.map((e) => e.id)).size, 6);
  assert.ok(partnerNotifEvents.every((e) => e.data.title.includes(rtNumber))); ok('Partner erhält jedes Status-Ereignis live (je 1×, eindeutige IDs, AZ-G-Nummer im Titel)');
  assert.ok(partnerNotifEvents.some((e) => /Abgeschlossen/.test(e.data.body))); assert.ok(partnerNotifEvents.some((e) => /Zahlung ausstehend/.test(e.data.body)));
  assert.equal(JSON.stringify(partnerNotifEvents).includes('Streng Geheim'), false);

  // Dasselbe Ereignis darf nie doppelt erzeugt werden (UNIQUE: Empfänger + Ereignis-Schlüssel)
  const { notify } = await import('../server/core/notifications.js');
  const key = r.notifications[0].key;
  assert.equal(notify([{ type: 'partner', id: rtPartner.partner.id }], { key, title: 'dup', body: '' }), 0); ok('Dasselbe Ereignis erzeugt nie eine zweite Benachrichtigung');

  // Lesestatus
  await rt.call('POST', '/api/p/notifications/read', {});
  assert.equal((await rt.call('GET', '/api/p/notifications')).unread, 0); ok('Benachrichtigungen als gelesen markieren (Partner)');
  assert.ok((await admin.call('GET', '/api/notifications')).unread > 0); await admin.call('POST', '/api/notifications/read', {}); assert.equal((await admin.call('GET', '/api/notifications')).unread, 0); ok('Benachrichtigungen als gelesen markieren (Mitarbeiter)');

  // Partner-Portal: nirgends Namen (Partner, Mitglieder)
  for (const pth of ['/api/p/me', '/api/p/market/deals', `/api/p/market/deals/${rtDeal}`, '/api/p/market/wanted', '/api/p/market/catalog', '/api/p/notifications']) await P('GET', pth);
  const joined = seen.join('\n');
  for (const needle of publicNames) assert.equal(joined.includes(needle), false, `Partner-Antworten enthalten: ${needle}`);
  assert.ok(joined.includes(rtNumber)); ok('Partner-Portal: keine Namen in Antworten, nur AZ-Nummern');

  // Reconnect: verpasste Ereignisse werden nachgeliefert (ohne Doppelte); zu alt/ungültig → reset
  const lastSeen = sPartner.lastId();
  sPartner.close();
  r = await admin.call('POST', '/api/market/items', { name: 'Reconnect-Item', unit: 'Stück' });
  const itemX = r.item.id;
  await admin.call('PATCH', `/api/market/items/${itemX}`, { description: 'geändert' });
  await admin.call('PATCH', `/api/market/items/${itemX}`, { description: 'nochmal' });
  const sResume = await openSse(rt.cookie, '/api/p/events', lastSeen);
  assert.ok(await sResume.waitFor((e) => e.event === 'hello' && e.data.resumed === true));
  const missed = sResume.events.filter((e) => e.event === 'change' && e.data.topic === 'market');
  assert.equal(missed.length, 3); assert.equal(new Set(missed.map((e) => e.id)).size, 3); assert.ok(missed.every((e) => Number(e.id) > lastSeen)); ok('Reconnect: 3 verpasste Änderungen nachgeliefert – je genau einmal');
  const resumeLast = sResume.lastId(); sResume.close();
  const sAgain = await openSse(rt.cookie, '/api/p/events', resumeLast);
  await sAgain.waitFor((e) => e.event === 'hello');
  assert.equal(sAgain.events.filter((e) => e.event !== 'hello').length, 0); sAgain.close(); ok('Erneuter Reconnect: nichts doppelt geliefert');
  const sReset = await openSse(rt.cookie, '/api/p/events', 999999999);
  assert.ok(await sReset.waitFor((e) => e.event === 'reset')); sReset.close(); ok('Unbekannter/veralteter Stand → reset (Client lädt vollständig neu)');

  // Mehrere Tabs/Benutzer
  assert.ok(sAdmin.events.filter((e) => e.event === 'change' && e.data.topic === 'market').length >= 7); ok('Alle Änderungen wurden live an offene Mitarbeiter-Sitzungen gesendet');
  const sAdmin2 = await openSse(admin.cookie, '/api/events');
  await sAdmin2.waitFor((e) => e.event === 'hello');
  await admin.call('PATCH', `/api/market/items/${itemX}`, { description: 'tab2' });
  const a2 = await sAdmin2.waitFor((e) => e.event === 'change' && e.data.entityId === String(itemX));
  const a1 = await sAdmin.waitFor((e) => e.id === a2?.id);
  assert.ok(a1 && a2 && a1.id === a2.id); sAdmin2.close(); ok('Mehrere Tabs/Benutzer erhalten dasselbe Ereignis (gleiche ID)');

  // Live-Zähler pro Kategorie und Status (immer aus dem Backend berechnet)
  const countActive = async () => { const d = (await admin.call('GET', '/api/market/deals?group=open')).deals.concat((await admin.call('GET', '/api/market/deals?group=active')).deals); return d.filter((x) => x.item.category?.id === catId).length; };
  const before = (await admin.call('GET', '/api/market/summary')).byCategory.find((c) => c.id === catId).active;
  assert.equal(before, await countActive());
  r = await rt.call('POST', '/api/p/market/offers', { itemId: eisen, quantity: 5, unitPrice: 60 });
  const newDeal = r.deal.id;
  assert.ok(await sAdmin.waitFor((e) => e.event === 'change' && e.data.entityId === String(newDeal)));
  const afterAdd = (await admin.call('GET', '/api/market/summary')).byCategory.find((c) => c.id === catId);
  assert.equal(afterAdd.active, before + 1); assert.equal(afterAdd.active, await countActive()); ok('Kategorie-Zähler steigt, wenn ein Vorgang hinzukommt');
  await rt.call('POST', `/api/p/market/deals/${newDeal}/withdraw`);
  const afterWd = (await admin.call('GET', '/api/market/summary')).byCategory.find((c) => c.id === catId);
  assert.equal(afterWd.active, before); assert.equal((await admin.call('GET', '/api/market/summary')).byStatus.withdrawn >= 1, true); ok('Kategorie- und Status-Zähler folgen dem Backend-Zustand');
  await admin.call('PATCH', `/api/market/items/${eisen}`, { categoryId: null });
  assert.equal((await admin.call('GET', '/api/market/summary')).byCategory.find((c) => c.id === catId).total, 0);
  await admin.call('PATCH', `/api/market/items/${eisen}`, { categoryId: catId }); ok('Kategorie wechseln → Zähler folgen');

  // Anonymität interner Mitglieder
  r = await mod.call('GET', '/api/users');
  const me = r.users.find((u) => u.isSelf);
  assert.equal(me.displayName, 'Neuer'); assert.equal(me.username, 'neuer');
  const others = r.users.filter((u) => !u.isSelf);
  assert.ok(others.length > 3);
  for (const u of others) { assert.match(u.displayName, /^(AZ-\d+|XY-\d+|Antrag #\d+)$/); if (u.status !== 'pending') assert.equal(u.username, null); }
  assert.equal(JSON.stringify(r).includes('Test Admin') || JSON.stringify(r).includes('"Admin"'), false); ok('Mitglieder sehen fremde Namen nie – nur Personalnummern (eigener Name sichtbar)');
  r = await admin.call('GET', `/api/users/${neuer.id}`); assert.match(r.user.displayName, /^AZ-\d+$/); assert.equal(r.user.username, null);
  assert.equal((await admin.call('PATCH', `/api/users/${neuer.id}`, { displayName: 'Anders' })).status, 403); ok('Auch Administratoren sehen/ändern fremde Namen nicht');
  r = await admin.call('GET', '/api/audit?limit=200');
  const auditJson = JSON.stringify(r.rows);
  for (const uname of ['admin', 'neuer', 'dritter', 'vierter', 'fuenfter', 'sechster', 'Test Admin']) assert.equal(auditJson.includes(`"${uname}"`), false, `Audit enthält Namen: ${uname}`);
  assert.ok(r.rows.some((x) => x.actor === 'Du') && r.rows.some((x) => /^AZ-\d+$/.test(x.actor))); ok('Audit-Log zeigt Handelnde nur als Personalnummer (man selbst als „Du“)');
  r = await admin.call('GET', `/api/market/deals/${rtDeal}`);
  assert.ok(r.events.some((e) => e.actorName === 'Du') && r.events.some((e) => e.actorType === 'partner'));
  assert.equal(JSON.stringify(r.events).includes('"Admin"'), false); ok('Geschäftsverlauf: Mitarbeiter als „Du“/Personalnummer');

  sAdmin.close(); sMod.close();


  // ══ Zuweisung: Team → AZ-Nummer, Sperrbildschirm, Chat ══
  r = await rt.call('POST', '/api/p/market/offers', { itemId: eisen, quantity: 3, unitPrice: 70 });
  const asgDeal = r.deal.id;
  await admin.call('POST', `/api/market/deals/${asgDeal}/message`, { text: 'Hallo vom Team' });
  r = await rt.call('GET', `/api/p/market/deals/${asgDeal}`);
  assert.equal(r.deal.assignee, null); assert.ok(r.events.some((e) => e.actorName === 'Team')); ok('Ohne Zuweisung bleibt es „Team“');
  await admin.call('POST', `/api/market/deals/${asgDeal}/assign`, { userId: adminUser.id });
  r = await rt.call('GET', `/api/p/market/deals/${asgDeal}`);
  assert.equal(r.deal.assignee.displayName, 'AZ-220'); assert.equal(r.events.some((e) => e.actorName === 'Team'), false);
  assert.ok(r.events.some((e) => e.actorName === 'AZ-220')); assert.equal(JSON.stringify(r).includes('"Admin"'), false); ok('Nach Zuweisung sieht der Partner die Personalnummer (AZ-220) statt „Team“');
  await admin.call('POST', `/api/market/deals/${asgDeal}/assign`, { userId: null });
  assert.equal((await rt.call('GET', `/api/p/market/deals/${asgDeal}`)).events.some((e) => e.actorName === 'AZ-220'), false); ok('Zuweisung entfernt → wieder „Team“');

  // Sperrbildschirm: Passwort/Code erneut bestätigen
  assert.equal((await admin.call('POST', '/api/auth/unlock', { password: 'falsch!!!' })).status, 401);
  assert.equal((await admin.call('POST', '/api/auth/unlock', { password: 'passwort123' })).status, 200);
  assert.equal((await rt.call('POST', '/api/p/unlock', { code: '000000' })).status, 401);
  assert.equal((await rt.call('POST', '/api/p/unlock', { code: rtPartner.code })).status, 200);
  assert.equal((await new Client().call('POST', '/api/auth/unlock', { password: 'x' })).status, 401); ok('Entsperren per Passwort (Mitarbeiter) bzw. Code (Partner); ohne Anmeldung unmöglich');
  const cfgAll = (await admin.call('GET', '/api/bootstrap')).config;
  assert.equal(cfgAll['security.lock_timeout_minutes'], 10); assert.equal(cfgAll['ui.theme'], 'anthracite'); ok('Design-/Sperr-Einstellungen sind konfigurierbar (Standard: Anthrazit, 10 Min.)');
  assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.theme': 'ocean', 'ui.radius': 'round', 'ui.dock_size': 60, 'security.lock_timeout_minutes': 5 } })).status, 200);
  assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.theme': 'pink' } })).status, 400);
  await admin.call('PUT', '/api/config', { values: { 'ui.theme': 'anthracite', 'ui.radius': 'normal', 'ui.dock_size': 52, 'security.lock_timeout_minutes': 10 } }); ok('Design-Einstellungen werden validiert');

  // Chat
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send'] });
  r = await admin.call('GET', '/api/chat/channels');
  assert.ok(r.channels.length >= 1); const general = r.channels[0].id; ok('Standardkanal vorhanden, Admin sieht Kanäle');
  const sChatMod = await openSse(mod.cookie, '/api/events');
  await sChatMod.waitFor((e) => e.event === 'hello');
  r = await admin.call('POST', `/api/chat/channels/${general}/messages`, { body: 'Hallo @AZ-221 willkommen' });
  assert.equal(r.status, 201); assert.equal(r.message.sender, 'AZ-220'); assert.equal(r.message.isMine, true); const m1 = r.message.id;
  assert.ok(await sChatMod.waitFor((e) => e.event === 'change' && e.data.topic === 'chat')); ok('Nachricht senden – Absender nur als Personalnummer, live beim anderen Mitglied');
  assert.ok(await sChatMod.waitFor((e) => e.event === 'notification' && /Erwähnung/.test(e.data.title))); ok('Erwähnung @AZ-221 löst eine Benachrichtigung aus');
  r = await mod.call('GET', `/api/chat/channels/${general}/messages`);
  assert.equal(r.messages[0].sender, 'AZ-220'); assert.equal(r.messages[0].isMine, false); assert.equal(JSON.stringify(r).includes('Test Admin') || JSON.stringify(r).includes('"admin"'), false);
  assert.ok(r.channel.unread >= 1); ok('Andere Mitglieder sehen nur die Personalnummer; Ungelesen-Zähler');
  await mod.call('POST', `/api/chat/channels/${general}/read`, {});
  assert.equal((await mod.call('GET', '/api/chat/unread')).unread, 0); ok('Als gelesen markieren setzt den Zähler zurück');
  r = await mod.call('POST', `/api/chat/channels/${general}/messages`, { body: 'Antwort', replyTo: m1 });
  assert.equal(r.message.replyTo.sender, 'AZ-220'); const m2 = r.message.id;
  assert.equal((await mod.call('POST', `/api/chat/channels/${general}/messages`, { body: 'x', replyTo: 999999 })).status, 400); ok('Antworten auf Nachrichten');
  assert.equal((await mod.call('PATCH', `/api/chat/messages/${m1}`, { body: 'gehackt' })).status, 403);
  r = await mod.call('PATCH', `/api/chat/messages/${m2}`, { body: 'Antwort (bearbeitet)' });
  assert.ok(r.message.editedAt); ok('Nur eigene Nachrichten bearbeiten');
  assert.equal((await mod.call('POST', `/api/chat/messages/${m2}/pin`)).status, 403);
  r = await admin.call('POST', `/api/chat/messages/${m2}/pin`); assert.equal(r.message.pinned, true);
  r = await mod.call('GET', `/api/chat/channels/${general}/messages`); assert.equal(r.pinned.length, 1); assert.equal(r.pinned[0].id, m2);
  await admin.call('DELETE', `/api/chat/messages/${m2}/pin`);
  assert.equal((await mod.call('GET', `/api/chat/channels/${general}/messages`)).pinned.length, 0); ok('Anpinnen/Lösen nur mit Recht, Pinnwand pro Kanal');
  assert.equal((await mod.call('DELETE', `/api/chat/messages/${m1}`)).status, 403);
  r = await mod.call('DELETE', `/api/chat/messages/${m2}`); assert.equal(r.status, 200);
  r = await admin.call('GET', `/api/chat/channels/${general}/messages`);
  assert.equal(r.messages.find((m) => m.id === m2).deleted, true); assert.equal(r.messages.find((m) => m.id === m2).body, ''); ok('Löschen: eigene Nachrichten ja, fremde nur mit Moderationsrecht');
  r = await mod.call('POST', `/api/chat/channels/${general}/messages`, { body: 'Moderationstest' });
  assert.equal((await admin.call('DELETE', `/api/chat/messages/${r.message.id}`)).status, 200); ok('Moderator darf fremde Nachrichten löschen');
  const privRole = (await admin.call('POST', '/api/roles', { name: 'Chat-Geheim', permissions: ['chat.view'] })).role.id;
  r = await admin.call('POST', '/api/chat/channels', { name: 'Intern', restricted: true, roleIds: [privRole] }); const priv = r.channel.id;
  assert.equal(r.status, 201);
  assert.equal((await mod.call('GET', '/api/chat/channels')).channels.some((c) => c.id === priv), false);
  assert.equal((await mod.call('GET', `/api/chat/channels/${priv}/messages`)).status, 403);
  assert.equal((await mod.call('POST', `/api/chat/channels/${priv}/messages`, { body: 'hi' })).status, 403); ok('Beschränkte Kanäle sind für andere Rollen unsichtbar und gesperrt');
  assert.equal((await mod.call('POST', '/api/chat/channels', { name: 'Hack' })).status, 403);
  assert.equal((await admin.call('DELETE', `/api/chat/channels/${priv}`)).status, 200); ok('Kanäle verwalten nur mit chat.manage');
  sChatMod.close();


  // ══ Fahrzeuge ══
  const setPerms = (perms) => admin.call('PATCH', `/api/users/${neuer.id}`, { permissions: perms });
  r = await admin.call('POST', '/api/vehicles', { name: 'Mercedes G-Class', plate: 'az 047', vin: 'wdb46312345678901', fuel: 'diesel', fuelLevel: 80, condition: 'ready', color: 'Schwarz', mileage: 12000, seats: 5, locationText: 'Garage Nord', parkingSlot: 'N-14', locX: -100, locY: 200, inspectionDue: '2027-01-31' });
  assert.equal(r.status, 201); assert.equal(r.vehicle.plate, 'AZ 047'); assert.match(r.vehicle.number, /^AZ-V-\d+$/); assert.equal(r.vehicle.fuel.label, 'Diesel'); const veh = r.vehicle.id; ok('Fahrzeug anlegen (Kennzeichen, Fahrgestellnummer, Kraftstoff, Zustand, Standort …)');
  assert.equal((await admin.call('POST', '/api/vehicles', { name: 'Doppelt', plate: 'AZ 047', fuel: 'petrol' })).status, 409);
  assert.equal((await admin.call('POST', '/api/vehicles', { name: 'X1', plate: 'AZ 1', vin: 'WDB46312345678901', fuel: 'petrol' })).status, 409);
  assert.equal((await admin.call('POST', '/api/vehicles', { name: 'Wasserstoff', plate: 'H2 1', fuel: 'wasserstoff' })).status, 400);
  assert.equal((await admin.call('POST', '/api/vehicles', { name: 'Tank', plate: 'T 1', fuel: 'petrol', fuelLevel: 150 })).status, 400);
  assert.equal((await admin.call('POST', '/api/vehicles', { name: 'Zustand', plate: 'Z 1', fuel: 'petrol', condition: 'kaputt' })).status, 400); ok('Eindeutigkeit und Validierung (nur Diesel/Benzin/Strom, gültiger Zustand, Tank 0–100)');
  r = await admin.call('POST', '/api/vehicles', { name: 'Tesla Model S', plate: 'AZ 100', fuel: 'electric', fuelLevel: 55, condition: 'damaged' });
  assert.equal(r.vehicle.fuel.key, 'electric'); const veh2 = r.vehicle.id;
  assert.equal((await mod.call('GET', '/api/vehicles')).status, 403); ok('Ohne Recht kein Zugriff auf Fahrzeuge');
  await setPerms(['vehicles.view']);
  r = await mod.call('GET', '/api/vehicles'); assert.equal(r.status, 200); assert.ok(r.vehicles.length >= 2); assert.equal(r.vehicles[0].location, null);
  assert.equal((await mod.call('POST', '/api/vehicles', { name: 'Nope', plate: 'N 1', fuel: 'petrol' })).status, 403);
  assert.equal((await mod.call('PATCH', `/api/vehicles/${veh}`, { condition: 'broken' })).status, 403);
  assert.equal((await mod.call('DELETE', `/api/vehicles/${veh}`)).status, 403); ok('Nur-Ansehen-Zugriff: lesen ja, anlegen/bearbeiten/löschen nein, Standort verborgen');
  await setPerms(['vehicles.view', 'vehicles.view_location']);
  r = await mod.call('GET', `/api/vehicles/${veh}`); assert.equal(r.vehicle.location.slot, 'N-14'); assert.equal(r.vehicle.location.x, -100); ok('Mit vehicles.view_location ist der Standort sichtbar');
  await setPerms(['vehicles.view', 'vehicles.view_location', 'vehicles.edit']);
  r = await mod.call('PATCH', `/api/vehicles/${veh}`, { condition: 'damaged', locationText: 'Werkstatt Süd', fuelLevel: 40 });
  assert.equal(r.vehicle.condition.key, 'damaged');
  r = await mod.call('GET', `/api/vehicles/${veh}`); assert.ok(r.history.some((h) => /Zustand: Einsatzbereit → Beschädigt/.test(h.text))); assert.ok(r.history.some((h) => h.kind === 'location'));
  assert.equal(JSON.stringify(r.history).includes('"admin"'), false); ok('Bearbeiten mit Änderungsverlauf (Zustand, Standort) – Handelnde nur als Personalnummer');
  assert.equal((await mod.call('PATCH', `/api/vehicles/${veh}`, { assignedUserId: neuer.id })).status, 403); ok('Zuweisen an Mitglieder braucht vehicles.assign');
  r = await admin.call('PATCH', `/api/vehicles/${veh}`, { assignedUserId: neuer.id });
  assert.match(r.vehicle.assignedTo.label, /^AZ-\d+$/); assert.equal((await mod.call('GET', `/api/vehicles/${veh}`)).vehicle.assignedTo.label, 'Du'); ok('Zugewiesene Mitglieder nur als Personalnummer');
  const PNGV = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await mod.call('POST', `/api/vehicles/${veh}/image`, { data: PNGV }); assert.ok(r.vehicle.imageUrl);
  const img = await fetch(`${base}${r.vehicle.imageUrl}`, { headers: { cookie: mod.cookie } }); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}${r.vehicle.imageUrl}`)).status, 401);
  assert.equal((await mod.call('POST', `/api/vehicles/${veh}/image`, { data: Buffer.from('<svg/>').toString('base64') })).status, 400); ok('Fahrzeugbild: nur echte Bilder, nur mit Anmeldung abrufbar');
  r = await mod.call('GET', '/api/vehicles?condition=damaged&fuel=diesel'); assert.ok(r.vehicles.every((v) => v.condition.key === 'damaged' && v.fuel.key === 'diesel')); assert.ok(r.vehicles.length >= 1);
  assert.equal((await mod.call('GET', '/api/vehicles?q=Tesla')).vehicles.length, 1); ok('Filter und Suche');
  await setPerms([]);

  // ══ Karte ══
  assert.equal((await mod.call('GET', '/api/map/config')).status, 403);
  await setPerms(['map.view']);
  r = await mod.call('GET', '/api/map/config'); assert.ok(['{z}', '{x}', '{y}'].every((p) => r.tileUrl.includes(p))); assert.equal(r.canEdit, false); assert.equal(r.calib.scale, 0.6465); ok('Karten-Konfiguration (Kachel-URL, Kalibrierung) abrufbar');
  r = await mod.call('GET', '/api/map/layers'); assert.ok(Array.isArray(r.layers)); ok('Karten-Ebenen für Module (z. B. Lager) abrufbar');
  r = await mod.call('GET', '/api/map/postals'); assert.ok(r.postals.length > 1000 && r.postals[0].length === 3); ok('Postleitzahlen-Daten (über 1000 Einträge)');
  r = await admin.call('POST', '/api/lookups/map.category', { label: 'Farming', color: '#84cc16' }); const mcat = r.entry.id;
  r = await admin.call('POST', '/api/map/points', { name: 'Eisen-Farm', description: '- Nur nachts\n- 2 Fahrzeuge', categoryId: mcat, icon: 'wrench', x: 1200.5, y: -300, visibility: 'all' });
  assert.equal(r.status, 201); const pt = r.point.id;
  assert.equal((await admin.call('POST', '/api/map/points', { name: 'Geheim', x: 10, y: 10, visibility: 'editors' })).status, 201);
  assert.equal((await admin.call('POST', '/api/map/points', { name: 'Kaputt', x: 'abc', y: 1 })).status, 400);
  assert.equal((await admin.call('POST', '/api/map/points', { name: 'Icon', x: 1, y: 1, icon: 'giftige-flasche' })).status, 400); ok('Waypoint setzen (Name, Notizen, Kategorie, Symbol, Koordinaten) mit Validierung');
  r = await mod.call('GET', '/api/map/points'); assert.ok(r.points.some((p) => p.id === pt)); assert.equal(r.points.some((p) => p.name === 'Geheim'), false); assert.equal(r.points[0].canEdit, false); ok('Nur-Ansehen sieht keine „nur Bearbeiter“-Punkte');
  assert.equal((await mod.call('POST', '/api/map/points', { name: 'X', x: 1, y: 1 })).status, 403);
  assert.equal((await mod.call('PATCH', `/api/map/points/${pt}`, { name: 'Y' })).status, 403);
  assert.equal((await mod.call('DELETE', `/api/map/points/${pt}`)).status, 403); ok('Bearbeiten der Karte nur mit map.edit');
  await setPerms(['map.view', 'map.edit']);
  r = await mod.call('PATCH', `/api/map/points/${pt}`, { x: 1300, y: -250, name: 'Eisen-Farm Nord' }); assert.equal(r.point.x, 1300); assert.equal(r.point.name, 'Eisen-Farm Nord');
  assert.equal((await mod.call('GET', '/api/map/points')).points.some((p) => p.name === 'Geheim'), true); ok('Mit map.edit: Waypoints verschieben/umbenennen, „nur Bearbeiter“-Punkte sichtbar');
  r = await mod.call('GET', '/api/map/vehicles'); assert.deepEqual(r.vehicles, []);
  await setPerms(['map.view', 'vehicles.view', 'vehicles.view_location']);
  r = await mod.call('GET', '/api/map/vehicles'); assert.ok(r.vehicles.some((v) => v.id === veh && v.x === -100)); ok('Fahrzeug-Ebene der Karte nur mit Fahrzeug- und Standortrecht');
  assert.equal((await admin.call('DELETE', `/api/map/points/${pt}`)).status, 200);
  assert.equal((await admin.call('DELETE', `/api/vehicles/${veh2}`)).status, 200); ok('Löschen von Waypoints und Fahrzeugen');
  await setPerms([]);


  // ══ Privatnachrichten ══
  r = await admin.call('POST', '/api/roles', { name: 'Chatter', permissions: ['chat.view', 'chat.send'] }); const chatRole = r.role.id;
  const third = new Client();
  await third.call('POST', '/api/auth/register', { displayName: 'Dritter', username: 'privat3', password: 'passwort123' });
  const privat3 = (await admin.call('GET', '/api/users')).users.find((u) => u.username === 'privat3');
  await admin.call('POST', `/api/users/${privat3.id}/status`, { status: 'active', roleIds: [chatRole] });
  await third.call('POST', '/api/auth/login', { username: 'privat3', password: 'passwort123' });
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send'] });
  r = await admin.call('GET', '/api/chat/people'); assert.ok(r.people.length >= 2); assert.ok(r.people.every((p) => /^[A-Z]+-\d+$/.test(p.label)), JSON.stringify(r.people)); assert.equal(JSON.stringify(r).includes('Neuer'), false); ok('Empfängerliste: alle aktiven Mitglieder, nur als Personalnummer');
  const sDmThird = await openSse(third.cookie, '/api/events'); const sDmMod = await openSse(mod.cookie, '/api/events');
  r = await admin.call('POST', '/api/chat/dms', { userId: neuer.id }); assert.equal(r.status, 200); const dm = r.channel.id; assert.equal(r.channel.kind, 'dm'); assert.match(r.channel.name, /^[A-Z]+-\d+$/);
  assert.equal((await admin.call('POST', '/api/chat/dms', { userId: neuer.id })).channel.id, dm);
  assert.equal((await admin.call('POST', '/api/chat/dms', { userId: 1 })).status, 400); ok('Privatchat anlegen (je Paar genau einer, nicht mit sich selbst)');
  r = await admin.call('POST', `/api/chat/channels/${dm}/messages`, { body: 'Hallo privat' }); assert.equal(r.status, 201); const dmMsg = r.message.id;
  assert.ok(await sDmMod.waitFor((e) => e.event === 'change' && e.data.topic === 'chat')); ok('Privatnachricht senden – live beim Empfänger');
  r = await mod.call('GET', '/api/chat/dms'); assert.equal(r.dms.length, 1); assert.equal(r.dms[0].unread, 1); assert.match(r.dms[0].name, /^[A-Z]+-\d+$/);
  assert.equal((await mod.call('GET', '/api/chat/unread')).unread >= 1, true);
  r = await mod.call('GET', '/api/notifications'); assert.ok(r.notifications.some((n) => n.title === 'Neue Privatnachricht')); ok('Empfänger sieht Ungelesen-Zähler und Benachrichtigung');
  r = await mod.call('GET', `/api/chat/channels/${dm}/messages`); assert.equal(r.messages[0].body, 'Hallo privat'); assert.match(r.messages[0].sender, /^[A-Z]+-\d+$/);
  r = await mod.call('POST', `/api/chat/channels/${dm}/messages`, { body: 'Antwort privat', replyTo: dmMsg }); assert.equal(r.status, 201); ok('Antworten im Privatchat (beide Richtungen)');
  assert.equal((await third.call('GET', `/api/chat/channels/${dm}/messages`)).status, 404);
  assert.equal((await third.call('POST', `/api/chat/channels/${dm}/messages`, { body: 'mitlesen' })).status, 404);
  assert.equal((await third.call('GET', '/api/chat/dms')).dms.length, 0);
  assert.equal((await admin.call('GET', '/api/chat/channels')).channels.every((c) => c.kind !== 'dm'), true);
  await sleep(150); assert.equal(sDmThird.events.some((e) => e.event === 'change' && e.data.topic === 'chat' && e.data.entityId === String(dm)), false); ok('Dritte können Privatchats weder lesen noch schreiben noch live mitbekommen');
  assert.equal((await admin.call('PATCH', `/api/chat/channels/${dm}`, { name: 'x' })).status, 404); sDmThird.close(); sDmMod.close(); ok('Privatchats sind keine Kanäle (nicht verwaltbar)');

  // ══ Lager ══
  assert.equal((await mod.call('GET', '/api/warehouses')).status, 403);
  r = await admin.call('POST', '/api/lookups/warehouse.type', { label: 'Depot', color: '#f59e0b' }); const whType = r.entry.id;
  r = await admin.call('POST', '/api/warehouse/items', { name: 'Eisenerz', unit: 'kg', space: 2, minPrice: 100, maxPrice: 200, targetStock: 1000 });
  assert.equal(r.status, 201); const ore = r.item.id; assert.equal(r.item.suggestedPrice, 200); // leeres Lager ⇒ Höchstpreis
  assert.equal((await admin.call('POST', '/api/warehouse/items', { name: 'Kaputt', minPrice: 300, maxPrice: 100 })).status, 400);
  assert.equal((await admin.call('POST', '/api/warehouse/items', { name: 'Halb', minPrice: 300 })).status, 400); ok('Items mit Preisspanne (Min/Max) – ungültige Spannen werden abgelehnt');
  r = await admin.call('POST', '/api/warehouses', { name: 'Hafen-Lager', typeId: whType, postal: '7085', capacity: 5000, sizeInfo: '120 m²', accessInfo: 'Tor-Code 1234', locationText: 'Hafen Süd', restricted: false });
  assert.equal(r.status, 201); assert.match(r.warehouse.number, /^[A-Z]+-L-\d+$/); const wh = r.warehouse.id; assert.ok(r.warehouse.location.resolved); ok('Lager anlegen (Postleitzahl wird in Koordinaten aufgelöst, Nummer AZ-L-…)');
  assert.equal((await admin.call('POST', '/api/warehouses', { name: 'Falsch', postal: '99999999' })).status, 400);
  assert.equal((await admin.call('POST', '/api/warehouses', { name: 'Koordinaten', locX: 100, locY: -200 })).status, 201);
  assert.equal((await admin.call('POST', '/api/warehouses', { name: 'Hafen-Lager' })).status, 409); ok('Validierung: unbekannte Postleitzahl, doppelter Name, Koordinaten');
  r = await admin.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'in', quantity: 600, note: 'Erstbestand' }); assert.equal(r.quantity, 600); assert.equal(r.used, 1200);
  assert.equal((await admin.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'out', quantity: 9999 })).status, 409);
  assert.equal((await admin.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'in', quantity: 2000 })).status, 409); ok('Einlagern/Auslagern mit Kapazitäts- und Bestandsprüfung');
  r = await admin.call('POST', '/api/warehouses', { name: 'Zweitlager', capacity: 1000 }); const wh2 = r.warehouse.id;
  assert.equal((await admin.call('POST', `/api/warehouses/${wh}/transfer`, { toId: wh2, itemId: ore, quantity: 100 })).status, 200);
  r = await admin.call('GET', `/api/warehouses/${wh2}`); assert.equal(r.stock[0].quantity, 100); assert.ok(r.events.length >= 1); ok('Umlagern zwischen Lagern mit Verlauf');
  r = await admin.call('GET', `/api/warehouses/${wh}`); assert.equal(r.stock[0].quantity, 500);
  // Zugriffe
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send', 'warehouse.view'] });
  r = await mod.call('GET', '/api/warehouses'); assert.ok(r.warehouses.length >= 2); assert.equal(r.warehouses.find((w) => w.id === wh).accessInfo, null); assert.equal(r.warehouses.find((w) => w.id === wh).canBook, false);
  assert.equal((await mod.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'in', quantity: 1 })).status, 403);
  assert.equal((await mod.call('POST', '/api/warehouses', { name: 'Nope' })).status, 403);
  r = await mod.call('GET', '/api/warehouse/items'); assert.equal(r.items.find((i) => i.id === ore).minPrice, undefined); ok('Nur-Ansehen: kein Zugangs-Code, keine Preisspannen, keine Buchungen');
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send', 'warehouse.view', 'warehouse.view_access', 'warehouse.stock', 'warehouse.prices'] });
  r = await mod.call('GET', `/api/warehouses/${wh}`); assert.equal(r.warehouse.accessInfo, 'Tor-Code 1234');
  assert.equal((await mod.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'in', quantity: 1 })).status, 403); // nur view-Stufe im Lager? nein: offenes Lager = view
  r = await admin.call('PATCH', `/api/warehouses/${wh}`, { restricted: true, access: [{ roleId: modRole, level: 'manage' }] }); assert.equal(r.warehouse.access.length, 1);
  assert.equal((await mod.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'in', quantity: 1 })).status, 200);
  assert.equal((await mod.call('GET', '/api/warehouse/items')).items.find((i) => i.id === ore).minPrice, 100); ok('Rollenbasierte Zugriffe pro Lager (ansehen/verwalten) + Rechte für Zugang und Preise');
  r = await admin.call('PATCH', `/api/warehouses/${wh2}`, { restricted: true, access: [] });
  assert.equal((await mod.call('GET', `/api/warehouses/${wh2}`)).status, 404); assert.equal((await mod.call('GET', '/api/warehouses')).warehouses.some((w) => w.id === wh2), false); ok('Beschränkte Lager sind für andere unsichtbar');
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send'] });
  assert.equal((await mod.call('GET', '/api/map/layers')).status, 403);
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send', 'map.view', 'warehouse.view'] });
  r = await mod.call('GET', '/api/map/layers'); const lay = r.layers.find((l) => l.key === 'warehouses'); assert.ok(lay); assert.ok(lay.items.some((i) => i.name === 'Hafen-Lager')); assert.ok(lay.items.every((i) => i.name !== 'Zweitlager'));
  r = await admin.call('GET', '/api/map/layers'); const lay2 = r.layers.find((l) => l.key === 'warehouses'); assert.ok(lay2.items.some((i) => i.name === 'Hafen-Lager' && Number.isFinite(i.x))); ok('Lager erscheinen als Kartenebene (per Postleitzahl/Koordinaten, nur wenn sichtbar)');
  assert.equal((await admin.call('DELETE', `/api/warehouses/${wh}`)).status, 409); ok('Nicht leeres Lager kann nicht gelöscht werden');

  // ══ Börse: automatischer Preisvorschlag aus der Preisspanne ══
  const pcli = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Händler Zwei', apps: ['market'] }); const ptok = r.partner.linkPath.split('/').pop(); assert.equal((await pcli.call('POST', `/api/p/${ptok}/login`, { code: r.code })).status, 200);
  r = await admin.call('GET', `/api/warehouse/items`); const oreNow = r.items.find((i) => i.id === ore);
  r = await pcli.call('GET', '/api/p/market/catalog'); const pItem = r.items.find((i) => i.id === ore); assert.ok(pItem); assert.equal(typeof pItem.suggestedPrice, 'number'); assert.equal(JSON.stringify(r).includes('minPrice'), false); assert.equal(JSON.stringify(r).includes('maxPrice'), false);
  r = await pcli.call('GET', `/api/p/market/quote?itemId=${ore}&quantity=100`); assert.equal(r.status, 200); assert.ok(r.quote.unitPrice >= 100 && r.quote.unitPrice <= 200); assert.equal(r.quote.total, r.quote.unitPrice * 100); const qPrice = r.quote.unitPrice;
  const bigger = (await pcli.call('GET', `/api/p/market/quote?itemId=${ore}&quantity=800`)).quote.unitPrice; assert.ok(bigger <= qPrice); ok('Partner sieht automatischen Preisvorschlag (fällt bei Menge/Bestand), aber nie die Spanne');
  r = await pcli.call('POST', '/api/p/market/offers', { itemId: ore, quantity: 100 }); assert.equal(r.status, 201); assert.equal(r.deal.unitPrice, qPrice); assert.equal(r.deal.suggestedPrice, qPrice); const deal1 = r.deal.id; ok('Angebot ohne Preis → Vorschlagspreis wird automatisch übernommen (Genehmigung durch das Team)');
  r = await pcli.call('POST', '/api/p/market/offers', { itemId: ore, quantity: 100, unitPrice: qPrice + 40 }); assert.equal(r.deal.unitPrice, qPrice + 40); assert.equal(r.deal.suggestedPrice, qPrice); ok('Eigener Preis → Gegenangebot, Vorschlag bleibt zum Vergleich gespeichert');
  r = await admin.call('POST', '/api/market/items', { name: 'Ohne Spanne', unit: 'Stück' }); const plain = r.item.id;
  assert.equal((await pcli.call('POST', '/api/p/market/offers', { itemId: plain, quantity: 5 })).status, 400); assert.equal((await pcli.call('POST', '/api/p/market/offers', { itemId: plain, quantity: 5, unitPrice: 10 })).status, 201); ok('Ohne Spanne muss der Partner selbst einen Preis nennen');
  assert.equal((await admin.call('POST', `/api/market/deals/${deal1}/accept`, {})).status, 200);
  assert.equal((await admin.call('POST', `/api/market/deals/${deal1}/handover`, { info: 'Hafen' })).status, 200);
  const stockBefore = (await admin.call('GET', `/api/warehouses/${wh}`)).stock.find((s) => s.itemId === ore).quantity;
  assert.equal((await admin.call('POST', `/api/market/deals/${deal1}/advance`, { warehouseId: wh })).status, 200);
  assert.equal((await admin.call('GET', `/api/warehouses/${wh}`)).stock.find((s) => s.itemId === ore).quantity, stockBefore + 100); ok('Ware eingegangen → wird direkt ins gewählte Lager eingebucht');


  // ══ Chat für externe Partner ══
  const nochat = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Ohne Chat', apps: ['market'] });
  await nochat.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code });
  assert.equal((await nochat.call('GET', '/api/p/chat/channels')).status, 403); ok('Partner ohne Chat-App: kein Zugriff auf den Chat');
  const cp = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Händler Chat', apps: ['market', 'chat'] }); const chatPartnerId = r.partner.id; const chatPartnerNo = r.partner.number;
  assert.equal((await cp.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code })).status, 200);
  r = await cp.call('GET', '/api/p/chat/people'); assert.ok(r.people.length >= 1); assert.ok(r.people.every((p) => /^[A-Z]+-\d+$/.test(p.label))); assert.equal(JSON.stringify(r).toLowerCase().includes('"admin"'), false); ok('Partner sieht als Ansprechpartner nur Mitglieder mit chat.partners – als Personalnummer');
  assert.equal((await cp.call('GET', '/api/p/chat/dms')).dms.length, 0);
  const sP = await openSse(cp.cookie, '/api/p/events');
  r = await cp.call('POST', '/api/p/chat/dms', { userId: 1 }); assert.equal(r.status, 200); const pdm = r.channel.id; assert.match(r.channel.name, /^[A-Z]+-\d+$/);
  assert.equal((await cp.call('POST', '/api/p/chat/dms', { userId: neuer.id })).status, 400); ok('Partner kann nur Ansprechpartner anschreiben, nicht beliebige Mitglieder');
  r = await cp.call('POST', `/api/p/chat/channels/${pdm}/messages`, { body: 'Hallo Team, hier der Partner' }); assert.equal(r.status, 201); assert.equal(r.message.sender, chatPartnerNo); assert.equal(r.message.isMine, true);
  r = await admin.call('GET', '/api/chat/dms'); const adm = r.dms.find((d) => d.id === pdm); assert.ok(adm); assert.equal(adm.name, chatPartnerNo); assert.equal(adm.description, 'Händler Chat'); assert.equal(adm.unread, 1);
  r = await admin.call('GET', '/api/notifications'); assert.ok(r.notifications.some((n) => n.title === 'Neue Privatnachricht' && n.body.startsWith(chatPartnerNo))); ok('Partner → Mitarbeiter: Privatnachricht samt Benachrichtigung (Partner nur als Partnernummer)');
  r = await admin.call('GET', `/api/chat/channels/${pdm}/messages`); assert.equal(r.messages[0].sender, chatPartnerNo); assert.equal(r.messages[0].body, 'Hallo Team, hier der Partner');
  r = await admin.call('POST', `/api/chat/channels/${pdm}/messages`, { body: 'Hallo Partner, wir melden uns' }); assert.equal(r.status, 201);
  assert.ok(await sP.waitFor((e) => e.event === 'change' && e.data.topic === 'chat')); ok('Mitarbeiter → Partner: Antwort kommt live an');
  r = await cp.call('GET', '/api/p/chat/dms'); assert.equal(r.dms.length, 1); assert.equal(r.dms[0].unread, 1);
  r = await cp.call('GET', `/api/p/chat/channels/${pdm}/messages`); assert.equal(r.messages.length, 2); assert.match(r.messages[1].sender, /^[A-Z]+-\d+$/); assert.equal(r.messages[1].isMine, false);
  assert.equal(JSON.stringify(r).includes('Admin'), false); assert.equal(JSON.stringify(r).includes('"username"'), false); ok('Partner sieht Mitarbeiter nur als Personalnummer – nie Namen');
  const pm = (await cp.call('POST', `/api/p/chat/channels/${pdm}/messages`, { body: 'Tippfehler' })).message.id;
  assert.equal((await cp.call('PATCH', `/api/p/chat/messages/${pm}`, { body: 'Korrigiert' })).message.body, 'Korrigiert');
  assert.equal((await cp.call('DELETE', `/api/p/chat/messages/${pm}`)).status, 200);
  const adminMsg = (await admin.call('GET', `/api/chat/channels/${pdm}/messages`)).messages.find((x) => !x.isMine && !x.deleted).id;
  assert.equal((await cp.call('PATCH', `/api/p/chat/messages/${(await admin.call('GET', `/api/chat/channels/${pdm}/messages`)).messages.find((x) => x.isMine).id}`, { body: 'fremd' })).status, 403); void adminMsg; ok('Partner kann eigene Nachrichten bearbeiten/löschen, fremde nicht');
  assert.equal((await mod.call('GET', `/api/chat/channels/${pdm}/messages`)).status, 404); assert.equal((await mod.call('POST', '/api/chat/dms', { partnerId: chatPartnerId })).status, 403); ok('Andere Mitarbeiter können Partner-Privatchats weder lesen noch ohne chat.partners starten');
  r = await admin.call('GET', '/api/chat/people'); assert.ok(r.partners.some((p) => p.label === chatPartnerNo)); assert.equal((await mod.call('GET', '/api/chat/people')).partners.length, 0);
  r = await admin.call('POST', '/api/chat/dms', { partnerId: chatPartnerId }); assert.equal(r.channel.id, pdm); ok('Mitarbeiter mit chat.partners findet Partner in der Empfängerliste (Partnernummer)');
  assert.equal((await cp.call('GET', `/api/p/chat/channels/${general}/messages`)).status, 404); assert.equal((await cp.call('GET', '/api/p/chat/channels')).channels.length, 0);
  r = await admin.call('PATCH', `/api/chat/channels/${general}`, { partnerIds: [chatPartnerId] }); assert.deepEqual(r.channel.partnerIds, [chatPartnerId]);
  r = await cp.call('GET', '/api/p/chat/channels'); assert.equal(r.channels.length, 1); assert.equal(r.channels[0].id, general);
  r = await cp.call('POST', `/api/p/chat/channels/${general}/messages`, { body: 'Hallo im Kanal' }); assert.equal(r.status, 201);
  r = await admin.call('GET', `/api/chat/channels/${general}/messages`); assert.ok(r.messages.some((x) => x.sender === chatPartnerNo && x.body === 'Hallo im Kanal')); ok('Kanäle lassen sich gezielt für Partner freigeben; Nachrichten erscheinen mit Partnernummer');
  r = await cp.call('GET', `/api/p/chat/channels/${general}/messages`); assert.equal((await cp.call('POST', `/api/p/chat/messages/${r.messages.find((x) => !x.isMine).id}/pin`)).status, 404); assert.equal((await cp.call('GET', '/api/chat/channels')).status, 401); ok('Partner können nicht pinnen und nicht auf die Mitarbeiter-API zugreifen');
  await admin.call('PATCH', `/api/partners/${chatPartnerId}`, { apps: ['market'] });
  assert.equal((await cp.call('GET', '/api/p/chat/channels')).status, 403); sP.close(); ok('Chat-App für Partner jederzeit entziehbar');


  // ══ Börse: Angebote an Partner (Verkauf aus dem Lager) + Finanz-Journal ══
  const buyer = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Käufer GmbH', apps: ['market'] }); const buyerId = r.partner.id;
  assert.equal((await buyer.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code })).status, 200);
  const stockOf = async () => (await admin.call('GET', `/api/warehouses/${wh}`)).stock.find((s) => s.itemId === ore)?.quantity ?? 0;
  const s0 = await stockOf();
  assert.equal((await mod.call('POST', '/api/market/offers', { partnerId: buyerId, warehouseId: wh, itemId: ore, quantity: 5, unitPrice: 90 })).status, 403);
  assert.equal((await admin.call('POST', '/api/market/offers', { partnerId: buyerId, warehouseId: wh, itemId: ore, quantity: s0 + 1, unitPrice: 90 })).status, 409);
  const onlyChat = (await admin.call('POST', '/api/partners', { name: 'Nur Chat', apps: ['chat'] })).partner.id;
  assert.equal((await admin.call('POST', '/api/market/offers', { partnerId: onlyChat, warehouseId: wh, itemId: ore, quantity: 5, unitPrice: 90 })).status, 400); ok('Angebot an Partner: Rechte, Bestandsprüfung und Börsen-Zugang des Partners werden geprüft');
  r = await admin.call('POST', '/api/market/offers', { partnerId: buyerId, warehouseId: wh, itemId: ore, quantity: 50, unitPrice: 90, note: 'Frisch eingetroffen' });
  assert.equal(r.status, 201); assert.equal(r.deal.direction, 'sell'); assert.equal(r.deal.status, 'submitted'); assert.equal(r.deal.turn, 'partner'); const sell1 = r.deal.id;
  assert.equal(await stockOf(), s0); ok('Angebot an einen Partner senden – Bestand bleibt bis zur Annahme unverändert');
  r = await buyer.call('GET', `/api/p/market/deals/${sell1}`); assert.equal(r.deal.direction, 'sell'); assert.equal(r.deal.warehouse, undefined); assert.equal(JSON.stringify(r).includes('Hafen-Lager'), false);
  r = await buyer.call('GET', '/api/notifications'); void r;
  assert.equal((await buyer.call('POST', `/api/p/market/deals/${sell1}/accept`)).status, 200); ok('Partner nimmt das Angebot an (ohne das Lager zu sehen)');
  assert.equal(await stockOf(), s0 - 50);
  r = await admin.call('GET', `/api/warehouses/${wh}`); const ev1 = r.events.find((e) => e.kind === 'deal_out'); assert.ok(ev1); assert.equal(ev1.delta, -50); assert.equal(ev1.dealId, sell1);
  r = await admin.call('GET', `/api/market/deals/${sell1}`); assert.equal(r.deal.stockBooked, true); assert.ok(r.events.some((e) => e.kind === 'stock' && e.internal && /Ausgebucht: 50/.test(e.text)));
  r = await buyer.call('GET', `/api/p/market/deals/${sell1}`); assert.equal(r.events.some((e) => e.kind === 'stock'), false); ok('Annahme bucht die Ware automatisch aus dem Lager ab – nachvollziehbar im Lager-Verlauf und im Geschäft (intern)');
  r = await admin.call('GET', '/api/finance/ledger'); const le = r.entries.find((e) => e.dealId === sell1); assert.ok(le); assert.equal(le.direction, 'in'); assert.equal(le.amount, 50 * 90); assert.equal(le.status, 'expected');
  assert.equal((await mod.call('GET', '/api/finance/ledger')).status, 403);
  r = await admin.call('GET', '/api/finance/summary'); assert.ok(r.summary.expectedIn >= 4500); ok('Geldbewegung wird für das Finanzsystem vorgemerkt (erwartet, Eingang) – nur mit finance.view sichtbar');
  assert.equal((await admin.call('POST', `/api/market/deals/${sell1}/handover`, { info: 'Übergabe am Hafen' })).status, 200);
  assert.equal((await admin.call('POST', `/api/market/deals/${sell1}/advance`, {})).status, 200); assert.equal((await admin.call('POST', `/api/market/deals/${sell1}/advance`, {})).deal.statusLabel, 'Zahlung ausstehend');
  assert.equal(await stockOf(), s0 - 50); assert.equal((await admin.call('POST', `/api/market/deals/${sell1}/advance`, {})).deal.status, 'completed');
  assert.equal((await admin.call('GET', '/api/finance/ledger')).entries.find((e) => e.dealId === sell1).status, 'settled'); assert.ok((await admin.call('GET', '/api/finance/summary')).summary.settledIn >= 4500); ok('Abschluss verbucht die Zahlung im Journal (bezahlt)');
  // Verhandlung: Partner macht Gegenangebot, Team nimmt an
  r = await admin.call('POST', '/api/market/offers', { partnerId: buyerId, warehouseId: wh, itemId: ore, quantity: 20, unitPrice: 100 }); const sell2 = r.deal.id;
  assert.equal((await admin.call('POST', `/api/market/deals/${sell2}/accept`)).status, 409);
  assert.equal((await buyer.call('POST', `/api/p/market/deals/${sell2}/counter`, { unitPrice: 85 })).deal.turn, 'staff');
  assert.equal((await admin.call('POST', `/api/market/deals/${sell2}/accept`)).status, 200); assert.equal(await stockOf(), s0 - 70);
  assert.equal((await admin.call('GET', '/api/finance/ledger')).entries.find((e) => e.dealId === sell2).amount, 20 * 85); ok('Gegenangebot des Partners → Team nimmt an → Abbuchung zum verhandelten Preis');
  // Storno gibt die Ware zurück
  assert.equal((await admin.call('POST', `/api/market/deals/${sell2}/cancel`, { text: 'Doch nicht' })).status, 200); assert.equal(await stockOf(), s0 - 50);
  assert.equal((await admin.call('GET', '/api/finance/ledger')).entries.find((e) => e.dealId === sell2).status, 'cancelled');
  assert.ok((await admin.call('GET', `/api/warehouses/${wh}`)).events.some((e) => e.kind === 'deal_return' && e.dealId === sell2)); ok('Storno vor der Übergabe bucht die Ware zurück ins Lager und storniert die Geldbewegung');
  // Ware zwischenzeitlich weg → Annahme scheitert, ohne Bestandszahlen zu verraten
  const left = await stockOf(); r = await admin.call('POST', '/api/market/offers', { partnerId: buyerId, warehouseId: wh, itemId: ore, quantity: left, unitPrice: 70 }); const sell3 = r.deal.id;
  await admin.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'out', quantity: 10 });
  r = await buyer.call('POST', `/api/p/market/deals/${sell3}/accept`); assert.equal(r.status, 409); assert.equal(/\d{2,}/.test(r.error ?? r.message ?? ''), false);
  assert.equal((await admin.call('GET', `/api/market/deals/${sell3}`)).deal.status, 'submitted'); assert.equal(await stockOf(), left - 10); ok('Reicht der Bestand bei Annahme nicht mehr, bleibt alles unverändert (Partner erfährt keine Bestandszahlen)');
  // Ankauf (Partner verkauft an uns): Annahme bucht Geld „Ausgang“ vor
  r = await admin.call('GET', '/api/finance/ledger?direction=out'); const outBefore = r.entries.length;
  r = await buyer.call('POST', '/api/p/market/offers', { itemId: ore, quantity: 10, unitPrice: 120 }); const buy1 = r.deal.id;
  assert.equal((await admin.call('POST', `/api/market/deals/${buy1}/accept`)).status, 200);
  r = await admin.call('GET', '/api/finance/ledger?direction=out'); assert.equal(r.entries.length, outBefore + 1); assert.equal(r.entries[0].amount, 1200); assert.equal(r.entries[0].status, 'expected'); ok('Ankäufe werden als erwartete Ausgabe vorgemerkt');


  // ══ Dashboard-Widgets ══
  const lay0 = (await admin.call('GET', '/api/dashboard/layout')).widgets; await admin.call('PUT', '/api/dashboard/layout', { widgets: lay0.map((w) => ({ id: w.id, enabled: true })) });
  r = await admin.call('GET', '/api/dashboard'); const wids = r.widgets.map((w) => w.id);
  for (const id of ['welcome', 'quick-links', 'vehicles-overview', 'warehouse-overview', 'finance-flow']) assert.ok(wids.includes(id), `Widget fehlt: ${id}`);
  const whWidget = r.widgets.find((w) => w.id === 'warehouse-overview').data; assert.ok(whWidget.count >= 1 && Array.isArray(whWidget.warehouses));
  assert.ok(Array.isArray(r.widgets.find((w) => w.id === 'vehicles-overview').data.conditions)); assert.equal(typeof r.widgets.find((w) => w.id === 'finance-flow').data.balanceExpected, 'number');
  r = await third.call('GET', '/api/dashboard'); assert.equal(r.widgets.some((w) => ['finance-flow', 'warehouse-overview', 'vehicles-overview'].includes(w.id)), false); ok('Neue Dashboard-Widgets (Lager, Fuhrpark, Geldfluss, Schnellzugriff) – nur mit passendem Recht sichtbar');
  const layoutBefore = (await admin.call('GET', '/api/dashboard/layout')).widgets;
  r = await admin.call('PUT', '/api/dashboard/layout', { widgets: layoutBefore.map((w) => ({ id: w.id, enabled: false })) }); assert.equal(r.status, 200);
  r = await admin.call('GET', '/api/dashboard'); assert.deepEqual(r.widgets, []);
  r = await admin.call('PUT', '/api/dashboard/layout', { widgets: layoutBefore.map((w) => ({ id: w.id, enabled: true })) }); assert.equal((await admin.call('GET', '/api/dashboard')).widgets.length > 3, true); ok('Alle Widgets aus-/einschalten funktioniert (leeres Dashboard ist gültig)');


  // ══ Deckel-System (Firmenabrechnung) ══
  await admin.call('PUT', '/api/config', { values: { 'tab.allow_current_period': true } });
  assert.equal(tabPeriodKey(new Date(2026, 9, 7), 'weekly'), '2026-W41'); assert.equal(tabPeriodInfo('2026-W41').label, 'KW 41 / 2026'); assert.equal(tabPeriodInfo('2026-10').label, 'Oktober 2026'); ok('Zeiträume: 07.10.2026 → KW 41 / 2026 bzw. Oktober 2026');
  assert.equal((await mod.call('POST', '/api/tab/companies', { name: 'X', interval: 'weekly' })).status, 403);
  r = await admin.call('POST', '/api/tab/companies', { name: 'Muster GmbH', contactName: 'Frau Muster', contactInfo: 'muster@example.org', interval: 'weekly' });
  assert.equal(r.status, 201); assert.match(r.company.number, /^[A-Z]+-F-\d+$/); assert.match(r.company.linkPath, /^\/deckel\/firma\/[A-Za-z0-9_-]{30,}$/); const coA = r.company.id; let tokA = r.company.linkPath.split('/').pop();
  r = await admin.call('POST', '/api/tab/companies', { name: 'Beispiel AG', interval: 'monthly', scope: 'selected', memberIds: [1] }); const coB = r.company.id; const tokB = r.company.linkPath.split('/').pop();
  r = await admin.call('POST', '/api/tab/companies', { name: 'Limit KG', interval: 'monthly', creditLimitCents: 10000 }); assert.equal(r.status, 201, JSON.stringify(r)); const coL = r.company.id;
  assert.equal((await admin.call('POST', '/api/tab/companies', { name: 'muster gmbh', interval: 'weekly' })).status, 409);
  assert.equal((await admin.call('POST', '/api/tab/companies', { name: 'Falsch', interval: 'täglich' })).status, 400);
  assert.equal((await admin.call('POST', '/api/tab/companies', { name: 'Perm Co', interval: 'weekly', scope: 'perm', scopePerm: 'gibt.es.nicht' })).status, 400); ok('Firmen anlegen: individueller Portal-Link, Intervall, Geltungsbereich, Validierung');
  // Buchungen
  await setPerms(['tab.book']);
  const tabCurWeek = tabPeriodKey(new Date(), 'weekly');
  assert.equal((await mod.call('POST', '/api/tab/entries', { companyId: coA, amountCents: 2550, description: 'Mittagessen' })).status, 400); // ohne Personalnummer
  assert.equal((await mod.call('POST', '/api/tab/entries', { companyId: coA, memberNumber: 'ZZ-99999', amountCents: 2550, description: 'Mittagessen' })).status, 400);
  assert.equal((await mod.call('POST', '/api/tab/entries', { companyId: coA, memberNumber: 'AZ-220', amountCents: 2550, description: 'Mittagessen' })).status, 403); // fremde Nummer ohne Recht
  assert.equal((await mod.call('POST', '/api/tab/entries', { companyId: coA, memberNumber: 'AZ-221', amountCents: 0, description: 'Mittagessen' })).status, 400); ok('Ohne gültige Personalnummer keine Deckelbuchung; fremde Nummer nur mit Sonderrecht');
  r = await mod.call('POST', '/api/tab/entries', { companyId: coA, memberNumber: 'AZ-221', amountCents: 2550, description: 'Mittagessen' });
  assert.equal(r.status, 201); assert.equal(r.entry.memberNumber, 'AZ-221'); assert.equal(r.entry.period.key, tabCurWeek); assert.equal(r.entry.amountCents, 2550); assert.match(r.entry.number, /^[A-Z]+-D-\d+$/); const e1 = r.entry.id;
  r = await mod.call('GET', '/api/tab/member?number=az-221&companyId=' + coA); assert.equal(r.found, true); assert.equal(r.number, 'AZ-221'); assert.equal(JSON.stringify(r).includes('Neuer'), false); ok('Buchung erfasst, automatisch dem Zeitraum (Woche) zugeordnet; Personalnummer wird erkannt – ohne Namen');
  assert.equal((await mod.call('POST', '/api/tab/entries', { companyId: coB, memberNumber: 'AZ-221', amountCents: 1000, description: 'Kaffee' })).status, 403); ok('Gültigkeit „bestimmte Mitarbeiter“ wird durchgesetzt');
  assert.equal((await admin.call('POST', '/api/tab/entries', { companyId: coB, memberNumber: 'AZ-220', amountCents: 1000, description: 'Kaffee' })).status, 201);
  r = await admin.call('POST', '/api/tab/entries', { companyId: coA, memberNumber: 'AZ-221', amountCents: 8490, description: 'Abendessen (Kasse)' }); assert.equal(r.status, 201); const e2 = r.entry.id; ok('Mit tab.book_others darf eine Kasse für andere Mitglieder buchen');
  // Limit
  const limE = await admin.call('POST', '/api/tab/entries', { companyId: coL, memberNumber: 'AZ-220', amountCents: 6000, description: 'Posten A' }); assert.equal(limE.status, 201, JSON.stringify(limE));
  assert.equal((await admin.call('POST', '/api/tab/entries', { companyId: coL, memberNumber: 'AZ-220', amountCents: 6000, description: 'Posten B' })).status, 409); assert.equal((await admin.call('POST', `/api/tab/entries/${limE.entry.id}/cancel`, { reason: 'Falsch gebucht' })).entry.status, 'cancelled'); assert.equal((await admin.call('POST', '/api/tab/entries', { companyId: coL, memberNumber: 'AZ-220', amountCents: 6000, description: 'Posten C' })).status, 201); ok('Firmenlimit verhindert Überschreitung (nach Storno wieder frei)');
  // Sichtbarkeit / Storno / Korrektur
  r = await mod.call('GET', '/api/tab/entries'); assert.ok(r.entries.every((e) => e.mine)); assert.equal(r.entries.length, 2);
  assert.equal((await mod.call('POST', `/api/tab/entries/${e1}/cancel`, { reason: 'Test' })).status, 403);
  assert.equal((await admin.call('POST', `/api/tab/entries/${e1}/cancel`, { reason: '' })).status, 400);
  r = await admin.call('POST', `/api/tab/entries/${e2}/correct`, { amountCents: 8590, reason: 'Tippfehler' }); assert.equal(r.status, 201); assert.equal(r.entry.correctsId, e2); const e2b = r.entry.id;
  r = await admin.call('GET', '/api/tab/entries?company=' + coA); assert.equal(r.entries.find((e) => e.id === e2).status, 'cancelled'); assert.equal(r.totalCents, 2550 + 8590);
  assert.equal((await admin.call('POST', `/api/tab/entries/${e2}/cancel`, { reason: 'nochmal' })).status, 409); ok('Nichts wird gelöscht: Storno und Korrektur (neue verknüpfte Buchung), nur mit tab.cancel');
  r = await admin.call('GET', '/api/finance/ledger?q=Muster'); const tabLe = r.entries.filter((e) => e.entryType === 'tab'); assert.equal(tabLe.length, 3); assert.equal(tabLe.filter((e) => e.status === 'cancelled').length, 1); assert.equal(tabLe.find((e) => e.status === 'expected').company.name, 'Muster GmbH'); ok('Jede Buchung ist eindeutig einem Finanzvorgang zugeordnet (Storno schlägt durch)');
  // Portal
  assert.equal((await new Client().call('GET', '/api/c/gibtsnicht-gibtsnicht-gibtsnicht')).status, 404);
  const portal = new Client();
  r = await portal.call('GET', `/api/c/${tokA}`); assert.equal(r.company.name, 'Muster GmbH'); assert.ok(r.periods.some((p) => p.key === tabCurWeek)); assert.equal(JSON.stringify(r).includes('Beispiel'), false); assert.deepEqual(r.statements, []);
  assert.equal(JSON.stringify(r).includes('2550'), false); ok('Firmenportal: nur der eigene Link funktioniert; die Firma sieht weder fremde Daten noch unsere Buchungssummen');
  assert.equal((await portal.call('POST', `/api/c/${tokA}/statements`, { periodKey: '1999-W01', amountCents: 100 })).status, 400);
  assert.equal((await portal.call('POST', `/api/c/${tokA}/statements`, { periodKey: tabCurWeek, amountCents: -5 })).status, 400);
  const ourTotal = 2550 + 8590;
  r = await portal.call('POST', `/api/c/${tokA}/statements`, { periodKey: tabCurWeek, amountCents: ourTotal, comment: 'Wie besprochen' }); assert.equal(r.status, 201); assert.match(r.message, /erfolgreich übermittelt/); assert.ok(!r.periods.some((p) => p.key === tabCurWeek));
  assert.equal((await portal.call('POST', `/api/c/${tokA}/statements`, { periodKey: tabCurWeek, amountCents: ourTotal })).status, 400); ok('Abrechnung einreichen: Bestätigung, Zeitraum danach nicht mehr wählbar, keine Doppeleinreichung');
  r = await admin.call('GET', '/api/notifications'); const tabNn = r.notifications.find((n) => n.title === 'Neue Deckel-Abrechnung'); assert.ok(tabNn); assert.match(tabNn.body, /Muster GmbH/); assert.equal(tabNn.target.app, 'tab'); ok('Neue Abrechnung löst eine Benachrichtigung aus (Firma, Zeitraum, Betrag)');
  r = await admin.call('GET', '/api/tab/statements'); const tabSt1 = r.statements.find((s) => s.company.id === coA); assert.equal(tabSt1.status, 'submitted'); assert.equal(tabSt1.matches, true); assert.equal(tabSt1.diffCents, 0); assert.equal(tabSt1.ourCents, ourTotal);
  r = await admin.call('GET', `/api/tab/statements/${tabSt1.id}`); assert.equal(r.entries.length, 3); assert.deepEqual(r.byMember.map((m) => [m.memberNumber, m.totalCents]), [['AZ-221', ourTotal]]); assert.ok(r.log.length >= 1); ok('Abgleich: unsere Summe = eingereicht, Differenz 0; Einzelbuchungen und Summen je Personalnummer');
  assert.equal((await mod.call('POST', `/api/tab/statements/${tabSt1.id}/review`)).status, 403);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt1.id}/pay`)).status, 409);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt1.id}/review`)).statement.status, 'review');
  r = await admin.call('POST', `/api/tab/statements/${tabSt1.id}/confirm`, {}); assert.equal(r.statement.status, 'confirmed'); assert.equal(r.statement.approvedCents, ourTotal);
  assert.equal((await admin.call('POST', '/api/tab/entries', { companyId: coA, memberNumber: 'AZ-220', amountCents: 100, description: 'zu spät' })).status, 409);
  assert.equal((await admin.call('POST', `/api/tab/entries/${e1}/cancel`, { reason: 'zu spät' })).status, 409); ok('Nach Bestätigung ist der Zeitraum für Buchungen und Stornos gesperrt');
  // Zahlung per Überweisung
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt1.id}/prepare`, { method: 'bar' })).status, 400);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt1.id}/prepare`, { method: 'transfer' })).statement.status, 'payment_pending');
  r = await admin.call('POST', `/api/tab/statements/${tabSt1.id}/pay`, { paidAt: '2026-10-08', reference: 'TX-4711' }); assert.equal(r.statement.status, 'paid'); assert.equal(r.statement.payReference, 'TX-4711');
  r = await admin.call('GET', '/api/finance/ledger?q=Muster'); assert.equal(r.entries.filter((e) => e.entryType === 'tab' && e.status === 'settled').length, 2); ok('Zahlung per Überweisung dokumentiert → Abrechnung bezahlt, Finanzvorgänge verbucht');
  // Abweichung + Rechnung (Firma B, Monat)
  const tabCurMonth = tabPeriodKey(new Date(), 'monthly');
  r = await portal.call('GET', `/api/c/${tokB}`); assert.equal(r.company.name, 'Beispiel AG');
  r = await portal.call('POST', `/api/c/${tokB}/statements`, { periodKey: tabCurMonth, amountCents: 900 }); assert.equal(r.status, 201); // wir haben 1000
  r = await admin.call('GET', '/api/tab/statements?company=' + coB); const tabSt2 = r.statements[0]; assert.equal(tabSt2.matches, false); assert.equal(tabSt2.diffCents, -100); assert.equal(tabSt2.ourCents, 1000);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/confirm`, {})).status, 409);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/confirm`, { acceptDifference: true })).status, 400);
  r = await admin.call('POST', `/api/tab/statements/${tabSt2.id}/confirm`, { acceptDifference: true, note: 'Firma hat Kaffee vergessen', approvedCents: 1000 }); assert.equal(r.statement.status, 'confirmed'); assert.equal(r.statement.approvedCents, 1000); ok('Abweichung (-1,00): nicht automatisch bestätigt – nur mit ausdrücklicher Freigabe und Begründung');
  await admin.call('POST', `/api/tab/statements/${tabSt2.id}/prepare`, { method: 'invoice' });
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/pay`, {})).status, 409);
  await admin.call('POST', `/api/tab/statements/${tabSt2.id}/invoice`, { received: true, number: 'RE-77', amountCents: 1100, date: '2026-10-09' });
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/pay`, {})).status, 409);
  const PDFB64 = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  { const rr = await admin.call('POST', `/api/tab/statements/${tabSt2.id}/invoice-file`, { data: 'data:application/pdf;base64,' + PDFB64 }); assert.equal(rr.status, 200, JSON.stringify(rr)); }
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/invoice-file`, { data: 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400);
  const tabDl = await fetch(`${base}/api/tab/statements/${tabSt2.id}/invoice-file`, { headers: { cookie: admin.cookie } }); assert.equal(tabDl.status, 200); assert.equal(tabDl.headers.get('content-type'), 'application/pdf');
  await admin.call('POST', `/api/tab/statements/${tabSt2.id}/invoice`, { amountCents: 1000 });
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/pay`, {})).statement.status, 'paid'); ok('Zahlung per Firmenrechnung: Rechnungsnummer/-betrag/-datum/-datei (nur PDF/Bild), Betrag muss zum freigegebenen passen');
  // Ablehnung + erneutes Einreichen
  r = await admin.call('POST', '/api/tab/companies', { name: 'Reject GmbH', interval: 'monthly' }); const coR = r.company.id; const tokR = r.company.linkPath.split('/').pop();
  await admin.call('POST', '/api/tab/entries', { companyId: coR, memberNumber: 'AZ-220', amountCents: 5000, description: 'Posten X' });
  await portal.call('POST', `/api/c/${tokR}/statements`, { periodKey: tabCurMonth, amountCents: 7777 });
  const tabSt3 = (await admin.call('GET', '/api/tab/statements?company=' + coR)).statements[0];
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt3.id}/reject`, { reason: '' })).status, 400);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt3.id}/reject`, { reason: 'Betrag falsch' })).statement.status, 'rejected');
  r = await portal.call('GET', `/api/c/${tokR}`); assert.ok(r.periods.some((p) => p.key === tabCurMonth)); assert.equal(r.statements[0].rejectReason, 'Betrag falsch');
  assert.equal((await portal.call('POST', `/api/c/${tokR}/statements`, { periodKey: tabCurMonth, amountCents: 5000 })).status, 201); ok('Abgelehnte Abrechnung: Firma sieht den Grund und kann den Zeitraum erneut einreichen');
  // Sicherheit
  r = await portal.call('GET', `/api/c/${tokA}`); assert.equal(r.statements.length, 1); assert.equal(JSON.stringify(r).includes('Beispiel') || JSON.stringify(r).includes('Reject'), false);
  r = await admin.call('POST', `/api/tab/companies/${coA}/reset-link`); assert.notEqual(r.company.linkPath.split('/').pop(), tokA); assert.equal((await portal.call('GET', `/api/c/${tokA}`)).status, 404);
  tokA = r.company.linkPath.split('/').pop(); assert.equal((await portal.call('GET', `/api/c/${tokA}`)).status, 200);
  await admin.call('PATCH', `/api/tab/companies/${coA}`, { status: 'disabled' }); assert.equal((await portal.call('GET', `/api/c/${tokA}`)).status, 404);
  assert.equal((await admin.call('POST', '/api/tab/entries', { companyId: coA, memberNumber: 'AZ-220', amountCents: 100, description: 'Posten x' })).status, 403); ok('Neuer Link macht den alten ungültig; deaktivierte Firmen sind gesperrt; Firmen sehen nur das Eigene');
  assert.equal((await admin.call('PATCH', `/api/tab/companies/${coB}`, { interval: 'weekly' })).status, 409); ok('Intervall lässt sich nach Buchungen nicht mehr ändern');
  r = await admin.call('GET', '/api/tab/summary'); assert.ok(r.summary.paid >= 2); assert.ok(r.summary.submitted >= 1); assert.equal(typeof r.summary.openCents, 'number'); assert.ok(r.summary.recent.length >= 3);
  r = await admin.call('GET', '/api/dashboard'); assert.ok(r.widgets.some((w) => w.id === 'tab-overview')); ok('Dashboard-Kennzahlen (offen, eingereicht, bezahlt, offener Gesamtbetrag)');
  r = await admin.call('GET', `/api/tab/companies/${coA}`); assert.ok(r.statements.length === 1 && r.periods.length >= 1);
  r = await admin.call('GET', '/api/audit?module=tab&limit=200'); const acts = new Set(r.rows.map((x) => x.action)); for (const a of ['tab.entry_created', 'tab.entry_cancelled', 'tab.entry_corrected', 'tab.company_created', 'tab.statement_submitted', 'tab.statement_confirm', 'tab.statement_pay']) assert.ok(acts.has(a), a); ok('Alle wichtigen Aktionen stehen im Audit-Log');
  await setPerms([]);


  // ══ Kreditsystem ══
  const { runCreditReminders } = await import('../server/modules/credit.js');
  const calcSrv = await import('../server/core/credit-calc.js'), calcCli = await import('../public/js/credit-calc.js');
  const sample = { principal: 123457, count: 7, frequency: 'monthly', type: 'flat', rateBp: 175, ratePeriod: 'month' };
  assert.deepEqual(calcSrv.calcLoan(sample), calcCli.calcLoan(sample)); assert.deepEqual(calcSrv.splitInstallments({ principal: 100, interest: 7, count: 3 }), calcCli.splitInstallments({ principal: 100, interest: 7, count: 3 }));
  assert.deepEqual(calcSrv.dueDates('2026-01-31', 3, 'monthly'), ['2026-02-28', '2026-03-31', '2026-04-30']); assert.deepEqual(calcSrv.calcLoan({ principal: 100000, count: 10, frequency: 'weekly', type: 'flat', rateBp: 250, ratePeriod: 'week' }), { days: 70, interest: 25000, total: 125000, installment: 12500 }); ok('Kreditberechnung: einfache Zinsen, Raten, Fälligkeiten (Server = Frontend)');
  const noCredit = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Ohne Kredit', apps: ['market'] }); await noCredit.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code });
  assert.equal((await noCredit.call('GET', '/api/p/credit/loans')).status, 403);
  const bor = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Kreditnehmer Eins', apps: ['credit'] }); const borId = r.partner.id; const borNo = r.partner.number;
  assert.equal((await bor.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code })).status, 200);
  const bor2 = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Kreditnehmer Zwei', apps: ['credit'] }); const bor2Id = r.partner.id; await bor2.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code });
  r = await bor.call('GET', '/api/p/credit/config'); assert.equal(r.limitCents, null); ok('Kredit-App nur für Partner mit freigeschalteter App');
  assert.equal((await bor.call('POST', '/api/p/credit/requests', { principalCents: 100, termCount: 5, frequency: 'weekly' })).status, 400);
  assert.equal((await bor.call('POST', '/api/p/credit/requests', { principalCents: 100000, termCount: 0, frequency: 'weekly' })).status, 400);
  assert.equal((await bor.call('POST', '/api/p/credit/requests', { principalCents: 100000, termCount: 5, frequency: 'täglich' })).status, 400);
  r = await bor.call('POST', '/api/p/credit/requests', { principalCents: 100000, termCount: 10, frequency: 'weekly', note: 'Fuhrpark erweitern' }); assert.equal(r.status, 201); assert.match(r.loan.number, /^[A-Z]+-K-\d+$/); assert.equal(r.loan.status, 'requested'); assert.equal(r.loan.turn, 'staff'); assert.equal(r.loan.interest.set, false); assert.equal(r.loan.partner, undefined); const loan1 = r.loan.id;
  r = await admin.call('GET', '/api/notifications'); assert.ok(r.notifications.some((n) => /neue Kreditanfrage/.test(n.title) && n.target.loanId === loan1)); ok('Kredit anfragen (Summe, Laufzeit, wöchentlich/monatlich) – Team wird benachrichtigt');
  assert.equal((await mod.call('GET', '/api/credit/loans')).status, 403);
  r = await admin.call('GET', '/api/credit/loans?group=staff'); assert.equal(r.loans.length, 1); assert.equal(r.loans[0].partner.number, borNo);
  assert.equal((await admin.call('POST', `/api/credit/loans/${loan1}/accept`, {})).status, 400); // Zahlungsziel fehlt
  assert.equal((await bor.call('POST', `/api/p/credit/loans/${loan1}/accept`)).status, 409); // nicht am Zug
  assert.equal((await admin.call('POST', `/api/credit/loans/${loan1}/counter`, { interestType: 'flat', ratePercent: 0, ratePeriod: 'week', payTo: 'Konto 123' })).status, 400);
  r = await admin.call('POST', `/api/credit/loans/${loan1}/counter`, { interestType: 'flat', ratePercent: 2.5, ratePeriod: 'week', payTo: 'Konto 123 · Verwendungszweck: Kreditnummer', text: 'Unser Angebot' });
  assert.equal(r.status, 200); assert.equal(r.loan.status, 'negotiating'); assert.equal(r.loan.turn, 'partner'); assert.equal(r.loan.interestCents, 25000); assert.equal(r.loan.totalCents, 125000); assert.equal(r.loan.installmentCents, 12500); ok('Gegenvorschlag des Teams: Zinssatz pro Woche, Zahlungsziel – Gesamtkosten werden berechnet');
  r = await bor.call('GET', `/api/p/credit/loans/${loan1}`); assert.equal(r.loan.interestCents, 25000); assert.equal(r.loan.totalCents, 125000); assert.equal(r.loan.installmentCents, 12500); assert.equal(r.loan.interest.text, '2,5 % pro Woche'); assert.match(r.loan.payTo, /Konto 123/); assert.equal(r.loan.turn, 'partner');
  assert.equal(JSON.stringify(r).includes('Kreditnehmer Eins'), false); assert.ok(r.events.length >= 2); ok('Kreditnehmer sieht transparent: Zinsen, Gesamtrückzahlung, Rate, Laufzeit, Zahlungsziel');
  assert.equal((await bor2.call('GET', `/api/p/credit/loans/${loan1}`)).status, 404); ok('Ein Kreditnehmer sieht nie Kredite anderer');
  r = await bor.call('POST', `/api/p/credit/loans/${loan1}/counter`, { termCount: 5, text: 'Lieber kürzer' }); assert.equal(r.loan.turn, 'staff'); assert.equal(r.loan.termCount, 5); assert.equal(r.loan.interestCents, 12500); assert.equal(r.loan.interest.rateBp, 250); assert.equal((await bor.call('POST', `/api/p/credit/loans/${loan1}/counter`, { termCount: 3 })).status, 409);
  assert.equal((await bor.call('POST', `/api/p/credit/loans/${loan1}/counter`, { interestType: 'none' })).status, 409); ok('Gegenvorschlag des Kreditnehmers (Laufzeit) – Zinssatz bleibt Sache des Teams, Zinsen werden neu berechnet');
  r = await admin.call('POST', `/api/credit/loans/${loan1}/accept`, {}); assert.equal(r.loan.status, 'accepted');
  assert.equal((await bor.call('POST', `/api/p/credit/loans/${loan1}/report`, { installmentId: 1 })).status, 409);
  r = await admin.call('POST', `/api/credit/loans/${loan1}/disburse`, { date: '2026-10-07' }); assert.equal(r.loan.status, 'active'); assert.equal(r.loan.installments.length, 5);
  assert.deepEqual(r.loan.installments.map((i) => i.dueDate), ['2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04', '2026-11-11']); assert.equal(r.loan.installments.reduce((a, i) => a + i.amountCents, 0), 112500); assert.equal(r.loan.installments[0].amountCents, 22500);
  r = await admin.call('GET', '/api/finance/ledger?q=' + borNo); const cl = r.entries.filter((e) => e.entryType === 'credit_payout' || e.entryType === 'credit_installment'); assert.equal(cl.filter((e) => e.entryType === 'credit_payout' && e.direction === 'out' && e.status === 'settled' && e.amount === 1000).length, 1); assert.equal(cl.filter((e) => e.entryType === 'credit_installment' && e.status === 'expected' && e.direction === 'in').length, 5); ok('Annahme → Auszahlung bestätigt: Tilgungsplan (5 Raten mit Fälligkeiten) und Finanzvorgänge');
  r = await bor.call('GET', `/api/p/credit/loans/${loan1}`); assert.equal(r.loan.installments.length, 5); assert.equal(r.loan.nextDue.date, '2026-10-14'); assert.equal(r.loan.remainingCents, 112500); assert.equal(r.loan.nextDue.amountCents, 22500); ok('Kreditnehmer sieht Fälligkeiten, Beträge und den Rest');
  const inst1 = r.loan.installments[0].id;
  r = await bor.call('POST', `/api/p/credit/loans/${loan1}/report`, { installmentId: inst1 }); assert.ok(r.loan.installments[0].reportedAt); assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Ratenzahlung gemeldet/.test(n.body)));
  assert.equal((await mod.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: inst1 })).status, 403);
  assert.equal((await admin.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: inst1, amountCents: 99999999 })).status, 400);
  r = await admin.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: inst1, amountCents: 10000, date: '2026-10-14' }); assert.equal(r.loan.installments[0].status, 'open'); assert.equal(r.loan.installments[0].paidCents, 10000);
  r = await admin.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: inst1, date: '2026-10-15' }); assert.equal(r.loan.installments[0].status, 'paid'); assert.equal(r.loan.installmentsPaid, 1); ok('Ratenzahlungen erfassen (auch teilweise), Zahlung melden');
  for (const i of r.loan.installments.slice(1)) r = await admin.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: i.id });
  assert.equal(r.loan.status, 'completed'); assert.equal(r.loan.remainingCents, 0); assert.equal(r.loan.nextDue, null);
  r = await admin.call('GET', '/api/finance/ledger?q=' + borNo); assert.equal(r.entries.filter((e) => e.entryType === 'credit_installment' && e.status === 'settled').length, 5); assert.equal((await admin.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: inst1 })).status, 409);
  r = await bor.call('GET', '/api/p/credit/loans'); assert.equal(r.loans[0].status, 'completed'); assert.equal((await bor.call('POST', '/api/p/credit/requests', { principalCents: 50000, termCount: 2, frequency: 'monthly' })).status, 201); ok('Abbezahlt: Kredit schließt sich, bleibt im Verlauf, neuer Kredit ist beantragbar');
  // Rahmen, Limits, Ablehnen, Ausfall
  assert.equal((await mod.call('PATCH', `/api/credit/borrowers/${borId}`, { limitCents: 1000 })).status, 403);
  assert.equal((await admin.call('PATCH', `/api/credit/borrowers/${borId}`, { limitCents: 15000 })).status, 200);
  assert.equal((await bor.call('POST', '/api/p/credit/requests', { principalCents: 20000, termCount: 2, frequency: 'monthly' })).status, 409); // 20000 > Rahmen 15000
  r = await bor.call('GET', '/api/p/credit/config'); assert.equal(r.limitCents, 15000); assert.equal(r.availableCents, 15000);
  r = await admin.call('GET', '/api/credit/borrowers'); assert.equal(r.borrowers.find((b) => b.id === borId).completedLoans, 1); ok('Kreditrahmen je Kreditnehmer wird bei Anfrage und Annahme geprüft');
  r = await admin.call('GET', '/api/credit/loans?partner=' + borId + '&status=requested'); const loan2 = r.loans[0].id;
  assert.equal((await admin.call('POST', `/api/credit/loans/${loan2}/accept`, { payTo: 'Bar' })).status, 409); // 50000 > Rahmen 15000 beim Annehmen
  assert.equal((await admin.call('POST', `/api/credit/loans/${loan2}/reject`, { text: 'Zu riskant' })).loan.status, 'rejected'); assert.equal((await bor.call('POST', `/api/p/credit/loans/${loan2}/withdraw`)).status, 409);
  await admin.call('PUT', '/api/config', { values: { 'credit.max_open_requests': 1 } });
  assert.equal((await bor2.call('POST', '/api/p/credit/requests', { principalCents: 10000, termCount: 4, frequency: 'monthly' })).status, 201); assert.equal((await bor2.call('POST', '/api/p/credit/requests', { principalCents: 10000, termCount: 4, frequency: 'monthly' })).status, 409);
  await admin.call('PUT', '/api/config', { values: { 'credit.max_open_requests': 3 } });
  const loan3 = (await admin.call('GET', '/api/credit/loans?partner=' + bor2Id)).loans[0].id;
  assert.equal((await bor2.call('POST', `/api/p/credit/loans/${loan3}/withdraw`)).loan.status, 'withdrawn'); ok('Ablehnen, Zurückziehen und Begrenzung offener Anfragen');
  // Zinsfrei annehmen, Erinnerungen, Ausfall
  const todayIso = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(new Date(todayIso + 'T12:00:00').getTime() - n * 86400000).toISOString().slice(0, 10);
  r = await bor2.call('POST', '/api/p/credit/requests', { principalCents: 30000, termCount: 3, frequency: 'weekly' }); const loan4 = r.loan.id;
  r = await admin.call('POST', `/api/credit/loans/${loan4}/accept`, { payTo: 'Barzahlung im Büro' }); assert.equal(r.loan.interest.type, 'none'); assert.equal(r.loan.interestCents, 0); assert.equal(r.loan.interest.text, 'Zinsfrei'); assert.equal(r.loan.totalCents, 30000);
  r = await admin.call('POST', `/api/credit/loans/${loan4}/disburse`, { date: daysAgo(6) }); // 1. Rate morgen fällig
  runCreditReminders(); r = await bor2.call('GET', '/api/p/notifications'); assert.ok(r.notifications.some((n) => /Rate bald fällig/.test(n.title)));
  r = await bor2.call('POST', '/api/p/credit/requests', { principalCents: 10000, termCount: 2, frequency: 'weekly' }); const loan5 = r.loan.id; await admin.call('POST', `/api/credit/loans/${loan5}/accept`, { payTo: 'Bar' });
  await admin.call('POST', `/api/credit/loans/${loan5}/disburse`, { date: daysAgo(20) }); runCreditReminders();
  r = await bor2.call('GET', '/api/p/notifications'); assert.ok(r.notifications.some((n) => /Rate überfällig/.test(n.title))); assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Rate überfällig/.test(n.title)));
  r = await bor2.call('GET', `/api/p/credit/loans/${loan5}`); assert.equal(r.loan.overdueCount, 2); assert.equal(r.loan.installments[0].overdue, true); assert.equal((await admin.call('GET', '/api/credit/loans?group=overdue')).loans.length, 1);
  r = await admin.call('GET', '/api/credit/summary'); assert.equal(r.summary.overdueCount, 2); assert.ok(r.summary.outstandingCents >= 40000); assert.ok(r.summary.upcoming.length >= 1); ok('Erinnerungen (bald fällig / überfällig) und Überfällig-Auswertung');
  r = await admin.call('POST', `/api/credit/loans/${loan5}/default`, { text: 'Zahlt nicht' }); assert.equal(r.loan.status, 'defaulted');
  r = await admin.call('GET', '/api/finance/ledger?q=Bar'); void r; assert.equal((await admin.call('POST', `/api/credit/loans/${loan5}/payment`, { installmentId: 1 })).status, 409);
  r = await admin.call('GET', '/api/finance/ledger?status=cancelled'); assert.ok(r.entries.some((e) => e.entryType === 'credit_installment')); ok('Ausfall markiert offene Raten als nicht mehr erwartet (Journal storniert)');
  assert.equal((await admin.call('GET', '/api/dashboard')).widgets.some((w) => w.id === 'credit-overview'), true);
  r = await admin.call('GET', '/api/audit?module=credit&limit=200'); const cacts = new Set(r.rows.map((x) => x.action)); for (const a of ['credit.requested', 'credit.counter', 'credit.accept', 'credit.disburse', 'credit.payment', 'credit.limit_set']) assert.ok(cacts.has(a), a); ok('Alle Kredit-Aktionen stehen im Audit-Log');

  // ══ Versionskennung (Selbstheilung nach Updates) ══
  r = await new Client().call('GET', '/api/bootstrap'); assert.match(r.version, /^[0-9a-f]{12}$/); assert.equal((await new Client().call('GET', '/api/version')).version, r.version);
  assert.equal((await fetch(`${base}/js/main.js`)).headers.get('cache-control'), 'no-store'); assert.equal((await fetch(`${base}/reset`)).status, 200); ok('Version im Bootstrap, Programmdateien ohne Browser-Cache, /reset erreichbar');


  // ══ Profilbilder ══
  const PNGAV = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await setPerms([]);
  const sProf = await openSse(admin.cookie, '/api/events');
  assert.equal((await new Client().call('POST', '/api/account/avatar', { data: PNGAV })).status, 401);
  assert.equal((await mod.call('POST', '/api/account/avatar', { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') })).status, 400);
  r = await mod.call('POST', '/api/account/avatar', { data: PNGAV }); assert.equal(r.status, 200); assert.match(r.avatarUrl, /^\/api\/avatars\/\d+\?v=1$/); const avUrl = r.avatarUrl;
  assert.ok(await sProf.waitFor((e) => e.event === 'change' && e.data.topic === 'profile')); ok('Eigenes Profilbild hochladen (nur echte Bilder) – live bei anderen sichtbar');
  const avRes = await fetch(`${base}${avUrl}`, { headers: { cookie: admin.cookie } }); assert.equal(avRes.status, 200); assert.equal(avRes.headers.get('content-type'), 'image/png'); assert.match(avRes.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}${avUrl}`)).status, 401);
  assert.equal((await mod.call('GET', '/api/auth/me')).user.avatarUrl, avUrl);
  r = await admin.call('GET', '/api/users'); assert.equal(r.users.find((u) => u.id === neuer.id).avatarUrl, avUrl); assert.equal(JSON.stringify(r).includes('Neuer'), false); ok('Profilbild erscheint in Konto, Benutzerliste (weiterhin ohne Namen) und ist nur angemeldet abrufbar');
  assert.equal((await mod.call('DELETE', `/api/users/${neuer.id}/avatar`)).status, 403); // kein Recht
  await setPerms(['users.avatar_remove']); assert.equal((await mod.call('DELETE', `/api/users/${1}/avatar`)).status, 403); // Admin hat gar keins
  assert.equal((await mod.call('DELETE', `/api/users/${neuer.id}/avatar`)).status, 200);
  assert.equal((await fetch(`${base}${avUrl}`, { headers: { cookie: admin.cookie } })).status, 404); await setPerms([]);
  await mod.call('POST', '/api/account/avatar', { data: PNGAV }); assert.equal((await admin.call('DELETE', `/api/users/${neuer.id}/avatar`)).status, 200); ok('Entfernen fremder Profilbilder nur mit users.avatar_remove (Admins immer)');
  await mod.call('POST', '/api/account/avatar', { data: PNGAV }); assert.equal((await mod.call('DELETE', '/api/account/avatar')).status, 200); assert.equal((await mod.call('GET', '/api/auth/me')).user.avatarUrl, null); sProf.close(); ok('Eigenes Profilbild entfernen');

  // ══ Live-Synchronisation im Firmenportal ══
  r = await admin.call('POST', '/api/tab/companies', { name: 'Live GmbH', interval: 'weekly' }); const liveTok = r.company.linkPath.split('/').pop(); const liveCo = r.company.id;
  r = await admin.call('POST', '/api/tab/companies', { name: 'Andere GmbH', interval: 'weekly' }); const otherTok = r.company.linkPath.split('/').pop();
  await admin.call('POST', '/api/tab/entries', { companyId: liveCo, memberNumber: 'AZ-220', amountCents: 1500, description: 'Live Test' });
  const sCo = await openSse('', `/api/c/${liveTok}/events`), sOther = await openSse('', `/api/c/${otherTok}/events`);
  assert.equal(sCo.status, 200); assert.equal((await openSse('', '/api/c/ungueltig-ungueltig-ungueltig/events')).status, 404);
  const curW = tabPeriodKey(new Date(), 'weekly');
  await new Client().call('POST', `/api/c/${liveTok}/statements`, { periodKey: curW, amountCents: 1500 });
  assert.ok(await sCo.waitFor((e) => e.event === 'change' && e.data.topic === 'tab')); const n0 = sCo.events.filter((e) => e.event === 'change').length;
  const liveSt = (await admin.call('GET', '/api/tab/statements?company=' + liveCo)).statements[0];
  await admin.call('POST', `/api/tab/statements/${liveSt.id}/review`);
  assert.ok(await sCo.waitFor((e) => e.event === 'change' && e.data.kind === 'tab.statement_review')); ok('Firmenportal: Statuswechsel durch Mitarbeiter kommt live bei der Firma an');
  await sleep(150); assert.equal(sOther.events.some((e) => e.event === 'change'), false); assert.ok(n0 >= 1); sCo.close(); sOther.close(); ok('Eine Firma bekommt nie Ereignisse einer anderen Firma');
  // Mitarbeiter-Seite: Einreichung einer Firma kommt live an
  const sStaff = await openSse(admin.cookie, '/api/events'); r = await new Client().call('POST', `/api/c/${otherTok}/statements`, { periodKey: curW, amountCents: 0 });
  assert.ok(await sStaff.waitFor((e) => e.event === 'change' && e.data.topic === 'tab' && e.data.kind === 'tab.statement_submitted')); sStaff.close(); ok('Mitarbeiter sehen neu eingereichte Firmen-Abrechnungen live');

  // ── Branding: eigenes Logo / Hintergrund ──
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  assert.equal((await mod.call('POST', '/api/admin/branding/logo', { data: PNG })).status, 403);
  assert.equal((await admin.call('POST', '/api/admin/branding/logo', { data: Buffer.from('<svg onload=alert(1)>').toString('base64') })).status, 400);
  assert.equal((await admin.call('POST', '/api/admin/branding/nope', { data: PNG })).status, 404);
  r = await admin.call('POST', '/api/admin/branding/logo', { data: `data:image/png;base64,${PNG}` });
  assert.equal(r.status, 200); assert.ok(r.version > 0);
  const served = await fetch(`${base}/branding/logo`);
  assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await admin.call('GET', '/api/bootstrap')).config['branding.logo_version'], r.version); ok('Eigenes Logo hochladen (nur echte PNG/JPEG/WebP-Bilder), wird öffentlich ausgeliefert');
  assert.equal((await admin.call('DELETE', '/api/admin/branding/logo')).version, 0);
  assert.equal((await fetch(`${base}/branding/logo`)).status, 404); ok('Logo auf Standard zurücksetzen');

  // Audit
  const actions = new Set();
  for (let off = 0; off < 2000; off += 200) { r = await admin.call('GET', `/api/audit?limit=200&offset=${off}`); r.rows.forEach((x) => actions.add(x.action)); if (r.rows.length < 200) break; }
  for (const a of ['system.setup', 'user.registered', 'role.created', 'user.approved', 'user.blocked', 'user.unblocked', 'config.changed']) assert.ok(actions.has(a), `Audit fehlt: ${a}`);
  ok('Audit-Log enthält alle Aktionen');
  assert.equal((await mod.call('GET', '/api/audit')).status, 200); ok('audit.view erlaubt Zugriff');
  assert.equal((await mod.call('GET', '/api/permissions')).status, 200);

  console.log(`\nAlle ${passed} Prüfungen bestanden.`);
} catch (e) {
  console.error('\n✗ FEHLGESCHLAGEN:', e.message, '\n', e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
} finally {
  server.close();
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(process.exitCode ?? 0); }, 200);
}
