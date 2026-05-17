/**
 * Internal Refs-Import-Endpoint (v1 → v2 Migration).
 *
 *   POST /internal/v1/refs/import
 *
 * Service-Token-Auth (X-Service-Token-Header, serviceTokenGuard).
 *
 * Used by `scripts/migrate-v1-refs.mjs` to re-create knowledge-graph refs
 * after v1-objects have been imported via `/internal/v1/objects/import`.
 * Caller passes v1-IDs (NOT v2-IDs) — the endpoint resolves v1→v2 by
 * scanning the user's v2-objects for `meta.v1_id` matches.
 *
 * Idempotent: KC2's `addRef` does ON CONFLICT DO NOTHING. Repeated calls
 * are safe.
 *
 * Body:
 *   {
 *     userEmail: string,
 *     refs: Array<{ fromV1Id: string; toV1Id: string; role: string; meta?: object }>
 *   }
 *
 * Response:
 *   { added: ImportedRef[], skippedMissingV1Id: Array<{...}>,
 *     errors: Array<{...}> }
 *
 * PLAN-Ref: PLAN-document-linking §9 Phase 6.
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

export interface InternalRefsImportDeps {
  readonly server: ServerContext;
  readonly knowledge: KnowledgeService;
}

const RefPayloadSchema = z.object({
  fromV1Id: z.string().min(1).max(64),
  toV1Id: z.string().min(1).max(64),
  role: z.string().min(1).max(64),
  meta: z.record(z.unknown()).optional(),
});

const ImportBodySchema = z.object({
  userEmail: z.string().email(),
  refs: z.array(RefPayloadSchema).min(1).max(500),
});

interface AddedRef {
  readonly fromV1Id: string;
  readonly toV1Id: string;
  readonly fromV2Id: string;
  readonly toV2Id: string;
  readonly role: string;
}

interface SkippedRef {
  readonly fromV1Id: string;
  readonly toV1Id: string;
  readonly role: string;
  readonly reason: string;
}

interface RefError {
  readonly fromV1Id: string;
  readonly toV1Id: string;
  readonly role: string;
  readonly message: string;
}

export function internalRefsImportRoutes(
  deps: InternalRefsImportDeps,
): Hono<AppBindings> {
  const { server, knowledge } = deps;
  const app = new Hono<AppBindings>();

  app.post('/internal/v1/refs/import', zValidator('json', ImportBodySchema), async (c) => {
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

    // ── 1. Sammle alle v1-IDs aus dem Refs-Set ──────────────────────────
    const allV1Ids = new Set<string>();
    for (const r of body.refs) {
      allV1Ids.add(r.fromV1Id);
      allV1Ids.add(r.toV1Id);
    }

    // ── 2. Baue v1→v2 ID-Map durch Scan aller User-Objects ──────────────
    //
    // Wir holen alle Objects des Users in einer cursored Loop und filtern
    // auf solche mit `meta.v1_id ∈ allV1Ids`. Bei <500 Objects/User ist
    // das ein einziger Page-Read.
    const v1ToV2 = new Map<string, string>();
    let cursor: number | null = null;
    let page = 0;
    do {
      const list = await knowledge.listObjects({
        userId: user.id,
        userEmail: user.email,
        limit: 200,
        ...(cursor !== null ? { cursor } : {}),
      });
      for (const obj of list.items) {
        const v1Id = (obj.meta as Record<string, unknown> | null)?.['v1_id'];
        if (typeof v1Id === 'string' && allV1Ids.has(v1Id)) {
          v1ToV2.set(v1Id, obj.id);
        }
      }
      cursor = list.nextCursor ?? null;
      page += 1;
      // safety break
      if (page > 20) break;
    } while (cursor !== null);

    // ── 3. Add jeden Ref ──────────────────────────────────────────────
    const added: AddedRef[] = [];
    const skipped: SkippedRef[] = [];
    const errors: RefError[] = [];

    for (const r of body.refs) {
      const fromV2 = v1ToV2.get(r.fromV1Id);
      const toV2 = v1ToV2.get(r.toV1Id);
      if (!fromV2 || !toV2) {
        skipped.push({
          fromV1Id: r.fromV1Id,
          toV1Id: r.toV1Id,
          role: r.role,
          reason: !fromV2 && !toV2 ? 'both v1-ids not in v2' : !fromV2 ? 'fromV1Id not in v2' : 'toV1Id not in v2',
        });
        continue;
      }
      try {
        await knowledge.addRef({
          userId: user.id,
          userEmail: user.email,
          approvalId: randomUUID(),
          fromId: fromV2,
          toId: toV2,
          role: r.role,
          ...(r.meta !== undefined ? { meta: r.meta } : {}),
        });
        added.push({
          fromV1Id: r.fromV1Id,
          toV1Id: r.toV1Id,
          fromV2Id: fromV2,
          toV2Id: toV2,
          role: r.role,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        errors.push({
          fromV1Id: r.fromV1Id,
          toV1Id: r.toV1Id,
          role: r.role,
          message: msg,
        });
      }
    }

    try {
      await emitAudit(server.db, {
        action: 'admin.refs.import',
        actorUserId: null,
        targetUserId: user.id,
        result: errors.length === 0 ? 'success' : 'failure',
        details: {
          userEmail: body.userEmail,
          requested: body.refs.length,
          added: added.length,
          skipped: skipped.length,
          errors: errors.length,
        },
      });
    } catch {
      // audit fail should not kill response
    }

    return c.json({ added, skipped, errors });
  });

  return app;
}
