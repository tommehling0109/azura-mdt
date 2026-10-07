import { h, mount, fmtDateTime, timeAgo } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, busy, card, field, input, select, checkbox, formError, openModal, confirmDialog, toast, skeletons, empty, note, badge, avatar } from '../../ui/kit.js';
import { api } from '../../api.js';
import { can } from '../../state.js';

const fullLink = (path) => `${location.origin}${path}`;

async function copy(text, label = 'Kopiert.') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast('Kopieren nicht möglich – bitte manuell markieren.', 'warn'); }
}

/** Telefonnummer wird schon beim Tippen ins Format (555) 123-4567 gebracht; Löschen von Sonderzeichen entfernt eine Ziffer. */
export const formatPhone = (digits) => {
  const d = digits.replace(/\D/g, '').slice(0, 10);
  if (!d) return '';
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
};
function phoneInput(value) {
  const el = input({ value: value ?? '', placeholder: '(555) 123-4567', inputmode: 'tel', maxLength: 14, autocomplete: 'off' });
  let prev = el.value;
  el.addEventListener('input', (e) => {
    let digits = el.value.replace(/\D/g, '');
    if (e.inputType?.startsWith('delete') && digits === prev.replace(/\D/g, '')) digits = digits.slice(0, -1); // nur ein Sonderzeichen gelöscht → Ziffer davor entfernen
    el.value = formatPhone(digits); prev = el.value;
  });
  return el;
}
const readFile = (file, maxMb = 5) => new Promise((res, rej) => {
  if (file.size > maxMb * 1024 * 1024) return rej(new Error(`${file.name}: Datei zu groß (max. ${maxMb} MB).`));
  const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = () => rej(new Error('Datei konnte nicht gelesen werden.')); rd.readAsDataURL(file);
});
/** Datei-Auswahl mit Anzeige des gewählten Dateinamens */
function filePicker(label, existing) {
  const f = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg,image/webp', hidden: true });
  const name = h('span', { class: 'muted' }, existing ?? 'Keine Datei gewählt');
  const btn = button(label, { size: 'sm', icon: 'download', onClick: () => f.click() });
  f.addEventListener('change', () => { name.textContent = f.files[0]?.name ?? (existing ?? 'Keine Datei gewählt'); });
  return { el: h('div', { class: 'row', style: { alignItems: 'center' } }, f, btn, name), file: () => f.files[0] ?? null };
}
const TYPE_OPTIONS = [{ value: 'customer', label: 'Kunde / Partner' }, { value: 'supplier', label: 'Lieferant (alle Angaben Pflicht)' }];

/**
 * Stammdaten eines externen Zugangs: Vorname / Nachname / Geburtsdatum / Postal Code / Straße / UMail / Telefon / Kontonummer + Ausweis, Waffenschein.
 * Bei Lieferanten sind alle Felder Pflicht, sonst optional. Der Server prüft zusätzlich.
 */
function profileForm(p, { docs }) {
  const a = { ...(p ?? {}) };
  const type = select(TYPE_OPTIONS, a.type ?? 'customer');
  const first = input({ value: a.firstName ?? '', maxLength: 40, autocomplete: 'off' }), last = input({ value: a.lastName ?? '', maxLength: 40, autocomplete: 'off' });
  const birth = input({ type: 'date', value: a.birthDate ?? '', max: new Date().toISOString().slice(0, 10) });
  const postal = input({ value: a.postalCode ?? '', maxLength: 12, placeholder: 'z. B. 1234', autocomplete: 'off' }), street = input({ value: a.street ?? '', maxLength: 80, autocomplete: 'off' });
  const umail = input({ value: a.umailLocal ?? '', maxLength: 40, placeholder: 'name', autocomplete: 'off' });
  umail.addEventListener('input', () => { umail.value = umail.value.toLowerCase().replace(/@.*$/, '').replace(/[^a-z0-9._-]/g, ''); });
  const phone = phoneInput(a.phone); const account = input({ value: a.accountNumber ?? '', maxLength: 20, placeholder: 'z. B. LS28180705', autocomplete: 'off' });
  account.addEventListener('input', () => { account.value = account.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); });
  const weapon = h('input', { type: 'checkbox', checked: !!a.weaponRequired }); const idPick = filePicker(a.docs?.id ? 'Ausweis ersetzen' : 'Ausweis hochladen', a.docs?.id ? 'Ausweis liegt vor' : null);
  const wPick = filePicker(a.docs?.weapon ? 'Waffenschein ersetzen' : 'Waffenschein hochladen', a.docs?.weapon ? 'Waffenschein liegt vor' : null);
  const req = h('div', { class: 'help', style: { margin: '0 0 12px' } });
  const lbl = (t, must) => (must ? `${t} *` : t);
  const rows = h('div');
  const draw = () => {
    const sup = type.value === 'supplier';
    req.textContent = sup ? 'Lieferant: Alle mit * markierten Felder sowie der Ausweis sind Pflicht.' : 'Alle Angaben sind optional – bei Lieferanten Pflicht.';
    mount(rows, req,
      h('div', { class: 'form-row' }, field(lbl('Vorname', sup), first), field(lbl('Nachname', sup), last)),
      h('div', { class: 'form-row' }, field(lbl('Geburtsdatum', sup), birth), field(lbl('Telefonnummer', sup), phone)),
      h('div', { class: 'form-row' }, field(lbl('Postal Code', sup), postal), field(lbl('Straße', sup), street)),
      h('div', { class: 'form-row' }, field(lbl('UMail', sup), h('div', { class: 'input-group' }, umail, h('span', { class: 'addon' }, '@umail.com')), { help: 'RP-interne Mail – die Endung ist fest.' }), field(lbl('Kontonummer', sup), account)),
      docs && field(lbl('Ausweis', sup), idPick.el, { help: 'PDF, PNG, JPG oder WebP, max. 5 MB.' }),
      docs && h('label', { class: 'check', style: { padding: 0, marginBottom: '6px' } }, weapon, h('span', { class: 'check-text' }, 'Waffenschein erforderlich')),
      docs && weapon.checked && field('Waffenschein', wPick.el, { help: 'Pflicht, wenn der Waffenschein erforderlich ist.' }));
  };
  type.addEventListener('change', draw); weapon.addEventListener('change', draw); draw();
  return {
    el: h('div', null, field('Art des Zugangs', type), rows),
    values: () => ({ type: type.value, firstName: first.value.trim(), lastName: last.value.trim(), birthDate: birth.value || null, postalCode: postal.value.trim(), street: street.value.trim(), umail: umail.value.trim(), phone: phone.value.trim(), accountNumber: account.value.trim(), weaponRequired: weapon.checked }),
    files: async () => ({ idDoc: idPick.file() ? await readFile(idPick.file()) : null, weaponDoc: weapon.checked && wPick.file() ? await readFile(wPick.file()) : null }),
  };
}

export default async function render(container, ctx) {
  const canManage = can('partners.manage'), canDocs = can('partners.documents'), canDelete = can('partners.delete');
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
          h('div', { class: 'desc' }, p.type === 'supplier' && badge('Lieferant', 'b-warn', false), ' ', p.note || h('span', { class: 'muted' }, 'Keine Notiz')),
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
    const name = input({ maxLength: 60, placeholder: 'Nur nötig, wenn Vor-/Nachname leer bleiben (z. B. Firmenname)' });
    const noteEl = input({ maxLength: 300, placeholder: 'Interne Notiz (optional)' });
    const prof = profileForm(null, { docs: canDocs });
    const code = input({ maxLength: 12, placeholder: 'leer lassen = zufälliger 6-stelliger Code', autocomplete: 'off' });
    const boxes = appBoxes(data.apps.map((a) => a.id), false);
    const m = openModal({
      title: 'Externen Zugang erstellen', wide: true,
      body: h('div', null, err, prof.el, field('Bezeichnung (optional)', name), field('Notiz', noteEl), field('Code', code, { help: 'Optional eigener Code aus 6–12 Buchstaben/Ziffern.' }),
        h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Freigeschaltete Apps'), boxes.map(([, c]) => c)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Erstellen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        try {
          const files = await prof.files();
          const res = await api.post('/api/partners', { ...prof.values(), ...files, name: name.value.trim() || undefined, note: noteEl.value, code: code.value.trim() || undefined, apps: boxes.filter(([, c]) => c.input.checked).map(([a]) => a.id) });
          m.close(); await load(); showCredentials(res.partner, res.code, 'Zugang erstellt');
        } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }

  /** Ausweis/Waffenschein: ansehen und ersetzen (nur mit „partners.documents“) */
  function docBox(p) {
    if (!canDocs) return null;
    const one = (kind, label, has) => {
      const f = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg,image/webp', hidden: true });
      f.addEventListener('change', async () => {
        if (!f.files[0]) return;
        try { await api.post(`/api/partners/${p.id}/docs/${kind}`, { data: await readFile(f.files[0], 5) }); toast(`${label} gespeichert.`); load(); } catch (ex) { toast(ex.message, 'err'); }
      });
      return h('div', { class: 'row', style: { alignItems: 'center', marginBottom: '6px' } }, h('b', { style: { minWidth: '110px' } }, label), has ? badge('liegt vor', 'b-ok', false) : badge('fehlt', 'b-mute', false),
        has && h('a', { class: 'btn btn-sm', href: `/api/partners/${p.id}/docs/${kind}`, target: '_blank', rel: 'noopener' }, icon('search'), 'Ansehen'), canManage && f, canManage && button(has ? 'Ersetzen' : 'Hochladen', { size: 'sm', icon: 'download', onClick: () => f.click() }));
    };
    return h('div', { style: { margin: '12px 0' } }, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Dokumente'), one('id', 'Ausweis', p.docs.id), (p.weaponRequired || p.docs.weapon) && one('weapon', 'Waffenschein', p.docs.weapon));
  }

  function edit(p) {
    const err = h('div');
    const name = input({ value: p.name, maxLength: 60, disabled: !canManage });
    const noteEl = input({ value: p.note, maxLength: 300, disabled: !canManage });
    const prof = profileForm(p, { docs: false });
    const boxes = appBoxes(p.apps, !canManage);
    const link = p.linkPath ? fullLink(p.linkPath) : null;
    const act = (fn) => async (e) => busy(e.currentTarget, async () => { try { await fn(); } catch (ex) { toast(ex.message, 'err'); } });
    const footer = [];
    if (canManage) {
      footer.push(button(p.status === 'active' ? 'Link deaktivieren' : 'Link aktivieren', { variant: p.status === 'active' ? 'danger' : 'ok', icon: p.status === 'active' ? 'lock' : 'unlock', onClick: act(async () => {
        if (p.status === 'active') { const r = await confirmDialog({ title: 'Link deaktivieren?', message: `${p.name} wird sofort abgemeldet und kann den Link nicht mehr nutzen. Du kannst ihn jederzeit wieder aktivieren.`, confirmLabel: 'Deaktivieren' }); if (!r) return; }
        await api.patch(`/api/partners/${p.id}`, { status: p.status === 'active' ? 'disabled' : 'active' }); m.close(); toast('Gespeichert.'); load();
      }) }));
      footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: act(async () => {
        const r = await confirmDialog({ title: 'Zugang löschen?', message: `${p.name} wird endgültig gelöscht.`, confirmLabel: 'Löschen' });
        if (!r) return;
        try { await api.del(`/api/partners/${p.id}`); } catch (ex) {
          if (ex.status !== 409 || !canDelete) throw ex;
          const all = await confirmDialog({ title: 'Samt aller Daten löschen?', message: `${ex.message.split(' Deaktiviere')[0]} Alles wird mit gelöscht (Geschäfte, Kredite, Finanz-Einträge, Dokumente). Das lässt sich nicht rückgängig machen.`, confirmLabel: 'Alles endgültig löschen' });
          if (!all) return; await api.del(`/api/partners/${p.id}?force=1`);
        }
        m.close(); toast('Gelöscht.'); load();
      }) }));
    }
    footer.push(h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    if (canManage) footer.push(button('Speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      try { await api.patch(`/api/partners/${p.id}`, { ...prof.values(), name: name.value, note: noteEl.value, apps: boxes.filter(([, c]) => c.input.checked).map(([a]) => a.id) }); m.close(); toast('Gespeichert.'); load(); }
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
        h('div', { class: 'form-row' }, field('Name', name), field('Notiz', noteEl)), canManage && prof.el, docBox(p),
        h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Freigeschaltete Apps'), boxes.map(([, c]) => c),
        h('dl', { class: 'details-dl', style: { marginTop: '14px' } }, h('dt', null, 'Erstellt'), h('dd', null, fmtDateTime(p.createdAt)),
          h('dt', null, 'Letzte Anmeldung'), h('dd', null, p.lastLoginAt ? fmtDateTime(p.lastLoginAt) : 'noch nie'))),
      footer,
    });
  }

  ctx.live(['partners', 'market'], load);
  await load();
}
