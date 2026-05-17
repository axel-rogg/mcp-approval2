/**
 * Write-Mode-Tab — Aktiviere/Deaktiviere Auto-Approve-Fenster fuer
 * reversible Tools (sensitivity='write'). DANGER-Tools bleiben immer
 * approval-pflichtig.
 *
 * Plan-Ref: docs/plans/active/PLAN-writemode.md (Slice 6/6).
 *
 * UX:
 *   - Live-Countdown wenn Session aktiv (1-Sekunden-Tick) + "Deaktivieren".
 *   - Drei Aktivierungs-Buttons (15 min / 1 h / 4 h) wenn inaktiv.
 *   - Aktivierung verlangt Passkey-Tap (WebAuthn-UV) — Server verifiziert
 *     Signature ueber `{action,duration,ts}`-canonical-JSON.
 *
 * Server-Surface: /v1/writemode/{status,activate,deactivate} (Bearer-gated).
 */
import { authedFetch } from './auth-token.js';
import { logout, renderSessionExpired } from './auth.js';
import type { ApiClient, Session } from './api.js';
import { renderHeader } from './components/header.js';
import { showToast } from './components/toast.js';

interface StatusResponse {
  readonly active: boolean;
  readonly sessions: ReadonlyArray<{
    readonly id: string;
    readonly activated_at: number;
    readonly expires_at: number;
  }>;
}

interface ActivateResponse {
  readonly ok: true;
  readonly session: {
    readonly id: string;
    readonly activated_at: number;
    readonly expires_at: number;
  };
}

type DurationMin = 15 | 60 | 240;

const DURATIONS: ReadonlyArray<{ duration: DurationMin; label: string }> = [
  { duration: 15, label: '15 min' },
  { duration: 60, label: '1 Stunde' },
  { duration: 240, label: '4 Stunden' },
];

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') +
    '}'
  );
}

function bytesToB64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function baseUrl(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787';
}

async function fetchStatus(): Promise<StatusResponse> {
  const res = await authedFetch(
    new URL('/v1/writemode/status', baseUrl()).toString(),
    { method: 'GET', headers: { accept: 'application/json' } },
    baseUrl(),
  );
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as StatusResponse;
}

async function postDeactivate(): Promise<void> {
  const res = await authedFetch(
    new URL('/v1/writemode/deactivate', baseUrl()).toString(),
    { method: 'POST', headers: { accept: 'application/json' } },
    baseUrl(),
  );
  if (!res.ok) throw new Error(`deactivate ${res.status}`);
}

async function postActivate(args: {
  duration: DurationMin;
  ts: number;
  assertion: {
    credentialIdB64: string;
    authenticatorDataB64: string;
    clientDataJsonB64: string;
    signatureB64: string;
    userHandleB64?: string;
  };
}): Promise<ActivateResponse> {
  const body: Record<string, unknown> = {
    duration: args.duration,
    ts: args.ts,
    credentialIdB64: args.assertion.credentialIdB64,
    authenticatorDataB64: args.assertion.authenticatorDataB64,
    clientDataJsonB64: args.assertion.clientDataJsonB64,
    signatureB64: args.assertion.signatureB64,
  };
  if (args.assertion.userHandleB64) body['userHandleB64'] = args.assertion.userHandleB64;
  const res = await authedFetch(
    new URL('/v1/writemode/activate', baseUrl()).toString(),
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    baseUrl(),
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as {
        error?: { message?: string; details?: { cause?: string } };
      };
      const base = err.error?.message;
      const cause = err.error?.details?.cause;
      if (base) msg = cause ? `${base} (${cause})` : base;
    } catch {
      /* keep generic */
    }
    throw new Error(msg);
  }
  return (await res.json()) as ActivateResponse;
}

async function signActivation(duration: DurationMin, ts: number): Promise<{
  credentialIdB64: string;
  authenticatorDataB64: string;
  clientDataJsonB64: string;
  signatureB64: string;
  userHandleB64?: string;
}> {
  if (typeof navigator === 'undefined' || !('credentials' in navigator)) {
    throw new Error('WebAuthn nicht verfuegbar in diesem Browser.');
  }
  const payload = { action: 'writemode.activate', duration, ts };
  const canonical = canonicalize(payload);
  const challengeBytes = new TextEncoder().encode(canonical);

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: toArrayBuffer(challengeBytes),
    timeout: 60_000,
    userVerification: 'required',
  };
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('User hat WebAuthn abgebrochen.');
  const assertion = credential.response as AuthenticatorAssertionResponse;

  return {
    credentialIdB64: bytesToB64Url(new Uint8Array(credential.rawId)),
    authenticatorDataB64: bytesToB64(new Uint8Array(assertion.authenticatorData)),
    clientDataJsonB64: bytesToB64(new Uint8Array(assertion.clientDataJSON)),
    signatureB64: bytesToB64(new Uint8Array(assertion.signature)),
    ...(assertion.userHandle
      ? { userHandleB64: bytesToB64(new Uint8Array(assertion.userHandle)) }
      : {}),
  };
}

export async function renderWritemodeTab(
  root: HTMLElement,
  api: ApiClient,
  session: Session,
): Promise<void> {
  let countdownTimer: number | null = null;

  function clearTimer(): void {
    if (countdownTimer !== null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  async function refresh(): Promise<void> {
    clearTimer();
    root.innerHTML = '';
    renderHeader(root, session, () => void logout(api));

    const main = document.createElement('main');
    main.className = 'writemode-tab';

    const h1 = document.createElement('h1');
    h1.textContent = 'Write-Mode';
    main.appendChild(h1);

    const card = document.createElement('section');
    card.className = 'card';

    const explain = document.createElement('p');
    explain.className = 'muted';
    explain.textContent =
      'Aktiviert fuer die gewaehlte Dauer Auto-Approve fuer reversible ' +
      'Tools (sensitivity=write). DANGER-Tools (z.B. delete, send) bleiben ' +
      'immer approval-pflichtig.';
    card.appendChild(explain);

    const timer = document.createElement('p');
    timer.className = 'wm-timer';
    timer.style.fontSize = '2rem';
    timer.style.fontVariantNumeric = 'tabular-nums';
    timer.textContent = '—';
    card.appendChild(timer);

    const buttonRow = document.createElement('div');
    buttonRow.className = 'wm-buttons';
    buttonRow.style.display = 'flex';
    buttonRow.style.gap = '0.5rem';
    buttonRow.style.marginTop = '1rem';
    card.appendChild(buttonRow);

    const status = document.createElement('p');
    status.className = 'muted';
    status.style.marginTop = '0.75rem';
    status.textContent = 'Lade Status …';
    card.appendChild(status);

    main.appendChild(card);
    root.appendChild(main);

    let data: StatusResponse;
    try {
      data = await fetchStatus();
    } catch (err) {
      if ((err as Error).message === 'unauthorized') {
        renderSessionExpired(root);
        return;
      }
      status.textContent = 'Status konnte nicht geladen werden: ' + (err as Error).message;
      return;
    }

    if (data.active && data.sessions.length > 0) {
      const sess = data.sessions[0]!;
      const expires = Number(sess.expires_at);
      const tick = (): void => {
        const ms = expires - Date.now();
        if (ms <= 0) {
          timer.textContent = '00:00';
          status.textContent = 'Abgelaufen — bitte erneut aktivieren.';
          clearTimer();
          void refresh();
          return;
        }
        const m = Math.floor(ms / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        timer.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      };
      tick();
      countdownTimer = window.setInterval(tick, 1000);
      status.textContent = 'Aktiv — reversible Schreib-Tools werden auto-approved.';

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'btn btn-reject';
      stopBtn.textContent = 'Jetzt deaktivieren';
      stopBtn.addEventListener('click', async () => {
        stopBtn.disabled = true;
        try {
          await postDeactivate();
          showToast('Write-Mode deaktiviert.', 'success');
          await refresh();
        } catch (err) {
          stopBtn.disabled = false;
          status.textContent = 'Deaktivieren fehlgeschlagen: ' + (err as Error).message;
        }
      });
      buttonRow.appendChild(stopBtn);
    } else {
      timer.textContent = 'inaktiv';
      status.textContent = 'Waehle eine Dauer, um Auto-Approve zu starten.';
      for (const opt of DURATIONS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary';
        btn.textContent = opt.label;
        btn.addEventListener('click', () => void activate(opt.duration));
        buttonRow.appendChild(btn);
      }
    }

    async function activate(duration: DurationMin): Promise<void> {
      const buttons = buttonRow.querySelectorAll('button');
      buttons.forEach((b) => ((b as HTMLButtonElement).disabled = true));
      status.textContent = 'Bestaetige am Geraet …';
      try {
        const ts = Date.now();
        const assertion = await signActivation(duration, ts);
        status.textContent = 'Aktiviere …';
        await postActivate({ duration, ts, assertion });
        showToast('Write-Mode aktiv.', 'success');
        await refresh();
      } catch (err) {
        const msg = (err as Error).message ?? 'unbekannt';
        if (msg.includes('abgebrochen') || msg.includes('NotAllowedError')) {
          status.textContent = 'Aktivierung abgebrochen.';
        } else {
          status.textContent = 'Aktivierung fehlgeschlagen: ' + msg;
        }
        buttons.forEach((b) => ((b as HTMLButtonElement).disabled = false));
      }
    }
  }

  await refresh();
}
