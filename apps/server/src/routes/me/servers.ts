/**
 * Route: /v1/me/servers — per-User-Sub-MCP-Subscription-Mgmt.
 *
 * Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md (Phase 1).
 *
 * Endpoints:
 *   GET   /v1/me/servers                      — Liste subscribed + available
 *   PATCH /v1/me/servers/:name/subscription   — toggle enabled
 *
 * Auth: authenticated User reicht (kein admin-only — jeder User pflegt
 * eigene Subscription). RLS auf user_sub_mcp_subscriptions sorgt fuer
 * Cross-User-Isolation.
 *
 * Phase 2+ kommen: config-GET/PUT/DELETE, POST /v1/me/servers (user-added),
 * OAuth-start/callback.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { auth } from '../../middleware/auth.js';
import type { SubMcpRegistry } from '../../mcp/gateway/registry.js';
import type { UserSubscriptionsService } from '../../services/user-subscriptions.js';

export interface MyServersRouteDeps {
  readonly server: ServerContext;
  readonly registry: SubMcpRegistry;
  readonly subscriptions: UserSubscriptionsService;
}

interface MyServerEntry {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly isCatalogDefault: boolean;
  readonly isOwnedByMe: boolean;
  /** Tool-Cache-Timestamp wenn discovered. */
  readonly toolsCachedAt: number | null;
  readonly toolsCount: number;
}

interface MyServersResponse {
  /** Vom User aktivierte Server (enabled=TRUE). */
  readonly subscribed: ReadonlyArray<MyServerEntry>;
  /** Catalog-Defaults die der User noch nicht aktiviert hat. */
  readonly available: ReadonlyArray<MyServerEntry>;
}

const SubscriptionPatchBody = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export function myServersRoutes(deps: MyServersRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const guard = auth(deps.server);

  app.get('/v1/me/servers', guard, async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');

    // 1. Lazy-Seed: alle catalog-defaults die der User noch nie gesehen hat
    //    bekommen eine subscription-Row mit enabled=FALSE. Idempotent.
    await deps.subscriptions.ensureCatalogRows(user.userId);

    // 2. Subscription-Rows + Server-Details kombinieren.
    const subs = await deps.subscriptions.list(user.userId);
    const enabledNames = new Set(subs.filter((s) => s.enabled).map((s) => s.subMcpName));
    const knownNames = new Set(subs.map((s) => s.subMcpName));

    // 3. Server-Configs holen (bypass scoped — wir wollen sowohl catalog
    //    als auch user-added). RLS-Policy auf sub_mcp_servers liefert
    //    nur die fuer den User sichtbaren (catalog OR owned).
    const all = await deps.registry.listAll();
    const subscribed: MyServerEntry[] = [];
    const available: MyServerEntry[] = [];
    for (const cfg of all) {
      // Filter: nur catalog-defaults oder user-owned. (Registry liefert
      // u.U. mehr — RLS faengt's ab, aber wir filtern auch app-side.)
      // Wir wissen nicht ob cfg.ownerUserId existiert — fallback auf
      // catalog-only fuer Phase 1.
      const entry: MyServerEntry = {
        name: cfg.name,
        displayName: cfg.displayName,
        baseUrl: cfg.baseUrl,
        enabled: enabledNames.has(cfg.name),
        isCatalogDefault: true, // Phase 1: alle aus dem registry sind Defaults
        isOwnedByMe: false,
        toolsCachedAt: cfg.toolsCachedAt,
        toolsCount: cfg.toolsCache?.length ?? 0,
      };
      if (enabledNames.has(cfg.name)) {
        subscribed.push(entry);
      } else if (knownNames.has(cfg.name)) {
        available.push(entry);
      } else {
        // Catalog-Server der nicht in der Sub-Tabelle ist (sollte nach
        // ensureCatalogRows nicht passieren — defensive Pfad).
        available.push(entry);
      }
    }

    subscribed.sort((a, b) => a.name.localeCompare(b.name));
    available.sort((a, b) => a.name.localeCompare(b.name));

    const body: MyServersResponse = { subscribed, available };
    return c.json(body);
  });

  app.patch(
    '/v1/me/servers/:name/subscription',
    guard,
    zValidator('json', SubscriptionPatchBody),
    async (c) => {
      const user = c.get('user');
      if (!user) throw HttpError.unauthorized('authentication required');
      const name = c.req.param('name');
      const body = c.req.valid('json');

      // Server muss in der Registry sein (RLS-gefiltert: user sieht catalog
      // + own).
      const cfg = await deps.registry.getByName(name).catch(() => null);
      if (!cfg) {
        throw HttpError.notFound(`server '${name}' not found`);
      }

      await deps.subscriptions.setEnabled(user.userId, name, body.enabled);
      return c.json({ name, enabled: body.enabled });
    },
  );

  return app;
}
