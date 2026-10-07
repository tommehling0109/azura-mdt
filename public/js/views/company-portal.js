import { h, mount, fmtDate, fmtDateTime } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, select, formError, note, empty } from '../ui/kit.js';
import { api } from '../api.js';
import { showLock, brandBlock } from '../shell.js';
import { parseMoney, fmtC } from './tab.js';

/**
 * Firmenportal (Deckel-Abrechnung): persönlicher Link, kein Login. Die Firma sieht ausschließlich ihre eigenen Abrechnungen,
 * wählt den Abrechnungszeitraum, trägt den fälligen Gesamtbetrag ein und übermittelt ihn. Unsere Buchungssummen sieht sie nie.
 */
export async function showCompanyPortal({ token }) {
  const url = `/api/c/${encodeURIComponent(token)}`;
  let data;
  try { data = await api.get(url); } catch {
    return showLock(h('div', { class: 'lock-card', style: { textAlign: 'center' } }, brandBlock(), h('h2', null, 'Link ungültig'),
      h('p', { class: 'lead' }, 'Dieser Link ist ungültig oder wurde deaktiviert. Bitte wende dich an deinen Ansprechpartner.')));
  }
  const host = h('div', { class: 'company-portal' });
  showLock(h('div', { class: 'lock-card wide' }, brandBlock(), host));
  document.querySelector('.lock-clock')?.remove(); // die große Uhr würde auf kleinen Bildschirmen das Formular überdecken
  let banner = null;

  function draw() {
    const err = h('div');
    const period = select(data.periods.map((p) => ({ value: p.key, label: `${p.label} (${fmtDate(p.from)} – ${fmtDate(p.to)})` })), '');
    const amount = input({ inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off' });
    const comment = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Optionaler Kommentar (z. B. Hinweise zur Abrechnung)' });
    const submit = button('Abrechnung absenden', { variant: 'primary', type: 'submit', icon: 'check' });
    const sel = h('div', { class: 'cp-selected' });
    const upd = () => { const p = data.periods.find((x) => x.key === period.value); sel.textContent = p ? `Abrechnungszeitraum: ${p.label}` : ''; };
    period.addEventListener('change', upd); upd();
    const form = h('form', { novalidate: true }, err,
      data.periods.length
        ? [field(data.company.interval === 'weekly' ? 'Kalenderwoche' : 'Monat', period, { help: 'Es werden nur Zeiträume angeboten, für die noch keine Abrechnung eingereicht wurde.' }), sel,
          field(`Fälliger Gesamtbetrag (${(data.currency)})`, amount), field('Kommentar', comment), submit]
        : note('Aktuell gibt es keinen Zeitraum, den du abrechnen kannst. Neue Zeiträume erscheinen nach Ablauf der Woche bzw. des Monats.', 'info'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.replaceChildren();
      const c = parseMoney(amount.value);
      if (c == null) return err.replaceChildren(formError('Bitte gib den fälligen Betrag ein (z. B. 1.284,50).'));
      await busy(submit, async () => {
        try {
          const res = await api.post(`${url}/statements`, { periodKey: period.value, amountCents: c, comment: comment.value.trim() });
          data = res; banner = res.message; draw();
        } catch (ex) { err.replaceChildren(formError(ex.message)); }
      });
    });
    mount(host,
      h('h2', null, data.company.name), h('p', { class: 'lead' }, `Deckel-Abrechnung · ${data.company.intervalLabel.toLowerCase()}e Abrechnung`),
      banner && h('div', { class: 'cp-success' }, icon('check'), banner), h('div', { class: 'cp-section' }, 'Neue Abrechnung übermitteln'), form,
      h('div', { class: 'cp-section' }, 'Deine bisherigen Abrechnungen'),
      data.statements.length ? h('div', { class: 'table-wrap' }, h('div', { class: 'table-scroll' }, h('table', { class: 'table', style: { minWidth: '480px' } },
        h('thead', null, h('tr', null, ['Zeitraum', 'Betrag', 'Status', 'Eingereicht'].map((t) => h('th', null, t)))),
        h('tbody', null, data.statements.map((s) => h('tr', null, h('td', null, h('b', null, s.period?.label), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, s.number)), h('td', null, fmtC(s.submittedCents)),
          h('td', null, h('span', { class: 'badge', style: { '--c': s.statusColor } }, s.statusLabel), s.rejectReason && h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, `Grund: ${s.rejectReason}`), s.paidAt && h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, `bezahlt am ${fmtDate(s.paidAt)}`)),
          h('td', null, fmtDateTime(s.submittedAt))))))))
        : empty('Noch keine Abrechnungen', 'Sobald du eine Abrechnung übermittelt hast, erscheint sie hier mit ihrem Status.', 'dollar'));
  }
  draw();
  // Status-Änderungen (z. B. „Bezahlt“) ohne Neuladen übernehmen – solange nichts eingegeben wird
  const iv = setInterval(async () => {
    if (!host.isConnected) return clearInterval(iv);
    if (host.querySelector('input')?.value || host.querySelector('textarea')?.value) return;
    try { data = await api.get(url); draw(); } catch { /* offline */ }
  }, 30_000);
}
