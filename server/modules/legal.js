import { all, get, run, now } from '../core/db.js';
import { bad, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';

/**
 * Legal-App: Gesetzessammlung (Google-Dokument, live im MDT eingebettet), Bußgeldrechner und Rechtsfälle (beide noch in Planung).
 * Sehen: „legal.view“; Dokumente hinterlegen, ändern, entfernen: „legal.manage“.
 */
const DEFAULT_DOC = { title: 'Gesetzessammlung', url: 'https://docs.google.com/document/d/16VAK1IRV_uo5quHuZGU1kHS76Al7K5e63JKwNJ05Hno/edit?tab=t.0' };
const KINDS = { document: 'Dokument', spreadsheets: 'Tabelle', presentation: 'Präsentation' };

/** Erkennt einen Google-Docs-Link; liefert Art und ID oder wirft einen Fehler. */
function parseGoogle(raw) {
  let u; try { u = new URL(String(raw ?? '').trim()); } catch { throw bad('Bitte einen gültigen Link angeben.'); }
  const m = u.protocol === 'https:' && u.hostname === 'docs.google.com' && /^\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{20,})/.exec(u.pathname);
  if (!m) throw bad('Nur Links zu Google Docs, Tabellen oder Präsentationen (https://docs.google.com/…) sind erlaubt.');
  return { kind: m[1], docId: m[2], tab: /^t\.[A-Za-z0-9]+$/.test(u.searchParams.get('tab') ?? '') ? u.searchParams.get('tab') : null };
}
const dto = (d) => ({
  id: d.id, title: d.title, kind: d.kind, kindLabel: KINDS[d.kind], url: d.url, sortOrder: d.sort_order, updatedAt: d.updated_at,
  embedUrl: `https://docs.google.com/${d.kind}/d/${d.doc_id}/preview`, // live: lädt immer den aktuellen Stand des Dokuments
  openUrl: `https://docs.google.com/${d.kind}/d/${d.doc_id}/edit${d.tab ? `?tab=${d.tab}` : ''}`,
});
const load = (id) => { const d = get('SELECT * FROM legal_docs WHERE id = ?', Number(id)); if (!d) throw notFound('Dokument nicht gefunden.'); return d; };

export default {
  name: 'legal',
  permissions: [
    ['legal.view', 'Legal: Gesetzessammlung und Rechts-Bereiche ansehen'],
    ['legal.manage', 'Legal: Dokumente (Google-Links) hinterlegen, ändern und entfernen'],
  ],
  init() {
    // Einmalig: Gesetzessammlung vorbelegen und bestehenden Rollen das Sehen erlauben
    if (get("SELECT 1 x FROM sequences WHERE name = 'legal_seeded'")) return;
    run("INSERT INTO sequences (name,next_value) VALUES ('legal_seeded',1)");
    if (!get('SELECT 1 x FROM legal_docs LIMIT 1')) {
      const g = parseGoogle(DEFAULT_DOC.url), t = now();
      run('INSERT INTO legal_docs (title,kind,doc_id,tab,url,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', DEFAULT_DOC.title, g.kind, g.docId, g.tab, DEFAULT_DOC.url, 1, t, t);
    }
    if (get("SELECT 1 x FROM permissions WHERE key = 'legal.view'")) run("INSERT OR IGNORE INTO role_permissions (role_id,permission_key) SELECT id, 'legal.view' FROM roles");
  },
  routes(r) {
    r.get('/api/legal', { perm: 'legal.view' }, (ctx) => ({
      docs: all('SELECT * FROM legal_docs ORDER BY sort_order, id').map(dto), canManage: ctx.user.perms.has('legal.manage'),
    }));

    const input = (b, partial) => {
      const out = {};
      if (!partial || b.title !== undefined) out.title = str(b.title, 'Titel', { min: 2, max: 80 });
      if (!partial || b.url !== undefined) { const g = parseGoogle(b.url); Object.assign(out, { kind: g.kind, doc_id: g.docId, tab: g.tab, url: String(b.url).trim().slice(0, 500) }); }
      return out;
    };
    r.post('/api/legal/docs', { perm: 'legal.manage' }, (ctx) => {
      const v = input(ctx.body, false), t = now(), max = get('SELECT COALESCE(MAX(sort_order),0) m FROM legal_docs').m;
      const id = Number(run('INSERT INTO legal_docs (title,kind,doc_id,tab,url,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', v.title, v.kind, v.doc_id, v.tab, v.url, max + 1, t, t).lastInsertRowid);
      audit(ctx, { action: 'legal.doc_created', module: 'legal', targetType: 'legal_doc', targetId: id, targetLabel: v.title });
      ctx.status = 201;
      return { doc: dto(load(id)) };
    });
    r.patch('/api/legal/docs/:id', { perm: 'legal.manage' }, (ctx) => {
      const d = load(ctx.params.id), v = input(ctx.body, true), cols = Object.keys(v);
      if (cols.length) run(`UPDATE legal_docs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => v[c]), now(), d.id);
      audit(ctx, { action: 'legal.doc_updated', module: 'legal', targetType: 'legal_doc', targetId: d.id, targetLabel: v.title ?? d.title });
      return { doc: dto(load(d.id)) };
    });
    r.delete('/api/legal/docs/:id', { perm: 'legal.manage' }, (ctx) => {
      const d = load(ctx.params.id);
      run('DELETE FROM legal_docs WHERE id = ?', d.id);
      audit(ctx, { action: 'legal.doc_deleted', module: 'legal', targetType: 'legal_doc', targetId: d.id, targetLabel: d.title });
      return { ok: true };
    });
  },
};
