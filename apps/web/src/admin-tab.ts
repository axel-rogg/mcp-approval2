/**
 * Admin-Tab (Multi-User Tier 1, 2026-05-17).
 *
 * Route: #/admin
 * Auth: requires session.role === 'admin' (Server enforct adminOnly).
 *
 * 4 Sub-Tabs:
 *   Users    — Liste + Suspend/Unsuspend + Role-Change + Delete
 *   Invites  — Form (Email) + Liste der letzten Invites mit acceptUrl-Copy
 *   Outbox   — Liste der Email-Outbox (insb. fuer console-Mode-Fallback)
 *   Audit    — Letzte 100 Audit-Events (admin-only view)
 *
 * Bewusst minimal — keine Pagination, kein deep-link-state, kein optimistic-UI.
 * 2-3 Pilot-Tester rechtfertigen kein Framework.
 */
import type { Session } from './api.js';
import { renderHeader } from './components/header.js';
import { showToast } from './components/toast.js';
import {
  createAdminApi,
  type AdminApi,
  type AdminUser,
  type OutboxEntry,
} from './api-admin.js';
import { logout } from './auth.js';
import type { ApiClient } from './api.js';

type SubTab = 'users' | 'invites' | 'outbox' | 'audit';

function fmtDate(raw: number | string | null | undefined): string {
  if (raw === null || raw === undefined || raw === '' || raw === 0) return '—';
  // Postgres BIGINT kommt via postgres-js als string zurueck (precision-
  // safety) — wir akzeptieren beides + parsen defensiv.
  const ms = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return '—';
  }
}

export async function renderAdminTab(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
): Promise<void> {
  if (session.role !== 'admin') {
    root.innerHTML = '';
    renderHeader(root, session, () => void logout(api));
    const main = document.createElement('main');
    main.className = 'admin';
    main.innerHTML = `<div class="card err"><strong>Forbidden.</strong> Admin-Rolle erforderlich. Dein Account ist <code>${session.role}</code>.</div>`;
    root.appendChild(main);
    return;
  }

  root.innerHTML = '';
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'admin';

  const h1 = document.createElement('h1');
  h1.textContent = 'Admin';
  main.appendChild(h1);

  // Diagnostic-Toolbar (Test-Approval) — sichtbar von jeder Admin-Subpage.
  // Erzeugt ein synthetisches Approval mit sectioned displayTemplate damit der
  // Operator den Visual-Look der Detail-View live verifizieren kann (Badge,
  // sec-cards, TTL, btn-row). Sicher: es wird kein Tool dispatched.
  main.appendChild(buildDiagnosticToolbar());

  // Sub-Tab-Navigation — Tools-Tab-Pattern (anchor-basiert + settings-subnav
  // CSS-Classes, statt selbst-gebauter button-pills).
  const subtabs: ReadonlyArray<{ id: SubTab; label: string }> = [
    { id: 'users', label: 'Users' },
    { id: 'invites', label: 'Invites' },
    { id: 'outbox', label: 'Outbox' },
    { id: 'audit', label: 'Audit' },
  ];
  const subnav = document.createElement('nav');
  subnav.className = 'settings-subnav admin-subnav';
  subnav.setAttribute('aria-label', 'Admin sections');
  const contentEl = document.createElement('div');
  contentEl.className = 'admin-content';

  function setActive(active: SubTab): void {
    for (const child of Array.from(subnav.children)) {
      const a = child as HTMLAnchorElement;
      if (a.dataset['subtab'] === active) {
        a.setAttribute('aria-current', 'page');
      } else {
        a.removeAttribute('aria-current');
      }
    }
  }

  async function loadAndRender(tab: SubTab): Promise<void> {
    setActive(tab);
    contentEl.innerHTML = '<p class="muted small">Lade …</p>';
    const adminApi = createAdminApi();
    try {
      if (tab === 'users') await renderUsersSubtab(contentEl, adminApi, session);
      else if (tab === 'invites') await renderInvitesSubtab(contentEl, adminApi);
      else if (tab === 'outbox') await renderOutboxSubtab(contentEl, adminApi);
      else if (tab === 'audit') await renderAuditSubtab(contentEl, adminApi);
    } catch (err) {
      contentEl.innerHTML = `<div class="card err"><strong>Fehler:</strong> ${escapeHtml((err as Error).message)}</div>`;
    }
  }

  for (const st of subtabs) {
    const a = document.createElement('a');
    a.href = `#/admin?tab=${st.id}`;
    a.textContent = st.label;
    a.className = 'settings-subnav-item';
    a.dataset['subtab'] = st.id;
    a.addEventListener('click', (e) => {
      // Verhindere harten hashchange-Reload — wir rendern in-place.
      // Browser-URL wird trotzdem upgedatet via history.replaceState damit
      // refresh / shareable-link den passenden Tab behaelt.
      e.preventDefault();
      history.replaceState(null, '', `#/admin?tab=${st.id}`);
      void loadAndRender(st.id);
    });
    subnav.appendChild(a);
  }

  main.appendChild(subnav);
  main.appendChild(contentEl);
  root.appendChild(main);

  // Initial-Load: hash-fragment query like #/admin?tab=invites respektieren.
  const url = new URL(window.location.href);
  const initial =
    (url.hash.split('?')[1] && new URLSearchParams(url.hash.split('?')[1]).get('tab')) ?? 'users';
  void loadAndRender((initial as SubTab) || 'users');
}

// ─── Users Subtab ────────────────────────────────────────────────────────────

async function renderUsersSubtab(
  root: HTMLElement,
  api: AdminApi,
  session: Session,
): Promise<void> {
  const users = await api.listUsers();
  root.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  const h2 = document.createElement('h2');
  h2.textContent = `Users (${users.length})`;
  card.appendChild(h2);

  const table = document.createElement('table');
  table.className = 'admin-table admin-users-table';
  table.innerHTML = `<thead><tr>
    <th>Email</th><th>Role</th><th>Status</th><th>Last login</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const u of users) {
    tbody.appendChild(renderUserRow(api, u, session, async () => {
      await renderUsersSubtab(root, api, session);
    }));
  }
  table.appendChild(tbody);
  card.appendChild(table);
  root.appendChild(card);
}

function renderUserRow(
  api: AdminApi,
  u: AdminUser,
  session: Session,
  reload: () => Promise<void>,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.dataset['userId'] = u.id;
  // Display-Name (aus Google-OAuth-Profil) als title-tooltip auf der Email-
  // Zelle — Spalte selbst entfernt weil nicht UI-pflegbar + mobil zu breit.
  const titleAttr = u.display_name ? ` title="${escapeHtml(u.display_name)}"` : '';
  tr.innerHTML = `
    <td${titleAttr}><code>${escapeHtml(u.email)}</code></td>
  `;
  const isSelf = u.id === session.userId;

  // ── Role-Zelle: <select> als inline-action. Wechsel triggert changeRole. ──
  const roleTd = document.createElement('td');
  const roleSel = document.createElement('select');
  roleSel.className = `admin-inline-select pill-${u.role}`;
  roleSel.disabled = u.status === 'deleted';
  if (roleSel.disabled) roleSel.title = 'User is deleted';
  for (const r of ['member', 'admin'] as const) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === u.role) opt.selected = true;
    roleSel.appendChild(opt);
  }
  roleSel.addEventListener('change', async () => {
    const newRole = roleSel.value as 'admin' | 'member';
    if (newRole === u.role) return;
    if (!confirm(`Rolle von ${u.email} → ${newRole}?`)) {
      roleSel.value = u.role;
      return;
    }
    try {
      await api.changeRole(u.id, newRole);
      showToast(`${u.email} → ${newRole}`, 'success');
      await reload();
    } catch (err) {
      roleSel.value = u.role;
      showToast(`Role-Change fail: ${(err as Error).message}`, 'error');
    }
  });
  roleTd.appendChild(roleSel);
  tr.appendChild(roleTd);

  // ── Status-Zelle: <select> mit allen Transitions als Aktionen. ──
  // active → [active, suspended, deleted]
  // suspended → [active, suspended, deleted]
  // deleted → [deleted] (no further change)
  // Self-protect: own user kann nicht suspended/deleted gewaehlt werden.
  const statusTd = document.createElement('td');
  const statusSel = document.createElement('select');
  statusSel.className = `admin-inline-select pill-${u.status}`;
  if (u.status === 'deleted') {
    statusSel.disabled = true;
    const opt = document.createElement('option');
    opt.value = 'deleted';
    opt.textContent = 'deleted';
    opt.selected = true;
    statusSel.appendChild(opt);
  } else {
    const options: Array<{ value: string; label: string; disabled?: boolean; title?: string }> = [
      { value: 'active', label: 'active' },
      {
        value: 'suspended',
        label: 'suspended',
        disabled: isSelf,
        ...(isSelf ? { title: 'Self-suspend not allowed' } : {}),
      },
      {
        value: 'deleted',
        label: 'deleted',
        disabled: isSelf,
        ...(isSelf ? { title: 'Self-delete not allowed' } : {}),
      },
    ];
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === u.status) opt.selected = true;
      if (o.disabled) opt.disabled = true;
      if (o.title) opt.title = o.title;
      statusSel.appendChild(opt);
    }
  }
  statusSel.addEventListener('change', async () => {
    const target = statusSel.value as 'active' | 'suspended' | 'deleted';
    if (target === u.status) return;
    try {
      if (target === 'suspended') {
        const reason = window.prompt(`${u.email} suspendieren — Grund (optional):`) ?? undefined;
        if (reason === undefined) {
          statusSel.value = u.status;
          return;
        }
        await api.suspendUser(u.id, reason || undefined);
        showToast(`${u.email} suspendiert`, 'success');
      } else if (target === 'active') {
        if (!confirm(`${u.email} reaktivieren?`)) {
          statusSel.value = u.status;
          return;
        }
        await api.unsuspendUser(u.id);
        showToast(`${u.email} aktiviert`, 'success');
      } else if (target === 'deleted') {
        if (
          !confirm(
            `User ${u.email} auf 'deleted' setzen?\n(Sessions revoked, Soft-Delete; Crypto-Shred via GDPR-Erase-Cron separat.)`,
          )
        ) {
          statusSel.value = u.status;
          return;
        }
        await api.deleteUser(u.id);
        showToast(`${u.email} gelöscht`, 'success');
      }
      await reload();
    } catch (err) {
      statusSel.value = u.status;
      showToast(`Status-Change fail: ${(err as Error).message}`, 'error');
    }
  });
  statusTd.appendChild(statusSel);
  tr.appendChild(statusTd);

  // ── Last-Login ──
  const dateTd = document.createElement('td');
  dateTd.className = 'small muted';
  dateTd.textContent = fmtDate(u.last_login_at);
  tr.appendChild(dateTd);

  return tr;
}

// ─── Invites Subtab ──────────────────────────────────────────────────────────

async function renderInvitesSubtab(root: HTMLElement, api: AdminApi): Promise<void> {
  root.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<h2>Neuen User einladen</h2>';

  const form = document.createElement('form');
  form.className = 'row';
  form.innerHTML = `
    <input type="email" name="email" placeholder="bob@example.com" required style="flex:1" />
    <button type="submit" class="btn">Invite</button>
  `;

  const result = document.createElement('div');
  result.className = 'admin-invite-result';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const email = String(fd.get('email') ?? '').trim();
    if (!email) return;
    result.innerHTML = '<p class="muted small">Lade …</p>';
    try {
      const r = await api.createInvite(email);
      const dispatchedHint = r.email.status === 'sent'
        ? `<span class="ok small">✓ Email gesendet (${r.email.provider})</span>`
        : r.email.status === 'failed'
          ? `<span class="err small">✗ Email-Versand fail: ${escapeHtml(r.email.errorDetail ?? '')}</span>`
          : `<span class="muted small">📋 Console-Mode — kein Versand. Link unten kopieren + zustellen.</span>`;
      result.innerHTML = `
        <div class="card ok">
          <p><strong>Invite gesendet an ${escapeHtml(email)}</strong> — ${dispatchedHint}</p>
          <p>Accept-URL (gültig bis ${fmtDate(r.expiresAt)}):</p>
          <p><code style="word-break:break-all">${escapeHtml(r.acceptUrl)}</code></p>
          <button type="button" class="btn btn-small" data-copy="${escapeHtml(r.acceptUrl)}">In Zwischenablage</button>
        </div>`;
      const copyBtn = result.querySelector('button[data-copy]') as HTMLButtonElement | null;
      copyBtn?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(r.acceptUrl);
          showToast('Link kopiert', 'success');
        } catch {
          showToast('Copy nicht möglich (Clipboard-API)', 'error');
        }
      });
      (form.querySelector('input[name=email]') as HTMLInputElement).value = '';
    } catch (err) {
      result.innerHTML = `<div class="card err"><strong>Invite fail:</strong> ${escapeHtml((err as Error).message)}</div>`;
    }
  });

  card.appendChild(form);
  card.appendChild(result);
  root.appendChild(card);

  // Hinweis auf Outbox
  const hint = document.createElement('p');
  hint.className = 'muted small';
  hint.innerHTML = '→ Sieh alle bisherigen Invite-Emails im <a href="#/admin?tab=outbox">Outbox-Tab</a>.';
  root.appendChild(hint);
}

// ─── Outbox Subtab ───────────────────────────────────────────────────────────

async function renderOutboxSubtab(root: HTMLElement, api: AdminApi): Promise<void> {
  const rows = await api.listOutbox({ limit: 100 });
  root.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  const h2 = document.createElement('h2');
  h2.textContent = `Email-Outbox (${rows.length})`;
  card.appendChild(h2);

  if (rows.length === 0) {
    card.innerHTML += '<p class="muted small">Keine Einträge.</p>';
    root.appendChild(card);
    return;
  }

  const table = document.createElement('table');
  table.className = 'admin-table';
  table.innerHTML = `<thead><tr>
    <th>Wann</th><th>To</th><th>Aktion</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    tbody.appendChild(renderOutboxRow(api, r, async () => {
      await renderOutboxSubtab(root, api);
    }));
  }
  table.appendChild(tbody);
  card.appendChild(table);
  root.appendChild(card);
}

function renderOutboxRow(
  api: AdminApi,
  r: OutboxEntry,
  reload: () => Promise<void>,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  // status != 'sent' bleibt sichtbar als kleiner Pill direkt am Empfaenger — fail/logged braucht der Admin auf einen Blick. 'sent' ist Default und braucht keine Markierung. manually_dispatched_at wird durch Abwesenheit des "Mark dispatched"-Buttons impliziert.
  const statusPill = r.status === 'sent'
    ? ''
    : ` <span class="pill pill-${r.status}">${r.status}</span>`;
  tr.innerHTML = `
    <td class="small muted">${fmtDate(r.createdAt)}</td>
    <td><code>${escapeHtml(r.toEmail)}</code>${statusPill}</td>
  `;
  const actionsTd = document.createElement('td');
  actionsTd.className = 'row';

  const resendBtn = document.createElement('button');
  resendBtn.type = 'button';
  resendBtn.className = 'btn btn-small';
  resendBtn.textContent = '↻ Resend';
  resendBtn.title = 'Email nochmal via aktuellem Provider versenden';
  resendBtn.addEventListener('click', async () => {
    if (!confirm(`Email "${r.subject}" an ${r.toEmail} nochmal senden?`)) return;
    resendBtn.disabled = true;
    try {
      const result = await api.resendOutbox(r.id);
      const tone = result.status === 'sent' ? 'success' : result.status === 'failed' ? 'error' : 'info';
      const detail = result.errorDetail ? ` — ${result.errorDetail}` : '';
      showToast(`Resend: ${result.status} (${result.provider})${detail}`, tone);
      await reload();
    } catch (err) {
      showToast(`Resend fail: ${(err as Error).message}`, 'error');
      resendBtn.disabled = false;
    }
  });
  actionsTd.appendChild(resendBtn);

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn btn-secondary btn-small';
  viewBtn.textContent = 'Body';
  viewBtn.addEventListener('click', () => {
    const w = window.open('', '_blank', 'width=700,height=600,scrollbars=yes');
    if (!w) {
      showToast('Popup blockiert — Browser zulassen', 'error');
      return;
    }
    w.document.write(r.bodyHtml);
    w.document.close();
  });
  actionsTd.appendChild(viewBtn);

  // Try to extract the actual link from text-body — invite/recovery patterns.
  const linkMatch = r.bodyText.match(/https?:\/\/\S+/);
  if (linkMatch) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-small';
    copyBtn.textContent = 'Copy link';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(linkMatch[0]);
        showToast('Link kopiert', 'success');
      } catch {
        showToast('Copy nicht möglich', 'error');
      }
    });
    actionsTd.appendChild(copyBtn);
  }

  if (!r.manuallyDispatchedAt) {
    const dispBtn = document.createElement('button');
    dispBtn.type = 'button';
    dispBtn.className = 'btn btn-secondary btn-small';
    dispBtn.textContent = '✓ Mark dispatched';
    dispBtn.addEventListener('click', async () => {
      try {
        await api.markDispatched(r.id);
        showToast('Markiert', 'success');
        await reload();
      } catch (err) {
        showToast(`Fail: ${(err as Error).message}`, 'error');
      }
    });
    actionsTd.appendChild(dispBtn);
  }

  tr.appendChild(actionsTd);
  return tr;
}

// ─── Audit Subtab ────────────────────────────────────────────────────────────

async function renderAuditSubtab(root: HTMLElement, api: AdminApi): Promise<void> {
  const entries = await api.listAudit({ limit: 100 });
  root.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  const h2 = document.createElement('h2');
  h2.textContent = `Audit-Log (letzte ${entries.length})`;
  card.appendChild(h2);

  if (entries.length === 0) {
    card.innerHTML += '<p class="muted small">Keine Einträge.</p>';
    root.appendChild(card);
    return;
  }

  const table = document.createElement('table');
  table.className = 'admin-table audit-table';
  table.innerHTML = `<thead><tr>
    <th>Wann</th><th>Actor</th><th>Action</th><th>Result</th><th>Resource</th><th>IP</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const e of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="small muted">${fmtDate(e.ts)}</td>
      <td class="small"><code>${escapeHtml(e.actor_user_id ?? '(system)')}</code></td>
      <td><code>${escapeHtml(e.action)}</code></td>
      <td><span class="pill pill-${e.result}">${e.result}</span></td>
      <td class="small">${escapeHtml((e.resource_kind ?? '') + (e.resource_id ? ':' + e.resource_id.slice(0, 8) : ''))}</td>
      <td class="small muted">${escapeHtml(e.ip ?? '')}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  card.appendChild(table);
  root.appendChild(card);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Diagnostic Toolbar ──────────────────────────────────────────────────────

function buildDiagnosticToolbar(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card admin-diagnostic';

  const title = document.createElement('strong');
  title.textContent = 'Diagnostic ';
  card.appendChild(title);

  const hint = document.createElement('span');
  hint.className = 'muted small';
  hint.textContent = ' — erzeugt ein synthetisches Approval (kein echter Tool-Call) damit du Display, Push-Notification und Approve/Reject-Flow live testen kannst.';
  card.appendChild(hint);

  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '0.6rem';

  const writeBtn = document.createElement('button');
  writeBtn.type = 'button';
  writeBtn.className = 'btn btn-small';
  writeBtn.textContent = '🔒 Test-Approval (WRITE)';
  row.appendChild(writeBtn);

  const dangerBtn = document.createElement('button');
  dangerBtn.type = 'button';
  dangerBtn.className = 'btn btn-small btn-reject';
  dangerBtn.textContent = '⚠ Test-Approval (DANGER)';
  row.appendChild(dangerBtn);

  const status = document.createElement('span');
  status.className = 'muted small';
  row.appendChild(status);

  card.appendChild(row);

  async function trigger(sensitivity: 'write' | 'danger'): Promise<void> {
    writeBtn.disabled = true;
    dangerBtn.disabled = true;
    status.textContent = `Erzeuge ${sensitivity}-Approval …`;
    try {
      const adminApi = createAdminApi();
      const result = await adminApi.createTestApproval({ sensitivity });
      showToast(`Test-Approval erzeugt (${sensitivity})`, 'success');
      // Navigate direkt zur Detail-View — User sieht den Visual-Look sofort.
      window.location.hash = `#/approvals/${encodeURIComponent(result.id)}`;
    } catch (err) {
      status.textContent = `Fehler: ${(err as Error).message}`;
      showToast(`Test-Approval Fehler: ${(err as Error).message}`, 'error');
    } finally {
      writeBtn.disabled = false;
      dangerBtn.disabled = false;
    }
  }

  writeBtn.addEventListener('click', () => void trigger('write'));
  dangerBtn.addEventListener('click', () => void trigger('danger'));

  return card;
}
