import { h, mount, fmtDateTime } from '../ui/dom.js';
import { button, busy, field, input, formError, openModal, toast, tabs, badge, note, avatar } from '../ui/kit.js';
import { api } from '../api.js';
import { state } from '../state.js';

const shortAgent = (ua = '') => (/Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser') + (/Windows/.test(ua) ? ' · Windows' : /Mac OS/.test(ua) ? ' · macOS' : /Android/.test(ua) ? ' · Android' : /iPhone|iPad/.test(ua) ? ' · iOS' : /Linux/.test(ua) ? ' · Linux' : '');

/** Konto & Sicherheit: Passwort ändern, eigene Sitzungen einsehen, überall abmelden. */
export function openAccountDialog() {
  const u = state.user;
  const body = h('div');
  const m = openModal({ title: 'Konto & Sicherheit', body: h('div', null, h('div', { class: 'member-card' }, avatar(u.displayName, 'lg'),
    h('div', { class: 'grow' }, h('div', { class: 'mc-name' }, u.displayName), h('div', { class: 'mc-sub' }, `@${u.username}`)),
    u.memberNumber && h('span', { class: 'member-no big' }, u.memberNumber)),
  h('div', { style: { marginBottom: '16px' } }, tabs([{ id: 'pw', label: 'Passwort' }, { id: 'sessions', label: 'Sitzungen' }], 'pw', (t) => (t === 'pw' ? pw() : sessions()))), body),
  footer: [button('Schließen', { onClick: () => m.close() })] });

  function pw() {
    const err = h('div');
    const cur = input({ type: 'password', autocomplete: 'current-password' });
    const next = input({ type: 'password', autocomplete: 'new-password', placeholder: 'Mindestens 8 Zeichen' });
    const again = input({ type: 'password', autocomplete: 'new-password' });
    mount(body, err, field('Aktuelles Passwort', cur), field('Neues Passwort', next), field('Neues Passwort wiederholen', again),
      button('Passwort ändern', { variant: 'primary', icon: 'key', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        if (next.value !== again.value) return err.replaceChildren(formError('Die neuen Passwörter stimmen nicht überein.'));
        try { await api.post('/api/auth/password', { current: cur.value, next: next.value }); toast('Passwort geändert.'); cur.value = next.value = again.value = ''; }
        catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) }));
  }

  async function sessions() {
    mount(body, h('div', { class: 'muted' }, 'Lade …'));
    try {
      const { sessions: list } = await api.get('/api/auth/sessions');
      mount(body, note('Hier siehst du, wo du angemeldet bist. Melde andere Geräte ab, wenn du etwas nicht erkennst.', 'info'), h('div', { style: { height: '10px' } }),
        list.map((s) => h('div', { class: 'list-row', style: { padding: '10px 0' } }, h('div', { class: 'grow' }, h('div', { class: 't' }, shortAgent(s.userAgent), ' ', s.current && badge('Dieses Gerät', 'b-ok', false)),
          h('div', { class: 's' }, `${s.ip ?? '–'} · angemeldet ${fmtDateTime(s.createdAt)}`)))),
        list.length > 1 && button('Alle anderen abmelden', { variant: 'danger', icon: 'logout', onClick: (e) => busy(e.currentTarget, async () => {
          const r = await api.post('/api/auth/sessions/revoke-others'); toast(`${r.revoked} Sitzung(en) beendet.`); sessions();
        }) }));
    } catch (e) { mount(body, formError(e.message)); }
  }
  pw();
}
