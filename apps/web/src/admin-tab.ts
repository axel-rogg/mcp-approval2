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
  table.className = 'admin-table';
  table.innerHTML = `<thead><tr>
    <th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th>
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
  tr.innerHTML = `
    <td><code>${escapeHtml(u.email)}</code></td>
    <td>${escapeHtml(u.display_name)}</td>
    <td><span class="pill pill-${u.role}">${u.role}</span></td>
    <td><span class="pill pill-${u.status}">${u.status}</span></td>
    <td class="small muted">${fmtDate(u.last_login_at)}</td>
  `;
  const actionsTd = document.createElement('td');
  actionsTd.className = 'row';

  const isSelf = u.id === session.userId;

  if (u.status === 'active') {
    const susBtn = document.createElement('button');
    susBtn.type = 'button';
    susBtn.className = 'btn btn-secondary btn-small';
    susBtn.textContent = 'Suspend';
    susBtn.disabled = isSelf;
    if (isSelf) susBtn.title = 'Self-suspend not allowed';
    susBtn.addEventListener('click', async () => {
      const reason = window.prompt('Suspend-Grund (optional):') ?? undefined;
      try {
        await api.suspendUser(u.id, reason || undefined);
        showToast(`${u.email} suspendiert`, 'success');
        await reload();
      } catch (err) {
        showToast(`Suspend fail: ${(err as Error).message}`, 'error');
      }
    });
    actionsTd.appendChild(susBtn);
  } else if (u.status === 'suspended') {
    const unsBtn = document.createElement('button');
    unsBtn.type = 'button';
    unsBtn.className = 'btn btn-small';
    unsBtn.textContent = 'Unsuspend';
    unsBtn.addEventListener('click', async () => {
      try {
        await api.unsuspendUser(u.id);
        showToast(`${u.email} aktiviert`, 'success');
        await reload();
      } catch (err) {
        showToast(`Unsuspend fail: ${(err as Error).message}`, 'error');
      }
    });
    actionsTd.appendChild(unsBtn);
  }

  const roleSel = document.createElement('select');
  roleSel.className = 'btn-small';
  for (const r of ['member', 'admin'] as const) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === u.role) opt.selected = true;
    roleSel.appendChild(opt);
  }
  roleSel.addEventListener('change', async () => {
    const newRole = roleSel.value as 'admin' | 'member';
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
  actionsTd.appendChild(roleSel);

  if (u.status !== 'deleted') {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger btn-small';
    delBtn.textContent = 'Delete';
    delBtn.disabled = isSelf;
    if (isSelf) delBtn.title = 'Self-delete not allowed';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`User ${u.email} unwiderruflich auf 'deleted' setzen?\n(Crypto-Shred erfolgt via GDPR-Erase-Cron separat.)`)) {
        return;
      }
      try {
        await api.deleteUser(u.id);
        showToast(`${u.email} gelöscht`, 'success');
        await reload();
      } catch (err) {
        showToast(`Delete fail: ${(err as Error).message}`, 'error');
      }
    });
    actionsTd.appendChild(delBtn);
  }

  tr.appendChild(actionsTd);
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

  const note = document.createElement('p');
  note.className = 'muted small';
  note.innerHTML = `Status <code>logged</code> = console-Mode, Email muss <strong>manuell zugestellt</strong> werden (Body-Preview/Copy via Detail-View). Status <code>sent</code> = Resend hat zugestellt. Status <code>failed</code> = Versand fail (Body bleibt als Fallback verfügbar).`;
  card.appendChild(note);

  if (rows.length === 0) {
    card.innerHTML += '<p class="muted small">Keine Einträge.</p>';
    root.appendChild(card);
    return;
  }

  const table = document.createElement('table');
  table.className = 'admin-table';
  table.innerHTML = `<thead><tr>
    <th>Wann</th><th>Kind</th><th>To</th><th>Subject</th><th>Status</th><th>Aktion</th>
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
  const dispatchedSuffix = r.manuallyDispatchedAt
    ? ` <span class="muted small">📤 ${fmtDate(r.manuallyDispatchedAt)}</span>`
    : '';
  tr.innerHTML = `
    <td class="small muted">${fmtDate(r.createdAt)}</td>
    <td><span class="pill pill-${r.kind}">${r.kind}</span></td>
    <td><code>${escapeHtml(r.toEmail)}</code></td>
    <td>${escapeHtml(r.subject)}</td>
    <td><span class="pill pill-${r.status}">${r.status}</span>${dispatchedSuffix}</td>
  `;
  const actionsTd = document.createElement('td');
  actionsTd.className = 'row';

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
