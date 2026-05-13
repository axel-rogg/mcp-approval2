/**
 * Approval-Detail-View — Vollbild eines einzelnen Pending-Approvals.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (PWA-Approval-Flow + WYSIWYS).
 *
 * Layout:
 *   Header  — back-Button + ToolName + Sensitivity-Badge
 *   Display — gerenderter display_template (WYSIWYS)
 *   Sections — siehe approval-sections.ts (was passiert / data / wohin / sensitivity)
 *   Decision — Approve / Reject Buttons → approval-decision.ts
 *
 * Hash-Route: `#/approvals/<id>`. main.ts dispatcht hier hin.
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

  // Re-render mit echten Daten
  renderLoaded(main, api, approval);
}

function renderLoaded(
  main: HTMLElement,
  api: ApiClient,
  approval: PendingApproval,
): void {
  main.innerHTML = '';

  // ── Header ──────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'approval-detail-head row';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn btn-secondary btn-small approval-back-btn';
  backBtn.textContent = '← Pending';
  backBtn.addEventListener('click', () => {
    window.location.hash = '#/approvals';
  });
  header.appendChild(backBtn);

  const title = document.createElement('h1');
  title.className = 'approval-detail-title';
  const titleCode = document.createElement('code');
  titleCode.textContent = approval.toolName;
  title.appendChild(titleCode);
  header.appendChild(title);

  const sens = document.createElement('span');
  sens.className = `pill pill-${approval.sensitivity} sensitivity-badge sensitivity-${approval.sensitivity}`;
  sens.textContent = approval.sensitivity;
  header.appendChild(sens);

  main.appendChild(header);

  // ── Requested-Timestamp ─────────────────────────────────────────────────
  const ts = document.createElement('p');
  ts.className = 'muted small';
  ts.textContent = `Requested ${new Date(approval.requestedAt).toLocaleString()}`;
  main.appendChild(ts);

  // ── Sections ────────────────────────────────────────────────────────────
  main.appendChild(renderSections(approval));

  // ── Decision-Buttons ────────────────────────────────────────────────────
  if (approval.status === 'pending') {
    const decisionRow = document.createElement('div');
    decisionRow.className = 'row approval-decision';

    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'btn btn-approve';
    approveBtn.textContent =
      approval.sensitivity === 'danger' ? 'Approve & sign (danger)' : 'Approve & sign';
    approveBtn.addEventListener('click', () => {
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      void renderDecisionFlow(api, approval, 'approve').finally(() => {
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
      });
    });
    decisionRow.appendChild(approveBtn);

    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'btn btn-secondary btn-reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => {
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      void renderDecisionFlow(api, approval, 'reject').finally(() => {
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
      });
    });
    decisionRow.appendChild(rejectBtn);

    main.appendChild(decisionRow);
  } else {
    const statusEl = document.createElement('p');
    statusEl.className = 'muted approval-detail-status';
    statusEl.textContent = `Status: ${approval.status} — no further action available.`;
    main.appendChild(statusEl);
  }

  // Silent error path for fetched-but-incomplete approvals
  if (!approval.toolName) {
    showToast('Approval payload incomplete — display may be partial.', 'error');
  }
}
