/**
 * Approval-View — Inbox (#/approvals) + Archiv (#/approvals?view=archive).
 *
 * Inbox  = status='pending', polled every 5 s
 * Archiv = status IN (approved, rejected, expired) der letzten 24h
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4. v1-Pattern: history-Tab
 * mit 24h-Fenster aus mcp-approval/assets/app/approval-list.js.
 *
 * Sub-Nav teilt sich nur den Inbox-Polling-Timer; Archive-View ist
 * statisch (kein Polling — historische Daten ändern sich nicht).
 */
import type { ApiClient, PendingApproval, Session } from './api.js';
import { ApiError } from './api.js';
import { logout, renderSessionExpired } from './auth.js';
import { renderHeader } from './components/header.js';
import { renderEmptyState } from './components/empty-state.js';
import { renderQuickCard } from './approval-quick.js';

const POLL_INTERVAL_MS = 5_000;
const ARCHIVE_WINDOW_MS = 24 * 3600 * 1000;

let pollTimer: number | undefined;
let active = false;

type ApprovalView = 'inbox' | 'archive';

export function stopApprovalPolling(): void {
  active = false;
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

function parseView(): ApprovalView {
  const hash = window.location.hash;
  if (hash.includes('view=archive')) return 'archive';
  return 'inbox';
}

export async function renderApproval(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
): Promise<void> {
  active = true;
  root.innerHTML = '';
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'approvals';

  const view = parseView();

  // ── Sub-Nav (Inbox / Archiv) ────────────────────────────────────────
  const subNav = document.createElement('nav');
  subNav.className = 'settings-subnav';
  subNav.setAttribute('aria-label', 'Approval sections');
  const tabs: Array<{ id: ApprovalView; href: string; label: string }> = [
    { id: 'inbox', href: '#/approvals', label: 'Inbox' },
    { id: 'archive', href: '#/approvals?view=archive', label: 'Archiv (24h)' },
  ];
  for (const t of tabs) {
    const a = document.createElement('a');
    a.href = t.href;
    a.textContent = t.label;
    a.className = 'settings-subnav-item';
    if (t.id === view) a.setAttribute('aria-current', 'page');
    subNav.appendChild(a);
  }
  main.appendChild(subNav);

  const h1 = document.createElement('h1');
  h1.id = 'approvals-title';
  h1.textContent = view === 'archive' ? 'Archiv (letzte 24h)' : 'Approval queue';
  main.appendChild(h1);

  const status = document.createElement('p');
  status.className = 'muted';
  status.id = 'approvals-status';
  status.textContent = 'Loading…';
  main.appendChild(status);

  const list = document.createElement('div');
  list.className = 'list';
  list.id = 'approvals-list';
  main.appendChild(list);

  root.appendChild(main);

  if (view === 'archive') {
    // Archive-View ist statisch — kein Polling, ein Fetch reicht.
    stopApprovalPolling();
    await refreshArchive(api);
  } else {
    await refreshAndSchedule(api, session);
  }
}

async function refreshAndSchedule(api: ApiClient, session: Session): Promise<void> {
  if (!active) return;
  await refreshInbox(api, session);
  if (!active) return;
  pollTimer = window.setTimeout(() => void refreshAndSchedule(api, session), POLL_INTERVAL_MS);
}

async function refreshInbox(api: ApiClient, session: Session): Promise<void> {
  const titleEl = document.getElementById('approvals-title');
  const statusEl = document.getElementById('approvals-status');
  const listEl = document.getElementById('approvals-list');
  if (!titleEl || !statusEl || !listEl) return;

  try {
    const items = await api.listApprovals({ status: 'pending' });
    statusEl.classList.remove('err');
    titleEl.textContent = `Approval queue (${items.length})`;
    statusEl.textContent =
      items.length === 0 ? 'No pending approvals.' : `${items.length} pending`;
    renderInboxList(listEl, items);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      stopApprovalPolling();
      renderSessionExpired(document.getElementById('app') ?? document.body);
      return;
    }
    statusEl.textContent = `Error: ${(err as Error).message}`;
    statusEl.classList.add('err');
  }
  void session;
}

async function refreshArchive(api: ApiClient): Promise<void> {
  const titleEl = document.getElementById('approvals-title');
  const statusEl = document.getElementById('approvals-status');
  const listEl = document.getElementById('approvals-list');
  if (!titleEl || !statusEl || !listEl) return;
  const sinceMs = Date.now() - ARCHIVE_WINDOW_MS;
  try {
    const items = await api.listApprovals({
      statusIn: ['approved', 'rejected', 'expired'],
      sinceMs,
      limit: 200,
    });
    statusEl.classList.remove('err');
    titleEl.textContent = `Archiv (letzte 24h) — ${items.length}`;
    if (items.length === 0) {
      statusEl.textContent = 'Keine Aktivitaet in den letzten 24h.';
    } else {
      const counts = countByStatus(items);
      statusEl.textContent =
        `${counts.approved} ✓ · ${counts.rejected} ✗ · ${counts.expired} ⏱`;
    }
    renderArchiveList(listEl, items);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderSessionExpired(document.getElementById('app') ?? document.body);
      return;
    }
    statusEl.textContent = `Error: ${(err as Error).message}`;
    statusEl.classList.add('err');
  }
}

function countByStatus(items: ReadonlyArray<PendingApproval>): {
  approved: number;
  rejected: number;
  expired: number;
} {
  const c = { approved: 0, rejected: 0, expired: 0 };
  for (const i of items) {
    if (i.status === 'approved') c.approved++;
    else if (i.status === 'rejected') c.rejected++;
    else if (i.status === 'expired') c.expired++;
  }
  return c;
}

function renderInboxList(host: HTMLElement, items: ReadonlyArray<PendingApproval>): void {
  host.innerHTML = '';
  if (items.length === 0) {
    host.appendChild(
      renderEmptyState({
        title: 'Nichts zu approven',
        body: 'Trigger ein write-Tool im MCP-Client und der Request erscheint hier.',
      }),
    );
    return;
  }
  for (const item of items) {
    host.appendChild(renderQuickCard(item));
  }
}

function renderArchiveList(host: HTMLElement, items: ReadonlyArray<PendingApproval>): void {
  host.innerHTML = '';
  if (items.length === 0) {
    host.appendChild(
      renderEmptyState({
        title: 'Archiv leer',
        body: 'In den letzten 24h wurden keine Approvals entschieden oder sind abgelaufen.',
      }),
    );
    return;
  }
  // Sortierung kommt schon vom Server (decided-at desc). Wir gruppieren
  // optisch via einfacher Status-Badge — keine separate Sections, sonst
  // schaut die Chronologie kaputt aus.
  for (const item of items) {
    host.appendChild(renderArchiveCard(item));
  }
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '?';
  const d = new Date(ms);
  return d.toLocaleString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
}

function statusBadge(status: PendingApproval['status']): {
  label: string;
  bg: string;
  fg: string;
} {
  switch (status) {
    case 'approved':
      return { label: '✓ approved', bg: '#dcfce7', fg: '#166534' };
    case 'rejected':
      return { label: '✗ rejected', bg: '#fee2e2', fg: '#991b1b' };
    case 'expired':
      return { label: '⏱ expired', bg: '#f3f4f6', fg: '#4b5563' };
    case 'pending':
      return { label: 'pending', bg: '#fef3c7', fg: '#92400e' };
    default:
      return { label: String(status), bg: '#e5e7eb', fg: '#1f2937' };
  }
}

function renderArchiveCard(a: PendingApproval): HTMLElement {
  const link = document.createElement('a');
  link.href = `#/approvals/${encodeURIComponent(a.id)}`;
  link.className = `approval-card archive ${a.status}`;
  link.style.display = 'block';
  link.style.padding = '0.5rem 0.75rem';
  link.style.borderBottom = '1px solid var(--border, #e5e7eb)';
  link.style.color = 'inherit';
  link.style.textDecoration = 'none';

  const row1 = document.createElement('div');
  row1.style.display = 'flex';
  row1.style.justifyContent = 'space-between';
  row1.style.alignItems = 'center';
  row1.style.gap = '0.5rem';

  const left = document.createElement('span');
  left.style.fontWeight = '600';
  left.textContent = a.toolName;
  row1.appendChild(left);

  const b = statusBadge(a.status);
  const badge = document.createElement('span');
  badge.textContent = b.label;
  badge.style.background = b.bg;
  badge.style.color = b.fg;
  badge.style.padding = '2px 8px';
  badge.style.borderRadius = '10px';
  badge.style.fontSize = '0.75rem';
  badge.style.fontWeight = '600';
  row1.appendChild(badge);

  link.appendChild(row1);

  const row2 = document.createElement('div');
  row2.className = 'muted';
  row2.style.fontSize = '0.85rem';
  row2.style.marginTop = '2px';
  row2.style.fontFamily = 'var(--font-mono, monospace)';
  const decidedMs =
    a.status === 'approved'
      ? a.approvedAt
      : a.status === 'rejected'
        ? a.rejectedAt
        : a.status === 'expired'
          ? a.expiredAt ?? a.expiresAt
          : null;
  row2.textContent = `${fmtTime(decidedMs)} · ${a.displayRendered ?? ''}`;
  link.appendChild(row2);

  return link;
}
