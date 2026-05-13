/**
 * Auth-Helper fuer die mcp-approval2 PWA.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3 (Identity & Auth), §3.4 (Passkey),
 * §3.5 (Session-Mgmt).
 *
 * Verantwortlichkeiten:
 *   - Google-OAuth-Redirect via `/auth/google/start`
 *   - Session-Check (in-memory cache + `/auth/refresh` probe via api.ts)
 *   - WebAuthn-Enrollment mit PRF-Extension (Bootstrap nach Google-Login)
 *   - Logout via `/auth/logout` + Session-Clear
 *
 * UI-Konvention: alle Render-Funktionen muten ihr `root` selbst (innerHTML +
 * Event-Listener), kein Framework. Komposition ueber `components/`.
 */
import type { ApiClient, Session } from './api.js';
import { renderHeader } from './components/header.js';
import { renderEmptyState } from './components/empty-state.js';
import {
  enrollPasskeyWithPrf,
  bytesToB64Url,
  b64UrlToBytes,
} from './webauthn-prf.js';

let cachedSession: Session | null = null;
let sessionFetched = false;

/**
 * Loads the current session, cached per page-load. `refresh=true` forces a
 * re-probe (e.g. after login redirect).
 */
export async function loadSession(api: ApiClient, refresh = false): Promise<Session | null> {
  if (!refresh && sessionFetched) return cachedSession;
  cachedSession = await api.getSession();
  sessionFetched = true;
  return cachedSession;
}

export function clearSessionCache(): void {
  cachedSession = null;
  sessionFetched = false;
}

/**
 * Login-Page mit Google-Sign-In-Button.
 *
 * `redirectTo` wird optional als `?next=` an `/auth/google/start` angehaengt,
 * damit das Backend nach OAuth-Callback wieder dorthin springt.
 */
export function renderLogin(root: HTMLElement, opts?: { redirectTo?: string; error?: string }): void {
  root.innerHTML = '';
  const main = document.createElement('main');
  main.className = 'login';

  const h1 = document.createElement('h1');
  h1.textContent = 'mcp-approval2';
  main.appendChild(h1);

  const lede = document.createElement('p');
  lede.className = 'muted';
  lede.textContent = 'Private MCP gateway — sign in to manage approvals and credentials.';
  main.appendChild(lede);

  if (opts?.error) {
    const err = document.createElement('div');
    err.className = 'card err';
    err.textContent = opts.error;
    main.appendChild(err);
  }

  const card = document.createElement('div');
  card.className = 'card';

  const desc = document.createElement('p');
  desc.className = 'muted';
  desc.textContent =
    'Sign in with your Google account. On first login a passkey will be enrolled to authorize sensitive actions.';
  card.appendChild(desc);

  const btn = document.createElement('a');
  btn.className = 'btn';
  const next = opts?.redirectTo ? `?next=${encodeURIComponent(opts.redirectTo)}` : '';
  btn.href = `/auth/google/start${next}`;
  btn.textContent = 'Sign in with Google';
  card.appendChild(btn);

  main.appendChild(card);

  const help = document.createElement('p');
  help.className = 'muted small';
  help.innerHTML =
    'Trouble signing in? Verify the <a href="/health">/health</a> endpoint or contact your administrator.';
  main.appendChild(help);

  root.appendChild(main);
}

/**
 * Logout — server-side session revoke + cookie clear + redirect to login.
 */
export async function logout(api: ApiClient): Promise<void> {
  try {
    await api.logout();
  } catch {
    // best-effort — proceed with client-side clear even if server-call failed
  }
  clearSessionCache();
  window.location.hash = '#/login';
}

/**
 * Triggert WebAuthn-Passkey-Enrollment (1 Passkey Pflicht, PRF aktiv).
 *
 * Flow:
 *   1. POST /auth/webauthn/enroll/start → { creationOptionsJSON }
 *   2. navigator.credentials.create() mit PRF-Extension
 *   3. POST /auth/webauthn/enroll/finish → bestaetigt Server-side
 *
 * Returnt `prfSupported` damit der Caller dem User signalisieren kann ob
 * Credentials mit PRF-Layer erstellt werden koennen.
 */
export async function enrollPasskey(): Promise<{ prfSupported: boolean }> {
  // 1. Start
  const startRes = await fetch('/auth/webauthn/enroll/start', {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!startRes.ok) {
    throw new Error(`Passkey-enrollment start failed: HTTP ${startRes.status}`);
  }
  const startBody = (await startRes.json()) as {
    creationOptionsJSON: PublicKeyCredentialCreationOptionsJSON;
  };
  const options = parseCreationOptions(startBody.creationOptionsJSON);

  // 2. WebAuthn create + PRF
  const result = await enrollPasskeyWithPrf({ options });

  // 3. Finish
  const finishRes = await fetch('/auth/webauthn/enroll/finish', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      credentialIdB64: bytesToB64Url(result.credentialId),
      clientDataJsonB64: bytesToB64Url(new Uint8Array(result.attestation.clientDataJSON)),
      attestationObjectB64: bytesToB64Url(new Uint8Array(result.attestation.attestationObject)),
      prfSupported: result.prfSupported,
    }),
  });
  if (!finishRes.ok) {
    throw new Error(`Passkey-enrollment finish failed: HTTP ${finishRes.status}`);
  }

  return { prfSupported: result.prfSupported };
}

/**
 * Onboarding-Screen: zeigt CTA fuer Passkey-Enrollment nach erstem Google-Login.
 */
export function renderEnrollPasskey(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
  onDone: () => void,
): void {
  root.innerHTML = '';
  renderHeader(root, session, () => void logout(api));

  const main = document.createElement('main');
  main.className = 'enroll';

  const h1 = document.createElement('h1');
  h1.textContent = 'Set up your passkey';
  main.appendChild(h1);

  const card = document.createElement('div');
  card.className = 'card';

  const desc = document.createElement('p');
  desc.textContent =
    'A passkey is required to authorize sensitive actions (approvals, credential access). Use your built-in authenticator (Face ID, Touch ID, Windows Hello) or a hardware key.';
  card.appendChild(desc);

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.type = 'button';
  btn.textContent = 'Enroll passkey now';
  card.appendChild(btn);

  const status = document.createElement('p');
  status.className = 'muted small';
  card.appendChild(status);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'Waiting for authenticator…';
    status.className = 'muted small';
    try {
      const { prfSupported } = await enrollPasskey();
      status.textContent = prfSupported
        ? 'Passkey enrolled. PRF supported — credential encryption available.'
        : 'Passkey enrolled. PRF not supported — credential encryption falls back to Vault-only.';
      status.className = 'ok small';
      setTimeout(onDone, 1500);
    } catch (err) {
      status.textContent = `Enrollment failed: ${(err as Error).message}`;
      status.className = 'err small';
      btn.disabled = false;
    }
  });

  main.appendChild(card);
  root.appendChild(main);
}

/**
 * Helper-Render-Stub fuer "session lost / expired" — used by polling fns.
 */
export function renderSessionExpired(root: HTMLElement): void {
  root.innerHTML = '';
  const main = document.createElement('main');
  main.appendChild(renderEmptyState({
    title: 'Session expired',
    body: 'Please sign in again to continue.',
    actionLabel: 'Sign in',
    actionHref: '#/login',
  }));
  root.appendChild(main);
}

// ---- JSON ↔ WebAuthn shape conversion ------------------------------------

interface PublicKeyCredentialDescriptorJSON {
  readonly id: string;
  readonly type: 'public-key';
  readonly transports?: AuthenticatorTransport[];
}

interface PublicKeyCredentialUserEntityJSON {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
}

interface PublicKeyCredentialCreationOptionsJSON {
  readonly rp: PublicKeyCredentialRpEntity;
  readonly user: PublicKeyCredentialUserEntityJSON;
  readonly challenge: string;
  readonly pubKeyCredParams: PublicKeyCredentialParameters[];
  readonly timeout?: number;
  readonly excludeCredentials?: PublicKeyCredentialDescriptorJSON[];
  readonly authenticatorSelection?: AuthenticatorSelectionCriteria;
  readonly attestation?: AttestationConveyancePreference;
}

function parseCreationOptions(
  json: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  const out: PublicKeyCredentialCreationOptions = {
    rp: json.rp,
    user: {
      id: toArrayBuffer(b64UrlToBytes(json.user.id)),
      name: json.user.name,
      displayName: json.user.displayName,
    },
    challenge: toArrayBuffer(b64UrlToBytes(json.challenge)),
    pubKeyCredParams: json.pubKeyCredParams,
    ...(json.timeout !== undefined ? { timeout: json.timeout } : {}),
    ...(json.excludeCredentials
      ? {
          excludeCredentials: json.excludeCredentials.map((d) => ({
            id: toArrayBuffer(b64UrlToBytes(d.id)),
            type: d.type,
            ...(d.transports ? { transports: d.transports } : {}),
          })),
        }
      : {}),
    ...(json.authenticatorSelection ? { authenticatorSelection: json.authenticatorSelection } : {}),
    ...(json.attestation ? { attestation: json.attestation } : {}),
  };
  return out;
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}
