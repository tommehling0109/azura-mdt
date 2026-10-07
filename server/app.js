import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, createRouter, parseCookies, readJson, sendJson, forbidden } from './core/http.js';
import { COOKIE, userFromToken } from './core/auth.js';
import { registerPermissions, syncPermissions, can } from './core/permissions.js';
import { PARTNER_COOKIE, partnerFromToken } from './core/partner-auth.js';
import { syncLookups } from './core/lookups.js';
import { registerConfig } from './core/config.js';
import { migrate, DB_PATH } from './core/db.js';
import { dirname } from 'node:path';

import systemModule, { brandingFile } from './modules/system.js';
import authModule from './modules/auth.js';
import usersModule from './modules/users.js';
import rolesModule from './modules/roles.js';
import orgModule from './modules/org.js';
import auditModule from './modules/audit.js';
import dashboardModule from './modules/dashboard.js';
import realtimeModule from './modules/realtime.js';
import chatModule from './modules/chat.js';
import vehiclesModule from './modules/vehicles.js';
import mapModule from './modules/map.js';
import warehouseModule from './modules/warehouses.js';
import financeModule from './modules/finance.js';
import tabModule from './modules/tab.js';
import creditModule from './modules/credit.js';
import profileModule from './modules/profile.js';
import lookupsModule from './modules/lookups.js';
import partnersModule from './modules/partners.js';
import marketModule from './modules/market.js';

/** Modulliste – spätere Phasen hängen hier weitere Module an (vehicles, storage, purchasing, chat, …). */
const MODULES = [systemModule, authModule, usersModule, rolesModule, orgModule, auditModule, dashboardModule, lookupsModule, partnersModule, marketModule, chatModule, vehiclesModule, mapModule, warehouseModule, financeModule, tabModule, creditModule, profileModule, realtimeModule];

/** Hinter nginx o. ä.: TRUST_PROXY=1 ⇒ Client-IP und Protokoll aus X-Forwarded-* übernehmen (sonst ignorieren – nicht fälschbar). */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const clientIp = (req) => (TRUST_PROXY ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress;
const isSecure = (req) => !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function buildApp() {
  migrate();
  const router = createRouter();
  for (const m of MODULES) {
    registerPermissions(m.name, m.permissions ?? []);
    registerConfig(m.config ?? []);
    m.routes?.(router);
  }
  syncPermissions();
  syncLookups();
  for (const m of MODULES) m.init?.();

  async function handleApi(req, res, url) {
    const { route, params, pathMatched } = router.match(req.method, url.pathname);
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Methode nicht erlaubt.' : 'Endpunkt nicht gefunden.');

    // CSRF-Schutz: Schreibzugriffe nur mit Custom-Header (löst Preflight aus) + SameSite=Strict-Cookie
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'mdt') throw forbidden('Ungültige Anfrage.');

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE];
    const user = userFromToken(token);
    const partnerToken = cookies[PARTNER_COOKIE];
    const partner = partnerFromToken(partnerToken);
    const ctx = {
      req, res, params, user, token, partner, partnerToken,
      actorName: partner ? `Partner ${partner.number ?? ''}`.trim() : undefined,
      ip: clientIp(req),
      secure: isSecure(req),
      query: Object.fromEntries(url.searchParams),
      body: req.method === 'GET' ? {} : await readJson(req, route.opts.bodyLimit),
      status: 200, headers: {},
    };

    const { auth = true, perm, partnerApp } = route.opts;
    if (auth === 'partner') {
      if (!partner) throw new HttpError(401, 'Nicht angemeldet.', 'unauthenticated_partner');
      if (partnerApp && !partner.apps.has(partnerApp)) throw forbidden('Diese App ist für deinen Zugang nicht freigeschaltet.');
    } else if (auth !== false) {
      if (!user) throw new HttpError(401, 'Nicht angemeldet.', 'unauthenticated');
      if (auth === true && user.status !== 'active') throw new HttpError(403, 'Dein Zugang ist nicht freigeschaltet.', 'not_active');
    }
    if (perm) {
      const list = Array.isArray(perm) ? perm : [perm];
      if (!list.some((p) => can(user, p))) throw forbidden();
    }
    const data = await route.handler(ctx);
    if (ctx.handled) return; // Handler hat die Antwort selbst geschrieben (SSE-Stream)
    if (ctx.raw) {
      res.writeHead(200, { 'Content-Type': ctx.raw.contentType, ...(ctx.raw.inline ? {} : { 'Content-Disposition': `attachment; filename="${ctx.raw.filename}"` }), 'Cache-Control': ctx.raw.cache ?? 'no-store' });
      return res.end(ctx.raw.body);
    }
    sendJson(res, ctx.status, data ?? { ok: true }, ctx.headers);
  }

  /** Selbst gehostete Kartenkacheln aus data/maptiles (…/{z}/{x}/{y}.png) – Pfad wird streng geprüft. */
  async function serveMapTile(res, pathname) {
    const m = /^\/maptiles\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.(png|jpg|jpeg|webp)$/.exec(pathname);
    if (!m) { res.writeHead(404); return res.end('Not found'); }
    try {
      const file = join(dirname(DB_PATH), 'maptiles', m[1], m[2], `${m[3]}.${m[4]}`);
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[`.${m[4] === 'jpeg' ? 'jpg' : m[4]}`] ?? 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(body);
    } catch { res.writeHead(404); res.end('Not found'); }
  }

  function serveBranding(res, kind) {
    const f = brandingFile(kind);
    if (!f) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(f.body);
  }

  async function serveStatic(req, res, url) {
    if (url.pathname.startsWith('/maptiles/')) return serveMapTile(res, url.pathname);
    if (url.pathname === '/branding/logo') return serveBranding(res, 'logo');
    if (url.pathname === '/branding/wallpaper') return serveBranding(res, 'wallpaper');
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    if (!rel || rel.endsWith(sep)) rel = join(rel, 'index.html');
    let file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    try {
      if (!(await stat(file)).isFile()) throw new Error();
    } catch {
      // Dateien mit Endung → 404, sonst SPA-Fallback
      if (extname(rel)) { res.writeHead(404); return res.end('Not found'); }
      file = join(PUBLIC_DIR, 'index.html');
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  return createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('ok'); }
      else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
      else { res.writeHead(405); res.end(); }
    } catch (e) {
      if (e instanceof HttpError) {
        if (!res.headersSent) sendJson(res, e.status, { error: e.message, code: e.code, details: e.details });
      } else {
        console.error('[Fehler]', req.method, req.url, e);
        if (!res.headersSent) sendJson(res, 500, { error: 'Interner Serverfehler.', code: 'internal' });
      }
    }
  });
}
