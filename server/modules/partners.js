import { all, get, run, tx, now } from '../core/db.js';
import { HttpError, bad, conflict, notFound, str, strList } from '../core/http.js';
import { hashPassword, verifyPassword, rateLimit } from '../core/auth.js';
import { getConfig } from '../core/config.js';
import { audit } from '../core/audit.js';
import {
  PARTNER_COOKIE, newLinkToken, randomCode, CODE_RE, createPartnerSession, destroyPartnerSession, destroyPartnerSessions,
} from '../core/partner-auth.js';
import { partnerApps, isPartnerApp } from '../core/partner-apps.js';
import { setupRequired } from './system.js';
import { allocateNumber } from '../core/numbers.js';

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const parseApps = (p) => { try { return JSON.parse(p.apps).filter(isPartnerApp); } catch { return []; } };
const linkPath = (token) => `/p/${token}`;
const dto = (p, { withLink }) => ({
  id: p.id, number: p.partner_number, name: p.name, note: p.note, status: p.status, apps: parseApps(p),
  lastLoginAt: p.last_login_at, createdAt: p.created_at,
  locked: !!(p.locked_until && p.locked_until > now()), lockedUntil: p.locked_until && p.locked_until > now() ? p.locked_until : null,
  dealCount: p.deal_count ?? 0,
  linkPath: withLink ? linkPath(p.link_token) : undefined,
});
const LIST_SQL = 'SELECT p.*, (SELECT COUNT(*) FROM market_deals d WHERE d.partner_id = p.id) deal_count FROM partners p';
const cleanApps = (v) => {
  const apps = strList(v, 'Apps');
  for (const a of apps) if (!isPartnerApp(a)) throw bad(`Unbekannte App: ${a}`);
  return apps;
};
const sessionCookie = (ctx, token, expires) =>
  `${PARTNER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((new Date(expires) - Date.now()) / 1000))}${ctx.secure ? '; Secure' : ''}`;

export default {
  name: 'partners',
  permissions: [
    ['partners.view', 'Externe Zugänge ansehen'],
    ['partners.manage', 'Externe Zugänge erstellen, Links und Codes verwalten'],
  ],
  config: [
    { key: 'partners.number_prefix', group: 'Zugang', label: 'Präfix der Partner-Nummer', help: 'Im Partner-Portal erscheint nur diese Nummer, nie der Name (z. B. AZ-P-100001).', type: 'string', default: 'AZ-P-', max: 12 },
    { key: 'partners.number_start', group: 'Zugang', label: 'Startnummer der Partner', type: 'number', default: 100001, min: 1, max: 99999999 },
    { key: 'partners.session_hours', group: 'Zugang', label: 'Sitzungsdauer externer Zugänge (Stunden)', type: 'number', default: 24, min: 1, max: 720 },
  ],
  init() {
    for (const r of all('SELECT id FROM partners WHERE partner_number IS NULL ORDER BY id')) {
      tx(() => run('UPDATE partners SET partner_number = ? WHERE id = ?', allocateNumber('partner_number', 'partners.number_prefix', 'partners.number_start'), r.id));
    }
  },
  routes(r) {
    // ── Verwaltung (Mitarbeiter) ──
    r.get('/api/partners', { perm: 'partners.view' }, (ctx) => {
      const canLink = ctx.user.perms.has('partners.manage');
      return { partners: all(`${LIST_SQL} ORDER BY p.created_at DESC`).map((p) => dto(p, { withLink: canLink })), apps: partnerApps() };
    });

    r.post('/api/partners', { perm: 'partners.manage' }, (ctx) => {
      const b = ctx.body;
      const name = str(b.name, 'Name', { min: 2, max: 60 });
      const note = str(b.note, 'Notiz', { max: 300, required: false });
      const apps = cleanApps(b.apps);
      let code = randomCode();
      if (b.code) {
        if (typeof b.code !== 'string' || !CODE_RE.test(b.code)) throw bad('Der Code muss aus 6–12 Buchstaben oder Ziffern bestehen.');
        code = b.code;
      }
      const t = now();
      const token = newLinkToken();
      const id = tx(() => {
        const res = run('INSERT INTO partners (partner_number,name,note,link_token,code_hash,status,apps,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          allocateNumber('partner_number', 'partners.number_prefix', 'partners.number_start'), name, note, token, hashPassword(code), 'active', JSON.stringify(apps), ctx.user.id, t, t);
        return Number(res.lastInsertRowid);
      });
      audit(ctx, { action: 'partner.created', module: 'partners', targetType: 'partner', targetId: id, targetLabel: name, after: { name, apps } });
      ctx.status = 201;
      return { partner: dto(get(`${LIST_SQL} WHERE p.id = ?`, id), { withLink: true }), code }; // Code wird nur hier einmal angezeigt
    });

    r.patch('/api/partners/:id', { perm: 'partners.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get(`${LIST_SQL} WHERE p.id = ?`, id);
      if (!cur) throw notFound('Zugang nicht gefunden.');
      const b = ctx.body;
      const before = dto(cur, { withLink: false });
      tx(() => {
        if (b.name !== undefined) run('UPDATE partners SET name = ? WHERE id = ?', str(b.name, 'Name', { min: 2, max: 60 }), id);
        if (b.note !== undefined) run('UPDATE partners SET note = ? WHERE id = ?', str(b.note, 'Notiz', { max: 300, required: false }), id);
        if (b.apps !== undefined) run('UPDATE partners SET apps = ? WHERE id = ?', JSON.stringify(cleanApps(b.apps)), id);
        if (b.status !== undefined) {
          if (!['active', 'disabled'].includes(b.status)) throw bad('Ungültiger Status.');
          run('UPDATE partners SET status = ? WHERE id = ?', b.status, id);
          if (b.status === 'disabled') destroyPartnerSessions(id); // Link deaktiviert ⇒ sofort abgemeldet
        }
        run('UPDATE partners SET updated_at = ? WHERE id = ?', now(), id);
      });
      const after = dto(get(`${LIST_SQL} WHERE p.id = ?`, id), { withLink: true });
      const action = b.status === 'disabled' ? 'partner.disabled' : b.status === 'active' && before.status === 'disabled' ? 'partner.enabled' : 'partner.updated';
      audit(ctx, { action, module: 'partners', targetType: 'partner', targetId: id, targetLabel: after.name, before, after: { ...after, linkPath: undefined } });
      return { partner: after };
    });

    // Neuer Zugangscode (zufällig oder festgelegt) – beendet bestehende Sitzungen, hebt eine Sperre auf
    r.post('/api/partners/:id/code', { perm: 'partners.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT name FROM partners WHERE id = ?', id);
      if (!cur) throw notFound('Zugang nicht gefunden.');
      let code = randomCode();
      if (ctx.body.code) {
        if (typeof ctx.body.code !== 'string' || !CODE_RE.test(ctx.body.code)) throw bad('Der Code muss aus 6–12 Buchstaben oder Ziffern bestehen.');
        code = ctx.body.code;
      }
      run('UPDATE partners SET code_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hashPassword(code), now(), id);
      destroyPartnerSessions(id);
      audit(ctx, { action: 'partner.code_reset', module: 'partners', targetType: 'partner', targetId: id, targetLabel: cur.name });
      return { code };
    });

    // Neuer Link (alter Link wird ungültig)
    r.post('/api/partners/:id/link', { perm: 'partners.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT name FROM partners WHERE id = ?', id);
      if (!cur) throw notFound('Zugang nicht gefunden.');
      const token = newLinkToken();
      run('UPDATE partners SET link_token = ?, updated_at = ? WHERE id = ?', token, now(), id);
      destroyPartnerSessions(id);
      audit(ctx, { action: 'partner.link_regenerated', module: 'partners', targetType: 'partner', targetId: id, targetLabel: cur.name });
      return { linkPath: linkPath(token) };
    });

    r.delete('/api/partners/:id', { perm: 'partners.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get(`${LIST_SQL} WHERE p.id = ?`, id);
      if (!cur) throw notFound('Zugang nicht gefunden.');
      if (cur.deal_count > 0) throw conflict(`Zu diesem Zugang gibt es ${cur.deal_count} Geschäft(e). Deaktiviere ihn stattdessen, damit der Verlauf erhalten bleibt.`);
      run('DELETE FROM partners WHERE id = ?', id);
      audit(ctx, { action: 'partner.deleted', module: 'partners', targetType: 'partner', targetId: id, targetLabel: cur.name });
      return { ok: true };
    });

    // ── Partner-Zugang über Link + Code (öffentlich) ──
    const byToken = (token) => get('SELECT * FROM partners WHERE link_token = ?', token);
    const invalid = () => new HttpError(404, 'Dieser Link ist ungültig oder wurde deaktiviert.', 'link_invalid');

    r.get('/api/p/:token/session', { auth: false }, (ctx) => {
      const p = byToken(ctx.params.token);
      if (!p || p.status !== 'active') throw invalid();
      const mine = ctx.partner && ctx.partner.id === p.id;
      return { valid: true, authenticated: !!mine, partner: mine ? { number: p.partner_number, apps: parseApps(p) } : null };
    });

    r.post('/api/p/:token/login', { auth: false }, (ctx) => {
      if (setupRequired()) throw invalid();
      const p = byToken(ctx.params.token);
      if (!p || p.status !== 'active') throw invalid();
      if (!rateLimit(`pl|${ctx.ip}`, 20, 10 * 60_000)) throw new HttpError(429, 'Zu viele Versuche. Bitte warte einige Minuten.', 'rate_limited');
      if (p.locked_until && p.locked_until > now()) throw new HttpError(429, `Zu viele Fehlversuche. Der Zugang ist bis ${new Date(p.locked_until).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr gesperrt.`, 'locked');
      const code = typeof ctx.body.code === 'string' ? ctx.body.code.trim() : '';
      if (!code || !verifyPassword(code, p.code_hash)) {
        const attempts = (p.locked_until && p.locked_until <= now() ? 0 : p.failed_attempts) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          run('UPDATE partners SET failed_attempts = 0, locked_until = ? WHERE id = ?', new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString(), p.id);
          audit(ctx, { action: 'partner.locked', module: 'partners', targetType: 'partner', targetId: p.id, targetLabel: p.name });
        } else run('UPDATE partners SET failed_attempts = ? WHERE id = ?', attempts, p.id);
        audit(ctx, { action: 'partner.login_failed', module: 'partners', targetType: 'partner', targetId: p.id, targetLabel: p.name });
        throw new HttpError(401, attempts >= MAX_ATTEMPTS ? `Zu viele Fehlversuche. Der Zugang ist für ${LOCK_MINUTES} Minuten gesperrt.` : 'Der Code ist nicht korrekt.', 'invalid_code');
      }
      run('UPDATE partners SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now(), p.id);
      const s = createPartnerSession(p.id, { ip: ctx.ip, ua: ctx.req.headers['user-agent'], hours: getConfig('partners.session_hours') });
      ctx.headers['Set-Cookie'] = sessionCookie(ctx, s.token, s.expires);
      audit({ ip: ctx.ip, actorName: `Partner: ${p.name}` }, { action: 'partner.login', module: 'partners', targetType: 'partner', targetId: p.id, targetLabel: p.name });
      return { partner: { number: p.partner_number, apps: parseApps(p) } };
    });

    r.post('/api/p/logout', { auth: false }, (ctx) => {
      if (ctx.partnerToken) destroyPartnerSession(ctx.partnerToken);
      ctx.headers['Set-Cookie'] = `${PARTNER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
      return { ok: true };
    });

    // Sperrbildschirm im Partner-Portal: Zugangscode erneut bestätigen
    r.post('/api/p/unlock', { auth: 'partner' }, (ctx) => {
      if (!rateLimit(`punlock|${ctx.partner.id}`, 8, 10 * 60_000)) throw new HttpError(429, 'Zu viele Versuche. Bitte warte einige Minuten.', 'rate_limited');
      const p = get('SELECT code_hash FROM partners WHERE id = ?', ctx.partner.id);
      const code = typeof ctx.body.code === 'string' ? ctx.body.code.trim() : '';
      if (!code || !verifyPassword(code, p.code_hash)) throw new HttpError(401, 'Der Code ist nicht korrekt.', 'invalid_code');
      return { ok: true };
    });

    r.get('/api/p/me', { auth: 'partner' }, (ctx) => ({
      partner: { number: ctx.partner.number, apps: [...ctx.partner.apps].filter(isPartnerApp) },
      apps: partnerApps().filter((a) => ctx.partner.apps.has(a.id)),
    }));
  },
};
