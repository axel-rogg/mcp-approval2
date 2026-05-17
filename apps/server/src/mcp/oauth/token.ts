/**
 * Token-Endpoint (OAuth 2.1 + PKCE + Refresh-Rotation + Resource-Indicators).
 *
 *   POST /oauth/token
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4.
 *
 * Supported Grants:
 *   - grant_type=authorization_code  (RFC 6749 + RFC 7636 PKCE)
 *   - grant_type=refresh_token       (RFC 9700 rotation + replay-detect)
 *
 * Access-Token-Format: JWT (HS256, signed with config.JWT_SECRET) mit:
 *   - iss = config.ORIGIN
 *   - sub = user_id (UUID)
 *   - aud = resource (RFC 8707) — Pflicht-Claim
 *   - client_id, scope, jti, iat, exp.
 *
 * Refresh-Token: opaque random base64url-Token, SHA-256-hashed persistiert.
 *
 * Client-Auth (RFC 6749 §2.3):
 *   - 'client_secret_post': client_id + client_secret im Body.
 *   - 'client_secret_basic': HTTP Basic-Auth (RFC 6749 §2.3.1).
 *   - 'none': public client, nur client_id im Body (PKCE-only).
 */
import { Hono, type Context } from 'hono';
import { randomBytes, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT } from 'jose';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { oauthError } from './errors.js';
import { emitAudit } from '../../services/audit.js';

const ACCESS_TOKEN_TTL_SEC = 30 * 60; // 30 min
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

const FormSchema = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token']),
  code: z.string().optional(),
  redirect_uri: z.string().url().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().url().optional(),
});

interface ClientRecord {
  readonly clientId: string;
  readonly clientSecretHash: string | null;
  readonly redirectUris: ReadonlyArray<string>;
  readonly grantTypes: ReadonlyArray<string>;
  readonly tokenEndpointAuthMethod: string;
  readonly expiresAt: number | null;
}

async function loadClient(
  server: ServerContext,
  clientId: string,
): Promise<ClientRecord | null> {
  const raw = server.db.unsafe('oauth_token_load_client');
  const rows = await raw.query<{
    client_id: string;
    client_secret_hash: string | null;
    redirect_uris: ReadonlyArray<string> | string;
    grant_types: ReadonlyArray<string> | string;
    token_endpoint_auth_method: string | null;
    expires_at: number | null;
  }>(
    `SELECT client_id, client_secret_hash, redirect_uris, grant_types,
            token_endpoint_auth_method, expires_at
       FROM oauth_clients WHERE client_id = $1 LIMIT 1`,
    [clientId],
  );
  const row = rows[0];
  if (!row) return null;
  const parseJson = <T,>(v: T | string): T =>
    typeof v === 'string' ? (JSON.parse(v) as T) : v;
  return {
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    redirectUris: parseJson(row.redirect_uris),
    grantTypes: parseJson(row.grant_types),
    tokenEndpointAuthMethod: row.token_endpoint_auth_method ?? 'client_secret_post',
    expiresAt: row.expires_at,
  };
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * RFC 7636 PKCE-S256-Check: base64url(SHA-256(verifier)) === code_challenge.
 */
function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return safeEqualHex(computed, challenge);
}

interface ClientAuthResult {
  readonly clientId: string;
  readonly client: ClientRecord;
}

/**
 * Validiert Client-Authentication via Basic-Auth-Header oder Body-Params.
 * Returns ClientRecord wenn OK, sonst null + oauth-error-helper-call.
 */
async function authenticateClient(
  server: ServerContext,
  c: Context<AppBindings>,
  body: z.infer<typeof FormSchema>,
): Promise<{ ok: true; result: ClientAuthResult } | { ok: false; response: Response }> {
  // Basic-Auth-Header parsen, falls vorhanden.
  let basicClientId: string | null = null;
  let basicClientSecret: string | null = null;
  const auth = c.req.header('authorization');
  if (auth && auth.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        basicClientId = decoded.slice(0, idx);
        basicClientSecret = decoded.slice(idx + 1);
      }
    } catch {
      return { ok: false, response: oauthError(c, 401, 'invalid_client', 'malformed Basic auth header') };
    }
  }

  const clientId = basicClientId ?? body.client_id;
  if (!clientId) {
    return { ok: false, response: oauthError(c, 401, 'invalid_client', 'client_id required') };
  }
  const client = await loadClient(server, clientId);
  if (!client) {
    return { ok: false, response: oauthError(c, 401, 'invalid_client', 'unknown client_id') };
  }
  if (client.expiresAt !== null && client.expiresAt < Date.now()) {
    return { ok: false, response: oauthError(c, 401, 'invalid_client', 'client registration expired') };
  }

  // Public-Client (none) — kein Secret erwartet.
  if (client.tokenEndpointAuthMethod === 'none') {
    if (client.clientSecretHash !== null) {
      // Inkonsistente Konfig — defensive.
      return { ok: false, response: oauthError(c, 500, 'server_error', 'client config inconsistent') };
    }
    return { ok: true, result: { clientId, client } };
  }

  // Confidential-Client — Secret pruefen.
  const presentedSecret = basicClientSecret ?? body.client_secret ?? null;
  if (!presentedSecret) {
    return { ok: false, response: oauthError(c, 401, 'invalid_client', 'client_secret required') };
  }
  if (!client.clientSecretHash) {
    return { ok: false, response: oauthError(c, 401, 'invalid_client', 'client has no secret registered') };
  }
  const presentedHash = createHash('sha256').update(presentedSecret).digest('hex');
  if (!safeEqualHex(presentedHash, client.clientSecretHash)) {
    return { ok: false, response: oauthError(c, 401, 'invalid_client', 'client_secret mismatch') };
  }
  return { ok: true, result: { clientId, client } };
}

interface IssuedTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly scope: string | null;
}

/**
 * AS-3: zusatz-Claims fuer Google-OIDC-Identity-Resolution.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.1 + §2.3.
 *
 * Wenn der User ueber Google-IdP eingeloggt hat (external_id ist gesetzt),
 * traegt das Issued-Token zusaetzlich:
 *   - `idp: 'google'`     — IdP-Discriminator (kuenftig erweiterbar)
 *   - `idp_sub: <google-sub>` — Google's stabiler User-Identifier
 *   - `email: <google-email>` — fuer Cross-Service-Lookup (KC2 mappt via citext-email)
 *
 * Das Token bleibt HS256-signed mit JWT_SECRET (das ist self-issued an
 * Claude.ai-Clients gegen approval2; KC2-Calls nutzen den separaten
 * OBO-JWT mit RS256-Service-Key, siehe §1.2).
 */
interface IdpClaims {
  readonly idp: 'google' | string;
  readonly idp_sub: string;
  readonly email?: string | undefined;
}

async function loadIdpClaims(
  server: ServerContext,
  userId: string,
): Promise<IdpClaims | null> {
  const raw = server.db.unsafe('oauth_token_load_idp_claims');
  const rows = await raw.query<{ external_id: string | null; email: string | null }>(
    `SELECT external_id, email FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.external_id) return null;
  return {
    idp: 'google',
    idp_sub: row.external_id,
    email: row.email ?? undefined,
  };
}

async function issueAccessToken(
  server: ServerContext,
  args: {
    readonly userId: string;
    readonly clientId: string;
    readonly resource: string;
    readonly scope: string | null;
    readonly idpClaims?: IdpClaims | null;
  },
): Promise<{ token: string; jti: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ACCESS_TOKEN_TTL_SEC;
  const jti = randomUUID();
  const issuer = server.config.ORIGIN.replace(/\/$/, '');
  const secret = new TextEncoder().encode(server.config.JWT_SECRET);
  const payload: Record<string, unknown> = {
    client_id: args.clientId,
    scope: args.scope ?? '',
  };
  // AS-3: IdP-Claims fuer Cross-Service-Identity-Trail (§2.3 Audience-Map).
  if (args.idpClaims) {
    payload['idp'] = args.idpClaims.idp;
    payload['idp_sub'] = args.idpClaims.idp_sub;
    if (args.idpClaims.email !== undefined) {
      payload['email'] = args.idpClaims.email;
    }
  }
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(args.userId)
    .setAudience(args.resource)
    .setIssuer(issuer)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(secret);
  return { token, jti, expiresIn: ACCESS_TOKEN_TTL_SEC };
}

async function issueRefreshToken(
  server: ServerContext,
  args: {
    readonly userId: string;
    readonly clientId: string;
    readonly scope: string | null;
    readonly resource: string;
    readonly familyId: string;
  },
): Promise<{ raw: string; expiresAt: number }> {
  const raw = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(raw).digest('hex');
  const now = Date.now();
  const expiresAt = now + REFRESH_TTL_SEC * 1000;
  const dbRaw = server.db.unsafe('oauth_issue_refresh');
  await dbRaw.query(
    `INSERT INTO oauth_refresh_tokens
       (token_hash, client_id, user_id, scope, resource, created_at, expires_at, family_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tokenHash, args.clientId, args.userId, args.scope, args.resource, now, expiresAt, args.familyId],
  );
  return { raw, expiresAt };
}

async function issueTokenPair(
  server: ServerContext,
  args: {
    readonly userId: string;
    readonly clientId: string;
    readonly scope: string | null;
    readonly resource: string;
    readonly familyId?: string;
  },
): Promise<IssuedTokenPair> {
  const familyId = args.familyId ?? randomUUID();
  // AS-3: IdP-Claims aus users.external_id holen — wenn Google-User, dann
  // im Access-Token mitgeben fuer Cross-Service-Identity-Trail.
  const idpClaims = await loadIdpClaims(server, args.userId);
  const access = await issueAccessToken(server, {
    userId: args.userId,
    clientId: args.clientId,
    resource: args.resource,
    scope: args.scope,
    idpClaims,
  });
  const refresh = await issueRefreshToken(server, {
    userId: args.userId,
    clientId: args.clientId,
    scope: args.scope,
    resource: args.resource,
    familyId,
  });
  return {
    accessToken: access.token,
    refreshToken: refresh.raw,
    expiresIn: access.expiresIn,
    scope: args.scope,
  };
}

export function tokenRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post('/oauth/token', async (c) => {
    // Body kann form-urlencoded (RFC 6749) ODER JSON (MCP-Spec erlaubt) sein.
    let body: z.infer<typeof FormSchema>;
    const contentType = c.req.header('content-type') ?? '';
    try {
      let raw: Record<string, unknown>;
      if (contentType.includes('application/json')) {
        raw = (await c.req.json()) as Record<string, unknown>;
      } else {
        const form = await c.req.parseBody();
        raw = form as Record<string, unknown>;
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

    const authResult = await authenticateClient(server, c, body);
    if (!authResult.ok) return authResult.response;
    const { client } = authResult.result;

    if (body.grant_type === 'authorization_code') {
      return handleAuthorizationCode(server, c, body, client);
    }
    if (body.grant_type === 'refresh_token') {
      return handleRefreshToken(server, c, body, client);
    }
    return oauthError(c, 400, 'unsupported_grant_type', 'unsupported grant_type');
  });

  return app;
}

async function handleAuthorizationCode(
  server: ServerContext,
  c: Context<AppBindings>,
  body: z.infer<typeof FormSchema>,
  client: ClientRecord,
): Promise<Response> {
  if (!client.grantTypes.includes('authorization_code')) {
    return oauthError(c, 400, 'unauthorized_client', 'client not allowed for authorization_code');
  }
  if (!body.code) return oauthError(c, 400, 'invalid_request', 'code required');
  if (!body.redirect_uri) return oauthError(c, 400, 'invalid_request', 'redirect_uri required');
  if (!body.code_verifier) return oauthError(c, 400, 'invalid_request', 'code_verifier required (PKCE)');

  const codeHash = createHash('sha256').update(body.code).digest('hex');
  const raw = server.db.unsafe('oauth_token_lookup_code');
  const rows = await raw.query<{
    code_hash: string;
    client_id: string;
    user_id: string;
    redirect_uri: string;
    scope: string | null;
    resource: string | null;
    code_challenge: string;
    code_challenge_method: string;
    expires_at: number;
    used_at: number | null;
  }>(
    `SELECT code_hash, client_id, user_id, redirect_uri, scope, resource,
            code_challenge, code_challenge_method, expires_at, used_at
       FROM oauth_authz_codes WHERE code_hash = $1 LIMIT 1`,
    [codeHash],
  );
  const row = rows[0];
  if (!row) return oauthError(c, 400, 'invalid_grant', 'code unknown');
  const now = Date.now();
  if (row.used_at !== null) {
    // Replay — Spec sagt: revoke any tokens previously issued for that code.
    // Wir loggen Audit + reject.
    await emitAudit(server.db, {
      action: 'oauth.code_replay',
      actorUserId: row.user_id,
      result: 'failure',
      details: { clientId: client.clientId },
    });
    return oauthError(c, 400, 'invalid_grant', 'code already used');
  }
  if (row.expires_at < now) {
    return oauthError(c, 400, 'invalid_grant', 'code expired');
  }
  if (row.client_id !== client.clientId) {
    return oauthError(c, 400, 'invalid_grant', 'code/client mismatch');
  }
  if (row.redirect_uri !== body.redirect_uri) {
    return oauthError(c, 400, 'invalid_grant', 'redirect_uri mismatch');
  }
  if (row.code_challenge_method !== 'S256') {
    return oauthError(c, 400, 'invalid_grant', 'unsupported code_challenge_method');
  }
  if (!pkceMatches(body.code_verifier, row.code_challenge)) {
    return oauthError(c, 400, 'invalid_grant', 'code_verifier does not match code_challenge');
  }

  // Resource-Indicator: prefer code-row, fallback request, default issuer.
  const resource = row.resource ?? body.resource ?? server.config.ORIGIN.replace(/\/$/, '');

  // Mark code used (one-shot).
  await raw.query(`UPDATE oauth_authz_codes SET used_at = $1 WHERE code_hash = $2`, [now, codeHash]);

  const pair = await issueTokenPair(server, {
    userId: row.user_id,
    clientId: client.clientId,
    scope: row.scope,
    resource,
  });

  await emitAudit(server.db, {
    action: 'oauth.token_issue',
    actorUserId: row.user_id,
    result: 'success',
    details: { clientId: client.clientId, grant_type: 'authorization_code', resource },
  });

  return c.json(
    {
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: pair.expiresIn,
      refresh_token: pair.refreshToken,
      ...(pair.scope ? { scope: pair.scope } : {}),
    },
    200,
    { 'cache-control': 'no-store', pragma: 'no-cache' },
  );
}

async function handleRefreshToken(
  server: ServerContext,
  c: Context<AppBindings>,
  body: z.infer<typeof FormSchema>,
  client: ClientRecord,
): Promise<Response> {
  if (!client.grantTypes.includes('refresh_token')) {
    return oauthError(c, 400, 'unauthorized_client', 'client not allowed for refresh_token');
  }
  if (!body.refresh_token) return oauthError(c, 400, 'invalid_request', 'refresh_token required');

  const tokenHash = createHash('sha256').update(body.refresh_token).digest('hex');
  const raw = server.db.unsafe('oauth_refresh_lookup');
  const rows = await raw.query<{
    token_hash: string;
    client_id: string;
    user_id: string;
    scope: string | null;
    resource: string | null;
    expires_at: number;
    rotated_at: number | null;
    family_id: string;
    revoked_at: number | null;
  }>(
    `SELECT token_hash, client_id, user_id, scope, resource,
            expires_at, rotated_at, family_id, revoked_at
       FROM oauth_refresh_tokens WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return oauthError(c, 400, 'invalid_grant', 'refresh_token unknown');
  if (row.client_id !== client.clientId) {
    return oauthError(c, 400, 'invalid_grant', 'refresh_token/client mismatch');
  }

  const now = Date.now();

  // Replay-Detection: rotated_at set + nicht revoked → second use of an old token.
  if (row.rotated_at !== null && row.revoked_at === null) {
    await raw.query(
      `UPDATE oauth_refresh_tokens
          SET revoked_at = $1, revoke_reason = 'replay_detect'
        WHERE family_id = $2 AND revoked_at IS NULL`,
      [now, row.family_id],
    );
    await emitAudit(server.db, {
      action: 'oauth.refresh_replay',
      actorUserId: row.user_id,
      result: 'failure',
      details: { clientId: client.clientId, familyId: row.family_id },
    });
    return oauthError(c, 400, 'invalid_grant', 'refresh_token replay detected — family revoked');
  }
  if (row.revoked_at !== null) {
    return oauthError(c, 400, 'invalid_grant', 'refresh_token revoked');
  }
  if (row.rotated_at !== null) {
    // Already rotated (race / explicit): reject.
    return oauthError(c, 400, 'invalid_grant', 'refresh_token already rotated');
  }
  if (row.expires_at < now) {
    return oauthError(c, 400, 'invalid_grant', 'refresh_token expired');
  }

  const resource = body.resource ?? row.resource ?? server.config.ORIGIN.replace(/\/$/, '');
  const scope = body.scope ?? row.scope; // Down-scoping erlaubt (RFC 6749 §6).

  // Rotate: mark old + issue new (same family).
  await raw.query(`UPDATE oauth_refresh_tokens SET rotated_at = $1 WHERE token_hash = $2`, [
    now,
    tokenHash,
  ]);

  const pair = await issueTokenPair(server, {
    userId: row.user_id,
    clientId: client.clientId,
    scope,
    resource,
    familyId: row.family_id,
  });

  await emitAudit(server.db, {
    action: 'oauth.token_refresh',
    actorUserId: row.user_id,
    result: 'success',
    details: { clientId: client.clientId, familyId: row.family_id, resource },
  });

  return c.json(
    {
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: pair.expiresIn,
      refresh_token: pair.refreshToken,
      ...(pair.scope ? { scope: pair.scope } : {}),
    },
    200,
    { 'cache-control': 'no-store', pragma: 'no-cache' },
  );
}
