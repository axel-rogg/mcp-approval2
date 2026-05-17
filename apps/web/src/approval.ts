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
import { renderQuickCard, shortDisplay } from './approval-quick.js';

const POLL_INTERVAL_MS = 5_000;
const ARCHIVE_WINDOW_MS = 24 * 3600 * 1000;
const POLL_PAUSE_KEY = 'approvals.pollingPaused';

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

function isPollingPaused(): boolean {
  try {
    return sessionStorage.getItem(POLL_PAUSE_KEY) === '1';
  } catch {
    return false;
  }
}

function setPollingPaused(paused: boolean): void {
  try {
    if (paused) sessionStorage.setItem(POLL_PAUSE_KEY, '1');
    else sessionStorage.removeItem(POLL_PAUSE_KEY);
  } catch {
    /* private mode etc. — ignore */
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

  // Title-Row mit optionalem Pause-Toggle (nur in Inbox-View).
  const titleRow = document.createElement('div');
  titleRow.className = 'approvals-title-row';
  titleRow.style.display = 'flex';
  titleRow.style.alignItems = 'center';
  titleRow.style.gap = '0.5rem';

  const h1 = document.createElement('h1');
  h1.id = 'approvals-title';
  h1.style.margin = '0';
  h1.textContent = view === 'archive' ? 'Archiv (letzte 24h)' : 'Approval queue';
  titleRow.appendChild(h1);

  if (view === 'inbox') {
    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.id = 'approvals-pause-btn';
    pauseBtn.className = 'btn-small';
    pauseBtn.style.marginLeft = 'auto';
    pauseBtn.textContent = isPollingPaused() ? '▶ Resume' : '⏸ Pause';
    pauseBtn.setAttribute(
      'title',
      'Auto-Refresh pausieren (laeuft lokaler Countdown weiter)',
    );
    pauseBtn.addEventListener('click', () => {
      const wasPaused = isPollingPaused();
      setPollingPaused(!wasPaused);
      pauseBtn.textContent = !wasPaused ? '▶ Resume' : '⏸ Pause';
      if (wasPaused) {
        // Resume → sofort refreshen + scheduler neu starten
        void refreshAndSchedule(api, session);
      } else {
        // Pause → laufenden Timer stoppen (active bleibt true!)
        if (pollTimer !== undefined) {
          window.clearTimeout(pollTimer);
          pollTimer = undefined;
        }
      }
    });
    titleRow.appendChild(pauseBtn);
  }

  main.appendChild(titleRow);

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
  if (isPollingPaused()) return; // User-Pause respektieren
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
  // Chronologisch nach Eingang absteigend (Server-ORDER BY created_at DESC).
  // Keine Gruppen-Header — jede Karte traegt ihr eigenes Status-Badge.
  for (const item of items) {
    host.appendChild(renderArchiveCard(item));
  }
}

function fmtDecidedAt(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusGlyph(status: PendingApproval['status']): {
  icon: string;
  cls: string;
} {
  switch (status) {
    case 'approved':
      return { icon: '✓', cls: 'st-approved' };
    case 'rejected':
      return { icon: '✗', cls: 'st-rejected' };
    case 'expired':
      return { icon: '⌛', cls: 'st-expired' };
    default:
      return { icon: '·', cls: 'st-other' };
  }
}

function decidedAtOf(a: PendingApproval): number | null | undefined {
  if (a.status === 'approved') return a.approvedAt;
  if (a.status === 'rejected') return a.rejectedAt;
  if (a.status === 'expired') return a.expiredAt ?? a.expiresAt;
  return null;
}

function renderArchiveCard(a: PendingApproval): HTMLElement {
  const g = statusGlyph(a.status);
  const link = document.createElement('a');
  link.href = `#/approvals/${encodeURIComponent(a.id)}`;
  link.className = `approval-card history ${g.cls}`;

  // row1: icon + tool-name + decided-at (rechts)
  const row1 = document.createElement('div');
  row1.className = 'card-row1';

  const icon = document.createElement('span');
  icon.className = 'st-icon';
  icon.textContent = g.icon;
  row1.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = a.toolName;
  row1.appendChild(name);

  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = fmtDecidedAt(decidedAtOf(a));
  row1.appendChild(when);

  link.appendChild(row1);

  // row2: mono ellipsis-truncated display
  const row2 = document.createElement('div');
  row2.className = 'card-row2 mono muted';
  row2.textContent = shortDisplay(a);
  link.appendChild(row2);

  return link;
}
