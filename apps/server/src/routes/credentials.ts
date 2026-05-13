/**
 * Credentials-HTTP-Routes.
 *
 *   POST   /v1/credentials              — create (with optional prfSessionId)
 *   GET    /v1/credentials              — list (no secrets)
 *   GET    /v1/credentials/:id          — metadata (default no secret)
 *   GET    /v1/credentials/:id?reveal=1 — secret (requires prfSessionId)
 *   POST   /v1/credentials/:id/rotate   — replace secret
 *   DELETE /v1/credentials/:id          — owner-only delete (RLS-enforced)
 *   POST   /v1/credentials/prf-session  — stash prfOutput, returns prfSessionId
 *
 * Auth: Bearer-Session-JWT pro Route. Auth-Middleware setzt `c.var.user`.
 * Owner-Only-Enforcement: RLS (postgres) — wir filtern hier nicht zusaetzlich
 * im SQL, weil `db.scoped(userId)` schon `SET LOCAL app.current_user` macht.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { auth } from '../middleware/auth.js';
import type { CredentialsService } from '../services/credentials.js';
import { PrfRequiredError } from '../services/credentials.js';
import type { PrfSessionService } from '../services/prf-session.js';

export interface CredentialsRouteDeps {
  readonly server: ServerContext;
  readonly credentials: CredentialsService;
  readonly prfSessions: PrfSessionService;
}

const kindSchema = z.enum(['oauth_refresh', 'api_token', 'password', 'service_account']);

const createSchema = z.object({
  provider: z.string().min(1).max(64),
  kind: kindSchema,
  label: z.string().min(1).max(128),
  secret: z.string().min(1),
  prfEnabled: z.boolean().optional(),
  prfSessionId: z.string().min(1).optional(),
  prfCredentialIdB64: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  expiresAt: z.number().int().positive().optional(),
});

const rotateSchema = z.object({
  newSecret: z.string().min(1),
  prfSessionId: z.string().min(1).optional(),
});

const prfSessionSchema = z.object({
  prfOutputB64: z.string().min(1),
  ttlSec: z.number().int().positive().max(15 * 60).optional(),
  credentialId: z.string().uuid().optional(),
});

function b64ToBytes(b64: string): Uint8Array {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return btoa(s);
}

async function resolvePrfOutput(
  prfSessions: PrfSessionService,
  userId: string,
  prfSessionId: string | undefined,
): Promise<Uint8Array | undefined> {
  if (!prfSessionId) return undefined;
  const out = await prfSessions.get(prfSessionId, userId);
  if (!out) throw HttpError.unauthorized('prf_session invalid or expired');
  return out;
}

function metaToJson(m: {
  id: string;
  ownerId: string;
  provider: string;
  kind: string;
  label: string;
  prfEnabled: boolean;
  prfCredentialId: Uint8Array | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  rotatedAt: number | null;
  lastUsedAt: number | null;
  expiresAt: number | null;
}): Record<string, unknown> {
  return {
    id: m.id,
    ownerId: m.ownerId,
    provider: m.provider,
    kind: m.kind,
    label: m.label,
    prfEnabled: m.prfEnabled,
    prfCredentialIdB64: m.prfCredentialId ? bytesToB64(m.prfCredentialId) : null,
    metadata: m.metadata,
    createdAt: m.createdAt,
    rotatedAt: m.rotatedAt,
    lastUsedAt: m.lastUsedAt,
    expiresAt: m.expiresAt,
  };
}

export function credentialsRoutes(deps: CredentialsRouteDeps): Hono<AppBindings> {
  const { server, credentials, prfSessions } = deps;
  const app = new Hono<AppBindings>();
  const guard = auth(server);

  // POST /v1/credentials — create
  app.post('/v1/credentials', guard, zValidator('json', createSchema), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const body = c.req.valid('json');
    const prfOutput = await resolvePrfOutput(prfSessions, principal.userId, body.prfSessionId);
    try {
      const meta = await credentials.create({
        userId: principal.userId,
        provider: body.provider,
        kind: body.kind,
        label: body.label,
        secret: body.secret,
        ...(body.prfEnabled !== undefined ? { prfEnabled: body.prfEnabled } : {}),
        ...(prfOutput ? { prfOutput } : {}),
        ...(body.prfCredentialIdB64 ? { prfCredentialId: b64ToBytes(body.prfCredentialIdB64) } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      });
      return c.json({ credential: metaToJson(meta) }, 201);
    } catch (err) {
      if (err instanceof PrfRequiredError) {
        return c.json(
          {
            error: {
              code: 'prf_required',
              message: 'WebAuthn-PRF approval required to create this credential',
              details: {
                prfCredentialIdB64: err.prfCredentialId ? bytesToB64(err.prfCredentialId) : null,
              },
            },
          },
          428,
        );
      }
      throw err;
    }
  });

  // GET /v1/credentials — list (no secrets)
  app.get('/v1/credentials', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const provider = c.req.query('provider');
    const list = await credentials.list({
      userId: principal.userId,
      ...(provider ? { provider } : {}),
    });
    return c.json({ credentials: list.map(metaToJson) });
  });

  // GET /v1/credentials/:id — metadata (and optionally secret if reveal=1)
  app.get('/v1/credentials/:id', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    const reveal = c.req.query('reveal') === 'true' || c.req.query('reveal') === '1';
    const prfSessionId = c.req.query('prfSessionId') ?? undefined;

    if (!reveal) {
      // List with id-filter — keine secrets, decrypt vermeiden
      const list = await credentials.list({ userId: principal.userId });
      const meta = list.find((m) => m.id === id);
      if (!meta) throw HttpError.notFound('credential not found');
      return c.json({ credential: metaToJson(meta) });
    }

    const prfOutput = await resolvePrfOutput(prfSessions, principal.userId, prfSessionId);
    try {
      const result = await credentials.read({
        userId: principal.userId,
        credentialId: id,
        ...(prfOutput ? { prfOutput } : {}),
      });
      return c.json({ credential: metaToJson(result.meta), secret: result.secret });
    } catch (err) {
      if (err instanceof PrfRequiredError) {
        return c.json(
          {
            error: {
              code: 'prf_required',
              message: 'WebAuthn-PRF approval required to read this credential',
              details: {
                prfCredentialIdB64: err.prfCredentialId ? bytesToB64(err.prfCredentialId) : null,
              },
            },
          },
          428,
        );
      }
      throw err;
    }
  });

  // POST /v1/credentials/:id/rotate
  app.post('/v1/credentials/:id/rotate', guard, zValidator('json', rotateSchema), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    const body = c.req.valid('json');
    const prfOutput = await resolvePrfOutput(prfSessions, principal.userId, body.prfSessionId);
    try {
      await credentials.rotate({
        userId: principal.userId,
        credentialId: id,
        newSecret: body.newSecret,
        ...(prfOutput ? { prfOutput } : {}),
      });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof PrfRequiredError) {
        return c.json(
          {
            error: {
              code: 'prf_required',
              message: 'WebAuthn-PRF approval required to rotate this credential',
              details: {
                prfCredentialIdB64: err.prfCredentialId ? bytesToB64(err.prfCredentialId) : null,
              },
            },
          },
          428,
        );
      }
      throw err;
    }
  });

  // DELETE /v1/credentials/:id
  app.delete('/v1/credentials/:id', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    await credentials.delete({ userId: principal.userId, credentialId: id });
    return c.json({ ok: true });
  });

  // POST /v1/credentials/prf-session — stash prfOutput
  app.post('/v1/credentials/prf-session', guard, zValidator('json', prfSessionSchema), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const body = c.req.valid('json');
    const prfOutput = b64ToBytes(body.prfOutputB64);
    if (prfOutput.byteLength !== 32) {
      throw HttpError.badRequest('invalid_request', 'prfOutput must decode to 32 bytes');
    }
    const id = await prfSessions.store({
      userId: principal.userId,
      prfOutput,
      ...(body.ttlSec !== undefined ? { ttlSec: body.ttlSec } : {}),
      ...(body.credentialId ? { credentialId: body.credentialId } : {}),
    });
    return c.json({ prfSessionId: id, ttlSec: body.ttlSec ?? 300 }, 201);
  });

  return app;
}
