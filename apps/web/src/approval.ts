/**
 * Pending-Approval-Liste — Top-Level-View fuer `#/approvals`.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (PWA-Approval-Flow) + §5.3
 * (PRF-Layer im Approval-Flow).
 *
 * Komponiert mit approval-quick (Inline-Cards) + approval-detail (Vollbild).
 *
 * Flow:
 *   1. /v1/approvals?status=pending  →  Liste
 *   2. Pro Item ein Quick-Card (Approve/Reject/Details).
 *   3. Click [Details] → #/approvals/:id  → renderApprovalDetail (Sections + Decision).
 *
 * Polling: 5s-Refresh wenn der View aktiv ist; cancelled bei Navigation.
 */
import type { ApiClient, PendingApproval, Session } from './api.js';
import { ApiError } from './api.js';
import { logout, renderSessionExpired } from './auth.js';
import { renderHeader } from './components/header.js';
import { renderEmptyState } from './components/empty-state.js';
import { renderQuickCard } from './approval-quick.js';

const POLL_INTERVAL_MS = 5_000;

let pollTimer: number | undefined;
let active = false;

export function stopApprovalPolling(): void {
  active = false;
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
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

  const h1 = document.createElement('h1');
  h1.id = 'approvals-title';
  h1.textContent = 'Approval queue';
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

  await refreshAndSchedule(api, session);
}

async function refreshAndSchedule(api: ApiClient, session: Session): Promise<void> {
  if (!active) return;
  await refresh(api, session);
  if (!active) return;
  pollTimer = window.setTimeout(() => void refreshAndSchedule(api, session), POLL_INTERVAL_MS);
}

async function refresh(api: ApiClient, session: Session): Promise<void> {
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
    renderList(listEl, items, api, session);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      stopApprovalPolling();
      renderSessionExpired(document.getElementById('app') ?? document.body);
      return;
    }
    statusEl.textContent = `Error: ${(err as Error).message}`;
    statusEl.classList.add('err');
  }
}

function renderList(
  host: HTMLElement,
  items: ReadonlyArray<PendingApproval>,
  api: ApiClient,
  _session: Session,
): void {
  host.innerHTML = '';
  if (items.length === 0) {
    host.appendChild(
      renderEmptyState({
        title: 'Nothing to approve',
        body: 'Trigger a write-tool from your MCP client and the request will appear here.',
      }),
    );
    return;
  }

  for (const item of items) {
    host.appendChild(renderQuickCard(item, api));
  }
}
