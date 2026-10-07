import { all, get, run, tx, now, DB_PATH } from '../core/db.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bad, conflict, forbidden, notFound, str, intList, HttpError } from '../core/http.js';
import { audit } from '../core/audit.js';
import { rateLimit } from '../core/auth.js';
import { getConfig } from '../core/config.js';
import { allocateNumber } from '../core/numbers.js';
import { labelForUser } from '../core/identity.js';
import { loadAccess, permissionExists } from '../core/permissions.js';
import { notify, staffWith } from '../core/notifications.js';
import { expectTabEntry, cancelTabEntry, settleTabPeriod } from '../core/ledger.js';
import { periodKey, periodInfo, recentPeriods } from '../core/periods.js';
import { registerWidget } from './dashboard.js';
import { openStream } from '../core/realtime.js';

/**
 * Deckel-System: Firmen als Geschäftskunden, auf die Mitarbeiter „auf Deckel schreiben“ (jede Buchung mit Personalnummer).
 * Buchungen werden automatisch dem Abrechnungszeitraum der Firma (Woche/Monat) zugeordnet, summiert und im Finanz-Journal vorgemerkt.
 * Die Firma übermittelt über ihren persönlichen Link den fälligen Betrag; das Team gleicht ihn mit den eigenen Buchungen ab,
 * bestätigt, wickelt die Zahlung ab (Überweisung oder Rechnung) und archiviert. Buchungen werden nie gelöscht – nur storniert/korrigiert.
 * Anonymität: Mitglieder erscheinen ausschließlich als Personalnummer; Firmen sehen nie Buchungen oder Mitglieder, nur ihre eigenen Abrechnungen.
 */
const STATUS = {
  submitted: { label: 'Eingereicht', color: '#fbbf24' }, review: { label: 'In Prüfung', color: '#60a5fa' }, confirmed: { label: 'Bestätigt', color: '#34d399' },
  payment_pending: { label: 'Zahlung ausstehend', color: '#fb923c' }, paid: { label: 'Bezahlt', color: '#22c55e' }, rejected: { label: 'Abgelehnt', color: '#f87171' },
};
const LOCKING = ['confirmed', 'payment_pending', 'paid']; // ab hier sind Buchungen des Zeitraums gesperrt
const INTERVALS = { weekly: 'Wöchentlich', monthly: 'Monatlich' };
const CENTS_MAX = 100_000_000_00;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const invDir = () => join(dirname(DB_PATH), 'tab-invoices');

const cents = (v, name, { min = 1 } = {}) => {
  if (!Number.isInteger(v) || v < min || v > CENTS_MAX) throw bad(`${name}: gültiger Betrag erforderlich.`);
  return v;
};
const currency = () => getConfig('market.currency') ?? '$';

// ── Firmen ──
const newToken = () => randomBytes(24).toString('base64url');
const portalPath = (t) => `/deckel/firma/${t}`;

function openAmount(companyId) {
  return get(`SELECT COALESCE(SUM(e.amount_cents),0) s FROM tab_entries e WHERE e.company_id = ? AND e.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM tab_statements s WHERE s.company_id = e.company_id AND s.period_key = e.period_key AND s.status = 'paid')`, companyId).s;
}
const turnover = (companyId) => get("SELECT COALESCE(SUM(amount_cents),0) s FROM tab_entries WHERE company_id = ? AND status = 'active'", companyId).s;

function companyDto(c, user, { detail = false } = {}) {
  const manage = user.perms.has('tab.manage_companies');
  const out = {
    id: c.id, number: c.company_number, name: c.name, contactName: c.contact_name, contactInfo: c.contact_info, interval: c.billing_interval, intervalLabel: INTERVALS[c.billing_interval],
    scope: c.scope, scopePerm: c.scope_perm, creditLimitCents: c.credit_limit_cents, status: c.status, notes: c.notes,
    openCents: openAmount(c.id), turnoverCents: turnover(c.id), createdAt: c.created_at,
    linkPath: manage ? portalPath(c.link_token) : undefined,
  };
  if (detail) {
    out.members = all('SELECT user_id FROM tab_company_members WHERE company_id = ?', c.id).map((m) => ({ id: m.user_id, label: labelForUser(m.user_id, user.id) }));
  }
  return out;
}
const loadCompany = (id) => get('SELECT * FROM tab_companies WHERE id = ?', id);

/** Darf das Mitglied (Personalnummer-Inhaber) auf den Deckel dieser Firma schreiben? */
function eligible(company, userId) {
  if (company.status !== 'active') return { ok: false, reason: 'Die Firma ist deaktiviert.' };
  if (company.scope === 'all') return { ok: true };
  if (company.scope === 'selected') return get('SELECT 1 x FROM tab_company_members WHERE company_id = ? AND user_id = ?', company.id, userId) ? { ok: true } : { ok: false, reason: 'Dieses Mitglied ist für den Deckel dieser Firma nicht freigegeben.' };
  return loadAccess(userId).perms.has(company.scope_perm) ? { ok: true } : { ok: false, reason: 'Diesem Mitglied fehlt die nötige Berechtigung für den Deckel dieser Firma.' };
}

function companyFields(b, partial) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) out.name = str(b.name, 'Firmenname', { min: 2, max: 80 });
  if (b.contactName !== undefined || !partial) out.contact_name = str(b.contactName, 'Ansprechpartner', { max: 80, required: false });
  if (b.contactInfo !== undefined || !partial) out.contact_info = str(b.contactInfo, 'Kontakt', { max: 300, required: false });
  if (has('interval')) { if (!INTERVALS[b.interval]) throw bad('Abrechnungsintervall: wöchentlich oder monatlich.'); out.billing_interval = b.interval; }
  if (b.scope !== undefined) {
    if (!['all', 'selected', 'perm'].includes(b.scope)) throw bad('Ungültiger Geltungsbereich.');
    out.scope = b.scope;
    if (b.scope === 'perm') {
      if (typeof b.scopePerm !== 'string' || !permissionExists(b.scopePerm)) throw bad('Bitte eine gültige Berechtigung für die Mitarbeitergruppe wählen.');
      out.scope_perm = b.scopePerm;
    } else out.scope_perm = null;
  }
  if (b.creditLimitCents !== undefined) out.credit_limit_cents = b.creditLimitCents == null || b.creditLimitCents === '' ? null : cents(b.creditLimitCents, 'Limit', { min: 0 });
  if (b.status !== undefined) { if (!['active', 'disabled'].includes(b.status)) throw bad('Ungültiger Status.'); out.status = b.status; }
  if (b.notes !== undefined) out.notes = str(b.notes, 'Notizen', { max: 1000, required: false });
  return out;
}
function setMembers(companyId, ids) {
  run('DELETE FROM tab_company_members WHERE company_id = ?', companyId);
  for (const id of ids) { if (!get("SELECT 1 x FROM users WHERE id = ? AND status = 'active'", id)) throw bad('Unbekanntes Mitglied.'); run('INSERT INTO tab_company_members (company_id,user_id) VALUES (?,?)', companyId, id); }
}

// ── Buchungen ──
const ENTRY_SQL = `SELECT e.*, c.name company_name, c.company_number, c.billing_interval FROM tab_entries e JOIN tab_companies c ON c.id = e.company_id`;
const entryDto = (e, viewer) => ({
  id: e.id, number: e.entry_number, company: { id: e.company_id, name: e.company_name, number: e.company_number }, memberNumber: e.member_number,
  amountCents: e.amount_cents, description: e.description, period: periodInfo(e.period_key), status: e.status, correctsId: e.corrects_id,
  creator: e.created_by ? labelForUser(e.created_by, viewer.id) : 'System', createdAt: e.created_at, cancelledAt: e.cancelled_at, cancelReason: e.cancel_reason,
  mine: e.created_by === viewer.id || e.member_user_id === viewer.id,
});
const periodLocked = (companyId, key) => !!get(`SELECT 1 x FROM tab_statements WHERE company_id = ? AND period_key = ? AND status IN (${LOCKING.map(() => '?').join(',')})`, companyId, key, ...LOCKING);

function createEntry({ company, memberUser, amount, description, creatorId, period, correctsId = null }) {
  const key = period ?? periodKey(new Date(), company.billing_interval);
  if (periodLocked(company.id, key)) throw conflict(`Der Zeitraum ${periodInfo(key).label} ist bereits bestätigt/abgerechnet – Buchungen sind gesperrt.`);
  if (company.credit_limit_cents != null && openAmount(company.id) + amount > company.credit_limit_cents) throw conflict('Das Limit dieser Firma wäre überschritten.');
  const number = allocateNumber('tab_entry', 'tab.entry_prefix', 'tab.entry_start');
  const t = now();
  const res = run(`INSERT INTO tab_entries (entry_number,company_id,member_user_id,member_number,amount_cents,description,period_key,status,corrects_id,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,'active',?,?,?)`, number, company.id, memberUser.id, memberUser.member_number, amount, description, key, correctsId, creatorId, t);
  const id = Number(res.lastInsertRowid);
  const row = get('SELECT * FROM tab_entries WHERE id = ?', id);
  expectTabEntry(row, company.name); // Finanzvorgang eindeutig zugeordnet
  return row;
}

// ── Abrechnungen ──
const STMT_SQL = `SELECT s.*, c.name company_name, c.company_number, c.billing_interval FROM tab_statements s JOIN tab_companies c ON c.id = s.company_id`;
const ourSum = (companyId, key) => get("SELECT COALESCE(SUM(amount_cents),0) s FROM tab_entries WHERE company_id = ? AND period_key = ? AND status = 'active'", companyId, key).s;
function statementDto(s, viewer) {
  const our = s.status === 'paid' ? s.our_cents : ourSum(s.company_id, s.period_key);
  const diff = s.submitted_cents - our;
  return {
    id: s.id, number: s.statement_number, company: { id: s.company_id, name: s.company_name, number: s.company_number, interval: s.billing_interval }, period: periodInfo(s.period_key),
    submittedCents: s.submitted_cents, ourCents: our, diffCents: diff, matches: diff === 0, approvedCents: s.approved_cents, comment: s.comment, status: s.status, statusLabel: STATUS[s.status].label, statusColor: STATUS[s.status].color,
    diffNote: s.diff_note, rejectReason: s.reject_reason, payMethod: s.pay_method, paidAt: s.paid_at, payReference: s.pay_reference,
    invoice: { received: !!s.invoice_received, number: s.invoice_number, amountCents: s.invoice_amount_cents, date: s.invoice_date, hasFile: !!s.invoice_file_ext },
    submittedAt: s.submitted_at, updatedAt: s.updated_at, entryCount: get("SELECT COUNT(*) c FROM tab_entries WHERE company_id = ? AND period_key = ? AND status = 'active'", s.company_id, s.period_key).c,
    reviewer: s.reviewed_by ? labelForUser(s.reviewed_by, viewer?.id ?? null) : null,
  };
}
const slog = (id, text, { userId = null, company = false } = {}) => run('INSERT INTO tab_statement_log (statement_id,ts,user_id,by_company,text) VALUES (?,?,?,?,?)', id, now(), userId, company ? 1 : 0, text);
const fmtC = (c) => `${(c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency()}`;

const PDF = Buffer.from('%PDF-');
function decodeFile(dataUrl) {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw bad('Ungültige Datei.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 8 || buf.length > 5 * 1024 * 1024) throw bad('Die Datei ist leer oder größer als 5 MB.');
  if (buf.subarray(0, 5).equals(PDF)) return { buf, ext: 'pdf' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { buf, ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { buf, ext: 'jpg' };
  throw bad('Erlaubt sind PDF, PNG und JPEG.');
}
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg' };

registerWidget({
  id: 'tab-overview', title: 'Deckel', size: 'medium', permission: 'tab.view',
  data: () => summary(),
});

function summary() {
  const by = Object.fromEntries(all('SELECT status, COUNT(*) c FROM tab_statements GROUP BY status').map((r) => [r.status, r.c]));
  const companies = all("SELECT * FROM tab_companies WHERE status = 'active'");
  let pendingPeriods = 0, openCompanies = 0;
  for (const c of companies) {
    if (openAmount(c.id) > 0) openCompanies++;
    const cur = periodKey(new Date(), c.billing_interval);
    const keys = all("SELECT DISTINCT period_key k FROM tab_entries WHERE company_id = ? AND status = 'active' AND period_key < ?", c.id, cur).map((r) => r.k);
    for (const k of keys) if (!get("SELECT 1 x FROM tab_statements WHERE company_id = ? AND period_key = ? AND status != 'rejected'", c.id, k)) pendingPeriods++;
  }
  const recent = all(`${STMT_SQL} ORDER BY s.id DESC LIMIT 8`).map((s) => ({ id: s.id, company: s.company_name, interval: INTERVALS[s.billing_interval], period: periodInfo(s.period_key)?.label, submittedCents: s.submitted_cents, status: s.status, statusLabel: STATUS[s.status].label, statusColor: STATUS[s.status].color }));
  return {
    currency: currency(), companies: companies.length, openCompanies, pendingPeriods,
    submitted: by.submitted ?? 0, review: by.review ?? 0, confirmed: by.confirmed ?? 0, paymentPending: by.payment_pending ?? 0, paid: by.paid ?? 0, rejected: by.rejected ?? 0,
    openCents: companies.reduce((a, c) => a + openAmount(c.id), 0), recent,
  };
}

export default {
  name: 'tab',
  permissions: [
    ['tab.book', 'Deckel: auf Deckel schreiben und eigene Buchungen ansehen'],
    ['tab.book_others', 'Deckel: mit fremder Personalnummer buchen (z. B. Kasse)'],
    ['tab.view', 'Deckel: alle Buchungen, Firmen und Abrechnungen ansehen'],
    ['tab.cancel', 'Deckel: Buchungen stornieren und korrigieren'],
    ['tab.manage_companies', 'Deckel: Firmen anlegen/bearbeiten und Portal-Links verwalten'],
    ['tab.statements', 'Deckel: Abrechnungen prüfen, bestätigen und Zahlungen abwickeln (Finanz)'],
  ],
  config: [
    { key: 'tab.entry_prefix', group: 'Deckel', label: 'Präfix der Buchungsnummer', type: 'string', default: 'AZ-D-', max: 12 },
    { key: 'tab.entry_start', group: 'Deckel', label: 'Startnummer der Buchungen', type: 'number', default: 100001, min: 1, max: 99999999 },
    { key: 'tab.statement_prefix', group: 'Deckel', label: 'Präfix der Abrechnungsnummer', type: 'string', default: 'AZ-DA-', max: 12 },
    { key: 'tab.statement_start', group: 'Deckel', label: 'Startnummer der Abrechnungen', type: 'number', default: 1001, min: 1, max: 99999999 },
    { key: 'tab.company_prefix', group: 'Deckel', label: 'Präfix der Firmennummer', type: 'string', default: 'AZ-F-', max: 12 },
    { key: 'tab.company_start', group: 'Deckel', label: 'Startnummer der Firmen', type: 'number', default: 1001, min: 1, max: 99999999 },
    { key: 'tab.allow_current_period', group: 'Deckel', label: 'Firmen dürfen den laufenden Zeitraum schon abrechnen', help: 'Standard: nur abgeschlossene Wochen/Monate.', type: 'bool', default: false },
  ],
  routes(r) {
    // ══ Mitarbeiter ══
    r.get('/api/tab/options', { perm: ['tab.book', 'tab.view', 'tab.statements', 'tab.manage_companies'] }, (ctx) => {
      const u = ctx.user;
      const companies = all("SELECT * FROM tab_companies WHERE status = 'active' ORDER BY name").filter((c) => u.perms.has('tab.book_others') || eligible(c, u.id).ok);
      return {
        currency: currency(), ownNumber: u.memberNumber, canBook: u.perms.has('tab.book'), canBookOthers: u.perms.has('tab.book_others'), canView: u.perms.has('tab.view'),
        canCancel: u.perms.has('tab.cancel'), canCompanies: u.perms.has('tab.manage_companies'), canStatements: u.perms.has('tab.statements'),
        companies: companies.map((c) => ({ id: c.id, name: c.name, number: c.company_number, interval: c.billing_interval, intervalLabel: INTERVALS[c.billing_interval] })),
        members: u.perms.has('tab.manage_companies') ? all("SELECT id FROM users WHERE status = 'active' ORDER BY member_number").map((m) => ({ id: m.id, label: labelForUser(m.id, u.id) })) : [],
        permissions: u.perms.has('tab.manage_companies') ? all('SELECT key, description FROM permissions ORDER BY key') : [],
        statuses: Object.entries(STATUS).map(([key, v]) => ({ key, ...v })),
      };
    });

    /** Personalnummer eingeben → Mitglied erkennen (nur als Nummer – Namen werden nie ausgeliefert). */
    r.get('/api/tab/member', { perm: 'tab.book' }, (ctx) => {
      const number = String(ctx.query.number ?? '').trim();
      if (!number) throw bad('Bitte eine Personalnummer eingeben.');
      const u = get("SELECT id, member_number FROM users WHERE status = 'active' AND UPPER(member_number) = UPPER(?)", number);
      if (!u) return { found: false, reason: 'Diese Personalnummer existiert nicht oder ist nicht aktiv.' };
      const own = u.id === ctx.user.id;
      if (!own && !ctx.user.perms.has('tab.book_others')) return { found: true, number: u.member_number, allowed: false, reason: 'Du darfst nur mit deiner eigenen Personalnummer buchen.' };
      const company = ctx.query.companyId ? loadCompany(Number(ctx.query.companyId)) : null;
      const el = company ? eligible(company, u.id) : { ok: true };
      return { found: true, number: u.member_number, own, allowed: el.ok, reason: el.ok ? null : el.reason };
    });

    r.get('/api/tab/entries', { perm: ['tab.book', 'tab.view'] }, (ctx) => {
      const where = [], p = [];
      const all_ = ctx.user.perms.has('tab.view');
      if (!all_ || ctx.query.mine === '1') { where.push('(e.created_by = ? OR e.member_user_id = ?)'); p.push(ctx.user.id, ctx.user.id); }
      const { company, period, status, q } = ctx.query;
      if (company) { where.push('e.company_id = ?'); p.push(Number(company)); }
      if (period) { where.push('e.period_key = ?'); p.push(period); }
      if (['active', 'cancelled'].includes(status)) { where.push('e.status = ?'); p.push(status); }
      if (q) { where.push('(e.member_number LIKE ? OR e.description LIKE ? OR e.entry_number LIKE ? OR c.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
      const rows = all(`${ENTRY_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC LIMIT ?`, ...p, Math.min(Math.max(parseInt(ctx.query.limit) || 200, 1), 1000));
      return { entries: rows.map((e) => entryDto(e, ctx.user)), totalCents: rows.filter((e) => e.status === 'active').reduce((a, e) => a + e.amount_cents, 0) };
    });

    r.post('/api/tab/entries', { perm: 'tab.book' }, (ctx) => {
      const b = ctx.body;
      const company = loadCompany(b.companyId);
      if (!company) throw bad('Bitte eine Firma wählen.');
      const number = String(b.memberNumber ?? '').trim();
      if (!number) throw bad('Die Personalnummer ist bei jeder Deckelbuchung Pflicht.');
      const member = get("SELECT id, member_number FROM users WHERE status = 'active' AND UPPER(member_number) = UPPER(?)", number);
      if (!member) throw bad('Diese Personalnummer existiert nicht oder ist nicht aktiv.');
      if (member.id !== ctx.user.id && !ctx.user.perms.has('tab.book_others')) throw forbidden('Du darfst nur mit deiner eigenen Personalnummer auf Deckel schreiben.');
      const el = eligible(company, member.id);
      if (!el.ok) throw forbidden(el.reason);
      const amount = cents(b.amountCents, 'Betrag');
      const description = str(b.description, 'Verwendungszweck', { min: 2, max: 200 });
      const row = tx(() => createEntry({ company, memberUser: member, amount, description, creatorId: ctx.user.id }));
      audit(ctx, { action: 'tab.entry_created', module: 'tab', targetType: 'tab_entry', targetId: row.id, targetLabel: `${row.entry_number} · ${company.name}`, after: { personalnummer: member.member_number, amount: fmtC(amount), period: row.period_key } });
      ctx.status = 201;
      return { entry: entryDto(get(`${ENTRY_SQL} WHERE e.id = ?`, row.id), ctx.user) };
    });

    const cancelEntry = (ctx, e, reason) => {
      if (e.status !== 'active') throw conflict('Die Buchung ist bereits storniert.');
      if (periodLocked(e.company_id, e.period_key)) throw conflict('Der Zeitraum ist bestätigt/abgerechnet – die Buchung ist gesperrt.');
      run("UPDATE tab_entries SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?", now(), ctx.user.id, reason, e.id);
      cancelTabEntry(e.id);
    };
    r.post('/api/tab/entries/:id/cancel', { perm: 'tab.cancel' }, (ctx) => {
      const e = get(`${ENTRY_SQL} WHERE e.id = ?`, Number(ctx.params.id));
      if (!e) throw notFound('Buchung nicht gefunden.');
      const reason = str(ctx.body.reason, 'Begründung', { min: 3, max: 200 });
      tx(() => cancelEntry(ctx, e, reason));
      audit(ctx, { action: 'tab.entry_cancelled', module: 'tab', targetType: 'tab_entry', targetId: e.id, targetLabel: `${e.entry_number} · ${e.company_name}`, before: { amount: fmtC(e.amount_cents) }, after: { reason } });
      return { entry: entryDto(get(`${ENTRY_SQL} WHERE e.id = ?`, e.id), ctx.user) };
    });
    /** Korrektur = Storno der alten Buchung + neue Buchung (verknüpft). Nichts wird überschrieben. */
    r.post('/api/tab/entries/:id/correct', { perm: 'tab.cancel' }, (ctx) => {
      const e = get(`${ENTRY_SQL} WHERE e.id = ?`, Number(ctx.params.id));
      if (!e) throw notFound('Buchung nicht gefunden.');
      const amount = cents(ctx.body.amountCents, 'Betrag');
      const description = str(ctx.body.description ?? e.description, 'Verwendungszweck', { min: 2, max: 200 });
      const reason = str(ctx.body.reason, 'Begründung', { min: 3, max: 200 });
      const company = loadCompany(e.company_id);
      const member = get('SELECT id, member_number FROM users WHERE id = ?', e.member_user_id) ?? { id: null, member_number: e.member_number };
      const row = tx(() => { cancelEntry(ctx, e, `Korrigiert: ${reason}`); return createEntry({ company, memberUser: member, amount, description, creatorId: ctx.user.id, period: e.period_key, correctsId: e.id }); });
      audit(ctx, { action: 'tab.entry_corrected', module: 'tab', targetType: 'tab_entry', targetId: row.id, targetLabel: `${row.entry_number} ersetzt ${e.entry_number}`, before: { amount: fmtC(e.amount_cents) }, after: { amount: fmtC(amount), reason } });
      ctx.status = 201;
      return { entry: entryDto(get(`${ENTRY_SQL} WHERE e.id = ?`, row.id), ctx.user) };
    });

    // ── Firmen ──
    r.get('/api/tab/companies', { perm: ['tab.view', 'tab.manage_companies', 'tab.statements'] }, (ctx) => ({
      companies: all('SELECT * FROM tab_companies ORDER BY status, name').map((c) => companyDto(c, ctx.user)),
    }));
    r.get('/api/tab/companies/:id', { perm: ['tab.view', 'tab.manage_companies', 'tab.statements'] }, (ctx) => {
      const c = loadCompany(Number(ctx.params.id));
      if (!c) throw notFound('Firma nicht gefunden.');
      const statements = all(`${STMT_SQL} WHERE s.company_id = ? ORDER BY s.submitted_at DESC`, c.id).map((s) => statementDto(s, ctx.user));
      const periods = all("SELECT period_key k, COUNT(*) n, SUM(amount_cents) s FROM tab_entries WHERE company_id = ? AND status = 'active' GROUP BY period_key ORDER BY period_key DESC", c.id)
        .map((p) => ({ period: periodInfo(p.k), count: p.n, totalCents: p.s, statement: statements.find((s) => s.period.key === p.k && s.status !== 'rejected')?.status ?? null }));
      return { company: companyDto(c, ctx.user, { detail: true }), statements, periods };
    });
    r.post('/api/tab/companies', { perm: 'tab.manage_companies' }, (ctx) => {
      const f = companyFields(ctx.body, false);
      if (get('SELECT 1 x FROM tab_companies WHERE name = ?', f.name)) throw conflict('Eine Firma mit diesem Namen existiert bereits.');
      const id = tx(() => {
        const t = now();
        const cols = { company_number: allocateNumber('tab_company', 'tab.company_prefix', 'tab.company_start'), scope: 'all', status: 'active', ...f, link_token: newToken(), created_by: ctx.user.id, created_at: t, updated_at: t };
        const res = run(`INSERT INTO tab_companies (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols));
        if (ctx.body.memberIds !== undefined) setMembers(Number(res.lastInsertRowid), intList(ctx.body.memberIds, 'Mitglieder'));
        return Number(res.lastInsertRowid);
      });
      const c = loadCompany(id);
      audit(ctx, { action: 'tab.company_created', module: 'tab', targetType: 'tab_company', targetId: id, targetLabel: `${c.company_number} · ${c.name}`, after: { interval: c.billing_interval, scope: c.scope } });
      ctx.status = 201;
      return { company: companyDto(c, ctx.user, { detail: true }) };
    });
    r.patch('/api/tab/companies/:id', { perm: 'tab.manage_companies' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadCompany(id);
      if (!cur) throw notFound('Firma nicht gefunden.');
      const f = companyFields(ctx.body, true);
      if (f.name && get('SELECT 1 x FROM tab_companies WHERE name = ? AND id != ?', f.name, id)) throw conflict('Eine Firma mit diesem Namen existiert bereits.');
      if (f.billing_interval && f.billing_interval !== cur.billing_interval && get('SELECT 1 x FROM tab_entries WHERE company_id = ?', id)) throw conflict('Das Abrechnungsintervall lässt sich nach der ersten Buchung nicht mehr ändern (bestehende Zeiträume würden sonst nicht mehr passen).');
      tx(() => {
        const cols = Object.keys(f);
        if (cols.length) run(`UPDATE tab_companies SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => f[c]), now(), id);
        if (ctx.body.memberIds !== undefined) setMembers(id, intList(ctx.body.memberIds, 'Mitglieder'));
      });
      const c = loadCompany(id);
      audit(ctx, { action: 'tab.company_updated', module: 'tab', targetType: 'tab_company', targetId: id, targetLabel: `${c.company_number} · ${c.name}`, before: { status: cur.status, interval: cur.billing_interval, scope: cur.scope }, after: { status: c.status, interval: c.billing_interval, scope: c.scope } });
      return { company: companyDto(c, ctx.user, { detail: true }) };
    });
    r.post('/api/tab/companies/:id/reset-link', { perm: 'tab.manage_companies' }, (ctx) => {
      const id = Number(ctx.params.id);
      const c = loadCompany(id);
      if (!c) throw notFound('Firma nicht gefunden.');
      run('UPDATE tab_companies SET link_token = ?, updated_at = ? WHERE id = ?', newToken(), now(), id);
      audit(ctx, { action: 'tab.company_link_reset', module: 'tab', targetType: 'tab_company', targetId: id, targetLabel: `${c.company_number} · ${c.name}` });
      return { company: companyDto(loadCompany(id), ctx.user, { detail: true }) };
    });

    // ── Abrechnungen ──
    r.get('/api/tab/summary', { perm: ['tab.view', 'tab.statements'] }, () => ({ summary: summary() }));
    r.get('/api/tab/statements', { perm: ['tab.view', 'tab.statements'] }, (ctx) => {
      const where = [], p = [];
      if (STATUS[ctx.query.status]) { where.push('s.status = ?'); p.push(ctx.query.status); }
      if (ctx.query.company) { where.push('s.company_id = ?'); p.push(Number(ctx.query.company)); }
      const rows = all(`${STMT_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (s.status IN ('submitted','review','confirmed','payment_pending')) DESC, s.submitted_at DESC LIMIT 300`, ...p);
      return { statements: rows.map((s) => statementDto(s, ctx.user)) };
    });
    r.get('/api/tab/statements/:id', { perm: ['tab.view', 'tab.statements'] }, (ctx) => {
      const s = get(`${STMT_SQL} WHERE s.id = ?`, Number(ctx.params.id));
      if (!s) throw notFound('Abrechnung nicht gefunden.');
      const entries = all(`${ENTRY_SQL} WHERE e.company_id = ? AND e.period_key = ? ORDER BY e.id`, s.company_id, s.period_key).map((e) => entryDto(e, ctx.user));
      const byMember = Object.values(entries.filter((e) => e.status === 'active').reduce((m, e) => { (m[e.memberNumber] ??= { memberNumber: e.memberNumber, count: 0, totalCents: 0 }); m[e.memberNumber].count++; m[e.memberNumber].totalCents += e.amountCents; return m; }, {}));
      const log = all('SELECT * FROM tab_statement_log WHERE statement_id = ? ORDER BY id', s.id).map((l) => ({ id: l.id, ts: l.ts, actor: l.by_company ? `Firma ${s.company_name}` : l.user_id ? labelForUser(l.user_id, ctx.user.id) : 'System', text: l.text }));
      return { statement: statementDto(s, ctx.user), entries, byMember, log, canManage: ctx.user.perms.has('tab.statements') };
    });

    r.post('/api/tab/statements/:id/invoice-file', { perm: 'tab.statements', bodyLimit: 8 * 1024 * 1024 }, (ctx) => {
      const id = Number(ctx.params.id);
      const s = get('SELECT * FROM tab_statements WHERE id = ?', id);
      if (!s) throw notFound('Abrechnung nicht gefunden.');
      const { buf, ext } = decodeFile(ctx.body.data);
      mkdirSync(invDir(), { recursive: true });
      writeFileSync(join(invDir(), `${id}.${ext}`), buf);
      run('UPDATE tab_statements SET invoice_file_ext = ?, updated_at = ? WHERE id = ?', ext, now(), id);
      slog(id, 'Rechnungsdatei hochgeladen', { userId: ctx.user.id });
      audit(ctx, { action: 'tab.statement_invoice_file', module: 'tab', targetType: 'tab_statement', targetId: id, targetLabel: s.statement_number });
      return { ok: true };
    });
    r.post('/api/tab/statements/:id/:action', { perm: 'tab.statements' }, (ctx) => {
      const id = Number(ctx.params.id);
      const s = get(`${STMT_SQL} WHERE s.id = ?`, id);
      if (!s) throw notFound('Abrechnung nicht gefunden.');
      const b = ctx.body, action = ctx.params.action;
      const our = ourSum(s.company_id, s.period_key);
      const touch = (fields) => { const cols = Object.keys(fields); run(`UPDATE tab_statements SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => fields[c]), now(), id); };
      const need = (...ok) => { if (!ok.includes(s.status)) throw conflict(`Das geht im Status „${STATUS[s.status].label}“ nicht.`); };
      let text;
      tx(() => {
        switch (action) {
          case 'review': need('submitted'); touch({ status: 'review', reviewed_by: ctx.user.id }); text = 'Prüfung gestartet'; break;
          case 'confirm': {
            need('submitted', 'review');
            const diff = s.submitted_cents - our;
            const note = str(b.note, 'Notiz', { max: 300, required: false });
            let approved = our;
            if (diff !== 0) {
              if (b.acceptDifference !== true) throw conflict(`Abweichung von ${fmtC(Math.abs(diff))}: Die Abrechnung muss geprüft werden. Bestätige nur mit ausdrücklicher Freigabe der Differenz und einer Notiz.`);
              if (!note) throw bad('Bitte begründe die akzeptierte Abweichung in einer Notiz.');
              approved = b.approvedCents === undefined ? our : cents(b.approvedCents, 'Freigegebener Betrag', { min: 0 });
            }
            touch({ status: 'confirmed', approved_cents: approved, our_cents: our, diff_note: note, reviewed_by: ctx.user.id });
            text = diff === 0 ? `Bestätigt: ${fmtC(approved)} stimmen mit den Buchungen überein` : `Bestätigt trotz Abweichung (${fmtC(diff)}); freigegeben: ${fmtC(approved)} – ${note}`;
            break;
          }
          case 'reject': need('submitted', 'review', 'confirmed', 'payment_pending'); touch({ status: 'rejected', reject_reason: str(b.reason, 'Begründung', { min: 3, max: 300 }), reviewed_by: ctx.user.id }); text = `Abgelehnt: ${b.reason}`; break;
          case 'prepare': {
            need('confirmed', 'payment_pending');
            if (!['transfer', 'invoice'].includes(b.method)) throw bad('Zahlungsart: Überweisung oder Rechnung.');
            touch({ status: 'payment_pending', pay_method: b.method }); text = `Zahlung vorbereitet (${b.method === 'transfer' ? 'Überweisung an die Firma' : 'Rechnung der Firma'})`; break;
          }
          case 'invoice': {
            need('confirmed', 'payment_pending');
            const f = {};
            if (b.received !== undefined) f.invoice_received = b.received ? 1 : 0;
            if (b.number !== undefined) f.invoice_number = str(b.number, 'Rechnungsnummer', { max: 60, required: false });
            if (b.amountCents !== undefined) f.invoice_amount_cents = b.amountCents == null || b.amountCents === '' ? null : cents(b.amountCents, 'Rechnungsbetrag', { min: 0 });
            if (b.date !== undefined) { if (b.date && !DATE_RE.test(b.date)) throw bad('Ungültiges Rechnungsdatum.'); f.invoice_date = b.date || null; }
            if (Object.keys(f).length) touch(f);
            text = 'Rechnungsdaten aktualisiert'; break;
          }
          case 'pay': {
            need('payment_pending');
            const method = s.pay_method;
            if (method === 'transfer') {
              const date = b.paidAt || now().slice(0, 10);
              if (!DATE_RE.test(date)) throw bad('Ungültiges Zahlungsdatum.');
              touch({ status: 'paid', paid_at: new Date(`${date}T12:00:00`).toISOString(), pay_reference: str(b.reference, 'Transaktions-/Buchungsnummer', { max: 80, required: false }), paid_by: ctx.user.id, our_cents: our });
              text = `Überweisung über ${fmtC(s.approved_cents)} am ${date} durchgeführt${b.reference ? ` (Ref. ${b.reference})` : ''}`;
            } else {
              if (!s.invoice_received) throw conflict('Bitte zuerst „Rechnung erhalten“ mit Rechnungsnummer erfassen.');
              if (!s.invoice_number) throw bad('Die Rechnungsnummer fehlt.');
              if (s.invoice_amount_cents !== s.approved_cents && b.acceptDifference !== true) throw conflict(`Rechnungsbetrag (${fmtC(s.invoice_amount_cents ?? 0)}) weicht vom freigegebenen Betrag (${fmtC(s.approved_cents)}) ab. Bitte prüfen oder die Differenz ausdrücklich freigeben.`);
              touch({ status: 'paid', paid_at: now(), paid_by: ctx.user.id, our_cents: our });
              text = `Rechnung ${s.invoice_number} über ${fmtC(s.invoice_amount_cents ?? s.approved_cents)} beglichen`;
            }
            settleTabPeriod(s.company_id, s.period_key);
            break;
          }
          case 'note': text = `Notiz: ${str(b.text, 'Notiz', { min: 1, max: 300 })}`; touch({}); break;
          default: throw bad('Unbekannte Aktion.');
        }
        slog(id, text, { userId: ctx.user.id });
        if (action === 'confirm') notify(staffWith('tab.statements', ctx.user.id), { key: `tab:${id}:confirm`, title: 'Zahlung abwickeln', body: `${s.company_name} · ${periodInfo(s.period_key).label}: ${fmtC(get('SELECT approved_cents a FROM tab_statements WHERE id = ?', id).a)} bestätigt – bitte Zahlung vorbereiten.`, target: { app: 'tab', statementId: id } });
      });
      audit(ctx, { action: `tab.statement_${action}`, module: 'tab', targetType: 'tab_statement', targetId: id, targetLabel: `${s.statement_number} · ${s.company_name} · ${periodInfo(s.period_key).label}`, after: { text } });
      return { statement: statementDto(get(`${STMT_SQL} WHERE s.id = ?`, id), ctx.user) };
    });

    r.get('/api/tab/statements/:id/invoice-file', { perm: ['tab.statements', 'tab.view'] }, (ctx) => {
      const s = get('SELECT * FROM tab_statements WHERE id = ?', Number(ctx.params.id));
      const file = s?.invoice_file_ext && join(invDir(), `${s.id}.${s.invoice_file_ext}`);
      if (!file || !existsSync(file)) throw notFound('Keine Rechnungsdatei vorhanden.');
      ctx.raw = { contentType: MIME[s.invoice_file_ext], body: readFileSync(file), filename: `Rechnung-${s.statement_number}.${s.invoice_file_ext}`, inline: true };
    });

    // ══ Firmenportal (persönlicher Link, kein Login; sieht nur die eigenen Abrechnungen) ══
    const byToken = (ctx) => {
      if (!rateLimit(`co|${ctx.ip}`, 120, 10 * 60_000)) throw new HttpError(429, 'Zu viele Anfragen. Bitte warte einige Minuten.', 'rate_limited');
      const t = String(ctx.params.token ?? '');
      const c = t.length >= 20 ? get("SELECT * FROM tab_companies WHERE link_token = ? AND status = 'active'", t) : null;
      if (!c) throw notFound('Dieser Link ist ungültig oder wurde deaktiviert.');
      return c;
    };
    const portalPeriods = (c) => {
      const used = new Set(all("SELECT period_key k FROM tab_statements WHERE company_id = ? AND status != 'rejected'", c.id).map((x) => x.k));
      return recentPeriods(c.billing_interval, { count: 12, includeCurrent: getConfig('tab.allow_current_period') === true }).filter((p) => !used.has(p.key));
    };
    const portalState = (c) => ({
      company: { name: c.name, interval: c.billing_interval, intervalLabel: INTERVALS[c.billing_interval] }, currency: currency(), periods: portalPeriods(c),
      statements: all(`${STMT_SQL} WHERE s.company_id = ? ORDER BY s.submitted_at DESC LIMIT 100`, c.id).map((s) => ({
        number: s.statement_number, period: periodInfo(s.period_key), submittedCents: s.submitted_cents, status: s.status, statusLabel: STATUS[s.status].label, statusColor: STATUS[s.status].color,
        submittedAt: s.submitted_at, paidAt: s.paid_at, rejectReason: s.status === 'rejected' ? s.reject_reason : '',
      })),
    });
    r.get('/api/c/:token', { auth: false }, (ctx) => portalState(byToken(ctx)));
    /** Live-Verbindung des Firmenportals: Statuswechsel erscheinen ohne Neuladen. */
    r.get('/api/c/:token/events', { auth: false }, (ctx) => { const c = byToken(ctx); return openStream(ctx, { kind: 'company', companyId: c.id, token: c.link_token }); });
    r.post('/api/c/:token/statements', { auth: false }, (ctx) => {
      const c = byToken(ctx);
      if (!rateLimit(`cosub|${c.id}`, 20, 10 * 60_000)) throw new HttpError(429, 'Zu viele Versuche. Bitte warte einige Minuten.', 'rate_limited');
      const period = portalPeriods(c).find((p) => p.key === ctx.body.periodKey);
      if (!period) throw bad('Für diesen Zeitraum kann keine Abrechnung (mehr) eingereicht werden.');
      const amount = cents(ctx.body.amountCents, 'Fälliger Betrag', { min: 0 });
      const comment = str(ctx.body.comment, 'Kommentar', { max: 500, required: false });
      const id = tx(() => {
        const t = now();
        const res = run(`INSERT INTO tab_statements (statement_number,company_id,period_key,submitted_cents,our_cents,comment,status,submitted_at,updated_at) VALUES (?,?,?,?,?,?,'submitted',?,?)`,
          allocateNumber('tab_statement', 'tab.statement_prefix', 'tab.statement_start'), c.id, period.key, amount, ourSum(c.id, period.key), comment, t, t);
        const sid = Number(res.lastInsertRowid);
        slog(sid, `Firma reicht Abrechnung über ${fmtC(amount)} ein${comment ? ` – „${comment}“` : ''}`, { company: true });
        notify(staffWith('tab.statements'), { key: `tab:${sid}:new`, title: 'Neue Deckel-Abrechnung',
          body: `Firma: ${c.name} · Zeitraum: ${period.label} · Betrag: ${fmtC(amount)} · eingereicht ${new Date(t).toLocaleDateString('de-DE')}`, target: { app: 'tab', statementId: sid } });
        return sid;
      });
      audit({ ip: ctx.ip, actorName: `Firma: ${c.name}` }, { action: 'tab.statement_submitted', module: 'tab', targetType: 'tab_statement', targetId: id, targetLabel: `${c.name} · ${period.label}`, after: { amount: fmtC(amount) } });
      ctx.status = 201;
      return { ok: true, message: 'Ihre Abrechnung wurde erfolgreich übermittelt und wird nun von uns geprüft.', ...portalState(c) };
    });
  },
};
