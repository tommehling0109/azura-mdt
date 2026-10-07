import { all, get, run, tx, now } from '../core/db.js';
import { bad, conflict, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { registerLookup, lookupEntries, isActiveEntry, lookupEntry } from '../core/lookups.js';
import { registerPartnerApp } from '../core/partner-apps.js';
import { getConfig } from '../core/config.js';
import { registerWidget } from './dashboard.js';
import { allocateNumber } from '../core/numbers.js';
import { labelForUser } from '../core/identity.js';
import { notify, staffWith } from '../core/notifications.js';

/** Zustände eines Geschäfts. Die SCHLÜSSEL kennt der Code, Beschriftung und Farbe sind im Admin-Bereich änderbar. */
const STATUS_FIXED = [
  { key: 'submitted', label: 'Eingereicht', color: '#60a5fa' },
  { key: 'negotiating', label: 'In Verhandlung', color: '#fbbf24' },
  { key: 'accepted', label: 'Angenommen', color: '#34d399' },
  { key: 'delivery', label: 'Lieferung ausstehend', color: '#38bdf8' },
  { key: 'delivered', label: 'Ware eingegangen', color: '#a78bfa' },
  { key: 'payout', label: 'Zahlung ausstehend', color: '#fb923c' },
  { key: 'completed', label: 'Abgeschlossen', color: '#22c55e' },
  { key: 'rejected', label: 'Abgelehnt', color: '#f87171' },
  { key: 'withdrawn', label: 'Zurückgezogen', color: '#94a3b8' },
  { key: 'cancelled', label: 'Storniert', color: '#94a3b8' },
];
const OPEN = ['submitted', 'negotiating'];
const ACTIVE = ['accepted', 'delivery', 'delivered', 'payout'];
const FINAL = ['completed', 'rejected', 'withdrawn', 'cancelled'];
const NEXT = { delivery: 'delivered', delivered: 'payout', payout: 'completed' };
const HANDOVER_VISIBLE = ['delivery', 'delivered', 'payout', 'completed'];
const INT_MAX = 100_000_000;

registerLookup({
  key: 'market.item_category', module: 'Börse', label: 'Item-Kategorien',
  description: 'Gliedern den Item-Katalog (z. B. Rohstoffe, Waffen …). Frei erweiterbar.',
  usage: (id) => get('SELECT COUNT(*) c FROM market_items WHERE category_id = ?', id).c,
});
registerLookup({
  key: 'market.handover_place', module: 'Börse', label: 'Übergabeorte',
  description: 'Orte/Lager, an denen Ware übergeben oder abgeholt wird. Die Beschreibung wird dem Partner als Anweisung angezeigt.',
  usage: (id) => get('SELECT COUNT(*) c FROM market_deals WHERE handover_place_id = ?', id).c,
});
registerLookup({
  key: 'market.deal_status', module: 'Börse', label: 'Geschäfts-Status',
  description: 'Feste Zustände eines Geschäfts – Beschriftung und Farbe sind anpassbar.', fixed: STATUS_FIXED,
});
registerPartnerApp({ id: 'market', label: 'Börse', icon: 'tag', description: 'Angebote einstellen, Gesuche einsehen und Geschäfte verhandeln' });

const posInt = (v, name, { min = 1, max = INT_MAX } = {}) => {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${name}: ganze Zahl zwischen ${min} und ${max.toLocaleString('de-DE')} erforderlich.`);
  return v;
};
const optPrice = (v, name) => (v == null || v === '' ? null : posInt(v, name, { min: 0 }));

// ── Katalog ──
const ITEM_SQL = 'SELECT i.*, l.label cat_label, l.color cat_color FROM market_items i LEFT JOIN lookups l ON l.id = i.category_id';
const itemDto = (i) => ({
  id: i.id, name: i.name, description: i.description, unit: i.unit, referencePrice: i.reference_price, isActive: !!i.is_active,
  category: i.category_id ? { id: i.category_id, label: i.cat_label, color: i.cat_color } : null,
});
const loadItem = (id) => { const i = get(`${ITEM_SQL} WHERE i.id = ?`, id); return i ? itemDto(i) : null; };

// ── Geschäfte ──
const DEAL_SQL = `SELECT d.*, p.name partner_name, p.partner_number partner_number, i.name item_name, i.unit item_unit, ic.id cat_id, ic.label cat_label, ic.color cat_color,
  sl.label status_label, sl.color status_color, u.member_number assignee_number, hp.label place_label, hp.description place_desc
  FROM market_deals d JOIN partners p ON p.id = d.partner_id JOIN market_items i ON i.id = d.item_id
  LEFT JOIN lookups ic ON ic.id = i.category_id
  LEFT JOIN lookups sl ON sl.list_key = 'market.deal_status' AND sl.key = d.status
  LEFT JOIN users u ON u.id = d.assignee_id LEFT JOIN lookups hp ON hp.id = d.handover_place_id`;

const dealDto = (d, partnerView, viewerId = null) => {
  const hasHandover = d.handover_place_id || d.handover_info || d.payout_info;
  return {
    id: d.id, number: d.deal_number, origin: d.origin, wantedId: d.wanted_id, status: d.status, statusLabel: d.status_label ?? d.status, statusColor: d.status_color ?? '#94a3b8',
    turn: d.turn, quantity: d.quantity, unitPrice: d.unit_price, total: d.quantity * d.unit_price, proposedBy: d.proposed_by, note: d.note,
    item: { id: d.item_id, name: d.item_name, unit: d.item_unit, category: d.cat_id ? { id: d.cat_id, label: d.cat_label, color: d.cat_color } : null },
    // Partner sehen weder den Namen der Gegenseite noch interne Zuständigkeiten – nur die AZ-Nummer des Geschäfts
    partner: partnerView ? undefined : { id: d.partner_id, name: d.partner_name, number: d.partner_number },
    // Staff: Zuständiger (Personalnummer, man selbst „Du“). Partner: Ansprechpartner nur als Personalnummer – ohne Zuweisung bleibt es „Team“
    assignee: d.assignee_id ? { id: partnerView ? undefined : d.assignee_id, displayName: !partnerView && d.assignee_id === viewerId ? 'Du' : (d.assignee_number || `Mitglied #${d.assignee_id}`), number: d.assignee_number ?? null } : null,
    handover: hasHandover && (!partnerView || HANDOVER_VISIBLE.includes(d.status))
      ? { place: d.handover_place_id ? { id: d.handover_place_id, label: d.place_label, description: d.place_desc } : null, info: d.handover_info, payoutInfo: d.payout_info }
      : null,
    createdAt: d.created_at, updatedAt: d.updated_at, closedAt: d.closed_at,
  };
};
const loadDeal = (id, partnerView = false, viewerId = null) => { const d = get(`${DEAL_SQL} WHERE d.id = ?`, id); return d ? dealDto(d, partnerView, viewerId) : null; };
const eventsOf = (dealId, partnerView, viewerId = null) => {
  // Wer ist dem Geschäft zugewiesen? Dessen Handlungen erscheinen für den Partner unter der Personalnummer statt „Team“
  const asg = partnerView ? get('SELECT u.id uid, u.member_number n FROM market_deals d JOIN users u ON u.id = d.assignee_id WHERE d.id = ?', dealId) : null;
  return eventsRaw(dealId, partnerView, viewerId, asg);
};
const eventsRaw = (dealId, partnerView, viewerId, asg) => all(
  `SELECT * FROM market_events WHERE deal_id = ? ${partnerView ? 'AND internal = 0' : ''} ORDER BY id`, dealId,
).map((e) => ({
  id: e.id, kind: e.kind, actorType: e.actor_type,
  actorName: partnerView ? (e.actor_type === 'partner' ? 'Du' : e.actor_type === 'system' ? 'System' : (asg && e.actor_id === asg.uid ? (asg.n || `Mitglied #${asg.uid}`) : 'Team')) : (e.actor_type === 'staff' ? (labelForUser(e.actor_id, viewerId) ?? 'Mitglied') : e.actor_name), quantity: e.quantity, unitPrice: e.unit_price,
  text: e.text, internal: !!e.internal, createdAt: e.created_at,
}));
const insertEvent = (dealId, actor, kind, { quantity, unitPrice, text, internal } = {}) =>
  run(`INSERT INTO market_events (deal_id,actor_type,actor_id,actor_name,kind,quantity,unit_price,text,internal,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    dealId, actor.type, actor.id ?? null, actor.name ?? null, kind, quantity ?? null, unitPrice ?? null, text ?? null, internal ? 1 : 0, now());
const addEvent = (...a) => Number(insertEvent(...a).lastInsertRowid);
const touch = (id, fields = {}) => {
  const cols = Object.keys(fields);
  run(`UPDATE market_deals SET ${[...cols.map((c) => `${c} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), now(), id);
};
const statusLabel = (key) => lookupEntries('market.deal_status').find((e) => e.key === key)?.label ?? key;

/**
 * Zentrale Zustandslogik – wird von Mitarbeitern (staff) und Partnern gleichermaßen genutzt.
 * Verhandlung: Wer am Zug ist (turn), kann annehmen, ablehnen oder ein Gegenangebot machen.
 */
function applyAction(dealId, actor, action, b) {
  return tx(() => {
    const d = get('SELECT * FROM market_deals WHERE id = ?', dealId);
    if (!d) throw notFound('Geschäft nicht gefunden.');
    const side = actor.type;
    const other = side === 'staff' ? 'partner' : 'staff';
    const isOpen = OPEN.includes(d.status);
    const needOpen = () => { if (!isOpen) throw conflict('Das Geschäft befindet sich nicht mehr in der Verhandlung.'); };
    const needTurn = () => { if (d.turn !== side) throw conflict(side === 'partner' ? 'Du bist gerade nicht am Zug. Bitte warte auf eine Antwort.' : 'Die Gegenseite ist am Zug.'); };
    const text = str(b.text, 'Text', { max: 1000, required: false });
    let evId = null;
    const ev = (...a) => { evId = addEvent(...a); return evId; };

    switch (action) {
      case 'accept': {
        needOpen(); needTurn();
        touch(dealId, { status: 'accepted', turn: null });
        ev(dealId, actor, 'accept', { quantity: d.quantity, unitPrice: d.unit_price, text });
        break;
      }
      case 'counter': {
        needOpen(); needTurn();
        const quantity = b.quantity === undefined ? d.quantity : posInt(b.quantity, 'Menge');
        const unitPrice = posInt(b.unitPrice, 'Preis pro Einheit');
        touch(dealId, { status: 'negotiating', turn: other, proposed_by: side, quantity, unit_price: unitPrice });
        ev(dealId, actor, 'counter', { quantity, unitPrice, text });
        break;
      }
      case 'reject': {
        needOpen();
        if (side === 'partner') needTurn();
        touch(dealId, { status: 'rejected', turn: null, closed_at: now() });
        ev(dealId, actor, 'reject', { text });
        break;
      }
      case 'withdraw': {
        if (side !== 'partner') throw forbidden();
        needOpen();
        touch(dealId, { status: 'withdrawn', turn: null, closed_at: now() });
        ev(dealId, actor, 'withdraw', { text });
        break;
      }
      case 'message': {
        if (FINAL.includes(d.status)) throw conflict('Das Geschäft ist abgeschlossen.');
        if (!text) throw bad('Bitte gib eine Nachricht ein.');
        const internal = side === 'staff' && b.internal === true;
        ev(dealId, actor, internal ? 'note' : 'message', { text, internal });
        touch(dealId);
        break;
      }
      case 'handover': {
        if (side !== 'staff') throw forbidden();
        if (!['accepted', 'delivery'].includes(d.status)) throw conflict('Die Übergabe kann erst nach der Annahme festgelegt werden.');
        const placeId = b.placeId == null || b.placeId === '' ? null : b.placeId;
        if (placeId != null && !isActiveEntry('market.handover_place', placeId)) throw bad('Unbekannter Übergabeort.');
        const info = str(b.info, 'Anweisung', { max: 1000, required: false });
        const payoutInfo = str(b.payoutInfo, 'Auszahlung', { max: 1000, required: false });
        if (placeId == null && !info) throw bad('Bitte wähle einen Übergabeort oder gib eine Anweisung ein.');
        touch(dealId, { status: 'delivery', turn: null, handover_place_id: placeId, handover_info: info, payout_info: payoutInfo });
        ev(dealId, actor, 'handover', { text: [placeId ? lookupEntry(placeId).label : null, info].filter(Boolean).join(' – ') });
        break;
      }
      case 'advance': {
        if (side !== 'staff') throw forbidden();
        const to = NEXT[d.status];
        if (!to) throw conflict('Von diesem Zustand aus ist kein Fortschritt möglich.');
        if (b.to !== undefined && b.to !== to) throw bad('Ungültiger Zielzustand.');
        touch(dealId, { status: to, ...(to === 'completed' ? { closed_at: now() } : {}) });
        ev(dealId, actor, 'status', { text: statusLabel(to) });
        break;
      }
      case 'cancel': {
        if (side !== 'staff') throw forbidden();
        if (FINAL.includes(d.status)) throw conflict('Das Geschäft ist bereits beendet.');
        touch(dealId, { status: 'cancelled', turn: null, closed_at: now() });
        ev(dealId, actor, 'cancel', { text });
        break;
      }
      case 'assign': {
        if (side !== 'staff') throw forbidden();
        const uid = b.userId == null ? null : b.userId;
        const u = uid == null ? null : get(`SELECT id, member_number FROM users WHERE id = ? AND status = 'active'`, uid);
        if (uid != null && !u) throw bad('Unbekannter Benutzer.');
        touch(dealId, { assignee_id: uid });
        ev(dealId, actor, 'assign', { text: u ? `Zuständig: ${u.member_number ?? 'Mitglied #' + u.id}` : 'Zuständigkeit entfernt', internal: true });
        break;
      }
      default: throw bad('Unbekannte Aktion.');
    }
    fanout(dealId, actor, action, evId, b);
    return action;
  });
}

/**
 * Benachrichtigungen zu einer Geschäfts-Änderung. Jede Änderung hat einen eigenen Schlüssel (Verlaufseintrag evId):
 * jede echte Änderung ⇒ eigene Benachrichtigung, dieselbe Änderung nie doppelt (UNIQUE in notifications).
 */
function fanout(dealId, actor, action, evId, b) {
  if (evId == null) return;
  const d = get(`${DEAL_SQL} WHERE d.id = ?`, dealId);
  const num = d.deal_number;
  const label = d.status_label ?? d.status;
  const target = { app: 'market', dealId };
  const key = `deal:${dealId}:ev:${evId}`;
  const title = `${num} · ${d.item_name}`;
  const nf = (n) => Number(n).toLocaleString('de-DE');
  if (action === 'assign') {
    if (d.assignee_id && !(actor.type === 'staff' && actor.id === d.assignee_id)) notify([{ type: 'user', id: d.assignee_id }], { key, title, body: 'Dir wurde dieses Geschäft zugewiesen.', target });
    return;
  }
  const body = {
    accept: `Angenommen · ${nf(d.quantity)} × ${nf(d.unit_price)}`,
    counter: `Gegenangebot: ${nf(d.quantity)} × ${nf(d.unit_price)}`,
    reject: 'Abgelehnt', withdraw: 'Zurückgezogen',
    handover: `${label} – Übergabe festgelegt`, advance: `Neuer Status: ${label}`, cancel: 'Storniert',
    message: `Neue Nachricht${b?.text ? ': ' + String(b.text).slice(0, 80) : ''}`,
  }[action];
  if (!body) return;
  if (actor.type === 'staff') {
    if (action === 'message' && b?.internal === true) return; // interne Notiz
    notify([{ type: 'partner', id: d.partner_id }], { key, title, body, target });
    if (d.assignee_id && d.assignee_id !== actor.id) notify([{ type: 'user', id: d.assignee_id }], { key: `${key}:assignee`, title, body, target });
  } else {
    notify(staffWith('market.view'), { key, title, body: `${d.partner_number} · ${d.partner_name}: ${body}`, target });
  }
}

const PARTNER_ACTIONS = ['accept', 'counter', 'reject', 'withdraw', 'message'];

function createDeal({ origin, partnerId, itemId, wantedId, quantity, unitPrice, note, actor }) {
  return tx(() => {
    const t = now();
    const number = allocateNumber('deal_number', 'market.deal_prefix', 'market.deal_start');
    const res = run(`INSERT INTO market_deals (deal_number,origin,partner_id,item_id,wanted_id,quantity,unit_price,proposed_by,turn,status,note,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,'partner','staff','submitted',?,?,?)`, number, origin, partnerId, itemId, wantedId ?? null, quantity, unitPrice, note, t, t);
    const id = Number(res.lastInsertRowid);
    const evId = addEvent(id, actor, origin === 'wanted' ? 'response' : 'offer', { quantity, unitPrice, text: note });
    const info = get('SELECT p.name pname, i.name iname FROM market_deals d JOIN partners p ON p.id = d.partner_id JOIN market_items i ON i.id = d.item_id WHERE d.id = ?', id);
    notify(staffWith('market.view'), { key: `deal:${id}:ev:${evId}`, title: `${number} · ${info.iname}`,
      body: `${info.pname}: ${origin === 'wanted' ? 'Antwort auf Gesuch' : 'Neues Angebot'} · ${quantity.toLocaleString('de-DE')} × ${unitPrice.toLocaleString('de-DE')}`, target: { app: 'market', dealId: id } });
    return id;
  });
}

const wantedDto = (w) => ({
  id: w.id, status: w.status, quantity: w.quantity, unitPrice: w.unit_price, note: w.note, expiresAt: w.expires_at, createdAt: w.created_at,
  item: { id: w.item_id, name: w.item_name, unit: w.item_unit, category: w.cat_id ? { id: w.cat_id, label: w.cat_label, color: w.cat_color } : null },
  responseCount: w.response_count ?? 0,
});
const WANTED_SQL = `SELECT w.*, i.name item_name, i.unit item_unit, ic.id cat_id, ic.label cat_label, ic.color cat_color,
  (SELECT COUNT(*) FROM market_deals d WHERE d.wanted_id = w.id) response_count
  FROM market_wanted w JOIN market_items i ON i.id = w.item_id LEFT JOIN lookups ic ON ic.id = i.category_id`;
const loadWanted = (id) => { const w = get(`${WANTED_SQL} WHERE w.id = ?`, id); return w ? wantedDto(w) : null; };
const isLive = (w) => w.status === 'open' && (!w.expires_at || w.expires_at > now());

const summary = () => ({
  awaitingStaff: get(`SELECT COUNT(*) c FROM market_deals WHERE status IN ('submitted','negotiating') AND turn = 'staff'`).c,
  awaitingPartner: get(`SELECT COUNT(*) c FROM market_deals WHERE status IN ('submitted','negotiating') AND turn = 'partner'`).c,
  active: get(`SELECT COUNT(*) c FROM market_deals WHERE status IN ('accepted','delivery','delivered','payout')`).c,
  openWanted: get(`SELECT COUNT(*) c FROM market_wanted WHERE status = 'open' AND (expires_at IS NULL OR expires_at > ?)`, now()).c,
  // Live-Zähler: je Status und je Item-Kategorie (immer direkt aus dem Backend-Zustand berechnet)
  byStatus: Object.fromEntries(all('SELECT status, COUNT(*) c FROM market_deals GROUP BY status').map((r) => [r.status, r.c])),
  statuses: (() => {
    const counts = Object.fromEntries(all('SELECT status, COUNT(*) c FROM market_deals GROUP BY status').map((r) => [r.status, r.c]));
    return lookupEntries('market.deal_status').map((e) => ({ key: e.key, label: e.label, color: e.color, count: counts[e.key] ?? 0 }));
  })(),
  byCategory: [
    ...all(`SELECT l.id, l.label, l.color,
        COALESCE(SUM(d.status IN ('submitted','negotiating','accepted','delivery','delivered','payout')), 0) active,
        COALESCE(SUM(d.status IN ('submitted','negotiating') AND d.turn = 'staff'), 0) waiting,
        COUNT(d.id) total
      FROM lookups l LEFT JOIN market_items i ON i.category_id = l.id LEFT JOIN market_deals d ON d.item_id = i.id
      WHERE l.list_key = 'market.item_category' AND l.is_active = 1 GROUP BY l.id ORDER BY l.sort_order, l.label`),
    ...all(`SELECT NULL id, 'Ohne Kategorie' label, '#94a3b8' color,
        COALESCE(SUM(d.status IN ('submitted','negotiating','accepted','delivery','delivered','payout')), 0) active,
        COALESCE(SUM(d.status IN ('submitted','negotiating') AND d.turn = 'staff'), 0) waiting, COUNT(d.id) total
      FROM market_deals d JOIN market_items i ON i.id = d.item_id WHERE i.category_id IS NULL HAVING COUNT(d.id) > 0`),
  ],
});

registerWidget({
  id: 'market-open', title: 'Börse', size: 'small', permission: 'market.view',
  data: () => ({
    ...summary(),
    latest: all(`${DEAL_SQL} WHERE d.status IN ('submitted','negotiating') AND d.turn = 'staff' ORDER BY d.updated_at DESC LIMIT 4`).map((d) => dealDto(d, false)),
  }),
});

export default {
  name: 'market',
  permissions: [
    ['market.view', 'Börse: Geschäfte, Gesuche und Katalog ansehen'],
    ['market.deals.manage', 'Börse: Geschäfte bearbeiten (annehmen, ablehnen, Gegenangebot, Übergabe)'],
    ['market.wanted.manage', 'Börse: Gesuche („Wir suchen“) verwalten'],
    ['market.catalog.manage', 'Börse: Item-Katalog verwalten'],
  ],
  config: [
    { key: 'market.currency', group: 'Börse', label: 'Währungssymbol', help: 'Wird hinter Preisen angezeigt (z. B. $).', type: 'string', default: '$', max: 6, public: true },
    { key: 'market.deal_prefix', group: 'Börse', label: 'Präfix der Geschäftsnummer', help: 'Partner sehen Geschäfte nur unter dieser Nummer (z. B. AZ-G-100001).', type: 'string', default: 'AZ-G-', max: 12 },
    { key: 'market.deal_start', group: 'Börse', label: 'Startnummer der Geschäfte', type: 'number', default: 100001, min: 1, max: 99999999 },
  ],
  init() {
    // Bestehende Geschäfte ohne Nummer nachträglich nummerieren (in Anlegereihenfolge)
    for (const r of all('SELECT id FROM market_deals WHERE deal_number IS NULL ORDER BY id')) {
      tx(() => run('UPDATE market_deals SET deal_number = ? WHERE id = ?', allocateNumber('deal_number', 'market.deal_prefix', 'market.deal_start'), r.id));
    }
  },
  routes(r) {
    // ══ Mitarbeiter-Seite ══
    r.get('/api/market/summary', { perm: 'market.view' }, () => summary());

    r.get('/api/market/deals', { perm: 'market.view' }, (ctx) => {
      const where = [];
      const p = [];
      const { status, turn, q, partner, group, category } = ctx.query;
      if (group === 'open') where.push(`d.status IN ('submitted','negotiating')`);
      else if (group === 'active') where.push(`d.status IN ('accepted','delivery','delivered','payout')`);
      else if (group === 'done') where.push(`d.status IN ('completed','rejected','withdrawn','cancelled')`);
      if (status) { where.push('d.status = ?'); p.push(status); }
      if (turn === 'staff' || turn === 'partner') { where.push('d.turn = ?'); p.push(turn); }
      if (partner) { where.push('d.partner_id = ?'); p.push(Number(partner)); }
      if (category === 'none') where.push('i.category_id IS NULL');
      else if (category) { where.push('i.category_id = ?'); p.push(Number(category)); }
      if (q) { where.push('(p.name LIKE ? OR i.name LIKE ? OR d.deal_number LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      const rows = all(`${DEAL_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.updated_at DESC LIMIT 300`, ...p);
      return { deals: rows.map((d) => dealDto(d, false)) };
    });

    r.get('/api/market/deals/:id', { perm: 'market.view' }, (ctx) => {
      const deal = loadDeal(Number(ctx.params.id), false, ctx.user.id);
      if (!deal) throw notFound('Geschäft nicht gefunden.');
      return { deal, events: eventsOf(deal.id, false, ctx.user.id) };
    });

    r.post('/api/market/deals/:id/:action', { perm: 'market.deals.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const before = loadDeal(id, false, ctx.user.id);
      if (!before) throw notFound('Geschäft nicht gefunden.');
      const action = applyAction(id, { type: 'staff', id: ctx.user.id, name: null }, ctx.params.action, ctx.body);
      const deal = loadDeal(id, false, ctx.user.id);
      audit(ctx, { action: `market.deal_${action}`, module: 'market', targetType: 'deal', targetId: id, targetLabel: `${deal.item.name} · ${deal.partner.name}`,
        before: { status: before.status, quantity: before.quantity, unitPrice: before.unitPrice }, after: { status: deal.status, quantity: deal.quantity, unitPrice: deal.unitPrice } });
      return { deal, events: eventsOf(id, false, ctx.user.id) };
    });

    // Katalog
    r.get('/api/market/items', { perm: 'market.view' }, () => ({ items: all(`${ITEM_SQL} ORDER BY i.is_active DESC, i.name`).map(itemDto) }));

    const itemFields = (b, partial = false) => {
      const out = {};
      if (!partial || b.name !== undefined) out.name = str(b.name, 'Name', { min: 2, max: 80 });
      if (!partial || b.description !== undefined) out.description = str(b.description, 'Beschreibung', { max: 300, required: false });
      if (!partial || b.unit !== undefined) out.unit = str(b.unit ?? 'Stück', 'Einheit', { min: 1, max: 20 });
      if (!partial || b.referencePrice !== undefined) out.reference_price = optPrice(b.referencePrice, 'Richtpreis');
      if (!partial || b.categoryId !== undefined) {
        const c = b.categoryId == null || b.categoryId === '' ? null : b.categoryId;
        if (c != null && !isActiveEntry('market.item_category', c)) throw bad('Unbekannte Kategorie.');
        out.category_id = c;
      }
      if (b.isActive !== undefined) out.is_active = b.isActive ? 1 : 0;
      return out;
    };
    r.post('/api/market/items', { perm: 'market.catalog.manage' }, (ctx) => {
      const f = itemFields(ctx.body);
      if (get('SELECT 1 x FROM market_items WHERE name = ? COLLATE NOCASE', f.name)) throw conflict('Ein Item mit diesem Namen existiert bereits.');
      const t = now();
      const res = run('INSERT INTO market_items (name,description,category_id,unit,reference_price,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        f.name, f.description, f.category_id, f.unit, f.reference_price, f.is_active ?? 1, t, t);
      const item = loadItem(Number(res.lastInsertRowid));
      audit(ctx, { action: 'market.item_created', module: 'market', targetType: 'item', targetId: item.id, targetLabel: item.name, after: item });
      ctx.status = 201;
      return { item };
    });
    r.patch('/api/market/items/:id', { perm: 'market.catalog.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadItem(id);
      if (!cur) throw notFound('Item nicht gefunden.');
      const f = itemFields(ctx.body, true);
      if (f.name && get('SELECT 1 x FROM market_items WHERE name = ? COLLATE NOCASE AND id != ?', f.name, id)) throw conflict('Ein Item mit diesem Namen existiert bereits.');
      const cols = Object.keys(f);
      if (cols.length) run(`UPDATE market_items SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => f[c]), now(), id);
      const item = loadItem(id);
      audit(ctx, { action: 'market.item_updated', module: 'market', targetType: 'item', targetId: id, targetLabel: item.name, before: cur, after: item });
      return { item };
    });
    r.delete('/api/market/items/:id', { perm: 'market.catalog.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadItem(id);
      if (!cur) throw notFound('Item nicht gefunden.');
      const n = get('SELECT COUNT(*) c FROM market_deals WHERE item_id = ?', id).c;
      if (n > 0) throw conflict(`Das Item wird in ${n} Geschäft(en) verwendet. Deaktiviere es stattdessen.`);
      run('DELETE FROM market_items WHERE id = ?', id);
      audit(ctx, { action: 'market.item_deleted', module: 'market', targetType: 'item', targetId: id, targetLabel: cur.name, before: cur });
      return { ok: true };
    });

    // Gesuche („Wir suchen“)
    r.get('/api/market/wanted', { perm: 'market.view' }, () => ({ wanted: all(`${WANTED_SQL} ORDER BY (w.status = 'open') DESC, w.created_at DESC`).map(wantedDto) }));

    const wantedFields = (b, partial = false) => {
      const out = {};
      if (!partial || b.itemId !== undefined) {
        const it = get('SELECT id, is_active FROM market_items WHERE id = ?', b.itemId);
        if (!it || !it.is_active) throw bad('Unbekanntes oder inaktives Item.');
        out.item_id = it.id;
      }
      if (!partial || b.quantity !== undefined) out.quantity = posInt(b.quantity, 'Menge');
      if (!partial || b.unitPrice !== undefined) out.unit_price = posInt(b.unitPrice, 'Preis pro Einheit');
      if (!partial || b.note !== undefined) out.note = str(b.note, 'Hinweis', { max: 300, required: false });
      if (b.expiresAt !== undefined) {
        if (b.expiresAt === null || b.expiresAt === '') out.expires_at = null;
        else {
          const d = new Date(`${b.expiresAt}T23:59:59`);
          if (Number.isNaN(d.getTime())) throw bad('Ungültiges Ablaufdatum.');
          out.expires_at = d.toISOString();
        }
      }
      if (b.status !== undefined) {
        if (!['open', 'closed'].includes(b.status)) throw bad('Ungültiger Status.');
        out.status = b.status;
      }
      return out;
    };
    r.post('/api/market/wanted', { perm: 'market.wanted.manage' }, (ctx) => {
      const f = wantedFields(ctx.body);
      const t = now();
      const res = run('INSERT INTO market_wanted (item_id,quantity,unit_price,note,status,expires_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        f.item_id, f.quantity, f.unit_price, f.note, 'open', f.expires_at ?? null, ctx.user.id, t, t);
      const w = loadWanted(Number(res.lastInsertRowid));
      audit(ctx, { action: 'market.wanted_created', module: 'market', targetType: 'wanted', targetId: w.id, targetLabel: w.item.name, after: w });
      ctx.status = 201;
      return { wanted: w };
    });
    r.patch('/api/market/wanted/:id', { perm: 'market.wanted.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadWanted(id);
      if (!cur) throw notFound('Gesuch nicht gefunden.');
      const f = wantedFields(ctx.body, true);
      const cols = Object.keys(f);
      if (cols.length) run(`UPDATE market_wanted SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => f[c]), now(), id);
      const w = loadWanted(id);
      audit(ctx, { action: 'market.wanted_updated', module: 'market', targetType: 'wanted', targetId: id, targetLabel: w.item.name, before: cur, after: w });
      return { wanted: w };
    });
    r.delete('/api/market/wanted/:id', { perm: 'market.wanted.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadWanted(id);
      if (!cur) throw notFound('Gesuch nicht gefunden.');
      run('DELETE FROM market_wanted WHERE id = ?', id);
      audit(ctx, { action: 'market.wanted_deleted', module: 'market', targetType: 'wanted', targetId: id, targetLabel: cur.item.name, before: cur });
      return { ok: true };
    });

    // ══ Partner-Seite (nur eigene Daten) ══
    const P = { auth: 'partner', partnerApp: 'market' };
    const mine = (ctx, id) => {
      const d = get('SELECT partner_id FROM market_deals WHERE id = ?', id);
      if (!d || d.partner_id !== ctx.partner.id) throw notFound('Geschäft nicht gefunden.');
    };
    const pActor = (ctx) => ({ type: 'partner', id: ctx.partner.id, name: ctx.partner.name });

    r.get('/api/p/market/catalog', P, () => ({
      currency: getConfig('market.currency'),
      categories: lookupEntries('market.item_category', { onlyActive: true }),
      items: all(`${ITEM_SQL} WHERE i.is_active = 1 ORDER BY i.name`).map((i) => ({ ...itemDto(i), referencePrice: undefined })), // Richtpreis ist intern
    }));

    r.get('/api/p/market/wanted', P, (ctx) => {
      const rows = all(`${WANTED_SQL} WHERE w.status = 'open' AND (w.expires_at IS NULL OR w.expires_at > ?) ORDER BY w.created_at DESC`, now());
      return { wanted: rows.map((w) => ({ ...wantedDto(w), responseCount: undefined })) };
    });

    r.post('/api/p/market/offers', P, (ctx) => {
      const b = ctx.body;
      const item = get('SELECT id, is_active FROM market_items WHERE id = ?', b.itemId);
      if (!item || !item.is_active) throw bad('Dieses Item kann nicht angeboten werden.');
      const id = createDeal({
        origin: 'offer', partnerId: ctx.partner.id, itemId: item.id, quantity: posInt(b.quantity, 'Menge'),
        unitPrice: posInt(b.unitPrice, 'Preis pro Einheit'), note: str(b.note, 'Hinweis', { max: 500, required: false }), actor: pActor(ctx),
      });
      audit(ctx, { action: 'market.deal_created', module: 'market', targetType: 'deal', targetId: id, targetLabel: loadDeal(id).item.name });
      ctx.status = 201;
      return { deal: loadDeal(id, true) };
    });

    r.post('/api/p/market/wanted/:id/respond', P, (ctx) => {
      const w = get('SELECT * FROM market_wanted WHERE id = ?', Number(ctx.params.id));
      if (!w || !isLive(w)) throw notFound('Dieses Gesuch ist nicht mehr offen.');
      const quantity = posInt(ctx.body.quantity, 'Menge', { max: w.quantity });
      const unitPrice = ctx.body.unitPrice == null ? w.unit_price : posInt(ctx.body.unitPrice, 'Preis pro Einheit');
      const id = createDeal({
        origin: 'wanted', partnerId: ctx.partner.id, itemId: w.item_id, wantedId: w.id, quantity, unitPrice,
        note: str(ctx.body.note, 'Hinweis', { max: 500, required: false }), actor: pActor(ctx),
      });
      audit(ctx, { action: 'market.deal_created', module: 'market', targetType: 'deal', targetId: id, targetLabel: loadDeal(id).item.name });
      ctx.status = 201;
      return { deal: loadDeal(id, true) };
    });

    r.get('/api/p/market/deals', P, (ctx) => ({
      deals: all(`${DEAL_SQL} WHERE d.partner_id = ? ORDER BY d.updated_at DESC`, ctx.partner.id).map((d) => dealDto(d, true)),
    }));

    r.get('/api/p/market/deals/:id', P, (ctx) => {
      const id = Number(ctx.params.id);
      mine(ctx, id);
      return { deal: loadDeal(id, true), events: eventsOf(id, true) };
    });

    r.post('/api/p/market/deals/:id/:action', P, (ctx) => {
      const id = Number(ctx.params.id);
      mine(ctx, id);
      if (!PARTNER_ACTIONS.includes(ctx.params.action)) throw forbidden();
      const before = loadDeal(id, true);
      const action = applyAction(id, pActor(ctx), ctx.params.action, { ...ctx.body, internal: false });
      const deal = loadDeal(id, true);
      audit(ctx, { action: `market.deal_${action}`, module: 'market', targetType: 'deal', targetId: id, targetLabel: deal.item.name,
        before: { status: before.status, quantity: before.quantity, unitPrice: before.unitPrice }, after: { status: deal.status, quantity: deal.quantity, unitPrice: deal.unitPrice } });
      return { deal, events: eventsOf(id, true) };
    });
  },
};
