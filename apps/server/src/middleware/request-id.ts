/**
 * Request-ID-Middleware.
 *
 * Setzt pro Request eine UUID in `c.var.requestId`, echoed sie als
 * `X-Request-Id`-Header. Nuetzlich fuer Audit-Korrelation (PLAN §6).
 */
import type { MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AppBindings } from '../lib/context.js';

export function requestId(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const id = incoming && /^[A-Za-z0-9_-]{6,128}$/.test(incoming) ? incoming : randomUUID();
    c.set('requestId', id);
    c.header('X-Request-Id', id);
    await next();
  };
}
