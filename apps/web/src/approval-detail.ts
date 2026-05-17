/**
 * Approval-Detail-View — Vollbild eines einzelnen Pending-Approvals.
 *
 * v1-Look (portiert von mcp-approval/assets/app/approval-detail.js):
 *
 *   ← Zurück zur Liste           (back-link chip)
 *   [BADGE] tool.name             (approval-tool-header h2 mit Sensitivity-Badge)
 *   Tool-Beschreibung optional    (muted)
 *
 *   [STATUS-BANNER]               (nur fuer entschiedene Approvals)
 *
 *   ┌─── SECTION 1 ──────────┐    (Sectioned display via approval-sections.ts)
 *   │ ... section body ...    │
 *   ├─── SECTION 2 ──────────┤
 *   ...
 *
 *   Restzeit: 4m 32s              (live countdown, sek-tick)
 *   ⚠ DANGER … / 🔒 Reversible … (Sensitivity-Hint)
 *
 *   [Approve mit Passkey] [Reject]   (btn-row)
 *
 * Wenn Status != pending: Status-Banner + Sections (read-only Verlauf),
 * keine Buttons + kein Countdown.
 */
import type { ApiClient, PendingApproval, Session } from './api.js';
import { ApiError } from './api.js';
import { logout, renderSessionExpired } from './auth.js';
import { renderHeader } from './components/header.js';
import { renderSections } from './approval-sections.js';
import { renderDecisionFlow } from './approval-decision.js';
import { showToast } from './components/toast.js';

export async function renderApprovalDetail(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
  approvalId: string,
): Promise<void> {
  root.innerHTML = '';
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'approval-detail';

  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = 'Loading approval…';
  main.appendChild(status);
  root.appendChild(main);

  let approval: PendingApproval;
  try {
    approval = await api.getApproval(approvalId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderSessionExpired(root);
      return;
    }
    status.className = 'err';
    if (err instanceof ApiError && err.status === 404) {
      status.textContent = 'Approval not found (already decided or expired).';
    } else {
      status.textContent = `Failed to load: ${(err as Error).message}`;
    }
    return;
  }

  renderLoaded(main, api, approval);
}

function renderLoaded(
  main: HTMLElement,
  api: ApiClient,
  approval: PendingApproval,
): void {
  main.innerHTML = '';

  // ── Back-link chip ────────────────────────────────────────────────────────
  const back = document.createElement('a');
  back.className = 'back-link';
  back.href = '#/approvals';
  back.textContent = '← Zurück zur Liste';
  main.appendChild(back);

  // ── Header: BADGE + tool-name als kombinierte h2 (v1 .approval-tool-header)
  const header = document.createElement('h2');
  header.className = 'approval-tool-header';
  header.appendChild(sensBadge(approval.sensitivity));

  const toolNameEl = document.createElement('span');
  toolNameEl.className = 'tool-name';
  toolNameEl.textContent = approval.toolName;
  header.appendChild(toolNameEl);
  main.appendChild(header);

  // ── Read-only Verlauf-Banner (entschiedene Approvals) ─────────────────────
  if (approval.status !== 'pending') {
    const banner = document.createElement('div');
    banner.className = `status-banner status-${approval.status}`;
    banner.textContent = `Status: ${approval.status.toUpperCase()} — read-only Verlauf`;
    main.appendChild(banner);
    main.appendChild(renderSections(approval));
    return;
  }

  // ── Sections (display_string oder Fallback) ──────────────────────────────
  main.appendChild(renderSections(approval));

  // ── Live TTL Countdown ───────────────────────────────────────────────────
  const ttl = document.createElement('p');
  ttl.className = 'approval-ttl';
  main.appendChild(ttl);

  // ── Sensitivity Hint ─────────────────────────────────────────────────────
  if (approval.sensitivity === 'danger') {
    const hint = document.createElement('p');
    hint.className = 'badge badge-danger approval-hint';
    hint.textContent = '⚠ DANGER — diese Aktion ist nicht reversibel. Frischer Passkey erforderlich.';
    main.appendChild(hint);
  } else if (approval.sensitivity === 'write') {
    const hint = document.createElement('p');
    hint.className = 'approval-hint muted';
    hint.textContent = '🔒 Reversibles Tool — Passkey-Signatur bestaetigt die Aktion.';
    main.appendChild(hint);
  }

  // ── Decision-Buttons (btn-row v1-Style) ──────────────────────────────────
  const buttonRow = document.createElement('div');
  buttonRow.className = 'btn-row';

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'btn btn-approve';
  approveBtn.textContent = approval.sensitivity === 'danger'
    ? 'Approve mit Passkey (DANGER)'
    : 'Approve mit Passkey';
  buttonRow.appendChild(approveBtn);

  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'btn btn-reject';
  rejectBtn.textContent = 'Reject';
  buttonRow.appendChild(rejectBtn);

  main.appendChild(buttonRow);

  // Inline-Status (Approving / Rejecting / Error)
  const statusLine = document.createElement('p');
  statusLine.className = 'muted approval-inline-status';
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');
  main.appendChild(statusLine);

  // ── Live countdown tick ──────────────────────────────────────────────────
  let stopped = false;
  const expiresAt = ((approval as PendingApproval & {
    expiresAt?: number; createdAt?: number;
  }).expiresAt) ?? (approval.requestedAt + 5 * 60 * 1000);
  const tick = () => {
    const ms = expiresAt - Date.now();
    ttl.textContent = `Restzeit: ${formatRemaining(ms)}`;
    if (ms <= 0 && !stopped) {
      stopped = true;
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      statusLine.textContent = 'Approval abgelaufen.';
    }
  };
  tick();
  const interval = window.setInterval(() => {
    if (stopped) {
      window.clearInterval(interval);
      return;
    }
    tick();
  }, 1000);

  approveBtn.addEventListener('click', async () => {
    if (stopped) return;
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    statusLine.textContent = 'Warte auf Passkey-Bestaetigung …';
    try {
      await renderDecisionFlow(api, approval, 'approve');
      stopped = true;
      statusLine.textContent = 'Approved.';
    } catch (err) {
      statusLine.textContent = `Approve fehlgeschlagen: ${(err as Error).message}`;
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
  });

  rejectBtn.addEventListener('click', async () => {
    if (stopped) return;
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    statusLine.textContent = 'Lehne ab …';
    try {
      await renderDecisionFlow(api, approval, 'reject');
      stopped = true;
      statusLine.textContent = 'Rejected.';
    } catch (err) {
      statusLine.textContent = `Reject fehlgeschlagen: ${(err as Error).message}`;
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
  });

  if (!approval.toolName) {
    showToast('Approval payload incomplete — display may be partial.', 'error');
  }
}

function sensBadge(sensitivity: 'write' | 'danger'): HTMLElement {
  const span = document.createElement('span');
  const cls = sensitivity === 'danger' ? 'badge-danger' : 'badge-write';
  span.className = `badge ${cls}`;
  span.textContent = sensitivity === 'danger' ? 'DANGER' : 'WRITE';
  span.title = sensitivity === 'danger'
    ? 'Approval-pflichtig + irreversibel (z.B. delete, send) — kann nicht rueckgaengig gemacht werden'
    : 'Approval-pflichtig + reversibel — Aktion kann rueckgaengig gemacht werden';
  span.setAttribute('aria-label', span.title);
  return span;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'abgelaufen';
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}m ${ss.toString().padStart(2, '0')}s`;
}
