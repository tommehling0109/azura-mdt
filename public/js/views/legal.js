import { h, mount } from '../ui/dom.js';
import { button, busy, field, input, tabs, formError, openModal, confirmDialog, toast, empty, note } from '../ui/kit.js';
import { api } from '../api.js';

/** Legal: Gesetzessammlung (live eingebettetes Google-Dokument), Bußgeldrechner und Rechtsfälle (Platzhalter, noch in Planung). */
export default async function render(container, ctx) {
  let data = await api.get('/api/legal');
  const TABS = [{ id: 'laws', label: 'Gesetzessammlung' }, { id: 'fines', label: 'Bußgeldrechner' }, { id: 'cases', label: 'Rechtsfälle' }];
  let tab = 'laws', docId = null;
  const tabHost = h('div', { style: { marginBottom: '12px' } }), host = h('div', { class: 'legal-host' });
  mount(container, tabHost, host);

  const todo = (title, text) => h('div', { class: 'card card-body' }, empty(title, text, 'clock'));
  const current = () => data.docs.find((d) => d.id === docId) ?? data.docs[0];

  function drawActions() {
    const d = current();
    ctx.setActions(tab === 'laws' && h('div', { class: 'row' },
      d && button('Neu laden', { icon: 'refresh', onClick: () => laws() }),
      d && button('In Google öffnen', { icon: 'link', onClick: () => window.open(d.openUrl, '_blank', 'noopener') }),
      data.canManage && button('Dokumente verwalten', { icon: 'edit', onClick: manage })));
  }

  function laws() {
    drawActions();
    if (!data.docs.length) {
      mount(host, h('div', { class: 'card card-body' }, empty('Noch kein Dokument hinterlegt', data.canManage ? 'Hinterlege über „Dokumente verwalten“ den Link zur Gesetzessammlung.' : 'Die Gesetzessammlung wurde noch nicht hinterlegt.', 'book')));
      return;
    }
    const d = current();
    const frame = h('iframe', { class: 'legal-frame', src: d.embedUrl, title: d.title, referrerpolicy: 'no-referrer', allow: 'clipboard-write' });
    mount(host,
      data.docs.length > 1 && h('div', { class: 'row', style: { marginBottom: '10px', flexWrap: 'wrap' } },
        data.docs.map((x) => button(x.title, { size: 'sm', variant: x.id === d.id ? 'primary' : '', onClick: () => { docId = x.id; laws(); } }))),
      frame,
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
        'Live-Ansicht des Google-Dokuments – Änderungen im Dokument erscheinen hier nach „Neu laden“. Wird nichts angezeigt, muss das Dokument für „Jeder mit dem Link“ freigegeben sein.'));
  }

  function show(t) {
    tab = t; mount(tabHost, tabs(TABS, tab, show));
    if (t === 'laws') laws();
    else {
      drawActions();
      mount(host, t === 'fines'
        ? todo('Bußgeldrechner – to be done', 'Der Bußgeldrechner ist noch in Arbeit und folgt in einem späteren Update.')
        : todo('Rechtsfälle / Aktensystem – to be done', 'Das Aktensystem für Rechtsfälle ist noch in Planung und folgt in einem späteren Update.'));
    }
  }

  function manage() {
    const list = h('div');
    const draw = () => mount(list, data.docs.length ? data.docs.map((d) => h('div', { class: 'row', style: { justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' } },
      h('div', null, h('strong', null, d.title), h('div', { class: 'muted', style: { fontSize: '12px' } }, d.kindLabel)),
      h('div', { class: 'row' }, button('Ändern', { size: 'sm', icon: 'edit', onClick: () => edit(d) }), button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Entfernen', onClick: () => remove(d) })))) : h('div', { class: 'muted' }, 'Noch keine Dokumente.'));
    async function refresh() { data = await api.get('/api/legal'); draw(); show(tab); }
    async function remove(d) {
      if (!await confirmDialog({ title: 'Dokument entfernen?', message: `„${d.title}“ wird aus dem MDT entfernt (das Google-Dokument selbst bleibt unberührt).`, confirmLabel: 'Entfernen' })) return;
      try { await api.del(`/api/legal/docs/${d.id}`); if (docId === d.id) docId = null; await refresh(); toast('Dokument entfernt.'); } catch (e) { toast(e.message, 'err'); }
    }
    function edit(d) {
      const err = h('div'), title = input({ value: d?.title ?? '', maxLength: 80 }), url = input({ value: d?.url ?? '', placeholder: 'https://docs.google.com/document/d/…' });
      const mm = openModal({
        title: d ? 'Dokument ändern' : 'Dokument hinzufügen',
        body: h('div', null, err, field('Titel', title), field('Google-Link', url, { help: 'Link zu einem Google Dokument, einer Tabelle oder Präsentation. Freigabe: „Jeder mit dem Link“ (Ansehen).' })),
        footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => mm.close() }), button('Speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
          err.replaceChildren();
          try {
            const body = { title: title.value, url: url.value };
            if (d) await api.patch(`/api/legal/docs/${d.id}`, body); else await api.post('/api/legal/docs', body);
            mm.close(); await refresh(); toast('Gespeichert.');
          } catch (ex) { err.replaceChildren(formError(ex.message)); }
        }) })],
      });
    }
    draw();
    const m = openModal({ title: 'Dokumente verwalten', body: h('div', null, note('Hier hinterlegte Google-Dokumente werden live im MDT angezeigt.'), list), footer: [button('Dokument hinzufügen', { icon: 'plus', onClick: () => edit(null) }), h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() })] });
  }

  show('laws');
}
