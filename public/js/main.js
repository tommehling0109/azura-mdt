import { api, onUnauthenticated } from './api.js';
import { state, applyConfig, previewConfig } from './state.js';
import { showApp, showLock, openApp } from './shell.js';
import { showLogin, showRegister, showSetup, showPending } from './views/auth.js';
import { showPartnerLogin, showInvalidLink } from './views/partner/login.js';
import { PARTNER_NAV } from './modules.js';
import { toast } from './ui/kit.js';
import { h } from './ui/dom.js';

// Externer Zugang: /p/<link-token> – eigene Anmeldung per Code, nur freigeschaltete Apps
const partnerToken = (() => { const m = location.pathname.match(/^\/p\/([^/]+)\/?$/); return m ? decodeURIComponent(m[1]) : null; })();

async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* egal */ }
  state.user = null;
  await start();
}

function route(user) {
  state.user = user;
  if (user.status === 'active') return showApp(logout);
  if (user.status === 'pending') {
    return showPending({
      user, onLogout: logout,
      onRefresh: async () => {
        const { user: fresh } = await api.get('/api/auth/me');
        if (fresh.status === 'active') { toast('Dein Zugang wurde freigeschaltet.'); route(fresh); } else toast('Noch nicht freigeschaltet.', 'warn');
      },
    });
  }
  return logout();
}

async function boot() {
  try { return await api.get('/api/bootstrap'); } catch (e) {
    showLock(h('div', { class: 'lock-card' }, h('h2', null, 'Server nicht erreichbar'), h('p', { class: 'lead' }, e.message)));
    return null;
  }
}

async function start() {
  const b = await boot();
  if (!b) return;
  applyConfig(b.config);
  const onAuthed = async (user, firstRun) => {
    try { applyConfig((await api.get('/api/bootstrap')).config); } catch { /* alte Konfiguration behalten */ }
    route(user);
    if (firstRun) openApp('config');
  };

  if (b.setupRequired) return showSetup({ onAuthed });
  try {
    const { user } = await api.get('/api/auth/me');
    return route(user);
  } catch { /* nicht angemeldet */ }
  const goLogin = () => showLogin({ onAuthed, goRegister });
  const goRegister = () => showRegister({ onAuthed, goLogin });
  goLogin();
}

async function partnerLogout() {
  try { await api.post('/api/p/logout'); } catch { /* egal */ }
  state.user = null;
  await startPartner();
}

async function startPartner() {
  const b = await boot();
  if (!b) return;
  applyConfig(b.config);
  let session;
  try { session = await api.get(`/api/p/${encodeURIComponent(partnerToken)}/session`); } catch { return showInvalidLink(); }
  const enter = (partner) => {
    state.user = { id: 0, username: '', displayName: partner.number ?? partner.name, status: 'active', roles: [], permissions: [], isAdmin: false, memberNumber: null, rank: null, department: null, isPartner: true };
    const allowed = new Set(partner.apps);
    showApp(partnerLogout, { nav: PARTNER_NAV, allow: (i) => allowed.has(i.id), footerRole: 'Externer Zugang', partner: true });
    if (!partner.apps.length) toast('Für diesen Zugang sind noch keine Apps freigeschaltet.', 'warn');
  };
  if (session.authenticated) return enter(session.partner);
  showPartnerLogin({ token: partnerToken, onAuthed: enter });
}

onUnauthenticated((code) => {
  if (!state.user) return;
  if (partnerToken && code === 'unauthenticated_partner') { state.user = null; toast('Deine Sitzung ist abgelaufen oder der Zugang wurde geändert.', 'warn'); startPartner(); }
  else if (!partnerToken && code === 'unauthenticated') { state.user = null; toast('Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.', 'warn'); start(); }
});
(partnerToken ? startPartner : start)();

// Konfigurationsänderungen (z. B. Akzentfarbe) sofort sichtbar machen
window.addEventListener('mdt:config', (e) => previewConfig(e.detail));
