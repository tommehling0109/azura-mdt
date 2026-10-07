// Benachrichtigungen – gleiche Logik für Mitarbeiter und Partner-Portal, ausschließlich INNERHALB des virtuellen Systems
// (keine Browser-/Betriebssystem-Benachrichtigungen): jedes Ereignis → Glocken-Liste + Zähler + System-Hinweis (Pop-up) + Ton.
import { api } from './api.js';
import { onNotification } from './realtime.js';
import { toast } from './ui/kit.js';

const listeners = new Set();
let base = '/api';
let scope = 'user:0';
let openTarget = () => {};
const data = { list: [], unread: 0 };

export const getNotifications = () => data;
export const onNotifChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((f) => f(data));

// ── Einstellungen (pro Browser): Ton und Pop-up-Hinweise ──
const pref = (k, d = '1') => { try { return (localStorage.getItem(`mdt:${k}`) ?? d) === '1'; } catch { return d === '1'; } };
export const getPref = (k) => pref(k);
export function setPref(k, v) { try { localStorage.setItem(`mdt:${k}`, v ? '1' : '0'); } catch { /* egal */ } }

// ── Ton: kleiner, dezenter Zweiklang (WebAudio, keine Datei nötig) ──
let audio = null;
function unlockAudio() {
  try { audio ??= new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch { /* kein Audio */ }
}
export function playSound(force = false) {
  if (!force && !pref('sound')) return;
  try {
    unlockAudio();
    if (!audio || audio.state !== 'running') return;
    const t = audio.currentTime;
    [[880, 0], [1318.5, 0.11]].forEach(([f, d]) => {
      const o = audio.createOscillator(); const g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.05, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.28);
      o.connect(g); g.connect(audio.destination); o.start(t + d); o.stop(t + d + 0.3);
    });
  } catch { /* egal */ }
}

/** Pro Ereignis spielt nur EIN Tab den Ton (sonst mehrfach) – Ereignis-ID wird per localStorage „beansprucht“. */
function claim(eventId) {
  const key = `mdt:claim:${scope}`;
  try {
    const cur = Number(localStorage.getItem(key) || 0);
    if (cur >= eventId) return false;
    localStorage.setItem(key, String(eventId));
    return true;
  } catch { return true; }
}

async function refresh() {
  try {
    const r = await api.get(`${base}/notifications`);
    data.list = r.notifications; data.unread = r.unread; emit();
  } catch { /* offline */ }
}

export async function markRead(ids) {
  try { await api.post(`${base}/notifications/read`, ids ? { ids } : {}); } catch { /* egal */ }
}

function handle(ev) {
  if (ev.kind === 'reset' || ev.kind === 'read') return refresh();
  if (ev.kind !== 'new') return;
  // 1) Liste + Zähler
  if (!data.list.some((x) => x.id === ev.id)) {
    data.list = [{ id: ev.id, key: ev.key, title: ev.title, body: ev.body, target: ev.target, createdAt: ev.createdAt, read: false }, ...data.list].slice(0, 60);
    data.unread += 1;
    emit();
  }
  // 2) System-Hinweis (Pop-up oben rechts im virtuellen Desktop) – Klick öffnet den Datensatz
  if (pref('popup')) toast(ev.body, 'info', { title: ev.title, onClick: () => { markRead([ev.id]); openTarget(ev.target); }, duration: 7000 });
  // 3) Ton
  if (claim(ev.eventId)) playSound();
}

/** kind: 'staff' | 'partner'; open(target) öffnet den betroffenen Datensatz. */
export function initNotifier({ kind, id, open }) {
  base = kind === 'partner' ? '/api/p' : '/api';
  scope = `${kind}:${id ?? 0}`;
  openTarget = open ?? (() => {});
  data.list = []; data.unread = 0;
  onNotification(handle);
  refresh();
  // Der Ton braucht eine Nutzergeste → bei der ersten Interaktion freischalten
  const once = () => { document.removeEventListener('pointerdown', once); unlockAudio(); };
  document.addEventListener('pointerdown', once);
}
export const reloadNotifications = refresh;
