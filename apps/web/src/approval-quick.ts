/**
 * Approval-Quick-Action — inline Card-Variante fuer die Pending-Liste.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 — UX-Variante fuer schnelles
 * Approven aus der Liste (kein Detail-Round-trip).
 *
 * Card-Form: ToolName + Sensitivity + 1-Zeilen-Display + 3 Buttons:
 *   [Details]   — navigiert zu #/approvals/:id
 *   [Approve]   — startet Decision-Flow inline (PRF-Tap)
 *   [Reject]    — startet Decision-Flow inline
 *
 * Bei `sensitivity='danger'` ist Quick-Approve nicht erlaubt — Approve-Button
 * leitet zwingend in die Detail-View um, weil danger-Operationen den Volltext
 * der Section-Aufschluesselung verlangen. (Defense-in-Depth fuer den User —
 * server-side ist nichts blockiert, aber UX faengt's ab.)
 */
import type { ApiClient, PendingApproval } from './api.js';
import { renderDecisionFlow } from './approval-decision.js';

export function renderQuickCard(
  approval: PendingApproval,
  api: ApiClient,
): HTMLElement {
  const card = document.createElement('div');
  card.className = `card approval approval-quick approval-${approval.sensitivity}`;
  card.dataset['id'] = approval.id;

  // Head
  const head = document.createElement('div');
  head.className = 'row approval-head approval-quick-head';

  const titleLink = document.createElement('a');
  titleLink.className = 'approval-quick-title';
  titleLink.href = `#/approvals/${encodeURIComponent(approval.id)}`;
  const titleCode = document.createElement('code');
  titleCode.textContent = approval.toolName;
  titleLink.appendChild(titleCode);
  head.appendChild(titleLink);

  const sens = document.createElement('span');
  sens.className = `pill pill-${approval.sensitivity}`;
  sens.textContent = approval.sensitivity;
  head.appendChild(sens);

  card.appendChild(head);

  // 1-Zeilen Display (truncated)
  const display = document.createElement('p');
  display.className = 'approval-quick-display';
  display.textContent = shortDisplay(approval);
  card.appendChild(display);

  // Timestamp
  const ts = document.createElement('div');
  ts.className = 'muted small';
  ts.textContent = `Requested ${new Date(approval.requestedAt).toLocaleString()}`;
  card.appendChild(ts);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'row approval-actions approval-quick-actions';

  const detailsBtn = document.createElement('a');
  detailsBtn.className = 'btn btn-secondary btn-small';
  detailsBtn.href = `#/approvals/${encodeURIComponent(approval.id)}`;
  detailsBtn.textContent = 'Details';
  actions.appendChild(detailsBtn);

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'btn btn-small btn-approve';
  approveBtn.textContent = 'Approve';
  approveBtn.addEventListener('click', () => {
    if (approval.sensitivity === 'danger') {
      // Defense-in-Depth: danger-Approvals MUESSEN ueber Detail-View laufen.
      window.location.hash = `#/approvals/${encodeURIComponent(approval.id)}`;
      return;
    }
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    void renderDecisionFlow(api, approval, 'approve').finally(() => {
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    });
  });
  actions.appendChild(approveBtn);

  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'btn btn-secondary btn-small btn-reject';
  rejectBtn.textContent = 'Reject';
  rejectBtn.addEventListener('click', () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    void renderDecisionFlow(api, approval, 'reject').finally(() => {
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    });
  });
  actions.appendChild(rejectBtn);

  card.appendChild(actions);
  return card;
}

function shortDisplay(approval: PendingApproval): string {
  const rendered = (approval as PendingApproval & { displayRendered?: unknown }).displayRendered;
  if (typeof rendered === 'string' && rendered.length > 0) {
    return truncate(rendered, 140);
  }
  if (approval.displayTemplate) {
    const subst = applyTemplate(approval.displayTemplate, approval.input);
    if (subst) return truncate(subst, 140);
  }
  // Fallback: 1-line preview of input keys
  const keys = Object.keys(approval.input ?? {});
  if (keys.length === 0) return '(no input)';
  return `Input fields: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
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
