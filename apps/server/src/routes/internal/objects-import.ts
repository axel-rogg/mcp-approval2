/**
 * Internal Objects-Import-Endpoint (Generic v1 → v2 Migration).
 *
 *   POST /internal/v1/objects/import
 *
 * Service-Token-Auth (X-Service-Token-Header, serviceTokenGuard).
 *
 * Generischer Bruder von /internal/v1/apps/import — fuer alles was kein
 * App ist: Memos (subtype='memo' + meta.scope), Docs (subtype='doc' +
 * meta.mime_type), Notes, Bookmarks. Schreibt direkt via KnowledgeService.
 * createObject — kein typedef-validation wie bei AppsService.
 *
 * Body:
 *   {
 *     userEmail: string,
 *     objects: Array<{
 *       subtype: string,            // 'memo' | 'doc' | 'note' | 'bookmark' | ...
 *       title: string,
 *       description?: string,
 *       body: string,               // utf-8 plain text (kein base64)
 *       mimeType?: string,          // default 'text/plain'
 *       meta?: Record<string, unknown>,
 *       keywords?: ReadonlyArray<string>,
 *     }>
 *   }
 *
 * Schritt-fuer-Schritt-Verhalten pro Object:
 *   1. UserSync push (best-effort, dedup'd via knowledge2-side-cache)
 *   2. knowledge.createObject mit synthetic approval_id (K-D4)
 *   3. Audit per Item
 *
 * Top-Level-Audit: admin.objects.import mit Counts.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import type { KnowledgeService } from '../../services/knowledge.js';
import { findUserByEmail } from '../../services/user.js';
import { emitAudit } from '../../services/audit.js';
import {
  syncArgsFromUser,
  type UserSyncService,
} from '../../services/user-sync.js';

export interface InternalObjectsImportDeps {
  readonly server: ServerContext;
  readonly knowledge: KnowledgeService;
  readonly userSync?: UserSyncService;
}

const ObjectPayloadSchema = z.object({
  subtype: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  body: z.string().min(1).max(1_000_000),
  mimeType: z.string().min(1).max(128).optional(),
  meta: z.record(z.unknown()).optional(),
  keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
});

const ImportBodySchema = z.object({
  userEmail: z.string().email(),
  objects: z.array(ObjectPayloadSchema).min(1).max(100),
});

interface ImportedEntry {
  readonly id: string;
  readonly title: string;
  readonly subtype: string;
}

interface ImportError {
  readonly title: string;
  readonly subtype: string;
  readonly message: string;
}

const enc = new TextEncoder();

export function internalObjectsImportRoutes(
  deps: InternalObjectsImportDeps,
): Hono<AppBindings> {
  const { server, knowledge, userSync } = deps;
  const app = new Hono<AppBindings>();

  app.post('/internal/v1/objects/import', zValidator('json', ImportBodySchema), async (c) => {
    const body = c.req.valid('json');

    if (!server.db) {
      throw new HttpError(500, 'internal', 'database not configured');
    }
    const user = await findUserByEmail(server.db, body.userEmail);
    if (!user) {
      throw HttpError.notFound(`user with email "${body.userEmail}" not found`, {
        userEmail: body.userEmail,
      });
    }

    // User-Sync (idempotent + KC2-cached). Wichtig fuer first-run.
    if (userSync) {
      try {
        await userSync.push(
          syncArgsFromUser({
            id: user.id,
            email: user.email,
            displayName: user.displayName ?? user.email,
            status:
              user.status === 'active' ||
              user.status === 'invited' ||
              user.status === 'suspended'
                ? user.status
                : 'active',
            externalId: user.externalId,
          }),
        );
      } catch {
        // user-sync hat selbst audit emitted
      }
    }

    const imported: ImportedEntry[] = [];
    const errors: ImportError[] = [];

    for (const o of body.objects) {
      try {
        const bodyBytes = enc.encode(o.body);
        const created = await knowledge.createObject({
          userId: user.id,
          userEmail: user.email,
          approvalId: randomUUID(),
          subtype: o.subtype,
          title: o.title,
          ...(o.description !== undefined ? { description: o.description } : {}),
          ...(o.keywords !== undefined ? { keywords: o.keywords } : {}),
          ...(o.meta !== undefined ? { meta: o.meta } : {}),
          body: bodyBytes,
          mimeType: o.mimeType ?? 'text/plain',
        });
        imported.push({ id: created.id, title: o.title, subtype: o.subtype });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        errors.push({ title: o.title, subtype: o.subtype, message: msg });
      }
    }

    try {
      await emitAudit(server.db, {
        action: 'admin.objects.import',
        actorUserId: null,
        targetUserId: user.id,
        result: errors.length === 0 ? 'success' : 'failure',
        details: {
          userEmail: body.userEmail,
          requested: body.objects.length,
          imported: imported.length,
          errors: errors.length,
        },
      });
    } catch {
      // audit fail soll response nicht killen
    }

    return c.json({ imported, errors });
  });

  return app;
}
