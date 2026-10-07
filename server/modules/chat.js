import { all, get, run, tx, now } from '../core/db.js';
import { bad, conflict, forbidden, notFound, str, intList } from '../core/http.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/realtime.js';
import { notify } from '../core/notifications.js';
import { memberLabel } from '../core/identity.js';
import { loadAccess } from '../core/permissions.js';
import { labelForUser } from '../core/identity.js';

/**
 * Chat: Kanäle (vom Admin angelegt, optional auf Rollen beschränkt), Nachrichten mit Antworten, Bearbeiten, Löschen,
 * Anpinnen, Zeitstempel, Ungelesen-Zähler und Erwähnungen. Absender erscheinen IMMER nur als Personalnummer (Anonymität).
 */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_LEN = 2000;

const senderLabel = (row) => (row.user_id == null ? 'Gelöschtes Mitglied' : memberLabel({ id: row.user_id, member_number: row.sender_number, status: row.sender_status }));
const snippet = (t) => (t.length > 90 ? `${t.slice(0, 90)}…` : t);

/** Sichtbare Kanäle: offene für alle mit chat.view, beschränkte nur für passende Rollen (Admins sehen alle). */
function visibleChannelIds(user) {
  if (user.isAdmin) return all("SELECT id FROM chat_channels WHERE kind = 'channel'").map((r) => r.id);
  const roleIds = user.roles.map((r) => r.id);
  return all("SELECT id, restricted FROM chat_channels WHERE kind = 'channel'").filter((c) => {
    if (!c.restricted) return true;
    if (!roleIds.length) return false;
    return !!get(`SELECT 1 x FROM chat_channel_roles WHERE channel_id = ? AND role_id IN (${roleIds.map(() => '?').join(',')})`, c.id, ...roleIds);
  }).map((c) => c.id);
}
function channelFor(user, id) {
  const ch = get('SELECT * FROM chat_channels WHERE id = ?', id);
  if (!ch) throw notFound('Kanal nicht gefunden.');
  if (ch.kind === 'dm') { if (ch.dm_a !== user.id && ch.dm_b !== user.id) throw notFound('Kanal nicht gefunden.'); return ch; }
  if (!visibleChannelIds(user).includes(ch.id)) throw forbidden('Kein Zugriff auf diesen Kanal.');
  return ch;
}

const MSG_SQL = `SELECT m.*, u.member_number sender_number, u.status sender_status FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id`;
function msgDto(m, user) {
  const deleted = !!m.deleted_at;
  let reply = null;
  if (m.reply_to) {
    const r = get(`${MSG_SQL} WHERE m.id = ?`, m.reply_to);
    if (r) reply = { id: r.id, sender: senderLabel(r), snippet: r.deleted_at ? 'Nachricht gelöscht' : snippet(r.body), deleted: !!r.deleted_at };
  }
  const mine = m.user_id === user.id;
  return {
    id: m.id, channelId: m.channel_id, sender: senderLabel(m), isMine: mine, body: deleted ? '' : m.body, deleted,
    createdAt: m.created_at, editedAt: m.edited_at, pinned: !!m.pinned_at && !deleted, pinnedAt: m.pinned_at, replyTo: reply,
    canEdit: mine && !deleted, canDelete: !deleted && (mine || (user.perms.has('chat.moderate') && get('SELECT kind FROM chat_channels WHERE id = ?', m.channel_id)?.kind !== 'dm')),
  };
}

const peerOf = (c, user) => { const id = c.dm_a === user.id ? c.dm_b : c.dm_a; return { id, label: labelForUser(id, user.id) }; };
const channelDto = (c, user) => {
  const last = get('SELECT COALESCE(last_read_id,0) l FROM chat_reads WHERE channel_id = ? AND user_id = ?', c.id, user.id)?.l ?? 0;
  return {
    id: c.id, kind: c.kind, name: c.kind === 'dm' ? peerOf(c, user).label : c.name, peer: c.kind === 'dm' ? peerOf(c, user) : null, description: c.kind === 'dm' ? 'Privatnachricht' : c.description, color: c.kind === 'dm' ? '#5b82b8' : c.color, restricted: !!c.restricted, sortOrder: c.sort_order,
    roleIds: all('SELECT role_id FROM chat_channel_roles WHERE channel_id = ?', c.id).map((r) => r.role_id),
    unread: get('SELECT COUNT(*) c FROM chat_messages WHERE channel_id = ? AND id > ? AND user_id != ? AND deleted_at IS NULL', c.id, last, user.id).c,
    pinnedCount: get('SELECT COUNT(*) c FROM chat_messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL', c.id).c,
    lastMessageAt: get('SELECT MAX(created_at) t FROM chat_messages WHERE channel_id = ? AND deleted_at IS NULL', c.id).t,
  };
};

/** Kanäle: alle mit chat.view bekommen den Hinweis. Privatnachrichten: nur die beiden Beteiligten (Live-Ereignis je Person). */
const changed = (channelId, kind) => {
  const c = get('SELECT kind, dm_a, dm_b FROM chat_channels WHERE id = ?', channelId);
  if (c?.kind === 'dm') { for (const uid of [c.dm_a, c.dm_b]) publish({ topic: 'chat', kind, entityType: 'channel', entityId: channelId, staff: 1, userId: uid }); return; }
  publish({ topic: 'chat', kind, entityType: 'channel', entityId: channelId, staff: 1, staffPerm: 'chat.view' });
};

/** @AZ-220 in einer Nachricht benachrichtigt das Mitglied (sofern es den Kanal sehen darf). */
function notifyMentions(msg, channel, sender) {
  const found = new Set((msg.body.match(/@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\d+)/g) ?? []).map((m) => m.slice(1).toUpperCase()));
  for (const num of found) {
    const u = get('SELECT id FROM users WHERE UPPER(member_number) = ? AND status = ?', num, 'active');
    if (!u || u.id === sender.id) continue;
    const acc = loadAccess(u.id);
    if (!acc.perms.has('chat.view')) continue;
    const peer = { isAdmin: acc.isAdmin, roles: acc.roles };
    if (!visibleChannelIds(peer).includes(channel.id)) continue;
    notify([{ type: 'user', id: u.id }], { key: `chat:${msg.id}:${u.id}`, title: `Erwähnung in #${channel.name}`, body: `${sender.memberNumber ?? 'Mitglied'}: ${snippet(msg.body)}`, target: { app: 'chat', channelId: channel.id, messageId: msg.id } });
  }
}

export default {
  name: 'chat',
  permissions: [
    ['chat.view', 'Chat öffnen und lesen'],
    ['chat.send', 'Chat: Nachrichten schreiben, eigene bearbeiten/löschen'],
    ['chat.pin', 'Chat: Nachrichten anpinnen'],
    ['chat.moderate', 'Chat: Nachrichten anderer löschen'],
    ['chat.manage', 'Chat: Kanäle erstellen, bearbeiten, löschen'],
  ],
  init() {
    if (!get("SELECT 1 x FROM chat_channels WHERE kind = 'channel'")) run('INSERT INTO chat_channels (name,description,color,sort_order,restricted,created_at) VALUES (?,?,?,?,0,?)', 'Allgemein', 'Allgemeiner Kanal für alle Mitglieder', '#6b7280', 1, now());
  },
  routes(r) {
    r.get('/api/chat/channels', { perm: 'chat.view' }, (ctx) => {
      const ids = visibleChannelIds(ctx.user);
      const rows = all("SELECT * FROM chat_channels WHERE kind = 'channel' ORDER BY sort_order, name").filter((c) => ids.includes(c.id));
      return { channels: rows.map((c) => channelDto(c, ctx.user)) };
    });
    r.get('/api/chat/unread', { perm: 'chat.view' }, (ctx) => {
      const ids = visibleChannelIds(ctx.user);
      const rows = all('SELECT * FROM chat_channels').filter((c) => (c.kind === 'dm' ? c.dm_a === ctx.user.id || c.dm_b === ctx.user.id : ids.includes(c.id)));
      return { unread: rows.reduce((a, c) => a + channelDto(c, ctx.user).unread, 0) };
    });

    // ── Privatnachrichten ──
    /** Alle aktiven Mitglieder mit Chat-Zugang – ausschließlich als Personalnummer (Anonymität). */
    r.get('/api/chat/people', { perm: 'chat.view' }, (ctx) => ({
      people: all(`SELECT id FROM users WHERE status = 'active' AND id != ? ORDER BY member_number`, ctx.user.id)
        .filter((u) => loadAccess(u.id).perms.has('chat.view')).map((u) => ({ id: u.id, label: labelForUser(u.id, ctx.user.id) })),
    }));
    r.get('/api/chat/dms', { perm: 'chat.view' }, (ctx) => {
      const rows = all("SELECT * FROM chat_channels WHERE kind = 'dm' AND (dm_a = ? OR dm_b = ?)", ctx.user.id, ctx.user.id);
      const dms = rows.map((c) => channelDto(c, ctx.user)).filter((c) => c.lastMessageAt).sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1));
      return { dms };
    });
    r.post('/api/chat/dms', { perm: 'chat.send' }, (ctx) => {
      const peer = get("SELECT id FROM users WHERE id = ? AND status = 'active'", ctx.body.userId);
      if (!peer) throw bad('Unbekanntes Mitglied.');
      if (peer.id === ctx.user.id) throw bad('Du kannst dir nicht selbst schreiben.');
      if (!loadAccess(peer.id).perms.has('chat.view')) throw bad('Dieses Mitglied hat keinen Chat-Zugang.');
      const [a, b] = [ctx.user.id, peer.id].sort((x, y) => x - y);
      let ch = get("SELECT * FROM chat_channels WHERE kind = 'dm' AND dm_a = ? AND dm_b = ?", a, b);
      if (!ch) {
        run("INSERT INTO chat_channels (name,description,color,sort_order,restricted,created_at,kind,dm_a,dm_b) VALUES (?,?,?,?,1,?,'dm',?,?)", `dm:${a}:${b}`, '', '#5b82b8', 0, now(), a, b);
        ch = get("SELECT * FROM chat_channels WHERE kind = 'dm' AND dm_a = ? AND dm_b = ?", a, b);
      }
      return { channel: channelDto(ch, ctx.user) };
    });

    r.get('/api/chat/channels/:id/messages', { perm: 'chat.view' }, (ctx) => {
      const ch = channelFor(ctx.user, Number(ctx.params.id));
      const limit = Math.min(Math.max(parseInt(ctx.query.limit) || 60, 1), 200);
      const before = Number(ctx.query.before) || null;
      const rows = all(`${MSG_SQL} WHERE m.channel_id = ? ${before ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`, ch.id, ...(before ? [before] : []), limit + 1);
      const more = rows.length > limit;
      const msgs = rows.slice(0, limit).reverse().map((m) => msgDto(m, ctx.user));
      const pinned = all(`${MSG_SQL} WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL ORDER BY m.pinned_at DESC LIMIT 50`, ch.id).map((m) => msgDto(m, ctx.user));
      return { channel: channelDto(ch, ctx.user), messages: msgs, pinned, hasMore: more };
    });

    r.post('/api/chat/channels/:id/messages', { perm: 'chat.send' }, (ctx) => {
      const ch = channelFor(ctx.user, Number(ctx.params.id));
      const body = str(ctx.body.body, 'Nachricht', { min: 1, max: MAX_LEN });
      let reply = null;
      if (ctx.body.replyTo != null) {
        reply = get('SELECT id FROM chat_messages WHERE id = ? AND channel_id = ?', ctx.body.replyTo, ch.id)?.id;
        if (!reply) throw bad('Die Nachricht, auf die du antwortest, existiert nicht mehr.');
      }
      const id = tx(() => {
        const res = run('INSERT INTO chat_messages (channel_id,user_id,body,reply_to,created_at) VALUES (?,?,?,?,?)', ch.id, ctx.user.id, body, reply, now());
        const mid = Number(res.lastInsertRowid);
        run(`INSERT INTO chat_reads (channel_id,user_id,last_read_id) VALUES (?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`, ch.id, ctx.user.id, mid);
        if (ch.kind === 'dm') {
          const peerId = ch.dm_a === ctx.user.id ? ch.dm_b : ch.dm_a;
          notify([{ type: 'user', id: peerId }], { key: `dm:${mid}`, title: 'Neue Privatnachricht', body: `${ctx.user.memberNumber ?? 'Mitglied'}: ${snippet(body)}`, target: { app: 'chat', channelId: ch.id, messageId: mid } });
        } else notifyMentions({ id: mid, body }, ch, ctx.user);
        changed(ch.id, 'message');
        return mid;
      });
      ctx.status = 201;
      return { message: msgDto(get(`${MSG_SQL} WHERE m.id = ?`, id), ctx.user) };
    });

    const ownMessage = (ctx, id) => {
      const m = get(`${MSG_SQL} WHERE m.id = ?`, id);
      if (!m) throw notFound('Nachricht nicht gefunden.');
      channelFor(ctx.user, m.channel_id);
      return m;
    };

    r.patch('/api/chat/messages/:id', { perm: 'chat.send' }, (ctx) => {
      const m = ownMessage(ctx, Number(ctx.params.id));
      if (m.user_id !== ctx.user.id) throw forbidden('Du kannst nur eigene Nachrichten bearbeiten.');
      if (m.deleted_at) throw conflict('Die Nachricht wurde gelöscht.');
      const body = str(ctx.body.body, 'Nachricht', { min: 1, max: MAX_LEN });
      run('UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?', body, now(), m.id);
      changed(m.channel_id, 'edit');
      return { message: msgDto(get(`${MSG_SQL} WHERE m.id = ?`, m.id), ctx.user) };
    });

    r.delete('/api/chat/messages/:id', { perm: 'chat.view' }, (ctx) => {
      const m = ownMessage(ctx, Number(ctx.params.id));
      const mine = m.user_id === ctx.user.id;
      if (!mine && !ctx.user.perms.has('chat.moderate')) throw forbidden('Dafür fehlt dir die Berechtigung.');
      if (mine && !ctx.user.perms.has('chat.send') && !ctx.user.perms.has('chat.moderate')) throw forbidden();
      if (m.deleted_at) return { ok: true };
      run('UPDATE chat_messages SET body = ?, deleted_at = ?, deleted_by = ?, pinned_at = NULL, pinned_by = NULL WHERE id = ?', '', now(), ctx.user.id, m.id);
      if (!mine) audit(ctx, { action: 'chat.message_deleted', module: 'chat', targetType: 'channel', targetId: m.channel_id, targetLabel: `Nachricht #${m.id}` });
      else changed(m.channel_id, 'delete');
      return { ok: true };
    });

    r.post('/api/chat/messages/:id/pin', { perm: 'chat.pin' }, (ctx) => {
      const m = ownMessage(ctx, Number(ctx.params.id));
      if (m.deleted_at) throw conflict('Gelöschte Nachrichten lassen sich nicht anpinnen.');
      run('UPDATE chat_messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', now(), ctx.user.id, m.id);
      changed(m.channel_id, 'pin');
      return { message: msgDto(get(`${MSG_SQL} WHERE m.id = ?`, m.id), ctx.user) };
    });
    r.delete('/api/chat/messages/:id/pin', { perm: 'chat.pin' }, (ctx) => {
      const m = ownMessage(ctx, Number(ctx.params.id));
      run('UPDATE chat_messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?', m.id);
      changed(m.channel_id, 'pin');
      return { ok: true };
    });

    r.post('/api/chat/channels/:id/read', { perm: 'chat.view' }, (ctx) => {
      const ch = channelFor(ctx.user, Number(ctx.params.id));
      const last = Number.isInteger(ctx.body.lastId) ? ctx.body.lastId : get('SELECT COALESCE(MAX(id),0) m FROM chat_messages WHERE channel_id = ?', ch.id).m;
      run(`INSERT INTO chat_reads (channel_id,user_id,last_read_id) VALUES (?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`, ch.id, ctx.user.id, last);
      return { ok: true };
    });

    // ── Kanal-Verwaltung ──
    const fields = (b, partial) => {
      const out = {};
      if (!partial || b.name !== undefined) out.name = str(b.name, 'Name', { min: 2, max: 40 });
      if (!partial || b.description !== undefined) out.description = str(b.description, 'Beschreibung', { max: 200, required: false });
      if (b.color !== undefined) { if (!COLOR_RE.test(b.color)) throw bad('Ungültige Farbe.'); out.color = b.color; }
      if (b.restricted !== undefined) out.restricted = b.restricted ? 1 : 0;
      return out;
    };
    const setRoles = (id, roleIds) => {
      run('DELETE FROM chat_channel_roles WHERE channel_id = ?', id);
      for (const rid of roleIds) { if (!get('SELECT 1 x FROM roles WHERE id = ?', rid)) throw bad('Unbekannte Rolle.'); run('INSERT INTO chat_channel_roles (channel_id,role_id) VALUES (?,?)', id, rid); }
    };
    r.post('/api/chat/channels', { perm: 'chat.manage' }, (ctx) => {
      const f = fields(ctx.body, false);
      if (get('SELECT 1 x FROM chat_channels WHERE name = ?', f.name)) throw conflict('Ein Kanal mit diesem Namen existiert bereits.');
      const id = tx(() => {
        const max = get('SELECT COALESCE(MAX(sort_order),0) m FROM chat_channels').m;
        const res = run('INSERT INTO chat_channels (name,description,color,sort_order,restricted,created_at) VALUES (?,?,?,?,?,?)', f.name, f.description ?? '', f.color ?? '#6b7280', max + 1, f.restricted ?? 0, now());
        setRoles(Number(res.lastInsertRowid), intList(ctx.body.roleIds, 'Rollen'));
        return Number(res.lastInsertRowid);
      });
      audit(ctx, { action: 'chat.channel_created', module: 'chat', targetType: 'channel', targetId: id, targetLabel: f.name });
      ctx.status = 201;
      return { channel: channelDto(get('SELECT * FROM chat_channels WHERE id = ?', id), ctx.user) };
    });
    r.patch('/api/chat/channels/:id', { perm: 'chat.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get("SELECT * FROM chat_channels WHERE id = ? AND kind = 'channel'", id);
      if (!cur) throw notFound('Kanal nicht gefunden.');
      const f = fields(ctx.body, true);
      if (f.name && get('SELECT 1 x FROM chat_channels WHERE name = ? AND id != ?', f.name, id)) throw conflict('Ein Kanal mit diesem Namen existiert bereits.');
      tx(() => {
        const cols = Object.keys(f);
        if (cols.length) run(`UPDATE chat_channels SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => f[c]), id);
        if (ctx.body.roleIds !== undefined) setRoles(id, intList(ctx.body.roleIds, 'Rollen'));
      });
      audit(ctx, { action: 'chat.channel_updated', module: 'chat', targetType: 'channel', targetId: id, targetLabel: f.name ?? cur.name });
      return { channel: channelDto(get('SELECT * FROM chat_channels WHERE id = ?', id), ctx.user) };
    });
    r.delete('/api/chat/channels/:id', { perm: 'chat.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get("SELECT * FROM chat_channels WHERE id = ? AND kind = 'channel'", id);
      if (!cur) throw notFound('Kanal nicht gefunden.');
      if (get("SELECT COUNT(*) c FROM chat_channels WHERE kind = 'channel'").c <= 1) throw conflict('Der letzte Kanal kann nicht gelöscht werden.');
      run('DELETE FROM chat_channels WHERE id = ?', id);
      audit(ctx, { action: 'chat.channel_deleted', module: 'chat', targetType: 'channel', targetId: id, targetLabel: cur.name });
      return { ok: true };
    });
  },
};
