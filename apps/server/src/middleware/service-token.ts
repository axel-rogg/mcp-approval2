/**
 * Service-Token-Middleware fuer `/internal/v1/*`-Routen.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1 (Service-to-Service-Auth),
 *           ADR-0001 (DEK-Resolution-Strategy / DEK-Resolve-Endpoint).
 *
 * Bestimmung: stoppen aller Requests die nicht den pre-shared
 * `MCP_APPROVAL_INTERNAL_TOKEN` mitliefern. Vorgesehene Callers:
 *   - mcp-knowledge2 (DEK-resolve)
 *   - kuenftige first-party services
 *
 * Akzeptierte Header (in Pruefreihenfolge):
 *   1. `X-Service-Token: <plain>`
 *   2. `Authorization: Bearer <plain>`
 *
 * Vergleich constant-time per `crypto.timingSafeEqual` — kein Early-Return
 * auf Laenge-Mismatch, sondern padded compare. Falsch-Token → 401 mit
 * minimaler Info (kein Echo des praesentierten Werts).
 *
 * Audit: jeder Aufruf erzeugt einen audit-event (`service_token.verified`
 * success | failure). Caller koennen den `actorService`-Tag im Body
 * mitliefern (z.B. via X-Service-Name); hier ist es opaque ein
 * `unknown`-fallback.
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { emitAudit } from '../services/audit.js';

export interface ServiceTokenOptions {
  readonly server: ServerContext;
  /** Pre-shared token. Wird gegen den eingehenden Header verglichen. */
  readonly expectedToken: string;
}

/**
 * Constant-time string compare. Niemals true bei Laengen-Mismatch — wir
 * vergleichen aber trotzdem padded ueber `expected` damit kein Timing-
 * Channel den genauen Mismatch-Punkt verraet.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  // Beide Buffer auf gleiche Laenge bringen (laengeren als Referenz).
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  // Pad to the longer length so timingSafeEqual is happy. We still return
  // false on length-mismatch.
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const eq = timingSafeEqual(aPad, bPad);
  return eq && aBuf.length === bBuf.length;
}

function extractToken(c: Context): string | null {
  const xs = c.req.header('x-service-token');
  if (xs && xs.length > 0) return xs;
  const auth = c.req.header('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    const v = auth.slice(7).trim();
    if (v.length > 0) return v;
  }
  return null;
}

/**
 * Hono-Middleware-Factory. Mounten auf `/internal/v1/*`-Subtree.
 */
export function serviceTokenMiddleware(
  opts: ServiceTokenOptions,
): MiddlewareHandler<AppBindings> {
  if (!opts.expectedToken || opts.expectedToken.length === 0) {
    throw new Error('serviceTokenMiddleware: expectedToken required (set MCP_APPROVAL_INTERNAL_TOKEN)');
  }
  if (opts.expectedToken.length < 32) {
    throw new Error('serviceTokenMiddleware: expectedToken must be >= 32 chars');
  }
  const expected = opts.expectedToken;
  const server = opts.server;

  return async (c, next: Next) => {
    const presented = extractToken(c);
    const requestId = c.get('requestId') ?? undefined;
    if (presented === null) {
      await emitAudit(server.db, {
        action: 'service_token.verified',
        actorUserId: null,
        result: 'failure',
        ...(requestId ? { requestId } : {}),
        details: { reason: 'missing_token', path: c.req.path },
      });
      throw HttpError.unauthorized('service token required');
    }
    if (!constantTimeEqual(presented, expected)) {
      await emitAudit(server.db, {
        action: 'service_token.verified',
        actorUserId: null,
        result: 'failure',
        ...(requestId ? { requestId } : {}),
        details: { reason: 'invalid_token', path: c.req.path },
      });
      throw HttpError.unauthorized('invalid service token');
    }
    await emitAudit(server.db, {
      action: 'service_token.verified',
      actorUserId: null,
      result: 'success',
      ...(requestId ? { requestId } : {}),
      details: { path: c.req.path },
    });
    return next();
  };
}
