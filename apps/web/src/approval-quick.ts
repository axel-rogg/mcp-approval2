/**
 * Approval Quick-Card — Pending-Liste-Eintrag (v1 .approval-card.pending Pattern).
 *
 * Identisch zu v1 (mcp-approval/assets/app/approval-list.js#buildPendingCard):
 *
 *   ┌── 3px accent border-left ──────────────────┐
 *   │  tool.name              laeuft in 4m 32s   │  card-row1
 *   │  display-string (1-Zeile, ellipsis, mono)  │  card-row2
 *   └────────────────────────────────────────────┘
 *
 * Klick auf die ganze Karte navigiert zu #/approvals/<id>. Approve/Reject
 * gibt es hier NICHT — User muss die Detail-View aufrufen damit er den
 * vollen WYSIWYS-Display + die sectioned Aufschluesselung sieht.
 *
 * (Die alte v2-Quick-Card mit inline Approve/Reject-Buttons war eine
 * Convenience-Variante. Sie umging die Sec-Card-Aufschluesselung und ist
 * mit dem v1-Look-Port entfallen.)
 */
import type { PendingApproval } from './api.js';
import { renderDisplay } from './approval-sections.js';

export function renderQuickCard(approval: PendingApproval): HTMLElement {
  const link = document.createElement('a');
  link.href = `#/approvals/${encodeURIComponent(approval.id)}`;
  link.className = 'approval-card pending';
  link.dataset['id'] = approval.id;

  // ── card-row1: tool-name + TTL ───────────────────────────────────────────
  const row1 = document.createElement('div');
  row1.className = 'card-row1';

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = approval.toolName;
  row1.appendChild(name);

  const ttl = document.createElement('span');
  ttl.className = 'ttl';
  ttl.textContent = `laeuft in ${formatTtl(expiresAtOf(approval) - Date.now())}`;
  row1.appendChild(ttl);

  link.appendChild(row1);

  // ── card-row2: display-string (1-Zeile) ──────────────────────────────────
  const row2 = document.createElement('div');
  row2.className = 'card-row2 mono';
  row2.textContent = shortDisplay(approval);
  link.appendChild(row2);

  return link;
}

export function shortDisplay(approval: PendingApproval): string {
  const rendered = renderDisplay(approval);
  if (rendered) {
    // sectioned strings haben "=== Label ===" Marker — strippen fuer 1-Zeile
    const flat = rendered.replace(/^=== .+ ===$/gm, '').replace(/\s+/g, ' ').trim();
    return flat.length > 0 ? flat : approval.toolName;
  }
  const keys = Object.keys(approval.input ?? {});
  if (keys.length === 0) return '(no input)';
  return `Input fields: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}`;
}

function expiresAtOf(approval: PendingApproval): number {
  const v = (approval as PendingApproval & { expiresAt?: number }).expiresAt;
  return typeof v === 'number' ? v : approval.requestedAt + 5 * 60 * 1000;
}

function formatTtl(ms: number): string {
  if (ms <= 0) return 'abgelaufen';
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}m ${ss.toString().padStart(2, '0')}s`;
}
