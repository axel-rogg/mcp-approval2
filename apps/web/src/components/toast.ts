/**
 * Toast-Notification-Helper — minimal, ephemeral status messages.
 *
 * Auto-dismiss after `ttlMs` (default 3000). Stacks vertikal in einem
 * fixed-position-Container am unteren Bildschirmrand (mobile-friendly).
 * Kein Framework — pure DOM + ein Singleton-Host der lazy angelegt wird.
 *
 * Verwendet von: approval-decision, defaults-tab, credentials. Importierbar
 * aus jeder View als reine UI-Helper ohne State.
 */

export type ToastKind = 'info' | 'success' | 'error';

const HOST_ID = 'toast-host';
const DEFAULT_TTL_MS = 3_000;

function ensureHost(): HTMLElement {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

export interface ShowToastOptions {
  readonly ttlMs?: number;
}

export function showToast(
  message: string,
  kind: ToastKind = 'info',
  opts: ShowToastOptions = {},
): void {
  const host = ensureHost();
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);

  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add('toast-leaving');
    window.setTimeout(() => {
      if (el.isConnected) el.remove();
    }, 200);
  };
  el.addEventListener('click', dismiss);
  window.setTimeout(dismiss, ttl);
}
