import { h, mount } from '../../ui/dom.js';
import { button, busy, card, field, input, select, toggle, toast, skeletons, formError, empty, note, openModal } from '../../ui/kit.js';
import { fmtDateTime } from '../../ui/dom.js';
import { api } from '../../api.js';
import { icon } from '../../ui/icons.js';
import { can, state, applyConfig } from '../../state.js';

const SWATCHES = ['#4f8cff', '#22d3ee', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#94a3b8'];

/** Rendert pro Einstellungstyp das passende Eingabeelement und liefert { el, get }. */
function control(s, disabled) {
  switch (s.type) {
    case 'bool': { const t = toggle(s.value ? 'Aktiviert' : 'Deaktiviert', s.value, null); t.input.disabled = disabled;
      t.input.addEventListener('change', () => (t.lastChild.firstChild.textContent = t.input.checked ? 'Aktiviert' : 'Deaktiviert'));
      return { el: t, get: () => t.input.checked }; }
    case 'number': { const i = input({ type: 'number', value: s.value, min: s.min, max: s.max, disabled }); return { el: i, get: () => Number(i.value) }; }
    case 'select': { const sel = select(s.options, s.value, { disabled }); return { el: sel, get: () => sel.value }; }
    case 'color': {
      const i = input({ type: 'color', value: s.value, class: 'input input-color', disabled });
      const wrap = h('div', null, i, h('div', { class: 'swatches' }, SWATCHES.map((c) => h('button', { type: 'button', class: 'swatch', style: { '--s': c }, disabled, 'aria-label': c,
        onclick: () => { i.value = c; i.dispatchEvent(new Event('input')); } }))));
      return { el: wrap, get: () => i.value };
    }
    default: { const i = input({ value: s.value, maxLength: s.max ?? 80, disabled }); return { el: i, get: () => i.value }; }
  }
}

const readAsDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Datei konnte nicht gelesen werden.')); r.readAsDataURL(file); });
const BRANDING = [
  { kind: 'logo', label: 'Logo', help: 'Wird im App-Menü, auf dem Anmeldebildschirm, als Wasserzeichen und als Favicon verwendet. Transparentes PNG oder WebP (weiß/hell) empfohlen, max. 2 MB.', max: 2 },
  { kind: 'wallpaper', label: 'Hintergrundbild', help: 'Ersetzt den Standard-Hintergrund auf dem Desktop und dem Anmeldebildschirm. Empfohlen: 1920×1080, PNG/JPEG/WebP, max. 8 MB.', max: 8, wide: true },
];

/** Karte „Logo & Hintergrund“: eigene Bilder hochladen oder auf den Standard zurücksetzen. */
function brandingCard(host, editable) {
  const body = h('div');
  host.append(card('Logo & Hintergrund', body, { icon: 'palette', flush: true }));
  const draw = () => mount(body, BRANDING.map((b) => {
    const version = state.config[`branding.${b.kind}_version`];
    const url = version ? `/branding/${b.kind}?v=${version}` : (b.kind === 'logo' ? '/img/logo.webp' : null);
    const preview = h('div', { class: `brand-preview ${b.wide ? 'wide' : ''}`, style: url ? { backgroundImage: `url(${url})` } : {} }, !url && h('span', { class: 'muted' }, 'Standard-Hintergrund'));
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > b.max * 1024 * 1024) return toast(`Die Datei ist zu groß (maximal ${b.max} MB).`, 'err');
      try {
        const { version: v } = await api.post(`/api/admin/branding/${b.kind}`, { data: await readAsDataUrl(f) });
        applyConfig({ ...state.config, [`branding.${b.kind}_version`]: v });
        toast(`${b.label} aktualisiert.`); draw();
      } catch (ex) { toast(ex.message, 'err'); }
      file.value = '';
    });
    return h('div', { class: 'brand-row' }, preview,
      h('div', null, h('div', { class: 'lbl' }, b.label), h('div', { class: 'hlp', style: { marginBottom: '10px' } }, b.help),
        editable && h('div', { class: 'row' }, file, button('Bild hochladen', { icon: 'download', size: 'sm', onClick: () => file.click() }),
          version ? button('Auf Standard zurücksetzen', { size: 'sm', variant: 'ghost', onClick: async () => {
            try { await api.del(`/api/admin/branding/${b.kind}`); applyConfig({ ...state.config, [`branding.${b.kind}_version`]: 0 }); toast('Zurückgesetzt.'); draw(); } catch (ex) { toast(ex.message, 'err'); }
          } }) : null)));
  }));
  draw();
}

/** Zusatzkarten: Logo/Hintergrund, Dashboard-Widgets (Sichtbarkeit/Reihenfolge) und Datensicherung. */
async function addExtras(host, editable) {
  brandingCard(host, editable);
  // Dashboard-Widgets
  const dashHost = h('div');
  host.append(card('Dashboard-Widgets', dashHost, { icon: 'dashboard', flush: true }));
  async function drawWidgets(widgets) {
    const save = async (list) => {
      try { const res = await api.put('/api/dashboard/layout', { widgets: list.map((w) => ({ id: w.id, enabled: w.enabled })) }); drawWidgets(res.widgets); toast('Dashboard gespeichert.'); }
      catch (e) { toast(e.message, 'err'); }
    };
    mount(dashHost, widgets.map((w, i) => {
      const t = toggle('', w.enabled, null); t.input.disabled = !editable;
      t.input.addEventListener('change', () => save(widgets.map((x) => (x.id === w.id ? { ...x, enabled: t.input.checked } : x))));
      return h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr) auto', padding: '12px 20px' } },
        h('div', null, h('div', { class: 'lbl' }, w.title), h('div', { class: 'hlp' }, w.permission ? `Sichtbar mit Recht: ${w.permission}` : 'Für alle freigeschalteten Benutzer')),
        h('div', { class: 'row' }, editable && button('', { size: 'sm', variant: 'ghost', icon: 'chevronU', title: 'Nach oben', disabled: i === 0, onClick: () => { const l = [...widgets]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; save(l); } }),
          editable && button('', { size: 'sm', variant: 'ghost', icon: 'chevronD', title: 'Nach unten', disabled: i === widgets.length - 1, onClick: () => { const l = [...widgets]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; save(l); } }), t));
    }));
  }
  try { drawWidgets((await api.get('/api/dashboard/layout')).widgets); } catch (e) { mount(dashHost, empty('Nicht verfügbar', e.message, 'alert')); }

  // Gefahrenzone: Panel auf null setzen (nur Superadmin)
  if (state.user.isSuperadmin) {
    host.append(card('Gefahrenzone', h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr) auto' } },
      h('div', null, h('div', { class: 'lbl' }, 'Panel auf null zurücksetzen'), h('div', { class: 'hlp' }, 'Löscht ALLE Daten (Benutzer, Rollen, Börse, Kredite, Deckel, Chat, Lager, Fahrzeuge, Einstellungen, Audit-Log, hochgeladene Dateien). Das Programm bleibt installiert – es muss nichts neu geladen werden. Vorher wird automatisch eine Datensicherung angelegt.')),
      button('Zurücksetzen …', { variant: 'danger', icon: 'trash', onClick: () => resetDialog() })), { icon: 'alert', flush: true }));
  }

  // Datensicherung
  if (!can('system.backup')) return;
  const bkHost = h('div');
  host.append(card('Datensicherung', bkHost, { icon: 'server', flush: true }));
  async function drawBackups() {
    const data = await api.get('/api/admin/backups');
    mount(bkHost, h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr) auto' } },
      h('div', null, h('div', { class: 'lbl' }, 'Datenbank sichern'), h('div', { class: 'hlp' }, `Erstellt eine konsistente Kopie im Ordner ${data.directory}. Die letzten 15 Sicherungen bleiben erhalten.`)),
      button('Backup erstellen', { icon: 'download', variant: 'primary', onClick: (e) => busy(e.currentTarget, async () => { try { await api.post('/api/admin/backups'); toast('Backup erstellt.'); drawBackups(); } catch (ex) { toast(ex.message, 'err'); } }) })),
    data.backups.map((b) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon('server')), h('div', { class: 'grow' }, h('div', { class: 't mono' }, b.name), h('div', { class: 's' }, fmtDateTime(b.createdAt))),
      h('span', { class: 'muted' }, `${(b.size / 1024 / 1024).toFixed(2)} MB`))));
  }
  drawBackups().catch((e) => mount(bkHost, empty('Nicht verfügbar', e.message, 'alert')));
}

function resetDialog() {
  const err = h('div'); const text = input({ placeholder: 'ALLES LÖSCHEN', autocomplete: 'off' }); const pw = input({ type: 'password', autocomplete: 'current-password' });
  const go = button('Alles endgültig löschen', { variant: 'danger', icon: 'trash', disabled: true, onClick: (e) => busy(e.currentTarget, async () => {
    err.replaceChildren();
    try { await api.post('/api/admin/reset', { confirm: text.value, password: pw.value }); toast('Das Panel wurde zurückgesetzt.'); setTimeout(() => location.replace('/reset'), 600); }
    catch (ex) { err.replaceChildren(formError(ex.message)); }
  }) });
  text.addEventListener('input', () => { go.disabled = text.value !== 'ALLES LÖSCHEN'; });
  const m = openModal({ title: 'Panel wirklich auf null setzen?', body: h('div', null, err,
    note('Alle Daten werden unwiderruflich gelöscht – auch alle Benutzer, auch dein eigener. Danach erscheint wieder die Ersteinrichtung. Eine automatische Datensicherung wird vorher im Ordner „backups“ angelegt.', 'alert'), h('div', { style: { height: '12px' } }),
    field('Zur Bestätigung „ALLES LÖSCHEN“ eintippen', text), field('Dein Passwort', pw)),
  footer: [button('Abbrechen', { onClick: () => m.close() }), go] });
}

export default async function render(container, ctx) {
  mount(container, skeletons(3, 120));
  const { settings } = await api.get('/api/config');
  if (!ctx.isCurrent()) return;
  const editable = can('config.edit');
  const controls = new Map();
  const groups = {};
  for (const s of settings.filter((x) => !x.hidden)) (groups[s.group] ??= []).push(s);

  const err = h('div');
  const cards = Object.entries(groups).map(([g, items]) => card(g, items.map((s) => {
    const c = control(s, !editable);
    controls.set(s.key, { ...c, initial: s.value });
    // Live-Vorschau: jede Änderung an Darstellungs-Einstellungen wirkt sofort (gespeichert wird erst per Knopf)
    if (s.key.startsWith('ui.')) {
      const fire = () => window.dispatchEvent(new CustomEvent('mdt:config', { detail: Object.fromEntries([...controls].filter(([k]) => k.startsWith('ui.')).map(([k, cc]) => [k, cc.get()]).filter(([, v]) => !(typeof v === 'number' && Number.isNaN(v)))) }));
      c.el.addEventListener('input', fire); c.el.addEventListener('change', fire);
    }
    return h('div', { class: 'setting-row' }, h('div', null, h('div', { class: 'lbl' }, s.label), s.help && h('div', { class: 'hlp' }, s.help)), c.el);
  }), { flush: true, icon: g === 'Darstellung' ? 'palette' : g === 'Zugang' ? 'lock' : g === 'Mitglieder' ? 'users' : 'sliders' }));

  const save = button('Änderungen speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
    err.replaceChildren();
    const values = {};
    for (const [k, c] of controls) if (JSON.stringify(c.get()) !== JSON.stringify(c.initial)) values[k] = c.get();
    if (!Object.keys(values).length) return toast('Keine Änderungen.', 'info');
    try {
      const res = await api.put('/api/config', { values });
      for (const s of res.settings) if (controls.has(s.key)) controls.get(s.key).initial = s.value;
      applyConfig({ ...state.config, ...values });
      document.querySelector('.brand-name') && (document.querySelectorAll('.brand-name').forEach((n) => (n.textContent = state.config['system.name'])));
      toast('Einstellungen gespeichert.');
    } catch (ex) { err.replaceChildren(formError(ex.message)); }
  }) });
  const extras = h('div', { class: 'stack', style: { gap: '18px' } });
  mount(container, h('div', { class: 'stack', style: { gap: '18px' } }, err, cards, extras), editable && h('div', { class: 'savebar' }, save));
  addExtras(extras, editable);
  // ungespeicherte Live-Vorschau der Akzentfarbe beim Verlassen zurücksetzen
  return () => applyConfig(state.config); // ungespeicherte Vorschau verwerfen
}
