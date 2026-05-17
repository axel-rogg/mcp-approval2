/**
 * Hono-Context-Types.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3 (Identity), §7 (Storage).
 *
 * `Variables` enthaelt was Middleware via `c.set()` schreibt. Pflicht-Felder:
 *   - `requestId` — Audit-Korrelation, von request-id-Middleware gesetzt.
 *   - `user` — von auth-Middleware gesetzt (nur bei protected routes).
 */
import type { AppConfig } from './config.js';
import type { DbAdapter } from '@mcp-approval2/adapters';

export interface SessionPrincipal {
  readonly userId: string;
  readonly email: string;
  readonly role: 'admin' | 'member';
  readonly sessionId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface AppBindings {
  Variables: {
    requestId: string;
    user?: SessionPrincipal;
  };
}

/**
 * Server-Singletons, die ueber alle Requests geteilt werden.
 *
 * In Tests koennen wir ein Mock-Set bauen + mit `app.use((c, next) => { c.env =
 * stubs; return next(); })` injecten.
 */
export interface ServerContext {
  readonly config: AppConfig;
  readonly db: DbAdapter;
  /**
   * Optionaler EmailAdapter — wenn ungesetzt, fallen Invite/Recovery-Flows
   * auf "return token in API response" (Dev-Mode) zurueck. Production: muss
   * gesetzt sein (Console- oder Resend-Adapter, je nach Config).
   */
  readonly email?: import('@mcp-approval2/adapters').EmailAdapter;
}
