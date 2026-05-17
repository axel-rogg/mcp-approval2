/**
 * Internal Servers-Import-Endpoint (One-Shot Migration v1 → v2).
 *
 *   POST /internal/v1/servers/import
 *
 * Service-Token-Auth (X-Service-Token-Header).
 *
 * Use-Case: Migration der v1 sub_mcp_servers + gateway_oauth_tokens-Metadaten
 * (cf, github) zu v2 sub_mcp_servers + user_sub_mcp_config. Refresh-Tokens
 * werden NICHT migriert (KMS-encrypted mit V1-KEK, Cross-Runtime-Decrypt
 * out-of-scope). User klickt nach Import in V2 einmal "Authorize" pro Server.
 *
 * Body:
 *   {
 *     userEmail: string,
 *     servers: Array<{
 *       name: string,            // 'github', 'cf'
 *       displayName: string,
 *       baseUrl: string,
 *       authMode: 'oauth',
 *       oauth: {
 *         provider: string,      // 'github' | 'cloudflare'
 *         kind: 'pre' | 'dcr',
 *         authorize_url: string,
 *         token_url: string,
 *         scopes: string[],
 *         client_id: string,     // OAuth-App ID (semi-public, NOT secret)
 *       }
 *     }>
 *   }
 *
 * Response: {
 *   imported: Array<{ name: string }>,
 *   errors:   Array<{ name: string, message: string }>,
 * }
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import type { SubMcpRegistry } from '../../mcp/gateway/registry.js';
import type { UserSubscriptionsService } from '../../services/user-subscriptions.js';
import type { UserServerConfigService } from '../../services/user-server-config.js';
import { findUserByEmail } from '../../services/user.js';
import { emitAudit } from '../../services/audit.js';

export interface InternalServersImportDeps {
  readonly server: ServerContext;
  readonly registry: SubMcpRegistry;
  readonly subscriptions: UserSubscriptionsService;
  /**
   * Optional config-svc — wenn vorhanden, importer schreibt _oauth_client_id
   * in user_sub_mcp_config (KMS-encrypted). Wenn nicht: nur das Server-Row
   * wird angelegt, User muss Client-ID manuell ergaenzen.
   */
  readonly config?: UserServerConfigService;
}

const ServerPayloadSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]{0,63}$/),
  displayName: z.string().min(1).max(128),
  baseUrl: z.string().url().refine((v) => v.startsWith('https://'), 'baseUrl muss https:// sein'),
  authMode: z.literal('oauth'),
  oauth: z.object({
    provider: z.string().min(1).max(64),
    kind: z.enum(['pre', 'dcr']).default('pre'),
    authorize_url: z.string().url(),
    token_url: z.string().url(),
    scopes: z.array(z.string()).default([]),
    client_id: z.string().min(1).max(256).optional(),
  }),
});

const ImportBodySchema = z.object({
  userEmail: z.string().email(),
  servers: z.array(ServerPayloadSchema).min(1).max(20),
});

export function internalServersImportRoutes(
  deps: InternalServersImportDeps,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.post(
    '/internal/v1/servers/import',
    zValidator('json', ImportBodySchema),
    async (c) => {
      const body = c.req.valid('json');
      const user = await findUserByEmail(deps.server.db, body.userEmail);
      if (!user) {
        throw HttpError.notFound(`user '${body.userEmail}' not found`);
      }

      const imported: Array<{ name: string }> = [];
      const errors: Array<{ name: string; message: string }> = [];

      for (const s of body.servers) {
        try {
          // Idempotent: register wenn neu, sonst Metadaten-Refresh.
          let cfgId: string;
          const existing = await deps.registry.getByName(s.name).catch(() => null);
          if (existing) {
            // Catalog-Default ist NICHT user-owned und nicht ueberschreibbar.
            if (!existing.ownerUserId || existing.ownerUserId !== user.id) {
              errors.push({
                name: s.name,
                message: `server '${s.name}' exists as catalog-default or belongs to another user`,
              });
              continue;
            }
            cfgId = existing.id;
            // Update der configSchema (OAuth-Metadaten) bei Re-Import.
          } else {
            const cfg = await deps.registry.register({
              name: s.name,
              displayName: s.displayName,
              baseUrl: s.baseUrl,
              authMode: s.authMode,
              authConfig: {},
              enabled: true,
              ownerUserId: user.id,
            });
            cfgId = cfg.id;
          }

          // configSchema._meta.oauth persistieren (idempotent — overwrite OK)
          if (deps.registry.updateConfigSchema) {
            const meta = {
              oauth: {
                provider: s.oauth.provider,
                kind: s.oauth.kind,
                authorize_url: s.oauth.authorize_url,
                token_url: s.oauth.token_url,
                scopes: s.oauth.scopes,
              },
            };
            await deps.registry.updateConfigSchema(cfgId, meta);
          }

          // Client-ID in user_sub_mcp_config schreiben (wenn vorhanden + KMS-fähig)
          if (s.oauth.client_id && deps.config) {
            await deps.config.set(user.id, s.name, '_oauth_client_id', s.oauth.client_id);
          }

          // Auto-Subscribe damit Server in der subscribed-Liste erscheint
          await deps.subscriptions.setEnabled(user.id, s.name, true);

          imported.push({ name: s.name });

          await emitAudit(deps.server.db, {
            action: 'admin.servers.import',
            actorUserId: user.id,
            result: 'success',
            details: {
              server_name: s.name,
              base_url: s.baseUrl,
              auth_mode: s.authMode,
              has_client_id: !!s.oauth.client_id,
              source: 'service-token',
            },
          });
        } catch (err) {
          errors.push({
            name: s.name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return c.json({ imported, errors });
    },
  );
  return app;
}
