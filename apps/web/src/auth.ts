/**
 * Auth-Helper fuer die PWA.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.5 (Session) + §3.4 (Passkey).
 *
 * Session-Detection: das Backend setzt einen `mcp_session=<jti>`-Cookie
 * (`HttpOnly` ist OK fuer Server-Auth; fuer Browser-Reads brauchen wir eine
 * non-HttpOnly Schwester-Cookie `mcp_session_marker` — TODO im Backend).
 * Skeleton: wir checken einfach den sichtbaren Marker.
 */

const SESSION_MARKER_COOKIE = 'mcp_session_marker';

export function isAuthenticated(): boolean {
  return document.cookie.split(/;\s*/).some((c) => c.startsWith(`${SESSION_MARKER_COOKIE}=`));
}

/**
 * Rendert die Login-Page. Single-Button "Sign in with Google" — redirected
 * direkt auf den Backend-Start-Endpoint. State + PKCE werden Server-seitig
 * gefuehrt.
 */
export function renderLogin(root: HTMLElement): void {
  root.innerHTML = `
    <main>
      <h1>mcp-approval2</h1>
      <p>Sign in to access your approval queue + tool surfaces.</p>
      <div class="card">
        <p class="muted">
          mcp-approval2 is a private MCP gateway. Sign-in is via your
          organization's Google account; a passkey will be enrolled on first
          login to authorize sensitive actions.
        </p>
        <p>
          <a class="btn" href="/auth/google/start">Sign in with Google</a>
        </p>
      </div>
      <p class="muted">
        Issues signing in? Check the
        <a href="/health">/health</a> endpoint or contact your administrator.
      </p>
    </main>
  `;
}

/**
 * Triggert die WebAuthn-Approval-Flow.
 *
 * Skeleton: ruft `navigator.credentials.get({publicKey: ...})` mit PRF-
 * Extension, sendet das `clientDataJSON` + `signature` + `prfOutput` an
 * den Backend-Endpoint, der die Signature validiert + den Approval-State
 * auf `approved` schiebt.
 *
 * TODO Backend: `/v1/approvals/:id/challenge` + `/v1/approvals/:id/sign` —
 * existieren noch nicht (siehe docs/STATUS.md).
 */
export async function signApproval(approvalId: string): Promise<void> {
  if (!('credentials' in navigator)) {
    throw new Error('WebAuthn not available in this browser.');
  }
  // Phase-4-Stub — wir holen einen Challenge vom Server und feedan ihn in
  // navigator.credentials.get. Hier nur als Vorlage; Backend-Endpoint fehlt.
  const challengeRes = await fetch(`/v1/approvals/${encodeURIComponent(approvalId)}/challenge`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!challengeRes.ok) {
    throw new Error(`approval challenge failed: HTTP ${challengeRes.status}`);
  }
  const challenge = (await challengeRes.json()) as {
    challengeB64: string;
    allowCredentialIds: string[];
  };

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: toBufferSource(base64UrlDecode(challenge.challengeB64)),
    timeout: 60_000,
    allowCredentials: challenge.allowCredentialIds.map((id) => ({
      type: 'public-key' as const,
      id: toBufferSource(base64UrlDecode(id)),
    })),
    userVerification: 'required',
    extensions: {
      // PRF extension is not in the default lib.dom typings yet — cast around it.
      prf: { eval: { first: toBufferSource(new Uint8Array(32)) } },
    } as AuthenticationExtensionsClientInputs,
  };

  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('WebAuthn assertion cancelled.');

  await fetch(`/v1/approvals/${encodeURIComponent(approvalId)}/sign`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      credentialIdB64: base64UrlEncode(new Uint8Array(cred.rawId)),
      // The full WebAuthn fields are TODO — Skeleton just shows the wire shape.
      assertion: 'TODO-serialize-AuthenticatorAssertionResponse',
    }),
  });
}

/**
 * TS-5-friendly conversion: `Uint8Array<ArrayBufferLike>` → `BufferSource`.
 * The runtime is identical; we just satisfy the stricter DOM typings.
 */
function toBufferSource(u: Uint8Array): BufferSource {
  const copy = new Uint8Array(u.length);
  copy.set(u);
  return copy.buffer as ArrayBuffer;
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlEncode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
