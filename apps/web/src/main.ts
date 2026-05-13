/**
 * PWA-Entry mit Hash-Routing.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 (Roll-Out-Phasen) — Phase 4 PWA-MVP.
 *
 * Routes:
 *   #/login          — anonyme Login-Page (Google-OAuth-Redirect)
 *   #/approvals      — Pending-Approval-Liste (auth required)
 *   #/credentials    — Credential-Management (auth required)
 *   #/enroll-passkey — Bootstrap nach erstem Google-Login (auth required)
 *
 * Session-Detection: `loadSession()` probet `/auth/refresh` und cached den
 * Output bis zum naechsten `clearSessionCache()`. Bei 401 → Login-Redirect.
 */
import { createApiClient } from './api.js';
import type { ApiClient, Session } from './api.js';
import {
  loadSession,
  renderLogin,
  renderEnrollPasskey,
  renderSessionExpired,
} from './auth.js';
import { renderApproval, stopApprovalPolling } from './approval.js';
import { renderCredentials } from './credentials.js';

const api: ApiClient = createApiClient();

type Route = 'login' | 'approvals' | 'credentials' | 'enroll-passkey';

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('login')) return 'login';
  if (hash.startsWith('credentials')) return 'credentials';
  if (hash.startsWith('enroll-passkey')) return 'enroll-passkey';
  return 'approvals';
}

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) {
    console.error('mcp-approval2: #app root missing in DOM');
    return;
  }

  // Reset any polling timers from previous routes
  stopApprovalPolling();

  const route = parseRoute();

  // Login is public — no session probe needed
  if (route === 'login') {
    renderLogin(root);
    return;
  }

  // All other routes require a session
  const session = await loadSession(api);
  if (!session) {
    renderLogin(root);
    return;
  }

  switch (route) {
    case 'enroll-passkey':
      renderEnrollPasskey(root, api, session, () => {
        window.location.hash = '#/approvals';
      });
      return;
    case 'credentials':
      await renderCredentialsSafe(root, api, session);
      return;
    case 'approvals':
    default:
      await renderApprovalSafe(root, api, session);
      return;
  }
}

async function renderApprovalSafe(root: HTMLElement, c: ApiClient, s: Session): Promise<void> {
  try {
    await renderApproval(root, c, s);
  } catch (err) {
    console.error('approval render failed', err);
    renderSessionExpired(root);
  }
}

async function renderCredentialsSafe(root: HTMLElement, c: ApiClient, s: Session): Promise<void> {
  try {
    await renderCredentials(root, c, s);
  } catch (err) {
    console.error('credentials render failed', err);
    renderSessionExpired(root);
  }
}

window.addEventListener('hashchange', () => void boot());
window.addEventListener('DOMContentLoaded', () => void boot());

// In case the script is loaded after DOMContentLoaded already fired
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  void boot();
}
