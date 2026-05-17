/**
 * Admin-Route: POST /v1/gateways/rediscover
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4.
 *
 * Triggert einen Live-Refresh aller Sub-MCP-Gateway-Tool-Caches + re-registriert
 * die in-memory Wrapper-Tools. Wird von der PWA Tools-Tab aufgerufen (Refresh-
 * Button), damit der User nicht auf den Cron warten + nicht approval2 neu
 * starten muss um geaenderte Sub-MCP-Tools zu sehen.
 *
 * Auth: admin-only. Wir wrappen `authMiddleware` + `adminOnly()` direkt in
 * der Route — der Pfad liegt bewusst NICHT unter `/v1/admin/*`, weil dort
 * der admin-router ein `app.use('*', adminOnly())` ohne authMiddleware-davor
 * hat (SEC-NEW-106: fail-closed-401 auf neue admin-paths bis das fix
 * landet). Eigenstaendiger Pfad → eigenstaendige Auth-Kette.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { auth as authMiddleware } from '../../middleware/auth.js';
import { adminOnly } from '../admin.js';
import {
  applyGatewayDiscovery,
  type SubMcpForwarder,
  type SubMcpRegistry,
  type SubMcpWrappersCache,
} from '../../mcp/gateway/index.js';
import type { ToolRegistry } from '../../mcp/protocol/registry.js';
import type { AppConfig } from '../../lib/config.js';

const RediscoverBody = z
  .object({
    /**
     * Optional einzelner Gateway-Name (z.B. "gws"). Sonst werden alle
     * enabled Sub-MCPs refreshed.
     */
    name: z.string().min(1).max(64).optional(),
  })
  .strict();

export interface AdminGatewayRouteDeps {
  readonly server: ServerContext;
  readonly registry: SubMcpRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly forwarder: SubMcpForwarder;
  readonly cache: SubMcpWrappersCache;
  readonly config: Pick<AppConfig, 'JWT_SECRET' | 'JWT_ISSUER'>;
  /** Override fuer Tests. */
  readonly fetchImpl?: typeof fetch;
}

export function adminGatewayRoutes(deps: AdminGatewayRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post(
    '/v1/gateways/rediscover',
    authMiddleware(deps.server, { required: true }),
    adminOnly(),
    zValidator('json', RediscoverBody.optional()),
    async (c) => {
      const body = (c.req.valid('json') ?? {}) as { name?: string };
      const applyArgs: Parameters<typeof applyGatewayDiscovery>[0] = {
        registry: deps.registry,
        toolRegistry: deps.toolRegistry,
        forwarder: deps.forwarder,
        cache: deps.cache,
        config: deps.config,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(body.name ? { only: [body.name] } : {}),
      };
      try {
        const out = await applyGatewayDiscovery(applyArgs);
        const totalTools = out.results.reduce((a, r) => a + r.count, 0);
        return c.json({
          results: out.results.map((r) => ({
            subMcpName: r.subMcpName,
            count: r.count,
            ...(r.error !== undefined ? { error: r.error } : {}),
          })),
          registered: out.registered,
          deregistered: out.deregistered,
          total_tools: totalTools,
          per_sub_mcp: Object.fromEntries(out.perSubMcp.entries()),
          skipped: out.skipped,
        });
      } catch (err) {
        throw new HttpError(
          500,
          'internal',
          `gateway rediscover failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  return app;
}
