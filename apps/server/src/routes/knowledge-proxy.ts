/**
 * Knowledge-Proxy-Routen.
 *
 * Plan-Reference: PLAN-architecture-v1.md §2.1 + §7.
 *
 * Zweck:
 *   Thin-HTTP-Proxy fuer PWA + MCP-Tool-Konsumenten innerhalb von mcp-approval2,
 *   die direkten Object/Search-Zugriff brauchen ohne den vollen Tool-Pfad
 *   (z.B. PWA-Storage-Tab: list + read + delete).
 *
 *   Alle Calls gehen durch den KnowledgeService → KnowledgeAdapter → mcp-knowledge2.
 *   Audit-Logging + JWT-Signing passieren transparent in der Service-Schicht.
 *
 * Sicherheits-Modell:
 *   - Auth-Middleware ist Pflicht (`auth(server)`) — Session-JWT muss vorhanden sein.
 *   - userId aus `c.get('user').userId` wird in alle Adapter-Calls injiziert.
 *   - Storage-Service enforced ownership/share via RLS — wir vertrauen darauf
 *     und mappen `KnowledgeError`-Subclasses auf `HttpError` (siehe Mapping unten).
 *
 * Routen (alle unter /v1/knowledge):
 *   POST   /v1/knowledge/objects                  — create
 *   GET    /v1/knowledge/objects/:id              — read
 *   PATCH  /v1/knowledge/objects/:id              — update
 *   DELETE /v1/knowledge/objects/:id              — delete (owner-only, server-enforced)
 *   GET    /v1/knowledge/objects                  — list (?subtype=&limit=&cursor=)
 *   POST   /v1/knowledge/objects/:id/shares       — create share
 *   GET    /v1/knowledge/objects/:id/shares       — list shares
 *   DELETE /v1/knowledge/shares/:shareId          — revoke share
 *   POST   /v1/knowledge/search                   — search
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { KnowledgeError } from '@mcp-approval2/adapters';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { auth } from '../middleware/auth.js';
import type { KnowledgeService } from '../services/knowledge.js';

/**
 * Free-form Subtype (post-ADR-0004 Generic Object Model). Caller-Convention,
 * Storage interpretiert NICHTS. Regex erlaubt `:` fuer `app:`-Prefix-Namespacing.
 */
const objectSubtypeSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_:-]*$/, {
    message: 'subtype must be lowercase alphanumeric with -, _, : separators',
  });

const createObjectSchema = z.object({
  subtype: objectSubtypeSchema.optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  body: z.string().optional(),
  visibility: z.enum(['private', 'shared']).optional(),
});

const updateObjectSchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  keywords: z.array(z.string()).optional(),
  body: z.string().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

type UpdatePatch = Partial<{
  title: string | null;
  description: string | null;
  keywords: ReadonlyArray<string>;
  body: string;
  pinned: boolean;
  archived: boolean;
}>;

function buildUpdatePatch(input: z.infer<typeof updateObjectSchema>): UpdatePatch {
  const out: UpdatePatch = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.description !== undefined) out.description = input.description;
  if (input.keywords !== undefined) out.keywords = input.keywords;
  if (input.body !== undefined) out.body = input.body;
  if (input.pinned !== undefined) out.pinned = input.pinned;
  if (input.archived !== undefined) out.archived = input.archived;
  return out;
}

const listObjectsQuerySchema = z.object({
  subtype: objectSubtypeSchema.optional(),
  // Prefix-Match — mutually exclusive with `subtype`. Same shape-regex
  // as `objectSubtypeSchema`.
  subtype_prefix: objectSubtypeSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  cursor: z.coerce.number().int().nonnegative().optional(),
});

const createShareSchema = z.object({
  grantedTo: z.string().uuid(),
  scope: z.enum(['read', 'write']),
});

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  subtypes: z.array(objectSubtypeSchema).optional(),
  // Prefix-match — combinable with `subtypes` (server joins via OR).
  subtype_prefixes: z.array(objectSubtypeSchema).max(8).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export interface KnowledgeRouteDeps {
  /**
   * Knowledge-Service-Resolver. Wir nehmen einen Factory-Callback statt einer
   * fertigen Instanz, damit `ServerContext` `knowledge` nicht hart als Pflicht
   * deklarieren muss (Tests koennen einen Stub einsetzen).
   */
  readonly knowledge: KnowledgeService;
}

export function knowledgeProxyRoutes(server: ServerContext, deps: KnowledgeRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // Alle Routes auth-pflichtig.
  app.use('/v1/knowledge/*', auth(server));

  app.post('/v1/knowledge/objects', zValidator('json', createObjectSchema), async (c) => {
    const user = requireUser(c);
    const body = c.req.valid('json');
    const obj = await runProxy(() =>
      deps.knowledge.createObject({
        userId: user.userId,
      userEmail: user.userEmail,
        ...(body.subtype !== undefined ? { subtype: body.subtype } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.keywords !== undefined ? { keywords: body.keywords } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      }),
    );
    return c.json(obj, 201);
  });

  app.get('/v1/knowledge/objects/:id', async (c) => {
    const user = requireUser(c);
    const id = c.req.param('id');
    if (!id) throw HttpError.badRequest('invalid_request', 'missing id');
    // PWA-Client schickt `?expand=body,refs,tags,summary`. KC2 returnt
    // body_b64 nur wenn expand=body — daher Param durchreichen.
    const expandParam = c.req.query('expand') ?? '';
    const expandBody = expandParam.split(',').includes('body');
    // PLAN-document-linking §10.5 D1: refs_limit (0..50, default KC2=5).
    const refsLimitRaw = c.req.query('refs_limit');
    let refsLimit: number | undefined;
    if (refsLimitRaw !== undefined) {
      const n = Number.parseInt(refsLimitRaw, 10);
      if (!Number.isFinite(n) || n < 0 || n > 50) {
        throw HttpError.badRequest('invalid_request', 'refs_limit must be 0..50');
      }
      refsLimit = n;
    }
    // PLAN-doc-linking §9 P9: optional eager-embed of ref bodies (CSV of roles).
    const includeBodiesRaw = c.req.query('include_bodies');
    const includeRefBodies: readonly string[] =
      includeBodiesRaw && includeBodiesRaw.length > 0
        ? includeBodiesRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const obj = await runProxy(() =>
      deps.knowledge.getObject({
        id,
        userId: user.userId,
        userEmail: user.userEmail,
        expandBody,
        ...(refsLimit !== undefined ? { refsLimit } : {}),
        ...(includeRefBodies.length > 0 ? { includeRefBodies } : {}),
      }),
    );
    // KC2 antwortet mit `body_b64`. PWA erwartet `body` + `bodyEncoding`.
    // Adapter-Layer mappt das nicht — wir machen es hier inline.
    const objAny = obj as unknown as {
      body?: unknown;
      bodyEncoding?: string;
      body_b64?: string;
    };
    if (expandBody && typeof objAny.body_b64 === 'string' && objAny.body === undefined) {
      objAny.body = objAny.body_b64;
      objAny.bodyEncoding = 'base64';
    }
    return c.json(obj);
  });

  app.patch('/v1/knowledge/objects/:id', zValidator('json', updateObjectSchema), async (c) => {
    const user = requireUser(c);
    const id = c.req.param('id');
    if (!id) throw HttpError.badRequest('invalid_request', 'missing id');
    const patch = buildUpdatePatch(c.req.valid('json'));
    const obj = await runProxy(() =>
      deps.knowledge.updateObject({ id, userId: user.userId, userEmail: user.userEmail, patch }),
    );
    return c.json(obj);
  });

  app.delete('/v1/knowledge/objects/:id', async (c) => {
    const user = requireUser(c);
    const id = c.req.param('id');
    if (!id) throw HttpError.badRequest('invalid_request', 'missing id');
    await runProxy(() =>
      deps.knowledge.deleteObject({ id, userId: user.userId, userEmail: user.userEmail }),
    );
    return c.body(null, 204);
  });

  app.get('/v1/knowledge/objects', zValidator('query', listObjectsQuerySchema), async (c) => {
    const user = requireUser(c);
    const q = c.req.valid('query');
    // Mutual-Exclusive: subtype + subtype_prefix duerfen nicht beide
    // gesetzt sein. zod kann das nicht ausdruecken ohne refinement-
    // Branch; wir machen es hier explizit.
    if (q.subtype !== undefined && q.subtype_prefix !== undefined) {
      throw HttpError.badRequest(
        'invalid_request',
        'subtype and subtype_prefix are mutually exclusive',
      );
    }
    const list = await runProxy(() =>
      deps.knowledge.listObjects({
        userId: user.userId,
      userEmail: user.userEmail,
        ...(q.subtype !== undefined ? { subtype: q.subtype } : {}),
        ...(q.subtype_prefix !== undefined ? { subtypePrefix: q.subtype_prefix } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      }),
    );
    return c.json(list);
  });

  app.post(
    '/v1/knowledge/objects/:id/shares',
    zValidator('json', createShareSchema),
    async (c) => {
      const user = requireUser(c);
      const id = c.req.param('id');
      if (!id) throw HttpError.badRequest('invalid_request', 'missing id');
      const body = c.req.valid('json');
      const share = await runProxy(() =>
        deps.knowledge.createShare({
          resourceId: id,
          userId: user.userId,
      userEmail: user.userEmail,
          grantedTo: body.grantedTo,
          scope: body.scope,
        }),
      );
      return c.json(share, 201);
    },
  );

  app.get('/v1/knowledge/objects/:id/shares', async (c) => {
    const user = requireUser(c);
    const id = c.req.param('id');
    if (!id) throw HttpError.badRequest('invalid_request', 'missing id');
    const shares = await runProxy(() =>
      deps.knowledge.listShares({ resourceId: id, userId: user.userId, userEmail: user.userEmail }),
    );
    return c.json({ items: shares });
  });

  app.delete('/v1/knowledge/shares/:shareId', async (c) => {
    const user = requireUser(c);
    const shareId = c.req.param('shareId');
    if (!shareId) throw HttpError.badRequest('invalid_request', 'missing shareId');
    await runProxy(() =>
      deps.knowledge.revokeShare({ shareId, userId: user.userId, userEmail: user.userEmail }),
    );
    return c.body(null, 204);
  });

  app.post('/v1/knowledge/search', zValidator('json', searchSchema), async (c) => {
    const user = requireUser(c);
    const body = c.req.valid('json');
    const hits = await runProxy(() =>
      deps.knowledge.search({
        userId: user.userId,
      userEmail: user.userEmail,
        query: body.query,
        ...(body.subtypes !== undefined ? { subtypes: body.subtypes } : {}),
        ...(body.subtype_prefixes !== undefined
          ? { subtypePrefixes: body.subtype_prefixes }
          : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
      }),
    );
    return c.json({ items: hits });
  });

  return app;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function requireUser(c: {
  get: (key: 'user') => AppBindings['Variables']['user'];
}): { userId: string; userEmail: string } {
  const user = c.get('user');
  if (!user) throw HttpError.unauthorized('missing principal');
  // SEC-K-001-fix: userEmail wandert via KnowledgeAdapter in den OBO-JWT
  // (`payload.on_behalf_of`). KC2 macht resolveByEmail(on_behalf_of) — ohne
  // Email wird auf resolveByGoogleSub mit der approval2-user-id gefallen
  // (UUID hat kein '@') und KC2 findet den User nicht → 403 'OBO subject
  // not provisioned'. Mit Email klappt der Lookup.
  return { userId: user.userId, userEmail: user.email };
}

/**
 * Wrappt einen KnowledgeService-Call und mapped `KnowledgeError` → `HttpError`.
 * Andere Errors fliegen weiter und werden vom globalen error-handler gefasst.
 */
async function runProxy<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof KnowledgeError) {
      throw mapKnowledgeError(err);
    }
    throw err;
  }
}

function mapKnowledgeError(err: KnowledgeError): HttpError {
  const details: Record<string, unknown> = {
    upstream: 'mcp-knowledge2',
    upstreamCode: err.code,
  };
  if (err.requestId) details['upstreamRequestId'] = err.requestId;
  if (err.details) details['upstreamDetails'] = err.details;

  switch (err.status) {
    case 400:
      return HttpError.badRequest('invalid_request', err.message, details);
    case 401:
      return HttpError.unauthorized(err.message, details);
    case 403:
      return HttpError.forbidden('forbidden', err.message, details);
    case 404:
      return HttpError.notFound(err.message, details);
    case 409:
      return HttpError.conflict(err.message, details);
    case 429:
      // Maps auf 'rate_limited' — wir haben keinen 429-Helper, also direkt konstruieren.
      return new HttpError(429, 'rate_limited', err.message, details);
    default:
      return new HttpError(502, 'internal', err.message, details);
  }
}
