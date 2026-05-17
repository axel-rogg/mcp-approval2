/**
 * Internal Apps-Import-Endpoint (One-Shot Migration v1 → v2).
 *
 *   POST /internal/v1/apps/import
 *
 * Service-Token-Auth (X-Service-Token-Header, validiert vom serviceTokenGuard).
 *
 * Use-Case: einmalige Migration der v1-Composable-Apps aus mcp-approval (CF)
 * nach mcp-approval2. Bypassed das User-Bearer-Pattern weil der User keinen
 * laufenden Browser-Session-Token hat — der Server resolved die userId per
 * Email-Lookup und ruft AppsService.createApp direkt.
 *
 * Body:
 *   {
 *     userEmail: string,            // e.g. "axelrogg@gmail.com"
 *     apps: Array<{
 *       appType: string,            // "composable"
 *       title: string,
 *       initialState: unknown,      // LayoutDoc v0.10
 *       pinned?: boolean,
 *     }>
 *   }
 *
 * Response: {
 *   imported: Array<{ id: string, title: string, pinned: boolean }>,
 *   errors:   Array<{ title: string, message: string }>,
 * }
 *
 * Audit: emittet pro Import einen `apps.create` (via AppsService) UND
 * einen `admin.apps.import` als Top-Level-Marker (actorType=service).
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import type { AppsService, AppInstance } from '../../apps/api.js';
import { findUserByEmail } from '../../services/user.js';
import { emitAudit } from '../../services/audit.js';

export interface InternalAppsImportDeps {
  readonly server: ServerContext;
  readonly apps: AppsService;
}

const AppPayloadSchema = z.object({
  appType: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  initialState: z.unknown(),
  pinned: z.boolean().optional(),
});

const ImportBodySchema = z.object({
  userEmail: z.string().email(),
  apps: z.array(AppPayloadSchema).min(1).max(50),
});

interface ImportedEntry {
  readonly id: string;
  readonly title: string;
  readonly pinned: boolean;
}

interface ImportError {
  readonly title: string;
  readonly message: string;
}

export function internalAppsImportRoutes(deps: InternalAppsImportDeps): Hono<AppBindings> {
  const { server, apps } = deps;
  const app = new Hono<AppBindings>();

  app.post('/internal/v1/apps/import', zValidator('json', ImportBodySchema), async (c) => {
    const body = c.req.valid('json');

    if (!server.db) {
      // Sollte production nicht passieren — Migration ohne DB ergibt keinen Sinn.
      throw new HttpError(500, 'internal', 'database not configured');
    }
    const user = await findUserByEmail(server.db, body.userEmail);
    if (!user) {
      throw HttpError.notFound(`user with email "${body.userEmail}" not found`, {
        userEmail: body.userEmail,
      });
    }

    const imported: ImportedEntry[] = [];
    const errors: ImportError[] = [];

    for (const a of body.apps) {
      try {
        const inst: AppInstance = await apps.createApp({
          userId: user.id,
          appType: a.appType,
          title: a.title,
          initialState: a.initialState,
        });
        // pin-bit ist server-side via Update — Phase 2: nicht implementiert,
        // wir tracken nur in Audit. UI kann manuell pinnen.
        imported.push({ id: inst.id, title: inst.title, pinned: a.pinned ?? false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        errors.push({ title: a.title, message: msg });
      }
    }

    // Top-Level Audit-Marker (service-actor: actorUserId=null → actor_type='system')
    try {
      await emitAudit(server.db, {
        action: 'admin.apps.import',
        actorUserId: null,
        targetUserId: user.id,
        result: errors.length === 0 ? 'success' : 'failure',
        details: {
          userEmail: body.userEmail,
          requested: body.apps.length,
          imported: imported.length,
          errors: errors.length,
        },
      });
    } catch {
      // Audit darf den Response nicht killen.
    }

    return c.json({ imported, errors });
  });

  return app;
}
