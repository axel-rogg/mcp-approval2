/**
 * Pending-Approval-View mit WebAuthn-Sign-Off (PRF).
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (PWA-Approval-Flow) + §5.3
 * (PRF-Layer im Approval-Flow).
 *
 * Flow pro Approval-Click:
 *   1. POST /v1/approvals/:id/challenge  → { challengeB64, allowCredentialIdsB64 }
 *   2. navigator.credentials.get(...) mit PRF-Extension (Salt=`approval:<id>`)
 *   3. PRF-Output → POST /v1/credentials/prf-session (wenn Tool credentials braucht)
 *   4. POST /v1/approvals/:id/sign mit signature + prfSessionId
 *   5. Poll /v1/approvals/:id/result bis status != 'executing'
 *
 * Polling: 5s-Refresh wenn der View aktiv ist; cancelled bei Navigation.
 */
import type { ApiClient, PendingApproval, Session } from './api.js';
import { ApiError } from './api.js';
import { logout, renderSessionExpired } from './auth.js';
import { renderHeader } from './components/header.js';
import { renderEmptyState } from './components/empty-state.js';
import { evalPrf, bytesToB64, b64UrlToBytes } from './webauthn-prf.js';

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
    statusEl.textContent = items.length === 0 ? 'No pending approvals.' : `${items.length} pending`;
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
  session: Session,
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
    host.appendChild(renderApprovalCard(item, api, session));
  }
}

function renderApprovalCard(
  approval: PendingApproval,
  api: ApiClient,
  session: Session,
): HTMLElement {
  const card = document.createElement('div');
  card.className = `card approval approval-${approval.sensitivity}`;
  card.dataset['id'] = approval.id;

  const head = document.createElement('div');
  head.className = 'row approval-head';

  const toolName = document.createElement('strong');
  toolName.textContent = approval.toolName;
  head.appendChild(toolName);

  const sens = document.createElement('span');
  sens.className = `pill pill-${approval.sensitivity}`;
  sens.textContent = approval.sensitivity;
  head.appendChild(sens);

  card.appendChild(head);

  // WYSIWYS display
  const display = document.createElement('div');
  display.className = 'approval-display';
  if (approval.displayTemplate) {
    display.textContent = applyTemplate(approval.displayTemplate, approval.input);
  } else {
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(approval.input, null, 2);
    display.appendChild(pre);
  }
  card.appendChild(display);

  const ts = document.createElement('div');
  ts.className = 'muted small';
  ts.textContent = `Requested ${new Date(approval.requestedAt).toLocaleString()}`;
  card.appendChild(ts);

  const actions = document.createElement('div');
  actions.className = 'row approval-actions';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn';
  approveBtn.type = 'button';
  approveBtn.textContent = approval.sensitivity === 'danger' ? 'Approve & sign (danger)' : 'Approve & sign';

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'btn btn-secondary';
  rejectBtn.type = 'button';
  rejectBtn.textContent = 'Reject';

  const inlineStatus = document.createElement('div');
  inlineStatus.className = 'muted small approval-inline-status';

  approveBtn.addEventListener('click', () => {
    void handleApprove(approval, api, session, { approveBtn, rejectBtn, status: inlineStatus });
  });
  rejectBtn.addEventListener('click', () => {
    void handleReject(approval, api, { approveBtn, rejectBtn, status: inlineStatus });
  });

  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(actions);
  card.appendChild(inlineStatus);

  return card;
}

interface ButtonRefs {
  readonly approveBtn: HTMLButtonElement;
  readonly rejectBtn: HTMLButtonElement;
  readonly status: HTMLDivElement;
}

async function handleApprove(
  approval: PendingApproval,
  api: ApiClient,
  _session: Session,
  refs: ButtonRefs,
): Promise<void> {
  refs.approveBtn.disabled = true;
  refs.rejectBtn.disabled = true;
  refs.status.textContent = 'Requesting signature…';
  refs.status.className = 'muted small approval-inline-status';

  try {
    // 1. Server-challenge holen (replay-Schutz). Fallback: client-Challenge,
    //    falls Backend-Route noch nicht existiert — Server muss in dem Fall
    //    den challenge im sign-Body ignorieren oder selbst injizieren.
    let challengeBytes: Uint8Array;
    let allowCredentials: PublicKeyCredentialDescriptor[] | undefined;
    try {
      const ch = await api.getApprovalChallenge(approval.id);
      challengeBytes = b64UrlToBytes(ch.challengeB64);
      allowCredentials = ch.allowCredentialIdsB64.map((idB64) => ({
        type: 'public-key' as const,
        id: toArrayBuffer(b64UrlToBytes(idB64)),
      }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Backend route not deployed yet — fall back to embedded data on the
        // approval object (if present) or a fresh random.
        const embedded = approval.challengeB64 ? b64UrlToBytes(approval.challengeB64) : crypto.getRandomValues(new Uint8Array(32));
        challengeBytes = embedded;
        if (approval.allowCredentialIdsB64) {
          allowCredentials = approval.allowCredentialIdsB64.map((idB64) => ({
            type: 'public-key' as const,
            id: toArrayBuffer(b64UrlToBytes(idB64)),
          }));
        }
      } else {
        throw err;
      }
    }

    // 2. WebAuthn-Sign mit PRF-Extension
    const salt = new TextEncoder().encode(`approval:${approval.id}`);
    const prfResult = await evalPrf({
      salt,
      challenge: challengeBytes,
      ...(allowCredentials ? { allowCredentials } : {}),
    });

    // 3. PRF-Session anlegen wenn das Tool credentials braucht
    let prfSessionId: string | undefined;
    const needsPrf =
      approval.requiresPrf === true ||
      approval.toolName.startsWith('credentials.') ||
      approval.toolName.startsWith('credentials/');
    if (needsPrf) {
      refs.status.textContent = 'Stashing PRF session…';
      const session = await api.storePrfSession({
        prfOutput: bytesToB64(prfResult.prfOutput),
      });
      prfSessionId = session.sessionId;
    }

    // 4. Signature an Server schicken
    refs.status.textContent = 'Submitting approval…';
    const signature = bytesToB64(prfResult.signature);
    await api.approveApproval({
      id: approval.id,
      signature,
      ...(prfSessionId ? { prfSessionId } : {}),
    });

    // 5. Poll result
    refs.status.textContent = 'Tool executing…';
    try {
      await api.pollResult(approval.id);
      refs.status.textContent = 'Tool completed.';
      refs.status.className = 'ok small approval-inline-status';
    } catch {
      refs.status.textContent = 'Approved. (result polling failed)';
    }

    // Card aus Liste entfernen — refresh wird bald folgen
    setTimeout(() => {
      const card = document.querySelector(`.card[data-id="${approval.id}"]`);
      card?.remove();
    }, 800);
  } catch (err) {
    refs.status.textContent = `Failed: ${(err as Error).message}`;
    refs.status.className = 'err small approval-inline-status';
    refs.approveBtn.disabled = false;
    refs.rejectBtn.disabled = false;
  }
}

async function handleReject(
  approval: PendingApproval,
  api: ApiClient,
  refs: ButtonRefs,
): Promise<void> {
  refs.approveBtn.disabled = true;
  refs.rejectBtn.disabled = true;
  refs.status.textContent = 'Rejecting…';
  refs.status.className = 'muted small approval-inline-status';

  const reason = window.prompt('Reject reason (optional)') ?? undefined;

  try {
    await api.rejectApproval({ id: approval.id, ...(reason ? { reason } : {}) });
    refs.status.textContent = 'Rejected.';
    refs.status.className = 'ok small approval-inline-status';
    setTimeout(() => {
      const card = document.querySelector(`.card[data-id="${approval.id}"]`);
      card?.remove();
    }, 800);
  } catch (err) {
    refs.status.textContent = `Failed: ${(err as Error).message}`;
    refs.status.className = 'err small approval-inline-status';
    refs.approveBtn.disabled = false;
    refs.rejectBtn.disabled = false;
  }
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
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
