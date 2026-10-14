import { all } from '../core/db.js';
import { getConfig } from '../core/config.js';
import { publish } from '../core/realtime.js';

/**
 * Online-Liste: welche Mitglieder haben das Panel gerade geöffnet? Jede geöffnete Seite meldet sich regelmäßig (Herzschlag) und sagt, ob der
 * Sperrbildschirm aktiv ist. „Aktiv“ = mindestens eine Seite entsperrt, „Gesperrt“ = alle offenen Seiten im Sperrbildschirm. Wer keine Seite
 * offen hat (kein Herzschlag), steht nicht in der Liste. Nur im Arbeitsspeicher (nichts wird gespeichert); sichtbar nur für Mitglieder, und
 * nur als Personalnummer mit Rang – nie mit Namen.
 */
const TTL = 80_000; // Herzschläge alle ~25 s, so lange gilt eine Seite als offen
const tabs = new Map(); // userId → Map(tabId → { locked, at })
let lastSig = '';

const stateOf = (userId, t = Date.now()) => {
  const m = tabs.get(userId); if (!m) return null;
  let any = false, active = false;
  for (const [id, x] of m) { if (t - x.at > TTL) { m.delete(id); continue; } any = true; if (!x.locked) active = true; }
  if (!m.size) { tabs.delete(userId); return null; }
  return any ? (active ? 'active' : 'locked') : null;
};
const snapshot = () => { const t = Date.now(), out = []; for (const id of [...tabs.keys()]) { const s = stateOf(id, t); if (s) out.push([id, s]); } return out.sort((a, b) => a[0] - b[0]); };
const announceIfChanged = () => { const sig = JSON.stringify(snapshot()); if (sig !== lastSig) { lastSig = sig; publish({ topic: 'presence', kind: 'changed', staff: 1 }); } };

export function listOnline(viewerId) {
  const snap = new Map(snapshot());
  if (!snap.size) return [];
  const rows = all(`SELECT u.id, u.member_number, r.name rank_name, r.color rank_color FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.status = 'active' AND u.id IN (${[...snap.keys()].map(() => '?').join(',')})`, ...snap.keys());
  return rows.map((u) => ({ id: u.id, label: u.member_number || `Mitglied #${u.id}`, rank: u.rank_name ? { name: u.rank_name, color: u.rank_color } : null, state: snap.get(u.id), isMe: u.id === viewerId }))
    .sort((a, b) => (a.state === b.state ? 0 : a.state === 'active' ? -1 : 1) || a.label.localeCompare(b.label, 'de', { numeric: true }));
}

export default {
  name: 'presence',
  config: [
    { key: 'presence.enabled', group: 'Online-Liste', label: 'Online-Liste anzeigen', help: 'Zeigt Mitgliedern rechts auf dem Desktop, wer gerade im Panel online ist (nur Personalnummer und Rang; gesperrte Bildschirme grau). Ausgeschaltet werden auch keine Herzschläge mehr gesendet.', type: 'bool', default: true, public: true },
  ],
  init() {
    // Abgelaufene Seiten bemerken (ohne dass jemand etwas sendet) und die Liste live aktualisieren
    setInterval(() => { try { announceIfChanged(); } catch { /* egal */ } }, 15_000).unref();
  },
  routes(r) {
    r.post('/api/presence', (ctx) => {
      if (!getConfig('presence.enabled')) return { ok: true };
      const tabId = String(ctx.body.tabId ?? '').slice(0, 40); if (!/^[A-Za-z0-9_-]{6,40}$/.test(tabId)) return { ok: false };
      const m = tabs.get(ctx.user.id) ?? new Map(); tabs.set(ctx.user.id, m);
      m.set(tabId, { locked: !!ctx.body.locked, at: Date.now() });
      announceIfChanged();
      return { ok: true };
    });
    r.post('/api/presence/leave', (ctx) => {
      const m = tabs.get(ctx.user.id); if (m) { m.delete(String(ctx.body.tabId ?? '')); if (!m.size) tabs.delete(ctx.user.id); }
      announceIfChanged();
      return { ok: true };
    });
    r.get('/api/presence', (ctx) => ({ enabled: !!getConfig('presence.enabled'), members: getConfig('presence.enabled') ? listOnline(ctx.user.id) : [] }));
  },
};
