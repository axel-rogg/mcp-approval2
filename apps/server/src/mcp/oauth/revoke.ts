/**
 * Token-Revocation-Endpoint (RFC 7009).
 *
 * POST /oauth/revoke
 *   Body (form-urlencoded ODER JSON):
 *     token            — der zu revokende Token (refresh ODER access)
 *     token_type_hint  — optional 'refresh_token' | 'access_token'
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4.
 *
 * Semantik (RFC 7009 §2):
 *   - Server MUSS Client-Auth analog /oauth/token verlangen.
 *   - Unbekannte/expired Tokens → 200 OK (KEINE Information leak).
 *   - Refresh-Token: revoke gesamte Familie (RFC 9700 + family_id-Pattern).
 *   - Access-Token: best-effort — wir setzen kein In-Memory-Blacklist auf,
 *     stattdessen Audit-Eintrag + return 200. Phase-2-Roadmap: revoked_jtis
 *     fuer Access-Tokens nutzen analog Session-JWT.
 */
import { Hono, type Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { oauthError } from './errors.js';
import { emitAudit } from '../../services/audit.js';

const FormSchema = z.object({
  token: z.string().min(1, 'token required'),
  token_type_hint: z.enum(['refresh_token', 'access_token']).optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
});

interface ClientRecord {
  readonly clientId: string;
  readonly clientSecretHash: string | null;
  readonly tokenEndpointAuthMethod: string;
  readonly expiresAt: number | null;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

async function loadClient(
  server: ServerContext,
  clientId: string,
): Promise<ClientRecord | null> {
  const raw = server.db.unsafe('oauth_revoke_load_client');
  const rows = await raw.query<{
    client_id: string;
    client_secret_hash: string | null;
    token_endpoint_auth_method: string | null;
    expires_at: number | null;
  }>(
    `SELECT client_id, client_secret_hash, token_endpoint_auth_method, expires_at
       FROM oauth_clients WHERE client_id = $1 LIMIT 1`,
    [clientId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method ?? 'client_secret_post',
    expiresAt: row.expires_at,
  };
}

async function authenticateClient(
  server: ServerContext,
  c: Context<AppBindings>,
  body: z.infer<typeof FormSchema>,
): Promise<{ ok: true; client: ClientRecord } | { ok: false; response: Response }> {
  let basicId: string | null = null;
  let basicSecret: string | null = null;
  const auth = c.req.header('authorization');
  if (auth && auth.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        basicId = decoded.slice(0, idx);
        basicSecret = decoded.slice(idx + 1);
      }
    } catch {
      return { ok: false, response: oauthError(c, 401, 'invalid_client', 'malformed Basic auth header') };
    }
  }
  const clientId = basicId ?? body.client_id;
  if (!clientId) return { ok: false, response: oauthError(c, 401, 'invalid_client', 'client_id required') };
  const client = await loadClient(server, clientId);
  if (!client) return { ok: false, response: oauthError(c, 401, 'invalid_client', 'unknown client_id') };
  if (client.expiresAt !== null && client.expiresAt < Date.now()) {
    return { ok: false, response: oauthError(c, 401, 'invalid_client', 'client registration expired') };
  }
  if (client.tokenEndpointAuthMethod === 'none') {
    return { ok: true, client };
  }
  const secret = basicSecret ?? body.client_secret ?? null;
  if (!secret || !client.clientSecretHash) {
    return { ok: false, response: oauthError(c, 401, 'invalid_client', 'client_secret required') };
  }
  const presented = createHash('sha256').update(secret).digest('hex');
  if (!safeEqualHex(presented, client.clientSecretHash)) {
    return { ok: false, response: oauthError(c, 401, 'invalid_client', 'client_secret mismatch') };
  }
  return { ok: true, client };
}

export function revokeRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post('/oauth/revoke', async (c) => {
    let body: z.infer<typeof FormSchema>;
    const contentType = c.req.header('content-type') ?? '';
    try {
      let raw: Record<string, unknown>;
      if (contentType.includes('application/json')) {
        raw = (await c.req.json()) as Record<string, unknown>;
      } else {
        raw = (await c.req.parseBody()) as Record<string, unknown>;
      }
      const parsed = FormSchema.safeParse(raw);
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return oauthError(c, 400, 'invalid_request', msg);
      }
      body = parsed.data;
    } catch {
      return oauthError(c, 400, 'invalid_request', 'malformed request body');
    }

    const auth = await authenticateClient(server, c, body);
    if (!auth.ok) return auth.response;
    const { client } = auth;

    const tokenHash = createHash('sha256').update(body.token).digest('hex');
    const now = Date.now();

    // Try refresh-token (unless hint explicitly says access_token).
    if (body.token_type_hint !== 'access_token') {
      const raw = server.db.unsafe('oauth_revoke_refresh');
      const rows = await raw.query<{
        client_id: string;
        user_id: string;
        family_id: string;
        revoked_at: number | null;
      }>(
        `SELECT client_id, user_id, family_id, revoked_at
           FROM oauth_refresh_tokens WHERE token_hash = $1 LIMIT 1`,
        [tokenHash],
      );
      const row = rows[0];
      if (row) {
        if (row.client_id !== client.clientId) {
          // RFC 7009: KEINE Info leak. Return 200.
          return c.json({}, 200, { 'cache-control': 'no-store' });
        }
        if (row.revoked_at === null) {
          await raw.query(
            `UPDATE oauth_refresh_tokens
                SET revoked_at = $1, revoke_reason = 'client_revoke'
              WHERE family_id = $2 AND revoked_at IS NULL`,
            [now, row.family_id],
          );
          await emitAudit(server.db, {
            action: 'oauth.token_revoke',
            actorUserId: row.user_id,
            result: 'success',
            details: { clientId: client.clientId, familyId: row.family_id, kind: 'refresh' },
          });
        }
        return c.json({}, 200, { 'cache-control': 'no-store' });
      }
    }

    // Access-Token: best-effort (kein In-Memory-Blacklist Phase 1). Audit-only.
    if (body.token_type_hint === 'access_token' || body.token_type_hint === undefined) {
      await emitAudit(server.db, {
        action: 'oauth.token_revoke',
        actorUserId: null,
        result: 'noop',
        details: { clientId: client.clientId, kind: 'access_or_unknown' },
      });
    }

    return c.json({}, 200, { 'cache-control': 'no-store' });
  });

  return app;
}
