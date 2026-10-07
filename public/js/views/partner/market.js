import { h, mount, timeAgo, fmtDate } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, busy, card, field, input, select, tabs, formError, openModal, toast, skeletons, empty, note, badge } from '../../ui/kit.js';
import { api } from '../../api.js';
import { money, dealBadge, catBadge, turnBadge, openDealModal, priceDialog } from '../market-shared.js';

/** Börse aus Sicht des externen Partners: Gesuche einsehen, Angebote einstellen, eigene Geschäfte verfolgen. */
export default async function render(container, ctx) {
  let tab = 'wanted';
  let catalog = { items: [], categories: [] };
  const tabHost = h('div', { style: { marginBottom: '16px' } });
  const host = h('div');
  mount(container, tabHost, host);
  ctx.setActions(button('Angebot einstellen', { variant: 'primary', icon: 'plus', onClick: () => offerDialog() }));

  async function show(t) {
    tab = t;
    let deals = [], wanted = [];
    try {
      [catalog, { deals }, { wanted }] = await Promise.all([api.get('/api/p/market/catalog'), api.get('/api/p/market/deals'), api.get('/api/p/market/wanted')]);
    } catch (e) { return mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
    if (!ctx.isCurrent()) return;
    const attention = deals.filter((d) => d.turn === 'partner' && ['submitted', 'negotiating'].includes(d.status)).length;
    mount(tabHost, tabs([
      { id: 'wanted', label: 'Gesucht', count: wanted.length || undefined },
      { id: 'deals', label: 'Meine Geschäfte', count: attention || deals.length || undefined },
    ], tab, show));
    mount(host, tab === 'wanted' ? wantedView(wanted) : dealsView(deals));
  }

  function wantedView(list) {
    if (!list.length) return card(null, empty('Aktuell suchen wir nichts', 'Du kannst trotzdem jederzeit selbst ein Angebot einstellen.', 'search'));
    return h('div', { class: 'stack' }, note('Das suchen wir aktuell. Hast du etwas davon? Melde dich mit einem Klick – wir antworten dir hier.', 'info'),
      h('div', { class: 'market-grid' }, list.map((w) => h('article', { class: 'card wanted-card', style: { '--rc': w.item.category?.color ?? 'var(--accent)' } },
        h('div', { class: 'row' }, catBadge(w.item.category), h('span', { class: 'grow' }), w.expiresAt && h('span', { class: 'muted', style: { fontSize: '12px' } }, `bis ${fmtDate(w.expiresAt)}`)),
        h('h3', null, w.item.name),
        h('div', { class: 'wc-price' }, `${money(w.unitPrice)} `, h('span', { class: 'muted', style: { fontSize: '13px', fontWeight: 500 } }, `/ ${w.item.unit}`)),
        h('div', null, `Gesucht: `, h('b', null, `${w.quantity.toLocaleString('de-DE')} ${w.item.unit}`)),
        h('div', { class: 'wc-note' }, w.note),
        button('Ich habe das', { variant: 'primary', icon: 'check', onClick: () => respond(w) })))));
  }

  function respond(w) {
    priceDialog({
      title: `Auf Gesuch melden: ${w.item.name}`, item: `Gesucht: ${w.quantity.toLocaleString('de-DE')} ${w.item.unit} zu ${money(w.unitPrice)} pro ${w.item.unit}`,
      quantity: Math.min(w.quantity, 1), unitPrice: w.unitPrice, maxQuantity: w.quantity, submitLabel: 'Melden',
      onSubmit: async (v) => { await api.post(`/api/p/market/wanted/${w.id}/respond`, { quantity: v.quantity, unitPrice: v.unitPrice, note: v.text }); toast('Gemeldet – wir melden uns bei dir.'); show('deals'); },
    });
  }

  function dealsView(list) {
    if (!list.length) return card(null, empty('Noch keine Geschäfte', 'Stelle ein Angebot ein oder melde dich auf ein Gesuch.', 'tag'));
    return h('div', null, list.map((d) => {
      const mine = d.turn === 'partner' && ['submitted', 'negotiating'].includes(d.status);
      const el = h('article', { class: `card hoverable deal-card ${mine ? 'attention' : ''}`, tabindex: 0 },
        h('div', { class: 'dc-main' }, h('div', { class: 'dc-title' }, h('span', { class: 'member-no' }, d.number), ' ', d.item.name, ' ', catBadge(d.item.category)),
          h('div', { class: 'dc-sub' }, `${d.quantity.toLocaleString('de-DE')} ${d.item.unit} × ${money(d.unitPrice)} · ${timeAgo(d.updatedAt)}`),
          h('div', { class: 'chips', style: { marginTop: '8px' } }, dealBadge(d), turnBadge(d, 'partner'))),
        h('div', { class: 'dc-price' }, money(d.total)), icon('chevronR'));
      const open = () => openDealModal({ side: 'partner', base: '/api/p/market', id: d.id, onChange: () => show('deals') });
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      return el;
    }));
  }

  function offerDialog() {
    if (!catalog.items.length) return toast('Aktuell können keine Items angeboten werden.', 'warn');
    const err = h('div');
    const catSel = select([{ value: '', label: 'Alle Kategorien' }, ...catalog.categories.map((c) => ({ value: c.id, label: c.label }))], '');
    const itemSel = h('select', { class: 'select' });
    const fill = () => mount(itemSel, catalog.items.filter((i) => !catSel.value || String(i.category?.id) === catSel.value).map((i) => h('option', { value: i.id }, `${i.name} (${i.unit})`)));
    catSel.addEventListener('change', fill); fill();
    const qty = input({ type: 'number', min: 1, inputmode: 'numeric' });
    const price = input({ type: 'number', min: 1, inputmode: 'numeric' });
    const text = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Beschreibung (Zustand, Besonderheiten …)' });
    const total = h('div', { class: 'total-line' }, 'Gesamt: –');
    const upd = () => mount(total, 'Gesamt: ', h('b', null, Number(qty.value) > 0 && Number(price.value) > 0 ? money(Number(qty.value) * Number(price.value)) : '–'));
    qty.addEventListener('input', upd); price.addEventListener('input', upd);
    const m = openModal({
      title: 'Angebot einstellen',
      body: h('div', null, err, h('div', { class: 'form-row' }, field('Kategorie', catSel), field('Was bietest du an?', itemSel)),
        h('div', { class: 'form-row' }, field('Menge', qty), field('Dein Preis pro Einheit', price)), total, h('div', { style: { height: '12px' } }), field('Hinweis', text)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Angebot senden', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        if (!itemSel.value) return err.replaceChildren(formError('Bitte wähle ein Item aus.'));
        try { await api.post('/api/p/market/offers', { itemId: Number(itemSel.value), quantity: Number(qty.value), unitPrice: Number(price.value), note: text.value.trim() }); m.close(); toast('Angebot gesendet – wir prüfen es und melden uns.'); show('deals'); }
        catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }

  ctx.live(['market', 'lookups', 'system', 'partners'], () => show(tab));
  await show('wanted');
}
