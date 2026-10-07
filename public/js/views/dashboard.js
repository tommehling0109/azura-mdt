import { h, mount, timeAgo, fmtDateTime } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { card, roleChip, avatar, button, skeletons, empty, badge, toast } from '../ui/kit.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { actionLabel } from './admin/audit.js';
import { openApp } from '../shell.js';

/**
 * Widget-Renderer. Spätere Module registrieren hier ihre Widgets (Schlüssel = Widget-ID vom Server).
 * Unbekannte Widget-IDs werden ignoriert, so bleibt das Dashboard bei Teil-Updates stabil.
 */
const hour = () => new Date().getHours();
const greeting = () => (hour() < 11 ? 'Guten Morgen' : hour() < 18 ? 'Guten Tag' : 'Guten Abend');

const RENDERERS = {
  welcome: (w) => h('section', { class: 'card hero' },
    h('h2', null, `${greeting()}, ${state.user.displayName}`),
    h('p', null, `Willkommen im ${state.config['system.name'] || 'MDT'}.`),
    h('div', { class: 'chips' }, w.data.roles.length ? w.data.roles.map(roleChip) : badge('Keine Rolle zugewiesen', 'b-mute', false))),

  'user-stats': (w) => {
    const c = w.data.counts;
    const k = (v, label, cls) => h('div', { class: `kpi ${cls}` }, h('div', { class: 'kpi-value' }, v ?? 0), h('div', { class: 'kpi-label' }, label));
    return card(w.title, h('div', { class: 'kpi-row' }, k(c.active, 'Aktiv', 'k-ok'), k(c.pending, 'Ausstehend', c.pending ? 'k-warn' : ''), k(c.blocked, 'Gesperrt', c.blocked ? 'k-err' : '')), { icon: 'users' });
  },

  'pending-access': (w) => {
    const list = w.data.users;
    const body = list.length
      ? list.map((u) => h('div', { class: 'list-row' }, avatar(u.displayName),
        h('div', { class: 'grow' }, h('div', { class: 't' }, u.displayName), h('div', { class: 's' }, `@${u.username} · ${timeAgo(u.createdAt)}`)),
        button('Prüfen', { size: 'sm', variant: 'info', onClick: () => openApp('users') })))
      : empty('Keine offenen Anträge', 'Alle Zugänge sind bearbeitet.', 'userCheck');
    return card(w.title, body, { icon: 'hourglass', flush: true });
  },

  'recent-activity': (w) => {
    const rows = w.data.rows;
    const body = rows.length
      ? rows.map((r) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon('activity')),
        h('div', { class: 'grow' }, h('div', { class: 't' }, actionLabel(r.action)), h('div', { class: 's' }, `${r.username ?? 'System'}${r.targetLabel ? ' → ' + r.targetLabel : ''}`)),
        h('span', { class: 'muted', style: { fontSize: '12px' }, title: fmtDateTime(r.ts) }, timeAgo(r.ts))))
      : empty('Noch keine Aktivitäten', null, 'activity');
    return card(w.title, body, { icon: 'activity', flush: true });
  },

  'market-open': (w) => {
    const d = w.data;
    const k = (v, label, cls) => h('div', { class: `kpi ${cls}` }, h('div', { class: 'kpi-value' }, v ?? 0), h('div', { class: 'kpi-label' }, label));
    const latest = d.latest.map((x) => h('div', { class: 'list-row', style: { padding: '9px 0', cursor: 'pointer' }, onclick: () => openApp('market') },
      h('div', { class: 'grow' }, h('div', { class: 't' }, `${x.partner.name} · ${x.item.name}`), h('div', { class: 's' }, `${x.quantity.toLocaleString('de-DE')} × ${x.unitPrice.toLocaleString('de-DE')}`))));
    return card(w.title, h('div', null, h('div', { class: 'kpi-row' }, k(d.awaitingStaff, 'Warten auf uns', d.awaitingStaff ? 'k-warn' : ''), k(d.active, 'Laufend', ''), k(d.openWanted, 'Gesuche', '')),
      latest.length > 0 && h('div', { style: { marginTop: '12px' } }, latest)), { icon: 'tag' });
  },

  'system-status': (w) => {
    const up = w.data.uptimeSeconds;
    const upTxt = up > 3600 ? `${Math.floor(up / 3600)} Std. ${Math.floor((up % 3600) / 60)} Min.` : `${Math.floor(up / 60)} Min.`;
    const row = (l, v) => h('div', { class: 'list-row', style: { padding: '9px 0' } }, h('div', { class: 'grow muted' }, l), v);
    return card(w.title, h('div', null,
      row('Datenbank', badge(w.data.database === 'ok' ? 'Online' : 'Fehler', w.data.database === 'ok' ? 'b-ok' : 'b-err')),
      row('Laufzeit', h('b', null, upTxt)),
      row('Serverzeit', h('b', null, new Date(w.data.serverTime).toLocaleTimeString('de-DE')))), { icon: 'server' });
  },
};
const SPAN = { small: 'span-4', medium: 'span-8', wide: 'span-12' };

export default async function render(container, ctx) {
  mount(container, skeletons(4, 120));
  const load = async () => {
    const { widgets } = await api.get('/api/dashboard');
    if (!ctx.isCurrent()) return;
    const grid = h('div', { class: 'grid' });
    for (const w of widgets) {
      const r = RENDERERS[w.id];
      if (!r) continue;
      const el = r(w);
      const wrap = h('div', { class: SPAN[w.size] ?? 'span-6', style: { display: 'flex', flexDirection: 'column' } }, el);
      el.style.flex = '1';
      grid.append(wrap);
    }
    mount(container, grid);
  };
  ctx.setActions(button('Aktualisieren', { icon: 'refresh', size: 'sm', onClick: () => load().catch((e) => toast(e.message, 'err')) }));
  ctx.live(['*'], () => load()); // jede Änderung im System aktualisiert das Dashboard sofort
  await load();
}
