/**
 * Approval-View.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (Approval-Flow E2E).
 *
 * Skeleton: pollt alle 5s `/v1/approvals/pending` und rendert die Liste.
 * Bei `Sign`-Click wird `signApproval(id)` aus auth.ts aufgerufen.
 *
 * Production-Roadmap (siehe docs/STATUS.md):
 *   - SSE statt Polling (Backend `/mcp/sse` ist die natuerliche Stelle, aber
 *     der Wire-Shape sollte fuer die PWA simplere `text/event-stream` sein).
 *   - WebAuthn-Sign-Off mit echtem `AuthenticatorAssertionResponse` serialisieren.
 *   - Push-Notifications via `navigator.serviceWorker` + Web-Push (Browser-Tab
 *     muss nicht offen sein).
 *   - WYSIWYS-Display-Template fuer jedes Tool (im Tool-Manifest hinterlegt).
 */

import { signApproval } from './auth.js';

interface PendingApproval {
  readonly id: string;
  readonly toolName: string;
  readonly sensitivity: 'write' | 'danger';
  readonly displayTemplate?: string;
  readonly input: Record<string, unknown>;
  readonly requestedAt: number;
}

interface ApprovalListResponse {
  readonly items: ReadonlyArray<PendingApproval>;
}

const POLL_INTERVAL_MS = 5_000;

let pollTimer: number | undefined;

export async function renderApproval(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <main>
      <div class="row" style="justify-content: space-between; align-items: baseline;">
        <h1>Approval queue</h1>
        <button class="btn btn-secondary" id="logoutBtn">Sign out</button>
      </div>
      <p class="muted" id="connStatus">Loading…</p>
      <div id="approvalList"></div>
    </main>
  `;
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      void fetch('/auth/logout', { method: 'POST', credentials: 'include' }).then(() => {
        window.location.assign('/');
      });
    });
  }
  await refresh();
  if (pollTimer === undefined) {
    pollTimer = window.setInterval(refresh, POLL_INTERVAL_MS);
  }
}

async function refresh(): Promise<void> {
  const listEl = document.getElementById('approvalList');
  const statusEl = document.getElementById('connStatus');
  if (!listEl || !statusEl) return;
  try {
    const res = await fetch('/v1/approvals/pending', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (res.status === 401) {
      statusEl.textContent = 'Session expired — please sign in again.';
      statusEl.classList.add('err');
      setTimeout(() => window.location.assign('/#login'), 1_500);
      return;
    }
    if (!res.ok) {
      statusEl.textContent = `Approvals endpoint returned HTTP ${res.status}.`;
      statusEl.classList.add('err');
      return;
    }
    statusEl.classList.remove('err');
    const body = (await res.json()) as ApprovalListResponse;
    renderList(listEl, body.items);
    statusEl.textContent = `${body.items.length} pending`;
  } catch (err) {
    statusEl.textContent = `Network error: ${String(err instanceof Error ? err.message : err)}`;
    statusEl.classList.add('err');
  }
}

function renderList(host: HTMLElement, items: ReadonlyArray<PendingApproval>): void {
  if (items.length === 0) {
    host.innerHTML = `
      <div class="card">
        <p class="muted">No pending approvals. Trigger a write-tool from your
        MCP client and the request will appear here.</p>
      </div>
    `;
    return;
  }
  host.innerHTML = items
    .map((it) => {
      const display = it.displayTemplate
        ? escapeHtml(applyTemplate(it.displayTemplate, it.input))
        : `${escapeHtml(it.toolName)} with input <code>${escapeHtml(JSON.stringify(it.input))}</code>`;
      return `
      <div class="card" data-id="${escapeHtml(it.id)}">
        <div class="row" style="justify-content: space-between;">
          <strong>${escapeHtml(it.toolName)}</strong>
          <span class="muted">${escapeHtml(it.sensitivity)}</span>
        </div>
        <p>${display}</p>
        <div class="row">
          <button class="btn" data-action="approve">Approve &amp; sign</button>
          <button class="btn btn-secondary" data-action="reject">Reject</button>
        </div>
      </div>
    `;
    })
    .join('');

  host.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const card = (btn.closest('.card') as HTMLElement | null);
      const id = card?.dataset['id'];
      if (!id) return;
      btn.disabled = true;
      try {
        if (btn.dataset['action'] === 'approve') {
          await signApproval(id);
        } else {
          await fetch(`/v1/approvals/${encodeURIComponent(id)}/reject`, {
            method: 'POST',
            credentials: 'include',
          });
        }
        await refresh();
      } catch (err) {
        // eslint-disable-next-line no-alert
        alert(`Failed: ${String(err instanceof Error ? err.message : err)}`);
        btn.disabled = false;
      }
    });
  });
}

function applyTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const segments = path.split('.');
    let cur: unknown = input;
    for (const seg of segments) {
      if (cur !== null && typeof cur === 'object' && seg in (cur as object)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        return '';
      }
    }
    return typeof cur === 'string' ? cur : JSON.stringify(cur);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
