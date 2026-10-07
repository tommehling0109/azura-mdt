import { h, mount, fmtDateTime, fmtDate, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, card, field, input, select, table, tabs, formError, openModal, confirmDialog, toast, skeletons, empty, note, memberNo, badge } from '../ui/kit.js';
import { api } from '../api.js';
import { can, state } from '../state.js';

export const fmtC = (c) => `${(Number(c ?? 0) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${state.config['market.currency'] || '$'}`;
/** „1.284,50“ / „1284.5“ / „25“ → Cent (oder null) */
export function parseMoney(text) {
  let s = String(text ?? '').trim().replace(/\s|[€$]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
const statusBadge = (s) => h('span', { class: 'badge', style: { '--c': s.statusColor } }, s.statusLabel);
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); toast('Link kopiert.'); } catch { toast('Kopieren nicht möglich – bitte manuell markieren.', 'warn'); } };
const fullLink = (path) => `${location.origin}${path}`;

export default async function render(container, ctx) {
  let opts = await api.get('/api/tab/options');
  const O = () => opts;
  const showOverview = opts.canView || opts.canStatements, showCompanies = opts.canView || opts.canCompanies || opts.canStatements;
  const TABS = [
    showOverview && { id: 'overview', label: 'Übersicht' },
    (opts.canBook || opts.canView) && { id: 'entries', label: 'Buchungen' },
    showOverview && { id: 'statements', label: 'Abrechnungen' },
    showCompanies && { id: 'companies', label: 'Firmen' },
  ].filter(Boolean);
  let tab = TABS[0].id;
  const f = { company: '', status: '', q: '', stStatus: '' };
  const tabHost = h('div', { style: { marginBottom: '16px' } });
  const host = h('div');
  mount(container, tabHost, host);

  function drawActions() {
    ctx.setActions(
      tab === 'entries' && opts.canBook && button('Auf Deckel schreiben', { variant: 'primary', icon: 'plus', onClick: () => bookDialog() }),
      tab === 'companies' && opts.canCompanies && button('Firma anlegen', { variant: 'primary', icon: 'plus', onClick: () => companyEditor(null) }));
  }
  async function show(t, silent = false) {
    tab = t; drawActions();
    if (!silent) mount(host, skeletons(3, 90));
    try { opts = await api.get('/api/tab/options'); } catch { /* alte Optionen */ }
    mount(tabHost, tabs(TABS, tab, (x) => show(x)));
    try { await ({ overview, entries, statements, companies })[tab](); } catch (e) { mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
  }

  // ── Übersicht ──
  async function overview() {
    const { summary: s } = await api.get('/api/tab/summary');
    if (!ctx.isCurrent() || tab !== 'overview') return;
    const tile = (v, label, tone, to) => { const el = h('div', { class: `tile ${tone ? 't-' + tone : ''} clickable` }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, v), h('div', { class: 'tile-label' }, label))); el.addEventListener('click', () => { f.stStatus = to ?? ''; show('statements'); }); return el; };
    mount(host, h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(s.openCompanies, 'Offene Deckel (Firmen)', s.openCompanies ? 'info' : '', ''), tile(s.pendingPeriods, 'Abrechnungen ausstehend', s.pendingPeriods ? 'warn' : '', ''),
        tile(s.submitted + s.review, 'Eingereicht / in Prüfung', s.submitted ? 'warn' : '', 'submitted'), tile(s.confirmed + s.paymentPending, 'Zahlungen ausstehend', s.paymentPending + s.confirmed ? 'warn' : '', 'payment_pending'), tile(s.paid, 'Bezahlt', 'ok', 'paid')),
      h('div', { class: 'fin-balance neg' }, h('div', { class: 'fb-l' }, 'Gesamt offen (noch nicht bezahlte Deckelbuchungen)'), h('div', { class: 'fb-v' }, fmtC(s.openCents))),
      card('Aktuelle Abrechnungen', table([
        { label: 'Firma', render: (x) => h('b', null, x.company) }, { label: 'Intervall', render: (x) => x.interval }, { label: 'Zeitraum', render: (x) => x.period },
        { label: 'Betrag', render: (x) => fmtC(x.submittedCents) }, { label: 'Status', render: (x) => h('span', { class: 'badge', style: { '--c': x.statusColor } }, x.statusLabel) },
      ], s.recent, { onRowClick: (x) => openStatement(x.id), empty: empty('Noch keine Abrechnungen', 'Sobald eine Firma ihren Betrag übermittelt, erscheint sie hier.', 'dollar') }), { icon: 'dollar', flush: true })));
  }

  // ── Buchungen ──
  async function entries() {
    const p = new URLSearchParams();
    if (f.company) p.set('company', f.company);
    if (f.status) p.set('status', f.status);
    if (f.q) p.set('q', f.q);
    if (opts.canView && !companyCache.length) { try { companyCache = (await api.get('/api/tab/companies')).companies; } catch { /* ohne Firmenliste */ } }
    const { entries: rows, totalCents } = await api.get(`/api/tab/entries?${p}`);
    if (!ctx.isCurrent() || tab !== 'entries') return;
    const had = host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    const search = input({ placeholder: 'Personalnummer, Zweck, Nummer …', value: f.q });
    search.addEventListener('input', debounce(() => { f.q = search.value.trim(); show('entries', true); }));
    const comp = select([{ value: '', label: 'Alle Firmen' }, ...allCompanies().map((c) => ({ value: c.id, label: c.name }))], f.company, { style: { width: '190px' } });
    comp.addEventListener('change', () => { f.company = comp.value; show('entries', true); });
    const st = select([{ value: '', label: 'Alle Status' }, { value: 'active', label: 'Aktiv' }, { value: 'cancelled', label: 'Storniert' }], f.status, { style: { width: '150px' } });
    st.addEventListener('change', () => { f.status = st.value; show('entries', true); });
    mount(host, h('div', { class: 'toolbar' }, h('div', { class: 'input-icon' }, icon('search'), search), comp, st, h('div', { class: 'grow' }), h('span', { class: 'muted' }, `${rows.length} Buchungen · Summe aktiv `), h('b', null, fmtC(totalCents))),
      table([
        { label: 'Nr.', style: { width: '1%' }, render: (e) => memberNo(e.number) },
        { label: 'Firma', render: (e) => e.company.name }, { label: 'Personalnr.', render: (e) => h('span', { class: 'member-no' }, e.memberNumber) },
        { label: 'Betrag', render: (e) => h('b', { style: e.status === 'cancelled' ? { textDecoration: 'line-through', opacity: 0.6 } : {} }, fmtC(e.amountCents)) },
        { label: 'Verwendungszweck', render: (e) => h('div', null, e.description, e.correctsId && h('div', { class: 'muted', style: { fontSize: '11.5px' } }, 'Korrekturbuchung'), e.cancelReason && h('div', { class: 'muted', style: { fontSize: '11.5px' } }, `Storno: ${e.cancelReason}`)) },
        { label: 'Zeitraum', render: (e) => e.period?.label }, { label: 'Erfasst', render: (e) => h('div', null, fmtDateTime(e.createdAt), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, `von ${e.creator}`)) },
        { label: 'Status', render: (e) => (e.status === 'active' ? badge('Aktiv', 'b-ok') : badge('Storniert', 'b-mute')) },
        opts.canCancel && { label: '', style: { whiteSpace: 'nowrap' }, render: (e) => e.status === 'active' && h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, button('Korrigieren', { size: 'sm', icon: 'edit', onClick: () => correctDialog(e) }), button('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Stornieren', onClick: () => cancelDialog(e) })) },
      ].filter(Boolean), rows, { empty: empty('Keine Buchungen', opts.canBook ? 'Schreibe etwas auf Deckel – jede Buchung braucht eine Personalnummer.' : null, 'dollar') }));
    if (had) { const i = host.querySelector('input'); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }
  }
  let companyCache = [];
  const allCompanies = () => (companyCache.length ? companyCache : opts.companies);

  async function bookDialog() {
    if (!opts.companies.length) return toast('Es gibt keine Firma, auf die du schreiben darfst.', 'warn');
    const err = h('div');
    const comp = select(opts.companies.map((c) => ({ value: c.id, label: `${c.name} (${c.intervalLabel})` })), '');
    const pn = input({ value: opts.ownNumber ?? '', maxLength: 20, placeholder: 'z. B. AZ-221', readOnly: !opts.canBookOthers && !!opts.ownNumber, autocomplete: 'off' });
    const who = h('div', { class: 'help', style: { minHeight: '18px' } });
    const amount = input({ inputmode: 'decimal', placeholder: '0,00' });
    const desc = input({ maxLength: 200, placeholder: 'z. B. Mittagessen' });
    let valid = false;
    const check = debounce(async () => {
      const n = pn.value.trim();
      valid = false;
      if (!n) { who.textContent = ''; return; }
      try {
        const r = await api.get(`/api/tab/member?number=${encodeURIComponent(n)}&companyId=${comp.value}`);
        if (!r.found) who.replaceChildren(h('span', { style: { color: 'var(--err)' } }, r.reason));
        else if (!r.allowed) who.replaceChildren(h('span', { style: { color: 'var(--err)' } }, `${r.number}: ${r.reason}`));
        else { valid = true; who.replaceChildren(h('span', { style: { color: 'var(--ok, #34d399)' } }, `✓ Mitglied erkannt: ${r.number}${r.own ? ' (du)' : ''}`)); }
      } catch (e) { who.textContent = e.message; }
    }, 250);
    pn.addEventListener('input', check); comp.addEventListener('change', check);
    const m = openModal({
      title: 'Auf Deckel schreiben',
      body: h('div', null, err, field('Firma', comp), field('Personalnummer (Pflicht)', pn, { help: opts.canBookOthers ? 'Du darfst auch für andere Mitglieder buchen.' : 'Es zählt deine eigene Personalnummer.' }), who, h('div', { style: { height: '8px' } }),
        h('div', { class: 'form-row' }, field('Betrag', amount), field('Verwendungszweck', desc))),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Buchen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        const c = parseMoney(amount.value);
        if (!c) return err.replaceChildren(formError('Bitte einen gültigen Betrag eingeben (z. B. 25,50).'));
        try {
          const { entry } = await api.post('/api/tab/entries', { companyId: Number(comp.value), memberNumber: pn.value.trim(), amountCents: c, description: desc.value.trim() });
          m.close(); toast(`Gebucht: ${fmtC(entry.amountCents)} für ${entry.memberNumber} · ${entry.period.label}`); show('entries', true);
        } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
    check();
  }
  function cancelDialog(e) {
    const err = h('div'); const reason = input({ maxLength: 200, placeholder: 'Begründung (Pflicht)' });
    const m = openModal({ title: `Buchung ${e.number} stornieren`, body: h('div', null, err, note(`${fmtC(e.amountCents)} · ${e.memberNumber} · ${e.description}. Die Buchung wird nicht gelöscht, sondern als storniert protokolliert.`, 'alert'), h('div', { style: { height: '10px' } }), field('Begründung', reason)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Stornieren', { variant: 'danger', icon: 'x', onClick: (b) => busy(b.currentTarget, async () => {
        try { await api.post(`/api/tab/entries/${e.id}/cancel`, { reason: reason.value }); m.close(); toast('Storniert.'); show('entries', true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }
  function correctDialog(e) {
    const err = h('div'); const amount = input({ inputmode: 'decimal', value: (e.amountCents / 100).toFixed(2).replace('.', ',') }); const desc = input({ value: e.description, maxLength: 200 }); const reason = input({ maxLength: 200, placeholder: 'Begründung (Pflicht)' });
    const m = openModal({ title: `Buchung ${e.number} korrigieren`, body: h('div', null, err, note('Die alte Buchung wird storniert und durch eine neue, verknüpfte Buchung ersetzt – nichts wird überschrieben.', 'info'), h('div', { style: { height: '10px' } }),
      h('div', { class: 'form-row' }, field('Neuer Betrag', amount), field('Verwendungszweck', desc)), field('Begründung', reason)),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button('Korrigieren', { variant: 'primary', icon: 'check', onClick: (b) => busy(b.currentTarget, async () => {
      const c = parseMoney(amount.value); if (!c) return err.replaceChildren(formError('Ungültiger Betrag.'));
      try { await api.post(`/api/tab/entries/${e.id}/correct`, { amountCents: c, description: desc.value, reason: reason.value }); m.close(); toast('Korrigiert.'); show('entries', true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })] });
  }

  // ── Abrechnungen ──
  async function statements() {
    const p = new URLSearchParams(); if (f.stStatus) p.set('status', f.stStatus);
    const { statements: rows } = await api.get(`/api/tab/statements?${p}`);
    if (!ctx.isCurrent() || tab !== 'statements') return;
    const chips = h('div', { class: 'count-chips' }, h('span', { class: 'chip-label' }, 'Status'), [['', 'Alle', '#94a3b8'], ...opts.statuses.map((s) => [s.key, s.label, s.color])].map(([k, label, color]) => {
      const b = h('button', { class: `cchip ${f.stStatus === k ? 'on' : ''}`, type: 'button', style: { '--c': color } }, h('span', { class: 'dot' }), label);
      b.addEventListener('click', () => { f.stStatus = k; show('statements', true); });
      return b;
    }));
    mount(host, chips, table([
      { label: 'Nr.', style: { width: '1%' }, render: (s) => memberNo(s.number) }, { label: 'Firma', render: (s) => h('b', null, s.company.name) }, { label: 'Zeitraum', render: (s) => s.period?.label },
      { label: 'Eingereicht', render: (s) => fmtC(s.submittedCents) }, { label: 'Unsere Summe', render: (s) => fmtC(s.ourCents) },
      { label: 'Abgleich', render: (s) => (['paid', 'rejected'].includes(s.status) && s.matches ? h('span', { class: 'muted' }, '–') : s.matches ? badge('Stimmt', 'b-ok') : badge(`${s.diffCents > 0 ? '+' : ''}${fmtC(s.diffCents)}`, 'b-err')) },
      { label: 'Status', render: statusBadge }, { label: 'Eingegangen', render: (s) => fmtDateTime(s.submittedAt) },
    ], rows, { onRowClick: (s) => openStatement(s.id), empty: empty('Keine Abrechnungen', 'Firmen reichen ihre Abrechnungen über den persönlichen Portal-Link ein.', 'dollar') }));
  }

  async function openStatement(id) {
    const body = h('div', null, skeletons(3, 70));
    let off;
    const m = openModal({ title: 'Abrechnung', wide: true, body, footer: null, onClose: () => off?.() });
    const footer = h('div', { class: 'modal-foot' }); m.el.append(footer);
    let dtab = 'info';
    async function reload() {
      let d;
      try { d = await api.get(`/api/tab/statements/${id}`); } catch (e) { mount(body, note(e.message, 'alert')); return; }
      const s = d.statement, manage = d.canManage;
      m.el.querySelector('.modal-head h3').textContent = `${s.number} · ${s.company.name} · ${s.period?.label}`;
      const cmp = h('div', { class: `cmp ${s.matches ? 'ok' : 'bad'}` },
        h('div', null, h('span', { class: 'k' }, 'Unsere Summe'), h('b', null, fmtC(s.ourCents)), h('span', { class: 'k' }, `${s.entryCount} Buchungen`)),
        h('div', null, h('span', { class: 'k' }, 'Firma eingereicht'), h('b', null, fmtC(s.submittedCents))),
        h('div', null, h('span', { class: 'k' }, 'Differenz'), h('b', null, `${s.diffCents > 0 ? '+' : ''}${fmtC(s.diffCents)}`)),
        h('div', { class: 'cmp-state' }, s.matches ? 'Betrag stimmt überein' : 'Abweichung vorhanden – Prüfung nötig'));
      const info = h('div', { class: 'stack-v' }, h('div', { class: 'chips' }, statusBadge(s), s.payMethod && badge(s.payMethod === 'transfer' ? 'Überweisung' : 'Rechnung der Firma', 'b-info', false)), cmp,
        s.comment && note(`Kommentar der Firma: ${s.comment}`, 'chat'), s.diffNote && note(`Notiz zur Abweichung: ${s.diffNote}`, 'alert'), s.rejectReason && note(`Abgelehnt: ${s.rejectReason}`, 'x'),
        h('dl', { class: 'details-dl' },
          h('dt', null, 'Firma'), h('dd', null, `${s.company.name} (${s.company.number}) · ${s.company.interval === 'weekly' ? 'wöchentlich' : 'monatlich'}`), h('dt', null, 'Zeitraum'), h('dd', null, `${s.period?.label} (${fmtDate(s.period?.from)} – ${fmtDate(s.period?.to)})`),
          h('dt', null, 'Eingereicht am'), h('dd', null, fmtDateTime(s.submittedAt)), s.approvedCents != null && [h('dt', null, 'Freigegebener Betrag'), h('dd', null, h('b', null, fmtC(s.approvedCents)))],
          s.reviewer && [h('dt', null, 'Bearbeitet von'), h('dd', null, s.reviewer)], s.paidAt && [h('dt', null, 'Bezahlt am'), h('dd', null, fmtDate(s.paidAt))], s.payReference && [h('dt', null, 'Transaktion'), h('dd', { class: 'mono' }, s.payReference)]),
        s.payMethod === 'invoice' || s.invoice.received ? invoiceBox(s, manage) : null);
      const entriesTab = h('div', null,
        h('div', { class: 'sub-title' }, 'Summe je Personalnummer'), table([{ label: 'Personalnr.', render: (x) => h('span', { class: 'member-no' }, x.memberNumber) }, { label: 'Buchungen', render: (x) => x.count }, { label: 'Summe', render: (x) => h('b', null, fmtC(x.totalCents)) }], d.byMember, { empty: empty('Keine aktiven Buchungen', null, 'dollar') }),
        h('div', { style: { height: '14px' } }), h('div', { class: 'sub-title' }, `Alle Buchungen des Zeitraums (Gesamt ${fmtC(d.entries.filter((e) => e.status === 'active').reduce((a, e) => a + e.amountCents, 0))})`),
        table([{ label: 'Nr.', render: (e) => memberNo(e.number) }, { label: 'Personalnr.', render: (e) => e.memberNumber }, { label: 'Betrag', render: (e) => h('span', { style: e.status === 'cancelled' ? { textDecoration: 'line-through', opacity: 0.6 } : {} }, fmtC(e.amountCents)) },
          { label: 'Zweck', render: (e) => e.description }, { label: 'Zeit', render: (e) => fmtDateTime(e.createdAt) }, { label: 'Status', render: (e) => (e.status === 'active' ? badge('Aktiv', 'b-ok') : badge('Storniert', 'b-mute')) }], d.entries));
      const logTab = h('div', null, d.log.length ? d.log.map((l) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon('activity')), h('div', { class: 'grow' }, h('div', { class: 't', style: { whiteSpace: 'normal' } }, l.text), h('div', { class: 's' }, `${l.actor} · ${fmtDateTime(l.ts)}`)))) : empty('Noch kein Verlauf', null, 'activity'));
      const panes = { info, entries: entriesTab, log: logTab };
      const content = h('div'); mount(content, panes[dtab]);
      const tbar = tabs([{ id: 'info', label: 'Übersicht' }, { id: 'entries', label: 'Buchungen', count: d.entries.length }, { id: 'log', label: 'Verlauf', count: d.log.length }], dtab, (x) => { dtab = x; mount(content, panes[x]); });
      tbar.style.marginBottom = '16px';
      mount(body, tbar, content);
      mount(footer, manage && actions(s, reload), h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    }
    const actions = (s, after) => {
      const run = (action, payload = {}, msg) => async () => { try { await api.post(`/api/tab/statements/${s.id}/${action}`, payload); if (msg) toast(msg); await after(); show(tab, true); } catch (ex) { toast(ex.message, 'err'); } };
      const out = [];
      if (s.status === 'submitted') out.push(button('Prüfung starten', { variant: 'info', icon: 'search', onClick: run('review', {}, 'In Prüfung.') }));
      if (['submitted', 'review'].includes(s.status)) out.push(button('Bestätigen', { variant: 'ok', icon: 'check', onClick: () => confirmDialogFor(s, after) }));
      if (s.status === 'confirmed') out.push(button('Zahlung per Überweisung', { variant: 'primary', icon: 'dollar', onClick: run('prepare', { method: 'transfer' }, 'Zahlung vorbereitet.') }), button('Rechnung der Firma', { variant: 'primary', icon: 'audit', onClick: run('prepare', { method: 'invoice' }, 'Zahlung vorbereitet.') }));
      if (s.status === 'payment_pending') out.push(s.payMethod === 'transfer' ? button('Überweisung dokumentieren', { variant: 'ok', icon: 'check', onClick: () => payDialog(s, after) }) : button('Als bezahlt markieren', { variant: 'ok', icon: 'check', onClick: run('pay', {}, 'Als bezahlt markiert.') }));
      if (['submitted', 'review', 'confirmed', 'payment_pending'].includes(s.status)) out.push(button('Ablehnen', { variant: 'danger', icon: 'x', onClick: () => rejectDialog(s, after) }));
      return out;
    };
    await reload();
    off = ctx.live(['tab'], reload, { wait: 150 });
  }
  function confirmDialogFor(s, after) {
    const err = h('div'); const accept = h('input', { type: 'checkbox' }); const noteIn = h('textarea', { class: 'textarea', maxLength: 300, placeholder: 'Begründung für die Abweichung' });
    const approved = input({ inputmode: 'decimal', value: (s.ourCents / 100).toFixed(2).replace('.', ',') });
    const m = openModal({ title: 'Abrechnung bestätigen', body: h('div', null, err,
      s.matches ? note(`Eingereichter Betrag und unsere Buchungen stimmen überein: ${fmtC(s.submittedCents)}.`, 'check')
        : [note(`Abweichung: Firma ${fmtC(s.submittedCents)} · wir ${fmtC(s.ourCents)} · Differenz ${fmtC(s.diffCents)}. Die Abrechnung darf nicht automatisch als vollständig gelten.`, 'alert'), h('div', { style: { height: '10px' } }),
          h('label', { class: 'check', style: { padding: 0 } }, accept, h('span', { class: 'check-text' }, 'Ich habe die Abweichung geprüft und gebe sie ausdrücklich frei')), field('Freigegebener Betrag', approved, { help: 'Standard: unsere Buchungssumme.' }), field('Notiz', noteIn)]),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button('Bestätigen', { variant: 'ok', icon: 'check', onClick: (b) => busy(b.currentTarget, async () => {
      try { await api.post(`/api/tab/statements/${s.id}/confirm`, s.matches ? {} : { acceptDifference: accept.checked, note: noteIn.value, approvedCents: parseMoney(approved.value) ?? undefined }); m.close(); toast('Bestätigt – bitte Zahlung abwickeln.'); await after(); show(tab, true); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })] });
  }
  function rejectDialog(s, after) {
    const err = h('div'); const reason = input({ maxLength: 300, placeholder: 'Grund (sieht die Firma)' });
    const m = openModal({ title: 'Abrechnung ablehnen', body: h('div', null, err, note('Die Firma sieht den Grund und kann den Zeitraum erneut einreichen.', 'info'), h('div', { style: { height: '10px' } }), field('Grund', reason)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Ablehnen', { variant: 'danger', icon: 'x', onClick: (b) => busy(b.currentTarget, async () => {
        try { await api.post(`/api/tab/statements/${s.id}/reject`, { reason: reason.value }); m.close(); toast('Abgelehnt.'); await after(); show(tab, true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }
  function payDialog(s, after) {
    const err = h('div'); const date = input({ type: 'date', value: new Date().toISOString().slice(0, 10) }); const ref = input({ maxLength: 80, placeholder: 'Transaktions-/Buchungsnummer (optional)' });
    const m = openModal({ title: 'Überweisung dokumentieren', body: h('div', null, err, note(`Betrag: ${fmtC(s.approvedCents)} an ${s.company.name}.`, 'dollar'), h('div', { style: { height: '10px' } }), h('div', { class: 'form-row' }, field('Zahlungsdatum', date), field('Referenz', ref))),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Als bezahlt markieren', { variant: 'ok', icon: 'check', onClick: (b) => busy(b.currentTarget, async () => {
        try { await api.post(`/api/tab/statements/${s.id}/pay`, { paidAt: date.value, reference: ref.value }); m.close(); toast('Bezahlt.'); await after(); show(tab, true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }
  function invoiceBox(s, manage) {
    const editable = manage && ['confirmed', 'payment_pending'].includes(s.status);
    const recv = h('input', { type: 'checkbox', checked: s.invoice.received, disabled: !editable }); const num = input({ value: s.invoice.number, disabled: !editable, maxLength: 60 });
    const amt = input({ inputmode: 'decimal', value: s.invoice.amountCents != null ? (s.invoice.amountCents / 100).toFixed(2).replace('.', ',') : '', disabled: !editable }); const date = input({ type: 'date', value: s.invoice.date ?? '', disabled: !editable });
    const file = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg', hidden: true });
    file.addEventListener('change', async () => {
      const fl = file.files[0]; if (!fl) return;
      if (fl.size > 5 * 1024 * 1024) return toast('Die Datei ist zu groß (max. 5 MB).', 'err');
      const data = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(fl); });
      try { await api.post(`/api/tab/statements/${s.id}/invoice-file`, { data }); toast('Rechnungsdatei gespeichert.'); } catch (ex) { toast(ex.message, 'err'); }
    });
    const el = h('div', { class: 'card', style: { padding: '16px' } }, h('div', { class: 'sub-title' }, 'Rechnung der Firma'),
      h('label', { class: 'check', style: { padding: 0, marginBottom: '8px' } }, recv, h('span', { class: 'check-text' }, 'Rechnung erhalten')),
      h('div', { class: 'form-row' }, field('Rechnungsnummer', num), field('Rechnungsbetrag', amt, { help: s.approvedCents != null ? `Freigegeben: ${fmtC(s.approvedCents)}` : '' })), field('Rechnungsdatum', date),
      h('div', { class: 'row' }, s.invoice.hasFile && h('a', { class: 'btn btn-sm', href: `/api/tab/statements/${s.id}/invoice-file`, target: '_blank', rel: 'noopener' }, icon('download'), 'Datei öffnen'),
        editable && file, editable && button('PDF/Bild hochladen', { size: 'sm', icon: 'download', onClick: () => file.click() }),
        editable && button('Rechnungsdaten speichern', { size: 'sm', variant: 'primary', icon: 'check', onClick: async () => {
          try { await api.post(`/api/tab/statements/${s.id}/invoice`, { received: recv.checked, number: num.value, amountCents: parseMoney(amt.value), date: date.value }); toast('Gespeichert.'); } catch (ex) { toast(ex.message, 'err'); }
        } })));
    return el;
  }

  // ── Firmen ──
  async function companies() {
    const { companies: rows } = await api.get('/api/tab/companies');
    companyCache = rows;
    if (!ctx.isCurrent() || tab !== 'companies') return;
    mount(host, table([
      { label: 'Firma', render: (c) => h('div', null, h('b', null, c.name), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${c.number}${c.contactName ? ' · ' + c.contactName : ''}`)) },
      { label: 'Intervall', render: (c) => c.intervalLabel }, { label: 'Gültig für', render: (c) => ({ all: 'Alle Mitarbeiter', selected: 'Bestimmte Mitarbeiter', perm: 'Gruppe (Recht)' })[c.scope] },
      { label: 'Offener Betrag', render: (c) => h('b', null, fmtC(c.openCents)) }, { label: 'Umsatz', render: (c) => fmtC(c.turnoverCents) },
      { label: 'Limit', render: (c) => (c.creditLimitCents != null ? fmtC(c.creditLimitCents) : h('span', { class: 'muted' }, '–')) },
      { label: 'Status', render: (c) => (c.status === 'active' ? badge('Aktiv', 'b-ok') : badge('Deaktiviert', 'b-mute')) },
      opts.canCompanies && { label: 'Portal-Link', render: (c) => c.linkPath && button('Kopieren', { size: 'sm', icon: 'link', onClick: (e) => { e.stopPropagation(); copyText(fullLink(c.linkPath)); } }) },
    ].filter(Boolean), rows, { onRowClick: (c) => companyDetail(c.id), empty: empty('Noch keine Firmen', opts.canCompanies ? 'Lege die erste Firma an – sie bekommt automatisch einen eigenen Portal-Link.' : null, 'dollar') }));
  }
  async function companyDetail(id) {
    const body = h('div', null, skeletons(3, 70)); let off;
    const m = openModal({ title: 'Firma', wide: true, body, footer: null, onClose: () => off?.() });
    const footer = h('div', { class: 'modal-foot' }); m.el.append(footer);
    let dtab = 'info';
    async function reload() {
      let d; try { d = await api.get(`/api/tab/companies/${id}`); } catch (e) { mount(body, note(e.message, 'alert')); return; }
      const c = d.company;
      m.el.querySelector('.modal-head h3').textContent = `${c.name} · ${c.number}`;
      const link = c.linkPath ? fullLink(c.linkPath) : null;
      const info = h('div', { class: 'stack-v' }, h('div', { class: 'chips' }, c.status === 'active' ? badge('Aktiv', 'b-ok') : badge('Deaktiviert', 'b-mute'), badge(c.intervalLabel, 'b-info', false)),
        h('div', { class: 'tile-row' }, h('div', { class: 'tile t-warn' }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, fmtC(c.openCents)), h('div', { class: 'tile-label' }, 'Aktuell offen'))), h('div', { class: 'tile' }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, fmtC(c.turnoverCents)), h('div', { class: 'tile-label' }, 'Bisheriger Umsatz'))),
          c.creditLimitCents != null && h('div', { class: 'tile' }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, fmtC(c.creditLimitCents)), h('div', { class: 'tile-label' }, 'Limit')))),
        h('dl', { class: 'details-dl' }, h('dt', null, 'Ansprechpartner'), h('dd', null, c.contactName || '–'), h('dt', null, 'Kontakt'), h('dd', null, c.contactInfo || '–'),
          h('dt', null, 'Deckel gültig für'), h('dd', null, c.scope === 'all' ? 'Alle Mitarbeiter' : c.scope === 'perm' ? `Mitarbeitergruppe mit Recht „${c.scopePerm}“` : c.members.length ? c.members.map((x) => x.label).join(', ') : 'Bestimmte Mitarbeiter (noch keine gewählt)'), c.notes && [h('dt', null, 'Notizen'), h('dd', null, c.notes)]),
        link && h('div', { class: 'link-box' }, h('code', null, link), button('Kopieren', { size: 'sm', icon: 'link', onClick: () => copyText(link) }), opts.canCompanies && button('Neuen Link erzeugen', { size: 'sm', variant: 'ghost', icon: 'refresh', onClick: async () => {
          if (!await confirmDialog({ title: 'Neuen Portal-Link erzeugen?', message: 'Der bisherige Link funktioniert danach nicht mehr.', confirmLabel: 'Neuen Link erzeugen' })) return;
          try { await api.post(`/api/tab/companies/${id}/reset-link`); toast('Neuer Link erzeugt.'); reload(); } catch (e) { toast(e.message, 'err'); } } })));
      const periods = h('div', null, table([{ label: 'Zeitraum', render: (p) => p.period?.label }, { label: 'Buchungen', render: (p) => p.count }, { label: 'Summe', render: (p) => h('b', null, fmtC(p.totalCents)) },
        { label: 'Abrechnung', render: (p) => (p.statement ? h('span', { class: 'badge', style: { '--c': opts.statuses.find((s) => s.key === p.statement)?.color } }, opts.statuses.find((s) => s.key === p.statement)?.label) : h('span', { class: 'muted' }, 'noch nicht eingereicht')) }], d.periods, { empty: empty('Noch keine Buchungen', null, 'dollar') }));
      const hist = h('div', null, table([{ label: 'Zeitraum', render: (s) => s.period?.label }, { label: 'Eingereicht', render: (s) => fmtC(s.submittedCents) }, { label: 'Freigegeben', render: (s) => (s.approvedCents != null ? fmtC(s.approvedCents) : '–') }, { label: 'Status', render: statusBadge }, { label: 'Datum', render: (s) => fmtDate(s.submittedAt) }],
        d.statements, { onRowClick: (s) => { m.close(); openStatement(s.id); }, empty: empty('Noch keine Abrechnungen', null, 'dollar') }));
      const panes = { info, periods, hist };
      const content = h('div'); mount(content, panes[dtab]);
      const tbar = tabs([{ id: 'info', label: 'Übersicht' }, { id: 'periods', label: 'Zeiträume', count: d.periods.length }, { id: 'hist', label: 'Abrechnungshistorie', count: d.statements.length }], dtab, (x) => { dtab = x; mount(content, panes[x]); });
      tbar.style.marginBottom = '16px'; mount(body, tbar, content);
      mount(footer, opts.canCompanies && button('Bearbeiten', { icon: 'edit', onClick: () => { m.close(); companyEditor(d.company); } }), h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    }
    await reload(); off = ctx.live(['tab'], reload, { wait: 150 });
  }
  function companyEditor(c) {
    const err = h('div');
    const name = input({ value: c?.name ?? '', maxLength: 80, placeholder: 'Firmenname' }); const cn = input({ value: c?.contactName ?? '', maxLength: 80 }); const ci = input({ value: c?.contactInfo ?? '', maxLength: 300, placeholder: 'E-Mail, Telefon, Discord …' });
    const interval = select([{ value: 'weekly', label: 'Wöchentlich' }, { value: 'monthly', label: 'Monatlich' }], c?.interval ?? 'monthly');
    const scope = select([{ value: 'all', label: 'Alle Mitarbeiter' }, { value: 'selected', label: 'Bestimmte Mitarbeiter' }, { value: 'perm', label: 'Mitarbeitergruppe (Berechtigung)' }], c?.scope ?? 'all');
    const permSel = select(opts.permissions.map((p) => ({ value: p.key, label: `${p.key} – ${p.description}` })), c?.scopePerm ?? opts.permissions[0]?.key);
    const chosen = new Set((c?.members ?? []).map((x) => x.id)); const memberBox = h('div', { class: 'people-list', style: { maxHeight: '180px' } });
    const drawMembers = () => mount(memberBox, opts.members.map((u) => { const cb = h('input', { type: 'checkbox', checked: chosen.has(u.id) }); cb.addEventListener('change', () => (cb.checked ? chosen.add(u.id) : chosen.delete(u.id))); return h('label', { class: 'check', style: { padding: '4px 8px' } }, cb, h('span', { class: 'check-text mono' }, u.label)); }));
    drawMembers();
    const limit = input({ inputmode: 'decimal', value: c?.creditLimitCents != null ? (c.creditLimitCents / 100).toFixed(2).replace('.', ',') : '', placeholder: 'leer = kein Limit' });
    const status = c && select([{ value: 'active', label: 'Aktiv' }, { value: 'disabled', label: 'Deaktiviert' }], c.status); const notes = h('textarea', { class: 'textarea', maxLength: 1000 }, c?.notes ?? '');
    const scopeRows = h('div'); const syncScope = () => mount(scopeRows, scope.value === 'selected' && field('Freigegebene Mitarbeiter (Personalnummern)', memberBox), scope.value === 'perm' && field('Berechtigung der Mitarbeitergruppe', permSel)); scope.addEventListener('change', syncScope); syncScope();
    const m = openModal({ title: c ? `Firma bearbeiten: ${c.name}` : 'Neue Firma', wide: true, body: h('div', null, err,
      h('div', { class: 'form-row' }, field('Firmenname', name), field('Ansprechpartner', cn)), field('Kontaktmöglichkeiten', ci),
      h('div', { class: 'form-row' }, field('Abrechnungsintervall', interval, { help: c ? 'Nach der ersten Buchung nicht mehr änderbar.' : 'Bestimmt, ob die Firma wochen- oder monatsweise abrechnet.' }), field('Kreditlimit (offener Betrag)', limit)),
      field('Deckel gültig für', scope), scopeRows, c && field('Status', status), field('Notizen', notes), !c && note('Nach dem Anlegen wird automatisch ein individueller Portal-Link für die Firma erzeugt.', 'link')),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button(c ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (b) => busy(b.currentTarget, async () => {
      err.replaceChildren();
      const lim = limit.value.trim() === '' ? null : parseMoney(limit.value);
      if (limit.value.trim() !== '' && lim == null) return err.replaceChildren(formError('Ungültiges Limit.'));
      const payload = { name: name.value, contactName: cn.value, contactInfo: ci.value, interval: interval.value, scope: scope.value, scopePerm: scope.value === 'perm' ? permSel.value : null, memberIds: [...chosen], creditLimitCents: lim, notes: notes.value };
      if (status) payload.status = status.value;
      try {
        const res = c ? await api.patch(`/api/tab/companies/${c.id}`, payload) : await api.post('/api/tab/companies', payload);
        m.close(); toast(c ? 'Gespeichert.' : 'Firma angelegt – Portal-Link erzeugt.'); await show('companies', true);
        if (!c) companyDetail(res.company.id);
      } catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })] });
  }

  // Benachrichtigung „Neue Deckel-Abrechnung“ → direkt öffnen
  const openFromTarget = () => { const id = Number(sessionStorage.getItem('mdt:tab:open')); if (id) { sessionStorage.removeItem('mdt:tab:open'); openStatement(id); } };
  window.addEventListener('mdt:tab-open', openFromTarget);

  ctx.live(['tab', 'org', 'users'], () => show(tab, true), { wait: 200 });
  await show(tab);
  openFromTarget();
  return () => window.removeEventListener('mdt:tab-open', openFromTarget);
}
