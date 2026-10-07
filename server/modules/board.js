import { all, get, run, now } from '../core/db.js';
import { bad, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { labelForUser } from '../core/identity.js';
import { notify, staffWith } from '../core/notifications.js';

/**
 * Schwarzes Brett: Ankündigungen, die direkt auf dem Desktop aller Mitglieder stehen (keine eigene App, nicht für externe Partner).
 * Sehen: „board.view“. Anlegen, bearbeiten, anpinnen, entfernen: „board.manage“. Verfasser erscheinen nur als Personalnummer.
 */
const LEVELS = ['info', 'important', 'urgent', 'success'];

const dto = (p, viewerId) => ({
  id: p.id, title: p.title, body: p.body, level: p.level, pinned: !!p.pinned,
  author: p.author_id ? labelForUser(p.author_id, viewerId) : null, createdAt: p.created_at, updatedAt: p.updated_at,
});
const load = (id) => { const p = get('SELECT * FROM board_posts WHERE id = ?', Number(id)); if (!p) throw notFound('Ankündigung nicht gefunden.'); return p; };
function input(b, partial = false) {
  const out = {};
  if (!partial || b.title !== undefined) out.title = str(b.title, 'Titel', { min: 2, max: 80 });
  if (!partial || b.body !== undefined) out.body = str(b.body ?? '', 'Text', { max: 1500, required: false }) ?? '';
  if (!partial || b.level !== undefined) { if (!LEVELS.includes(b.level ?? 'info')) throw bad('Ungültige Hervorhebung.'); out.level = b.level ?? 'info'; }
  if (!partial || b.pinned !== undefined) out.pinned = b.pinned ? 1 : 0;
  return out;
}

export default {
  name: 'board',
  permissions: [
    ['board.view', 'Schwarzes Brett: Ankündigungen auf dem Desktop sehen'],
    ['board.manage', 'Schwarzes Brett: Ankündigungen anlegen, bearbeiten, anpinnen und entfernen'],
  ],
  init() {
    // Einmalig: bestehende Rollen dürfen das Brett sehen (neue Rechte sind sonst für niemanden sichtbar)
    if (get("SELECT 1 x FROM sequences WHERE name = 'board_view_granted'")) return;
    run("INSERT INTO sequences (name,next_value) VALUES ('board_view_granted',1)");
    if (get("SELECT 1 x FROM permissions WHERE key = 'board.view'")) run("INSERT OR IGNORE INTO role_permissions (role_id,permission_key) SELECT id, 'board.view' FROM roles");
  },
  routes(r) {
    r.get('/api/board', { perm: 'board.view' }, (ctx) => ({
      posts: all('SELECT * FROM board_posts ORDER BY pinned DESC, id DESC LIMIT 100').map((p) => dto(p, ctx.user.id)),
      canManage: ctx.user.perms.has('board.manage'),
    }));

    r.post('/api/board', { perm: 'board.manage' }, (ctx) => {
      const v = input(ctx.body), t = now();
      const id = Number(run('INSERT INTO board_posts (title,body,level,pinned,author_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', v.title, v.body, v.level, v.pinned, ctx.user.id, t, t).lastInsertRowid);
      if (v.level === 'important' || v.level === 'urgent') notify(staffWith('board.view', ctx.user.id), { key: `board:${id}:new`, title: v.level === 'urgent' ? 'Dringende Ankündigung' : 'Neue Ankündigung', body: v.title });
      audit(ctx, { action: 'board.created', module: 'board', targetType: 'board_post', targetId: id, targetLabel: v.title, after: { level: v.level, pinned: !!v.pinned } });
      ctx.status = 201;
      return { post: dto(get('SELECT * FROM board_posts WHERE id = ?', id), ctx.user.id) };
    });

    r.patch('/api/board/:id', { perm: 'board.manage' }, (ctx) => {
      const p = load(ctx.params.id), v = input(ctx.body, true), cols = Object.keys(v);
      if (cols.length) run(`UPDATE board_posts SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => v[c]), now(), p.id);
      audit(ctx, { action: 'board.updated', module: 'board', targetType: 'board_post', targetId: p.id, targetLabel: v.title ?? p.title, before: { level: p.level, pinned: !!p.pinned }, after: { level: v.level ?? p.level, pinned: v.pinned !== undefined ? !!v.pinned : !!p.pinned } });
      return { post: dto(get('SELECT * FROM board_posts WHERE id = ?', p.id), ctx.user.id) };
    });

    r.delete('/api/board/:id', { perm: 'board.manage' }, (ctx) => {
      const p = load(ctx.params.id);
      run('DELETE FROM board_posts WHERE id = ?', p.id);
      audit(ctx, { action: 'board.deleted', module: 'board', targetType: 'board_post', targetId: p.id, targetLabel: p.title });
      return { ok: true };
    });
  },
};
