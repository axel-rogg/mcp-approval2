/**
 * Approval-Decision-Flow — Approve (WebAuthn + PRF) / Reject (mit Begruendung).
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.4 (Passkey), §5.3 (PRF-Layer),
 *           §11 Phase 4 (Approval-Flow).
 *
 * Approve-Path:
 *   1. POST /v1/approvals/:id/challenge  → { challengeB64, allowCredentialIdsB64 }
 *   2. navigator.credentials.get(...) mit PRF-Extension (Salt=`approval:<id>`)
 *   3. Wenn das Tool credentials braucht (toolName-Prefix `credentials.`): PRF-
 *      Output via /v1/credentials/prf-session stashen → prfSessionId
 *   4. POST /v1/approvals/:id/sign mit signatureB64 + optional prfSessionId
 *   5. Poll /v1/approvals/:id/result bis !executing
 *
 * Reject-Path:
 *   prompt() fuer Reason → POST /v1/approvals/:id/reject
 *
 * Toast-Feedback bei Success/Failure, navigation zu #/approvals nach Erledigt.
 */
import type { ApiClient, PendingApproval } from './api.js';
import { ApiError } from './api.js';
import { evalPrf, bytesToB64, bytesToB64Url, b64UrlToBytes } from './webauthn-prf.js';
import { showToast } from './components/toast.js';

export type Decision = 'approve' | 'reject';

export async function renderDecisionFlow(
  api: ApiClient,
  approval: PendingApproval,
  decision: Decision,
): Promise<void> {
  if (decision === 'reject') {
    await handleReject(api, approval);
    return;
  }
  await handleApprove(api, approval);
}

async function handleReject(api: ApiClient, approval: PendingApproval): Promise<void> {
  const reason = window.prompt('Reason for rejection (optional):') ?? undefined;
  // null → abgebrochen; leerer string → trotzdem rejecten ohne reason
  if (reason === undefined) return;
  try {
    await api.rejectApproval({ id: approval.id, ...(reason ? { reason } : {}) });
    showToast('Approval rejected', 'success');
    window.location.hash = '#/approvals';
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      showToast('Session expired — please re-login.', 'error');
      window.location.hash = '#/login';
      return;
    }
    showToast(`Reject failed: ${(err as Error).message}`, 'error');
  }
}

async function handleApprove(api: ApiClient, approval: PendingApproval): Promise<void> {
  try {
    // 1. Server-Challenge holen (replay-Schutz)
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
      // Fallback: Embedded auf dem Approval-Object oder zufaellig
      if (err instanceof ApiError && err.status === 404) {
        const embedded = approval.challengeB64
          ? b64UrlToBytes(approval.challengeB64)
          : crypto.getRandomValues(new Uint8Array(32));
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

    // 2. WebAuthn-Sign + PRF
    showToast('Tap your passkey…', 'info', { ttlMs: 5_000 });
    const salt = new TextEncoder().encode(`approval:${approval.id}`);
    const prfResult = await evalPrf({
      salt,
      challenge: challengeBytes,
      ...(allowCredentials ? { allowCredentials } : {}),
    });

    // 3. PRF-Session anlegen wenn Tool credentials braucht
    let prfSessionId: string | undefined;
    const needsPrf =
      approval.requiresPrf === true ||
      approval.toolName.startsWith('credentials.') ||
      approval.toolName.startsWith('credentials/');
    if (needsPrf) {
      const session = await api.storePrfSession({
        prfOutput: bytesToB64(prfResult.prfOutput),
      });
      prfSessionId = session.sessionId;
    }

    // 4. Vollstaendige Assertion an Server schicken (SEC-001).
    //   credentialId, authenticatorData, signature → base64 (Server konvertiert
    //   intern via SimpleWebAuthn's `isoBase64URL.toBuffer`, akzeptiert beide
    //   b64-Varianten).
    //   clientDataJSON wird ohne re-encode durchgereicht — der WebAuthn-Standard
    //   verlangt, dass der Server EXAKT die clientDataJSON sieht die der
    //   Authenticator gesignt hat, byte-fuer-byte.
    await api.approveApproval({
      id: approval.id,
      credentialIdB64: bytesToB64Url(prfResult.credentialId),
      authenticatorDataB64: bytesToB64(prfResult.authenticatorData),
      clientDataJsonB64: bytesToB64(prfResult.clientDataJson),
      signatureB64: bytesToB64(prfResult.signature),
      ...(prfResult.userHandle ? { userHandleB64: bytesToB64(prfResult.userHandle) } : {}),
      ...(prfSessionId ? { prfSessionId } : {}),
    });

    showToast('Approval signed, executing…', 'info');

    // 5. Result pollen
    try {
      await api.pollResult(approval.id);
      showToast(`Tool completed: ${approval.toolName}`, 'success');
    } catch {
      showToast('Approved. (Result polling failed — check tool output later.)', 'info');
    }
    window.location.hash = '#/approvals';
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      showToast('Session expired — please re-login.', 'error');
      window.location.hash = '#/login';
      return;
    }
    showToast(`Approval failed: ${(err as Error).message}`, 'error');
  }
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}
