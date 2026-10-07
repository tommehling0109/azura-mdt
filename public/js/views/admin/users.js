import { h, mount, fmtDateTime, timeAgo, debounce } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import {
  button, busy, table, tabs, avatar, statusBadge, roleChip, memberNo, rankBadge, deptBadge, field, input, select, checkbox, formError,
  openModal, confirmDialog, toast, skeletons, empty, note,
} from '../../ui/kit.js';
import { api } from '../../api.js';
import { can, state } from '../../state.js';

let permCatalog = null;
const loadCatalog = async () => (permCatalog ??= (await api.get('/api/permissions')).permissions);

export default async function render(container, ctx) {
  const f = { status: 'all', q: '' };
  const [{ roles }, org] = await Promise.all([api.get('/api/roles'), api.get('/api/org'), loadCatalog().catch(() => [])]);
  const tabsHost = h('div');
  const listHost = h('div');
  const search = h('input', { class: 'input', placeholder: 'Benutzer suchen …', 'aria-label': 'Suche' });
  mount(container, h('div', { class: 'toolbar' }, tabsHost, h('div', { class: 'grow' }), h('div', { class: 'input-icon' }, icon('search'), search)), listHost);

  if (can('users.create')) ctx.setActions(button('Benutzer anlegen', { variant: 'primary', icon: 'userPlus', onClick: () => editor(null) }));

  async function load(silent = false) {
    if (!silent) mount(listHost, skeletons(5, 56));
    const p = new URLSearchParams();
    if (f.status !== 'all') p.set('status', f.status);
    if (f.q) p.set('q', f.q);
    const [{ users }, { counts }] = await Promise.all([api.get('/api/users?' + p), api.get('/api/users')]);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    mount(tabsHost, tabs([
      { id: 'all', label: 'Alle', count: total }, { id: 'pending', label: 'Ausstehend', count: counts.pending ?? 0 },
      { id: 'active', label: 'Aktiv', count: counts.active ?? 0 }, { id: 'blocked', label: 'Gesperrt', count: counts.blocked ?? 0 },
      { id: 'rejected', label: 'Abgelehnt', count: counts.rejected ?? 0 },
    ], f.status, (id) => { f.status = id; load(); }));
    ctx.refreshCounters?.();
    mount(listHost, table([
      { label: 'Nr.', style: { width: '1%' }, render: (u) => memberNo(u.memberNumber) },
      { label: 'Benutzer', render: (u) => h('div', { class: 'cell-user' }, avatar(u.displayName), h('div', null, h('div', { class: 'nm' }, u.displayName), h('div', { class: 'sub' }, u.username ? '@' + u.username : (u.isSelf ? 'Du' : 'Name geschützt')))) },
      { label: 'Rang / Abteilung', render: (u) => (u.rank || u.department ? h('div', { class: 'chips' }, rankBadge(u.rank), deptBadge(u.department)) : h('span', { class: 'muted' }, '–')) },
      { label: 'Status', render: (u) => statusBadge(u.status) },
      { label: 'Rollen', render: (u) => (u.roles.length ? h('div', { class: 'chips' }, u.roles.map(roleChip)) : h('span', { class: 'muted' }, '–')) },
      { label: 'Letzte Anmeldung', render: (u) => h('span', { class: 'muted', title: fmtDateTime(u.lastLoginAt) }, u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'nie') },
      { label: '', style: { width: '1%' }, render: (u) => h('div', { class: 'actions' }, rowActions(u)) },
    ], users, { onRowClick: (u) => editor(u.id), empty: empty('Keine Benutzer gefunden', 'Passe Filter oder Suche an.', 'users') }));
  }

  function rowActions(u) {
    const out = [];
    const me = u.id === state.user.id;
    if (can('users.approve') && !me) {
      if (u.status === 'pending') {
        out.push(button('Freischalten', { size: 'sm', variant: 'ok', icon: 'check', onClick: (e) => approve(u, e.currentTarget) }));
        out.push(button('Ablehnen', { size: 'sm', variant: 'danger', icon: 'x', onClick: () => setStatus(u, 'rejected', { title: 'Zugang ablehnen?', msg: `${u.displayName} erhält keinen Zugriff.`, label: 'Ablehnen', reason: true }) }));
      } else if (u.status === 'active') out.push(button('Sperren', { size: 'sm', variant: 'danger', icon: 'lock', onClick: () => setStatus(u, 'blocked', { title: 'Benutzer sperren?', msg: `${u.displayName} wird sofort abgemeldet und kann sich nicht mehr anmelden.`, label: 'Sperren', reason: true }) }));
      else out.push(button('Freischalten', { size: 'sm', variant: 'ok', icon: u.status === 'blocked' ? 'unlock' : 'check', onClick: (e) => approve(u, e.currentTarget) }));
    }
    return out;
  }

  async function setStatus(u, status, c) {
    const r = await confirmDialog({ title: c.title, message: c.msg, confirmLabel: c.label, withReason: c.reason });
    if (!r) return;
    try { await api.post(`/api/users/${u.id}/status`, { status, reason: r.reason }); toast(`${u.displayName}: ${c.label.toLowerCase()} ✓`); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  /** Freischalten mit Rollenauswahl (neue Benutzer haben noch keine Rolle). */
  function approve(u) {
    if (u.status !== 'pending' || u.roles.length) return quickActivate(u);
    const checks = roles.filter((r) => !r.isAdmin || state.user.isAdmin).map((r) => [r, checkbox(h('span', null, roleChip(r)), false, { desc: r.description })]);
    const m = openModal({
      title: `${u.displayName} freischalten`,
      body: h('div', { class: 'stack' }, h('p', { style: { color: 'var(--text-2)' } }, 'Wähle optional Rollen aus, die der Benutzer mit der Freischaltung erhält. Ohne Rolle sieht er nur das Dashboard.'),
        roles.length ? checks.map(([, c]) => c) : note('Es existieren noch keine Rollen. Du kannst sie im Bereich „Rollen & Rechte“ anlegen.')),
      footer: [button('Abbrechen', { onClick: () => m.close() }),
        button('Freischalten', { variant: 'ok', icon: 'check', onClick: async (e) => busy(e.currentTarget, async () => {
          try {
            await api.post(`/api/users/${u.id}/status`, { status: 'active', roleIds: checks.filter(([, c]) => c.input.checked).map(([r]) => r.id) });
            m.close(); toast(`${u.displayName} wurde freigeschaltet.`); await load();
          } catch (ex) { toast(ex.message, 'err'); }
        }) })],
    });
  }
  async function quickActivate(u) {
    try { await api.post(`/api/users/${u.id}/status`, { status: 'active' }); toast(`${u.displayName} wurde freigeschaltet.`); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  /** Dialog zum Anlegen (id = null) bzw. Bearbeiten. */
  async function editor(id) {
    let user = null;
    if (id) { try { user = (await api.get(`/api/users/${id}`)).user; } catch (e) { return toast(e.message, 'err'); } }
    const err = h('div');
    const dn = input({ value: user?.displayName ?? '', maxLength: 60, disabled: !!user && !can('users.edit') });
    const un = input({ value: user?.username ?? '', maxLength: 32, disabled: !!user, autocomplete: 'off' });
    const pw = input({ type: 'password', autocomplete: 'new-password', placeholder: 'Mindestens 8 Zeichen' });
    const editable = !user || can('users.edit');
    const rankSel = select([{ value: '', label: '— kein Rang —' }, ...org.ranks.map((r) => ({ value: r.id, label: r.name }))], user?.rank?.id ?? '', { disabled: !editable });
    const deptSel = select([{ value: '', label: '— keine Abteilung —' }, ...org.departments.map((d) => ({ value: d.id, label: d.name }))], user?.department?.id ?? '', { disabled: !editable });
    let supSel = null;
    if (user) {
      let candidates = [];
      try { candidates = (await api.get('/api/users?status=active')).users.filter((x) => x.id !== user.id); } catch { /* ohne Auswahl */ }
      supSel = select([{ value: '', label: '— kein Vorgesetzter —' }, ...candidates.map((x) => ({ value: x.id, label: `${x.displayName}${x.memberNumber ? ' (' + x.memberNumber + ')' : ''}` }))], user.supervisor?.id ?? '', { disabled: !editable });
    }
    const idOrNull = (el) => (el.value ? Number(el.value) : null);
    const roleBoxes = roles.map((r) => [r, checkbox(roleChip(r), user?.roles.some((x) => x.id === r.id), { desc: r.description, locked: !can('users.edit') && !!user })]);
    const directSet = new Set(user?.directPermissions ?? []);
    const permBoxes = (permCatalog ?? []).map((p) => [p, checkbox(h('code', null, p.key), directSet.has(p.key), { desc: p.description, locked: !can('users.edit') })]);
    const groups = {};
    for (const [p, c] of permBoxes) (groups[p.module] ??= []).push(c);

    const roleBody = h('div', null, roles.length ? roleBoxes.map(([, c]) => c) : note('Noch keine Rollen vorhanden.'));
    const permBody = h('div', null, note('Direkte Rechte gelten zusätzlich zu den Rollen. Nutze sie sparsam – Rollen sind übersichtlicher.'), h('div', { style: { height: '12px' } }),
      Object.entries(groups).map(([m, boxes]) => h('div', { class: 'perm-group' }, h('h4', null, m), h('div', { class: 'perm-grid' }, boxes))));
    const effBody = h('div', null, user?.isAdmin && note('Administrator – dieser Benutzer besitzt automatisch alle Rechte.', 'shield'), h('div', { class: 'chips', style: { marginTop: '10px' } },
      (user?.effectivePermissions ?? []).map((k) => h('span', { class: 'badge no-dot b-info mono' }, k))));

    const general = h('div', null, err,
      user && h('div', { class: 'member-card' }, avatar(user.displayName, 'lg'),
        h('div', { class: 'grow' }, h('div', { class: 'mc-name' }, user.displayName), h('div', { class: 'mc-sub' }, user.username ? `@${user.username}` : (user.memberNumber ? 'Personalnummer' : '')),
          h('div', { class: 'mc-meta' }, statusBadge(user.status), rankBadge(user.rank), deptBadge(user.department))),
        memberNo(user.memberNumber, true)),
      (!user || user.isSelf) ? h('div', { class: 'form-row' }, field('Anzeigename', dn), field('Benutzername', un))
        : note('Namen anderer Mitglieder werden aus Datenschutzgründen nicht angezeigt – die Identifikation läuft ausschließlich über die Personalnummer.', 'shield'),
      h('div', { class: 'form-row' }, field('Rang', rankSel), field('Abteilung', deptSel)),
      supSel && field('Vorgesetzter', supSel, { help: 'Direkter Vorgesetzter dieses Mitglieds.' }),
      !user && field('Passwort', pw),
      !user && h('div', { class: 'help' }, 'Der Benutzer wird sofort aktiv geschaltet und erhält automatisch die nächste Mitgliedsnummer.'),
      user && h('dl', { class: 'details-dl' },
        h('dt', null, 'Erstellt'), h('dd', null, fmtDateTime(user.createdAt)),
        h('dt', null, 'Letzte Anmeldung'), h('dd', null, user.lastLoginAt ? fmtDateTime(user.lastLoginAt) : 'nie'),
        user.statusReason && [h('dt', null, 'Begründung'), h('dd', null, user.statusReason)]));

    const panes = { general, roles: roleBody, perms: permBody, eff: effBody };
    const body = h('div');
    const show = (k) => mount(body, panes[k]);
    show('general');
    const tabBar = user ? tabs([{ id: 'general', label: 'Allgemein' }, { id: 'roles', label: 'Rollen' }, { id: 'perms', label: 'Direkte Rechte' }, { id: 'eff', label: 'Effektiv' }], 'general', show) : null;
    if (tabBar) tabBar.style.marginBottom = '16px';

    const footer = [];
    if (user && can('users.delete') && user.id !== state.user.id) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      const r = await confirmDialog({ title: 'Benutzer löschen?', message: `${user.displayName} wird endgültig gelöscht. Audit-Einträge bleiben erhalten.`, confirmLabel: 'Endgültig löschen' });
      if (!r) return;
      try { await api.del(`/api/users/${user.id}`); m.close(); toast('Benutzer gelöscht.'); load(); } catch (e) { toast(e.message, 'err'); }
    } }));
    if (user && can('users.edit')) footer.push(button('Passwort setzen', { icon: 'key', onClick: () => passwordDialog(user) }));
    footer.push(h('span', { class: 'grow' }));
    footer.push(button('Schließen', { onClick: () => m.close() }));
    if (!user || can('users.edit')) footer.push(button(user ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, save) }));

    async function save() {
      err.replaceChildren();
      try {
        if (!user) {
          await api.post('/api/users', { displayName: dn.value, username: un.value, password: pw.value, rankId: idOrNull(rankSel), departmentId: idOrNull(deptSel), roleIds: roleBoxes.filter(([, c]) => c.input.checked).map(([r]) => r.id) });
        } else {
          await api.patch(`/api/users/${user.id}`, {
            displayName: user.isSelf ? dn.value : undefined,
            rankId: idOrNull(rankSel), departmentId: idOrNull(deptSel), supervisorId: supSel ? idOrNull(supSel) : undefined,
            roleIds: roleBoxes.filter(([, c]) => c.input.checked).map(([r]) => r.id),
            permissions: permBoxes.filter(([, c]) => c.input.checked).map(([p]) => p.key),
          });
        }
        m.close(); toast(user ? 'Änderungen gespeichert.' : 'Benutzer angelegt.'); load();
      } catch (ex) { err.replaceChildren(formError(ex.message)); if (tabBar) show('general'); body.scrollTop = 0; }
    }
    const m = openModal({ title: user ? 'Benutzer bearbeiten' : 'Benutzer anlegen', wide: true, body: h('div', null, tabBar, body), footer });
    if (!user) {
      // Rollenauswahl direkt im Anlege-Dialog
      if (roles.length) panes.general.append(h('div', { class: 'sep' }), h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Rollen'), roleBoxes.map(([, c]) => c));
    }
  }

  function passwordDialog(user) {
    const pw = input({ type: 'password', autocomplete: 'new-password', placeholder: 'Neues Passwort (min. 8 Zeichen)' });
    const err = h('div');
    const m = openModal({
      title: `Passwort für ${user.displayName}`,
      body: h('div', null, err, field('Neues Passwort', pw, { help: 'Alle aktiven Sitzungen des Benutzers werden beendet.' })),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Setzen', { variant: 'primary', onClick: (e) => busy(e.currentTarget, async () => {
        try { await api.post(`/api/users/${user.id}/password`, { password: pw.value }); m.close(); toast('Passwort gesetzt.'); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }

  search.addEventListener('input', debounce(() => { f.q = search.value.trim(); load(); }));
  ctx.live(['users', 'org', 'roles'], () => load(true));
  await load();
}
