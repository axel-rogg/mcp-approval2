/**
 * PWA-Entry. Routet zwischen Login + Approval-Queue basierend auf Session.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (PWA-Approval-Flow).
 *
 * Skeleton-Scope (Burst-3):
 *   - Login-Page: "Sign in with Google" → window.location auf /auth/google/start
 *   - Approval-View: zeigt pending approval-requests aus /v1/approvals/pending
 *     (TODO: Backend-Endpoint existiert noch nicht — stubbed)
 *   - WebAuthn-Sign-Off: ruft navigator.credentials.get() mit PRF-Extension
 *     (TODO: full flow), schickt assertion an /v1/approvals/:id/sign
 *
 * Was hier nicht passiert:
 *   - Echte Approval-DB-Persistence (Backend muss `approval_requests` Table +
 *     Routes liefern — siehe docs/STATUS.md).
 *   - Push-Notifications via Web-Push (Phase 5+).
 *   - Reaktiver UI-Framework — bewusst vanilla TS gehalten, damit der Skeleton
 *     unkompliziert bleibt. Bei mehr Komplexitaet auf Solid / Preact-Signals
 *     umstellen.
 */
import { isAuthenticated, renderLogin } from './auth.js';
import { renderApproval } from './approval.js';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) {
    // eslint-disable-next-line no-console
    console.error('mcp-approval2: #app root missing in DOM');
    return;
  }
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('login') || !isAuthenticated()) {
    renderLogin(root);
    return;
  }
  // Default: Approval-Queue.
  void renderApproval(root);
}

window.addEventListener('hashchange', boot);
boot();
