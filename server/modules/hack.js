import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { all, get, run, now } from '../core/db.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { audit } from '../core/audit.js';
import { getConfig, setConfig } from '../core/config.js';
import { rateLimit } from '../core/auth.js';
import { notify, staffWith } from '../core/notifications.js';

/**
 * „Hack“-Zugang für die Exekutive (Rollenspiel-Funktion): ein dauerhafter, geheimer Link (/x/<Schlüssel>) ohne Anmeldung und OHNE jede Kennzeichnung
 * des Systems (kein Name, kein Logo). Dahinter vier Minigames; wer alle besteht, bekommt zufällige, bewusst harmlose Schnipsel aus dem System
 * (Personalnummern, Partnernummern, Teilbestände einzelner Lager, Fahrzeugkennzeichen, Geschäftsnummern) – niemals Klarnamen, Telefonnummern,
 * Personalakten oder sonstige sensible Daten. Danach gilt eine gemeinsame Sperrzeit (Cooldown) für den Link.
 *
 * Die Lösungen liegen ausschließlich auf dem Server (Sitzung im Speicher); der Browser bekommt nur die Aufgaben.
 */
const RUN_MAX_MS = 10 * 60_000; // so lange darf ein Zugriffsversuch dauern
const LIVES = 3;
const sessions = new Map(); // sid → Zustand
export const __sessions = sessions; // nur für den Test
setInterval(() => { const t = Date.now(); for (const [k, s] of sessions) if (t - s.started > RUN_MAX_MS + 60_000) sessions.delete(k); }, 60_000).unref();

// ── Link-Schlüssel ──
const KEY = 'hack.link_token';
function linkToken() {
  let t = get('SELECT value FROM settings WHERE key = ?', KEY);
  t = t ? JSON.parse(t.value) : null;
  if (!t) { t = randomBytes(18).toString('base64url'); setConfig(KEY, t, null); }
  return t;
}
const tokenOk = (given) => {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(linkToken());
  return a.length === b.length && timingSafeEqual(a, b);
};
function guard(ctx) {
  if (!rateLimit(`hk|${ctx.ip}`, 240, 10 * 60_000)) throw new HttpError(429, 'Zu viele Anfragen.', 'rate_limited');
  if (!tokenOk(ctx.params.token)) throw notFound('Nicht gefunden.');
}

// ── Sperrzeit: gemeinsam für den Link; zählt ab Ende des letzten Versuchs (läuft einer ins Leere, ab Start + Höchstdauer) ──
function cooldownLeftSec() {
  const last = get('SELECT * FROM hack_runs ORDER BY id DESC LIMIT 1');
  if (!last) return 0;
  const end = last.ended_at ? Date.parse(last.ended_at) : Date.parse(last.started_at) + RUN_MAX_MS;
  return Math.max(0, Math.ceil((end + getConfig('hack.cooldown_minutes') * 60_000 - Date.now()) / 1000));
}

// ── Minigames ──
const hex = (n) => randomBytes(n).toString('hex').toUpperCase();
const ip = () => `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(2, 250)}`;
const COMMANDS = [
  () => `scan --host ${ip()} --port ${randomInt(1000, 9999)} --stealth`,
  () => `inject payload_${hex(2)}.bin -> gate${randomInt(10, 99)}`,
  () => `Invoke-Bypass -Token 0x${hex(3)} -Force`,
  () => `tunnel open ${ip()}:${randomInt(2000, 9000)} --relay ${randomInt(1, 9)}`,
  () => `crack --hash ${hex(4).toLowerCase()} --mode fast`,
  () => `Set-Item HKLM:\\sys\\node${randomInt(10, 99)} -Value 0x${hex(2)}`,
  () => `spoof --mac ${hex(1)}:${hex(1)}:${hex(1)}:${hex(1)} --iface eth${randomInt(0, 3)}`,
];
const WORDS = ['FREIGABE', 'ZUGRIFF', 'KENNWORT', 'SCHLUESSEL', 'ARCHIV', 'DATENBANK', 'PROTOKOLL', 'SPERRE', 'TERMINAL', 'BEWEIS'];
const STAGES = ['typing', 'code', 'sequence', 'cipher'];

function makeStage(type) {
  switch (type) {
    case 'typing': { const lines = [...COMMANDS].sort(() => randomInt(0, 3) - 1).slice(0, 3).map((f) => f()); return { type, lines, secret: { lines } }; }
    case 'code': {
      const digits = [...'0123456789'].sort(() => randomInt(0, 3) - 1).slice(0, 4).join('');
      return { type, secret: { digits, tries: 8 }, public: { tries: 8, length: 4 } };
    }
    case 'sequence': { const seq = []; while (seq.length < 6) { const n = randomInt(0, 9); if (n !== seq.at(-1)) seq.push(n); } return { type, secret: { seq }, public: { sequence: seq, grid: 9 } }; }
    case 'cipher': {
      const word = WORDS[randomInt(0, WORDS.length)], shift = randomInt(3, 23);
      const enc = [...word].map((c) => String.fromCharCode(((c.charCodeAt(0) - 65 + shift) % 26) + 65)).join('');
      return { type, secret: { word }, public: { cipher: enc } };
    }
    default: throw new Error('stage');
  }
}
const stageDto = (st, index) => ({ type: st.type, index, total: STAGES.length, ...(st.type === 'typing' ? { lines: st.lines } : st.public) });

// ── Beute: harmlose Schnipsel, nur ausdrücklich ausgewählte Spalten (keine Namen, Telefonnummern, Akten, Preise) ──
const SNIPPETS = [
  () => { // Personalnummern (nur Kennung + Rang)
    const rows = all("SELECT u.member_number n, r.name rank FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.status = 'active' AND u.member_number IS NOT NULL ORDER BY RANDOM() LIMIT 3");
    return rows.length ? { kind: 'Personal', title: 'Personalkennungen', lines: rows.map((x) => `${x.n}${x.rank ? `  ·  ${x.rank}` : ''}`) } : null;
  },
  () => { // Teilbestand eines Lagers – wenige Positionen, gerundete Menge, nur die Lagernummer
    const w = get("SELECT w.id, w.warehouse_number n FROM warehouses w WHERE w.is_active = 1 AND EXISTS (SELECT 1 FROM warehouse_stock s WHERE s.warehouse_id = w.id AND s.quantity > 0) ORDER BY RANDOM() LIMIT 1");
    if (!w) return null;
    const rows = all('SELECT i.name, s.quantity q, i.unit FROM warehouse_stock s JOIN market_items i ON i.id = s.item_id WHERE s.warehouse_id = ? AND s.quantity > 0 ORDER BY RANDOM() LIMIT 2', w.id);
    const round = (q) => (q < 10 ? q : q < 100 ? Math.round(q / 5) * 5 : Math.round(q / 50) * 50);
    return { kind: 'Lager', title: `Lagerauszug ${w.n ?? ''}`.trim(), lines: [...rows.map((x) => `${x.name}  ·  ca. ${round(x.q)} ${x.unit}`), '… (Auszug unvollständig)'] };
  },
  () => { // Fahrzeug
    const v = get('SELECT plate, name FROM vehicles ORDER BY RANDOM() LIMIT 1');
    return v ? { kind: 'Fahrzeug', title: 'Fahrzeugregister', lines: [`${v.plate}  ·  ${v.name}`] } : null;
  },
  () => { // Geschäft (ohne Preise und Namen)
    const d = get("SELECT d.deal_number n, i.name item, d.quantity q, d.status FROM market_deals d JOIN market_items i ON i.id = d.item_id ORDER BY RANDOM() LIMIT 1");
    return d ? { kind: 'Handel', title: 'Geschäftsvorgang', lines: [`${d.n}  ·  ${d.item} ×${d.q}  ·  Status: ${d.status}`] } : null;
  },
  () => { // Externe Zugänge (nur Kennung)
    const rows = all("SELECT partner_number n FROM partners WHERE status = 'active' AND partner_number IS NOT NULL ORDER BY RANDOM() LIMIT 2");
    return rows.length ? { kind: 'Extern', title: 'Gegenstellen', lines: rows.map((x) => x.n) } : null;
  },
];
function loot() {
  const want = Math.max(1, Number(getConfig('hack.reward_count')) || 3);
  const out = [];
  for (const f of [...SNIPPETS].sort(() => randomInt(0, 3) - 1)) {
    if (out.length >= want) break;
    const s = f(); if (s) out.push(s);
  }
  return out.length ? out : [{ kind: 'Hinweis', title: 'Keine Daten', lines: ['Der Zugriff war erfolgreich, aber es wurden keine verwertbaren Datensätze gefunden.'] }];
}

function finish(ctx, s, success, reason) {
  s.done = true; sessions.delete(s.sid);
  run('UPDATE hack_runs SET ended_at = ?, success = ?, stage = ? WHERE id = ?', now(), success ? 1 : 0, s.index, s.runId);
  audit({ ip: ctx.ip, actorName: 'Unbekannter Zugriff' }, { action: success ? 'hack.success' : 'hack.failed', module: 'hack', targetType: 'hack', targetId: s.runId, targetLabel: success ? 'Zugriff erfolgreich' : `Zugriff abgebrochen (${reason})` });
  notify(staffWith('hack.manage'), { key: `hack:${s.runId}:end`, title: success ? 'Unbefugter Zugriff erfolgreich' : 'Unbefugter Zugriff abgewehrt', body: success ? 'Ein externer Zugriff über den Sonderzugang hat Daten abgegriffen.' : `Ein externer Zugriffsversuch ist gescheitert (${reason}).` });
}

export default {
  name: 'hack',
  permissions: [['hack.manage', 'Exekutive-Zugang: Link ansehen/erneuern, Einstellungen und Zugriffsprotokoll']],
  config: [
    { key: 'hack.enabled', group: 'Exekutive-Zugang', label: 'Zugang aktiv', help: 'Schaltet den Hack-Link der Exekutive ein oder aus.', type: 'bool', default: true },
    { key: 'hack.cooldown_minutes', group: 'Exekutive-Zugang', label: 'Sperrzeit nach einem Versuch (Minuten)', help: 'Gilt für den Link insgesamt – nach Erfolg und nach Misserfolg.', type: 'number', default: 30, min: 1, max: 10080 },
    { key: 'hack.reward_count', group: 'Exekutive-Zugang', label: 'Datenschnipsel pro Erfolg', type: 'number', default: 3, min: 1, max: 5 },
  ],
  routes(r) {
    // ── Verwaltung ──
    r.get('/api/hack/admin', { perm: 'hack.manage' }, () => ({
      path: `/x/${linkToken()}`, enabled: getConfig('hack.enabled'), cooldownLeftSec: cooldownLeftSec(),
      runs: all('SELECT id, started_at startedAt, ended_at endedAt, success, stage FROM hack_runs ORDER BY id DESC LIMIT 20'),
    }));
    r.post('/api/hack/admin/regenerate', { perm: 'hack.manage' }, (ctx) => {
      setConfig(KEY, randomBytes(18).toString('base64url'), ctx.user.id); sessions.clear();
      audit(ctx, { action: 'hack.link_renewed', module: 'hack', targetType: 'hack', targetLabel: 'Link erneuert' });
      return { path: `/x/${linkToken()}` };
    });
    r.post('/api/hack/admin/reset-cooldown', { perm: 'hack.manage' }, (ctx) => {
      run('UPDATE hack_runs SET ended_at = ? WHERE id = (SELECT MAX(id) FROM hack_runs)', new Date(0).toISOString());
      audit(ctx, { action: 'hack.cooldown_reset', module: 'hack', targetType: 'hack', targetLabel: 'Sperrzeit aufgehoben' });
      return { ok: true };
    });

    // ── Öffentlicher Link (ohne Anmeldung, ohne Kennzeichnung) ──
    const O = { auth: false };
    r.get('/api/h/:token/status', O, (ctx) => { guard(ctx); return { enabled: getConfig('hack.enabled'), cooldownSec: cooldownLeftSec() }; });

    r.post('/api/h/:token/start', O, (ctx) => {
      guard(ctx);
      if (!getConfig('hack.enabled')) throw new HttpError(403, 'Verbindung nicht möglich.', 'disabled');
      const left = cooldownLeftSec();
      if (left > 0) throw new HttpError(429, 'Gesperrt.', 'cooldown', { cooldownSec: left });
      const runId = Number(run('INSERT INTO hack_runs (started_at, ip) VALUES (?, ?)', now(), ctx.ip).lastInsertRowid);
      const sid = randomBytes(16).toString('hex');
      const s = { sid, runId, started: Date.now(), index: 0, lives: LIVES, stage: makeStage(STAGES[0]) };
      sessions.set(sid, s);
      audit({ ip: ctx.ip, actorName: 'Unbekannter Zugriff' }, { action: 'hack.started', module: 'hack', targetType: 'hack', targetId: runId, targetLabel: 'Zugriffsversuch gestartet' });
      return { sid, lives: s.lives, stage: stageDto(s.stage, 0) };
    });

    r.post('/api/h/:token/answer', O, (ctx) => {
      guard(ctx);
      const s = sessions.get(String(ctx.body.sid ?? ''));
      if (!s || s.done) throw new HttpError(410, 'Verbindung verloren.', 'lost');
      if (Date.now() - s.started > RUN_MAX_MS) { finish(ctx, s, false, 'Zeit abgelaufen'); return { result: 'failed', reason: 'Zeitüberschreitung', cooldownSec: cooldownLeftSec() }; }
      const st = s.stage, a = ctx.body;
      const lose = (feedback) => { // Leben verlieren, neue Aufgabe gleicher Art
        s.lives -= 1;
        if (s.lives <= 0) { finish(ctx, s, false, 'keine Versuche mehr'); return { result: 'failed', reason: 'Rückverfolgung abgeschlossen', cooldownSec: cooldownLeftSec() }; }
        s.stage = makeStage(st.type);
        return { result: 'retry', lives: s.lives, message: feedback, stage: stageDto(s.stage, s.index) };
      };
      const advance = () => {
        s.index += 1;
        if (s.index >= STAGES.length) { const rewards = loot(); finish(ctx, s, true); return { result: 'done', rewards, cooldownSec: cooldownLeftSec() }; }
        s.stage = makeStage(STAGES[s.index]);
        return { result: 'ok', lives: s.lives, stage: stageDto(s.stage, s.index) };
      };
      switch (st.type) {
        case 'typing': {
          const text = String(a.text ?? ''), ms = Number(a.ms);
          if (!Number.isFinite(ms) || ms < text.length * 45) return lose('Eingabe zu schnell – Muster erkannt.'); // Einfügen/Automaten abwehren
          if (ms > 150_000) return lose('Zeit abgelaufen.');
          return text === st.secret.lines.join('\n') ? advance() : lose('Eingabe fehlerhaft.');
        }
        case 'code': {
          const g = String(a.guess ?? '');
          if (!/^\d{4}$/.test(g)) throw bad('Vier Ziffern eingeben.');
          st.secret.tries -= 1;
          const d = st.secret.digits;
          const exact = [...g].filter((c, i) => c === d[i]).length;
          const present = [...g].filter((c, i) => c !== d[i] && d.includes(c)).length;
          if (exact === 4) return advance();
          if (st.secret.tries <= 0) return lose('Kennwort nicht geknackt.');
          return { result: 'feedback', exact, present, tries: st.secret.tries };
        }
        case 'sequence': {
          const seq = Array.isArray(a.sequence) ? a.sequence.map(Number) : [];
          return seq.length === st.secret.seq.length && seq.every((x, i) => x === st.secret.seq[i]) ? advance() : lose('Falsche Reihenfolge.');
        }
        case 'cipher': return String(a.text ?? '').toUpperCase() === st.secret.word ? advance() : lose('Entschlüsselung falsch.');
        default: throw bad('Ungültig.');
      }
    });
  },
};
