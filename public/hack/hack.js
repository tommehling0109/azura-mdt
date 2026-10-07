// Terminal-Minigame (Exekutive-Zugang). Bewusst eigenständig: keine Verbindung zur Hauptoberfläche, keine Namen/Logos.
const token = decodeURIComponent(location.pathname.split('/')[2] ?? '');
const API = `/api/h/${encodeURIComponent(token)}`;
const out = document.getElementById('out'), panel = document.getElementById('panel'), hud = document.getElementById('hud');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

async function call(path, body) {
  try {
    const r = await fetch(API + path, { method: body ? 'POST' : 'GET', headers: { 'X-Requested-With': 'mdt', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    let data = {}; try { data = await r.json(); } catch { /* leer */ }
    return { status: r.status, data };
  } catch { return { status: 0, data: {} }; }
}

// ── Ausgabe ──
async function line(text = '', cls = '', speed = 7) {
  const d = el('div', cls); out.append(d);
  if (speed && text.length < 90) { for (const c of text) { d.textContent += c; if (speed > 1 && Math.random() < 0.5) await sleep(speed); } } else d.textContent = text;
  out.scrollTop = out.scrollHeight; return d;
}
const clearPanel = () => panel.replaceChildren();
const fmt = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`; };
const prompt = (cmd) => line(`PS C:\\ghost> ${cmd}`, 'info', 10);

let timer = null;
function countdown(sec, label) {
  const d = el('div', 'warn'); out.append(d); const end = Date.now() + sec * 1000;
  clearInterval(timer);
  const tick = () => { const left = Math.max(0, Math.ceil((end - Date.now()) / 1000)); d.textContent = `${label} ${fmt(left)}`; if (!left) { clearInterval(timer); location.reload(); } };
  tick(); timer = setInterval(tick, 1000); out.scrollTop = out.scrollHeight;
}

function setHud(index, total, lives) {
  hud.hidden = false; hud.replaceChildren();
  const a = el('span'); a.append('STUFE ', Object.assign(el('b'), { textContent: `${index + 1}/${total}` }));
  const b = el('span', 'lives', '\u2665'.repeat(lives) + '\u2661'.repeat(Math.max(0, state.maxLives - lives)));
  const c = el('span'); c.append('ZEIT ', Object.assign(el('b'), { textContent: '--:--' }));
  hud.append(a, b, c);
  if (!setHud.t0) setHud.t0 = Date.now();
  clearInterval(setHud.iv); setHud.iv = setInterval(() => { const s = Math.floor((Date.now() - setHud.t0) / 1000); c.lastChild.textContent = fmt(s); }, 1000);
}

// ── Ablauf ──
async function boot() {
  await line('Microsoft Windows [Version 10.0.19045.4291]', 'dim', 2);
  await line('(c) Microsoft Corporation. Alle Rechte vorbehalten.', 'dim', 2);
  await line('');
  await prompt('.\\ghost.ps1 -init');
  await line('[+] lade Module ............ ok', 'dim', 2);
  await line('[+] Tarnung aktiv ........... ok', 'dim', 2);
  await line('[+] suche Relay ............. ok', 'dim', 2);
  const { status, data } = await call('/status');
  if (status === 404 || status === 0) { await line(''); await line(status === 0 ? '[-] keine Netzwerkverbindung' : '[-] Ziel nicht erreichbar (404)', 'err'); return; }
  if (!data.enabled) { await line('[-] Relay offline. Später erneut versuchen.', 'err'); return; }
  if (data.cooldownSec > 0) return locked(data.cooldownSec);
  await line('');
  await line('Zielsystem gefunden. Vier Sicherheitsstufen aktiv.', 'warn');
  state.maxLives = data.lives;
  await line(`Du hast ${data.lives} Versuch${data.lives === 1 ? '' : 'e'}. Wird die Rückverfolgung abgeschlossen, bist du raus.`, 'dim');
  const go = el('button', '', 'Verbindung aufbauen'); go.addEventListener('click', () => { clearPanel(); begin(); });
  panel.append(go); go.focus();
}

async function locked(sec, text = '[-] Firewall-Sperre aktiv – dein Zugang wird überwacht.') {
  clearPanel(); hud.hidden = true; clearInterval(setHud.iv);
  await line(''); await line(text, 'err'); countdown(sec, 'Nächster Versuch möglich in');
}

async function begin() {
  await prompt('connect --target core --bypass');
  const { status, data } = await call('/start', {});
  if (status === 429) return locked(data.details?.cooldownSec ?? 60);
  if (status !== 200) { await line('[-] Verbindung abgelehnt.', 'err'); return; }
  setHud.t0 = Date.now();
  state.sid = data.sid; state.maxLives = data.maxLives ?? data.lives;
  await line('[+] Verbindung steht. Sicherheitsstufe 1 …', 'ok');
  await stage(data.stage, data.lives);
}
const state = { sid: null, maxLives: 3 };

// Antwort des Servers verarbeiten
async function handle(res, lives) {
  const { status, data } = res;
  if (status === 410) { await line('[-] Verbindung verloren.', 'err'); clearPanel(); hud.hidden = true; return countdown(5, 'Neustart in'); }
  if (status === 429) return locked(data.details?.cooldownSec ?? 60);
  if (data.result === 'ok') { await line('[+] Stufe geknackt.', 'ok'); return stage(data.stage, data.lives); }
  if (data.result === 'retry') { await line(`[!] ${data.message} – Rückverfolgung läuft (${data.lives} Versuch${data.lives === 1 ? '' : 'e'} übrig).`, 'warn'); return stage(data.stage, data.lives); }
  if (data.result === 'failed') { clearPanel(); await line(`[-] ZUGRIFF VERWEIGERT – ${data.reason}.`, 'err'); return locked(data.cooldownSec, '[-] Verbindung getrennt. Firewall-Sperre aktiv.'); }
  if (data.result === 'done') return success(data);
  if (status >= 400) await line(`[-] ${data.error ?? 'Fehler'}`, 'err');
  return lives;
}

async function stage(s, lives) {
  clearPanel(); setHud(s.index, s.total, lives);
  ({ typing, code, sequence, cipher }[s.type])(s, lives);
}

// 1) Brute-Force: Befehle exakt abtippen
async function typing(s, lives) {
  await prompt(`payload --compose   # tippe die Befehle exakt ab (${s.typeSec} s)`);
  const target = s.lines.join('\n'); let t0 = 0, sent = false;
  const view = el('div', 'typed'), ta = el('textarea'); ta.setAttribute('aria-label', 'Befehle eingeben'); ta.spellcheck = false; ta.autocomplete = 'off';
  const draw = () => {
    view.replaceChildren(); const v = ta.value;
    [...target].forEach((c, i) => { const sp = el('span', i < v.length ? (v[i] === c ? 'good' : 'bad') : 'todo', c); view.append(sp); });
  };
  for (const ev of ['paste', 'drop', 'cut', 'contextmenu']) ta.addEventListener(ev, (e) => e.preventDefault());
  ta.addEventListener('input', async () => {
    if (!t0) t0 = Date.now(); draw();
    if (!sent && ta.value.length >= target.length) { sent = true; ta.disabled = true; handle(await call('/answer', { sid: state.sid, text: ta.value, ms: Date.now() - t0 }), lives); }
  });
  draw(); panel.append(view, ta); ta.focus();
}

// 2) Kennwort knacken (Mastermind, 4 verschiedene Ziffern)
async function code(s, lives) {
  await prompt(`hash --crack   # ${s.length} verschiedene Ziffern, ● = richtige Stelle, ○ = falsche Stelle`);
  const inp = el('input'); inp.maxLength = s.length; inp.inputMode = 'numeric'; inp.placeholder = '0'.repeat(s.length); inp.autocomplete = 'off';
  const go = el('button', '', 'Testen'), info = el('div', 'dim', `Versuche übrig: ${s.tries}`), hist = el('div', 'hist');
  const submit = async () => {
    if (!new RegExp(`^\\d{${s.length}}$`).test(inp.value)) { info.textContent = `Bitte genau ${s.length} Ziffern eingeben.`; return; }
    go.disabled = inp.disabled = true; const g = inp.value;
    const res = await call('/answer', { sid: state.sid, guess: g });
    if (res.data.result === 'feedback') {
      const d = el('div'); d.append(el('span', '', g), el('span', 'pegs ok', '\u25CF'.repeat(res.data.exact)), el('span', 'pegs info', '\u25CB'.repeat(res.data.present)));
      hist.prepend(d); info.textContent = `Versuche übrig: ${res.data.tries}`; inp.value = ''; go.disabled = inp.disabled = false; inp.focus();
    } else handle(res, lives);
  };
  go.addEventListener('click', submit); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  const row = el('div', 'row'); row.append(inp, go); panel.append(row, info, hist); inp.focus();
}

// 3) Sequenz merken
async function sequence(s, lives) {
  await prompt('firewall --pattern   # merke dir die Folge und wiederhole sie');
  const grid = el('div', 'grid'), info = el('div', 'dim', 'Beobachte …'); const cells = [];
  for (let i = 0; i < s.grid; i++) { const b = el('button', '', ''); b.disabled = true; b.setAttribute('aria-label', `Feld ${i + 1}`); cells.push(b); grid.append(b); }
  panel.append(grid, info);
  await sleep(700);
  for (const n of s.sequence) { cells[n].classList.add('lit'); await sleep(s.speed); cells[n].classList.remove('lit'); await sleep(Math.round(s.speed / 2.4)); }
  info.textContent = `Jetzt du: ${s.sequence.length} Felder in derselben Reihenfolge.`;
  const mine = []; cells.forEach((b) => (b.disabled = false));
  cells.forEach((b, i) => b.addEventListener('click', async () => {
    if (mine.length >= s.sequence.length) return;
    mine.push(i); b.classList.add('mine'); setTimeout(() => b.classList.remove('mine'), 180); info.textContent = `${mine.length}/${s.sequence.length}`;
    if (mine.length === s.sequence.length) { cells.forEach((x) => (x.disabled = true)); handle(await call('/answer', { sid: state.sid, sequence: mine }), lives); }
  }));
}

// 4) Entschlüsseln (Caesar): Verschiebung finden
async function cipher(s, lives) {
  await prompt('decrypt --blob   # drehe am Regler, bis ein sinnvolles Wort erscheint');
  const big = el('div', 'big'), slider = el('input', 'slider'); slider.type = 'range'; slider.min = 0; slider.max = 25; slider.value = 0;
  const dec = (k) => [...s.cipher].map((c) => String.fromCharCode(((c.charCodeAt(0) - 65 - k + 26) % 26) + 65)).join('');
  const lbl = el('div', 'dim'), go = el('button', '', 'Entschlüsselung bestätigen');
  const upd = () => { big.textContent = dec(Number(slider.value)); lbl.textContent = `Verschiebung: ${slider.value}   (verschlüsselt: ${s.cipher})`; };
  slider.addEventListener('input', upd); upd();
  go.addEventListener('click', async () => { go.disabled = slider.disabled = true; handle(await call('/answer', { sid: state.sid, text: big.textContent }), lives); });
  const row = el('div', 'row'); row.append(slider, go); panel.append(big, lbl, row); slider.focus();
}

async function success(data) {
  clearPanel(); clearInterval(setHud.iv);
  await line(''); await line('[+] ZUGRIFF GEWÄHRT', 'ok'); await line('');
  await prompt('dump --random');
  await line('Datenschnipsel werden übertragen …', 'dim');
  for (const r of data.rewards) {
    await sleep(500); const box = el('div', 'loot'); out.append(box);
    const head = el('div', 'info', `[${r.kind}] ${r.title}`); box.append(head);
    for (const l of r.lines) box.append(el('div', '', l));
    out.scrollTop = out.scrollHeight;
  }
  await line(''); await line('[+] Übertragung beendet. Spuren werden gelöscht …', 'dim');
  await line('Mach dir Notizen oder einen Screenshot – die Verbindung wird getrennt.', 'warn');
  countdown(data.cooldownSec, 'Nächster Zugriff möglich in');
}

boot();
