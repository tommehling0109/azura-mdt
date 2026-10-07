import { openStream } from '../core/realtime.js';
import { listNotifications, markRead } from '../core/notifications.js';
import { intList } from '../core/http.js';

/**
 * Live-Verbindung (SSE) und Benachrichtigungs-Endpunkte – für Mitarbeiter und Partner-Portal identisch aufgebaut.
 */
export default {
  name: 'realtime',
  routes(r) {
    // Mitarbeiter
    r.get('/api/events', (ctx) => openStream(ctx, { kind: 'staff', userId: ctx.user.id, token: ctx.token, perms: ctx.user.perms }));
    r.get('/api/notifications', (ctx) => listNotifications('user', ctx.user.id, Math.min(Number(ctx.query.limit) || 40, 100)));
    r.post('/api/notifications/read', (ctx) => { markRead('user', ctx.user.id, ctx.body.ids === undefined ? null : intList(ctx.body.ids, 'IDs')); return { ok: true }; });

    // Partner-Portal
    const P = { auth: 'partner' };
    r.get('/api/p/events', P, (ctx) => openStream(ctx, { kind: 'partner', partnerId: ctx.partner.id, token: ctx.partnerToken }));
    r.get('/api/p/notifications', P, (ctx) => listNotifications('partner', ctx.partner.id, Math.min(Number(ctx.query.limit) || 40, 100)));
    r.post('/api/p/notifications/read', P, (ctx) => { markRead('partner', ctx.partner.id, ctx.body.ids === undefined ? null : intList(ctx.body.ids, 'IDs')); return { ok: true }; });
  },
};
