import { h, mount, fmtDateTime, timeAgo } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, busy, card, field, input, checkbox, formError, openModal, confirmDialog, toast, skeletons, empty, note, badge, avatar } from '../../ui/kit.js';
import { api } from '../../api.js';
import { can } from '../../state.js';

const fullLink = (path) => `${location.origin}${path}`;

async function copy(text, label = 'Kopiert.') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast('Kopieren nicht möglich – bitte manuell markieren.', 'warn'); }
}

export default async function render(container, ctx) {
  const canManage = can('partners.manage');
  mount(container, skeletons(3, 90));
  let data;
  const load = async () => { data = await api.get('/api/partners'); if (ctx.isCurrent()) draw(); };

  if (canManage) ctx.setActions(button('Zugang erstellen', { variant: 'primary', icon: 'userPlus', onClick: () => create() }));

  function draw() {
    if (!data.partners.length) return mount(container, card(null, empty('Noch keine externen Zugänge', canManage ? 'Erstelle einen Zugang. Du erhältst einen Link und einen Code, den du an die Person schickst.' : null, 'link')));
    mount(container, note('Externe Zugänge haben keinen Benutzer-Account: Die Person öffnet den persönlichen Link, gibt den Code ein und sieht nur die hier freigeschalteten Apps.', 'info'),
      h('div', { style: { height: '14px' } }),
      h('div', { class: 'role-grid' }, data.partners.map((p) => {
        const c = h('article', { class: 'card role-card hoverable', style: { '--rc': p.status === 'active' ? 'var(--ok)' : 'var(--mute)', cursor: 'pointer' }, tabindex: 0 },
          h('h3', null, p.name, ' ', p.status === 'active' ? badge('Aktiv', 'b-ok') : badge('Deaktiviert', 'b-mute'), p.locked && badge('Gesperrt', 'b-err')),
          h('div', { class: 'desc' }, p.note || h('span', { class: 'muted' }, 'Keine Notiz')),
          h('div', { class: 'chips' }, p.apps.length ? p.apps.map((a) => badge((data.apps.find((x) => x.id === a)?.label ?? a), 'b-info', false)) : h('span', { class: 'muted' }, 'Keine Apps freigeschaltet')),
          h('div', { class: 'meta' }, h('span', null, p.lastLoginAt ? `Zuletzt: ${timeAgo(p.lastLoginAt)}` : 'Noch nie angemeldet'), h('span', null, `${p.dealCount} Geschäft${p.dealCount === 1 ? '' : 'e'}`)));
        c.addEventListener('click', () => edit(p));
        c.addEventListener('keydown', (e) => { if (e.key === 'Enter') edit(p); });
        return c;
      })));
  }

  const appBoxes = (selected, locked) => data.apps.map((a) => [a, checkbox(h('span', null, a.label), selected.includes(a.id), { desc: a.description, locked })]);

  /** Zeigt Link + (einmalig) Code zum Weitergeben. */
  function showCredentials(partner, code, title = 'Zugangsdaten') {
    const link = fullLink(partner.linkPath);
    const m = openModal({
      title,
      body: h('div', { class: 'stack' },
        note(`Schicke ${partner.name} den Link und den Code. Der Code wird nur jetzt angezeigt – danach nur noch als Hash gespeichert.`, 'alert'),
        h('div', null, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Persönlicher Link (dauerhaft, bis du ihn deaktivierst)'),
          h('div', { class: 'link-box' }, h('code', null, link), button('Kopieren', { size: 'sm', icon: 'check', onClick: () => copy(link, 'Link kopiert.') }))),
        code && h('div', null, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Zugangscode'), h('div', { class: 'code-display' }, code),
          h('div', { class: 'row', style: { marginTop: '8px' } }, button('Code kopieren', { size: 'sm', icon: 'check', onClick: () => copy(code, 'Code kopiert.') }),
            button('Beides kopieren', { size: 'sm', onClick: () => copy(`Zugang: ${link}\nCode: ${code}`, 'Link und Code kopiert.') })))),
      footer: [button('Fertig', { variant: 'primary', onClick: () => m.close() })],
    });
  }

  function create() {
    const err = h('div');
    const name = input({ maxLength: 60, placeholder: 'Name oder Bezeichnung des Partners' });
    const noteEl = input({ maxLength: 300, placeholder: 'Interne Notiz (optional)' });
    const code = input({ maxLength: 12, placeholder: 'leer lassen = zufälliger 6-stelliger Code', autocomplete: 'off' });
    const boxes = appBoxes(data.apps.map((a) => a.id), false);
    const m = openModal({
      title: 'Externen Zugang erstellen',
      body: h('div', null, err, field('Name', name), field('Notiz', noteEl), field('Code', code, { help: 'Optional eigener Code aus 6–12 Buchstaben/Ziffern.' }),
        h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Freigeschaltete Apps'), boxes.map(([, c]) => c)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Erstellen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        try {
          const res = await api.post('/api/partners', { name: name.value, note: noteEl.value, code: code.value.trim() || undefined, apps: boxes.filter(([, c]) => c.input.checked).map(([a]) => a.id) });
          m.close(); await load(); showCredentials(res.partner, res.code, 'Zugang erstellt');
        } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }

  function edit(p) {
    const err = h('div');
    const name = input({ value: p.name, maxLength: 60, disabled: !canManage });
    const noteEl = input({ value: p.note, maxLength: 300, disabled: !canManage });
    const boxes = appBoxes(p.apps, !canManage);
    const link = p.linkPath ? fullLink(p.linkPath) : null;
    const act = (fn) => async (e) => busy(e.currentTarget, async () => { try { await fn(); } catch (ex) { toast(ex.message, 'err'); } });
    const footer = [];
    if (canManage) {
      footer.push(button(p.status === 'active' ? 'Link deaktivieren' : 'Link aktivieren', { variant: p.status === 'active' ? 'danger' : 'ok', icon: p.status === 'active' ? 'lock' : 'unlock', onClick: act(async () => {
        if (p.status === 'active') { const r = await confirmDialog({ title: 'Link deaktivieren?', message: `${p.name} wird sofort abgemeldet und kann den Link nicht mehr nutzen. Du kannst ihn jederzeit wieder aktivieren.`, confirmLabel: 'Deaktivieren' }); if (!r) return; }
        await api.patch(`/api/partners/${p.id}`, { status: p.status === 'active' ? 'disabled' : 'active' }); m.close(); toast('Gespeichert.'); load();
      }) }));
      if (!p.dealCount) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: act(async () => {
        const r = await confirmDialog({ title: 'Zugang löschen?', message: `${p.name} wird endgültig gelöscht.`, confirmLabel: 'Löschen' });
        if (!r) return; await api.del(`/api/partners/${p.id}`); m.close(); toast('Gelöscht.'); load();
      }) }));
    }
    footer.push(h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    if (canManage) footer.push(button('Speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      try { await api.patch(`/api/partners/${p.id}`, { name: name.value, note: noteEl.value, apps: boxes.filter(([, c]) => c.input.checked).map(([a]) => a.id) }); m.close(); toast('Gespeichert.'); load(); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) }));
    const m = openModal({
      title: p.name, wide: true,
      body: h('div', null, err,
        p.locked && h('div', { style: { marginBottom: '14px' } }, note(`Wegen zu vieler Fehlversuche gesperrt bis ${fmtDateTime(p.lockedUntil)}. Ein neuer Code hebt die Sperre auf.`, 'alert')),
        link && h('div', { style: { marginBottom: '16px' } }, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Persönlicher Link'),
          h('div', { class: 'link-box' }, h('code', null, link), button('Kopieren', { size: 'sm', icon: 'check', onClick: () => copy(link, 'Link kopiert.') })),
          h('div', { class: 'row', style: { marginTop: '8px' } },
            button('Neuen Code erzeugen', { size: 'sm', icon: 'key', onClick: act(async () => {
              const r = await confirmDialog({ title: 'Neuen Code erzeugen?', message: 'Der alte Code wird ungültig und bestehende Sitzungen werden beendet.', confirmLabel: 'Neuer Code', variant: 'primary' });
              if (!r) return; const res = await api.post(`/api/partners/${p.id}/code`); showCredentials(p, res.code, 'Neuer Code'); load();
            }) }),
            button('Neuen Link erzeugen', { size: 'sm', icon: 'refresh', onClick: act(async () => {
              const r = await confirmDialog({ title: 'Neuen Link erzeugen?', message: 'Der bisherige Link wird sofort ungültig. Du musst den neuen Link weitergeben.', confirmLabel: 'Neuer Link', variant: 'primary' });
              if (!r) return; const res = await api.post(`/api/partners/${p.id}/link`); m.close(); await load(); showCredentials({ ...p, linkPath: res.linkPath }, null, 'Neuer Link');
            }) }))),
        h('div', { class: 'form-row' }, field('Name', name), field('Notiz', noteEl)),
        h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Freigeschaltete Apps'), boxes.map(([, c]) => c),
        h('dl', { class: 'details-dl', style: { marginTop: '14px' } }, h('dt', null, 'Erstellt'), h('dd', null, fmtDateTime(p.createdAt)),
          h('dt', null, 'Letzte Anmeldung'), h('dd', null, p.lastLoginAt ? fmtDateTime(p.lastLoginAt) : 'noch nie'))),
      footer,
    });
  }

  ctx.live(['partners', 'market'], load);
  await load();
}
