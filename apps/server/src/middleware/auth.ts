/**
 * Auth-Middleware.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.5 (Session-Management).
 *
 * Validiert das Session-JWT aus `Authorization: Bearer <token>`. Bei Erfolg
 * setzt `c.set('user', principal)`.
 *
 * Revocation-Check: Wir laden hier KEINE DB-Row (Performance). Statt dessen
 * pflegen wir die `revoked_jtis`-Tabelle und ein optionaler Bloom-Filter-
 * Service kann das in-memory cachen. Phase 1: minimal mit DB-Lookup ueber
 * `services/sessions` — TODO wird unten als optional-Param gefuehrt.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppBindings, ServerContext, SessionPrincipal } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { verifySessionJwt } from '../auth/session/issuer.js';

export interface AuthOptions {
  readonly required?: boolean;
  readonly roles?: ReadonlyArray<'admin' | 'member'>;
  /** Optional callback to check if `jti` is revoked (returns true if revoked). */
  readonly isJtiRevoked?: (jti: string) => Promise<boolean>;
}

export function auth(server: ServerContext, opts: AuthOptions = {}): MiddlewareHandler<AppBindings> {
  const required = opts.required !== false;
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      if (!required) {
        await next();
        return;
      }
      throw HttpError.unauthorized('missing bearer token');
    }
    const token = header.slice(7).trim();
    if (!token) throw HttpError.unauthorized('empty bearer token');

    let principal: SessionPrincipal;
    try {
      principal = await verifySessionJwt(token, server.config);
    } catch (err) {
      throw HttpError.unauthorized('invalid bearer token', {
        cause: err instanceof Error ? err.message : 'unknown',
      });
    }

    if (opts.isJtiRevoked) {
      const revoked = await opts.isJtiRevoked(principal.sessionId);
      if (revoked) throw HttpError.unauthorized('session revoked', { jti: principal.sessionId });
    }

    if (opts.roles && opts.roles.length > 0 && !opts.roles.includes(principal.role)) {
      throw HttpError.forbidden('insufficient role', {
        required: opts.roles,
        actual: principal.role,
      });
    }

    c.set('user', principal);
    await next();
  };
}

/** Convenience: require admin role. */
export function requireAdmin(server: ServerContext): MiddlewareHandler<AppBindings> {
  return auth(server, { required: true, roles: ['admin'] });
}
