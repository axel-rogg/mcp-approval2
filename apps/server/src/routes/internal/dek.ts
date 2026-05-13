/**
 * Internal DEK-Resolve-Endpoint — Cross-Service-Bridge fuer mcp-knowledge2.
 *
 *   POST /internal/v1/dek/resolve
 *
 * Plan-Ref: ADR-0001 (DEK-Resolution-Strategy, Variant B). mcp-knowledge2
 *           callt diesen Endpoint pro decrypt-Operation; access wird per
 *           pre-shared `MCP_APPROVAL_INTERNAL_TOKEN` autorisiert (Service-
 *           Token-Middleware ist auf dem ganzen `/internal/v1`-Subtree
 *           gemounted).
 *
 * Contract:
 *   Headers:
 *     Authorization: Bearer <MCP_APPROVAL_INTERNAL_TOKEN>
 *       (oder X-Service-Token; both accepted by the middleware)
 *     X-Request-Id:  <uuid>  (optional; wird durchgereicht)
 *   Body:
 *     { "user_id": "<uuid>" }
 *   Response 200:
 *     { "dek_b64": "<base64-32-bytes>" }
 *   Errors:
 *     401  — invalid/missing service token (von Middleware geworfen)
 *     400  — invalid body
 *     500  — KEK/Vault unavailable, etc.
 *
 * Logging-Disziplin:
 *   - NIE den DEK loggen (auch nicht b64).
 *   - Audit-Event `dek.resolved` (via DekService) +
 *     `dek.resolved.gateway` (hier) mit user_id + request_id + result.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import type { DekService } from '../../services/dek.js';
import { emitAudit } from '../../services/audit.js';

export interface InternalDekRouteDeps {
  readonly server: ServerContext;
  readonly dek: DekService;
}

const ResolveBodySchema = z.object({
  user_id: z.string().uuid('user_id must be a UUID'),
});

export function internalDekRoutes(deps: InternalDekRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const { server, dek } = deps;

  app.post('/internal/v1/dek/resolve', zValidator('json', ResolveBodySchema), async (c) => {
    const body = c.req.valid('json');
    // request-id middleware sets c.var.requestId. Caller may also pass it
    // via X-Request-Id — prefer the explicit header so cross-service
    // correlation works.
    const reqIdHeader = c.req.header('x-request-id');
    const requestId = reqIdHeader && reqIdHeader.length > 0 ? reqIdHeader : c.get('requestId');

    try {
      const dekArgs: { userId: string; requestId?: string } = {
        userId: body.user_id,
      };
      if (requestId) dekArgs.requestId = requestId;
      const dekBytes = await dek.resolveUserDek(dekArgs);

      // Convert to base64 WITHOUT logging the intermediate. We touch the
      // bytes for the smallest possible window: convert → drop reference.
      const dekB64 = bytesToBase64(dekBytes);

      // Audit (no DEK material).
      await emitAudit(server.db, {
        action: 'dek.resolved.gateway',
        actorUserId: body.user_id,
        result: 'success',
        ...(requestId ? { requestId } : {}),
        details: { caller: 'internal' },
      });

      return c.json({ dek_b64: dekB64 });
    } catch (err) {
      await emitAudit(server.db, {
        action: 'dek.resolved.gateway',
        actorUserId: body.user_id,
        result: 'failure',
        ...(requestId ? { requestId } : {}),
        details: { caller: 'internal', error: errorMessage(err) },
      });
      throw err;
    }
  });

  return app;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
