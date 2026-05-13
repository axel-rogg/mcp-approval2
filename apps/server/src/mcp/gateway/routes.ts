/**
 * Sub-MCP-Gateway-internal Routen.
 *
 *   POST /internal/v1/sub-mcp/discover  — Cron-Trigger fuer Tool-Cache-Refresh.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9.
 *
 * Auth: Service-Account-Bearer im `Authorization`-Header, validiert gegen
 * `INTERNAL_API_TOKEN_HASH` aus dem ServerContext. Wir wollen NICHT, dass
 * jeder authentifizierte User Discovery triggern kann — das ist eine
 * Maintenance-Operation.
 *
 * Anmerkung: Falls `INTERNAL_API_TOKEN_HASH` nicht konfiguriert ist (Pre-Phase-5),
 * akzeptieren wir den Endpoint nur bei NODE_ENV=test (sonst 503).
 */
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import type { SubMcpRegistry } from './registry.js';
import { refreshSubMcpToolCache } from './discovery.js';

export interface SubMcpDiscoverRouteDeps {
  readonly server: ServerContext;
  readonly registry: SubMcpRegistry;
  /** Optional: SHA-256-Hex des Service-Tokens. Wenn nicht gesetzt → endpoint ist nur in Tests aktiv. */
  readonly internalTokenHash?: string;
  /** Override-Hook fuer Tests. */
  readonly fetchImpl?: typeof fetch;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function subMcpDiscoverRoutes(deps: SubMcpDiscoverRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const isTest = deps.server.config.NODE_ENV === 'test';

  app.post('/internal/v1/sub-mcp/discover', async (c) => {
    const expectedHash = deps.internalTokenHash;
    if (!expectedHash) {
      if (!isTest) throw HttpError.forbidden('internal endpoint not configured');
    } else {
      const auth = c.req.header('authorization') ?? '';
      if (!auth.toLowerCase().startsWith('bearer ')) {
        throw HttpError.unauthorized('bearer required');
      }
      const presented = auth.slice(7).trim();
      const presentedHash = createHash('sha256').update(presented).digest('hex');
      if (!constantTimeEqualHex(presentedHash, expectedHash)) {
        throw HttpError.unauthorized('invalid internal token');
      }
    }

    let only: ReadonlyArray<string> | undefined;
    try {
      const body = (await c.req.json().catch(() => ({}))) as { only?: unknown };
      if (Array.isArray(body.only)) {
        only = body.only.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      only = undefined;
    }

    const refreshArgs: Parameters<typeof refreshSubMcpToolCache>[0] = {
      registry: deps.registry,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(only ? { only } : {}),
    };
    const results = await refreshSubMcpToolCache(refreshArgs);
    return c.json({ refreshed: results });
  });

  return app;
}
