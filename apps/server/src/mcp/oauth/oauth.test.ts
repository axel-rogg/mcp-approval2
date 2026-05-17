/**
 * Integration-Tests fuer den OAuth-2.1-Authorization-Server.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4.
 *
 * Test-Strategie:
 *   - In-Memory-Stub-DbAdapter (Maps statt Postgres).
 *   - SQL-Pattern-Matching im Stub: jede `raw.query()` schaut auf SQL-Prefix
 *     + Operation und manipuliert die passende Map.
 *   - Wir testen die Endpoint-Logik (DCR → Authorize → Token → Refresh
 *     → Replay-Detect), NICHT das Wire-Protocol gegen Postgres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify } from 'jose';
import type { AppConfig } from '../../lib/config.js';
import type { ServerContext, AppBindings, SessionPrincipal } from '../../lib/context.js';
import { issueSessionJwt } from '../../auth/session/issuer.js';
import { oauthRoutes, buildDiscoveryMetadata } from './index.js';
import type { ClientRegistrationResponse, AuthorizationServerMetadata } from './types.js';

// --- In-memory stub of the DbAdapter --------------------------------------

interface OauthClientRow {
  client_id: string;
  client_secret_hash: string | null;
  redirect_uris: string; // JSON string
  grant_types: string; // JSON string
  scope: string | null;
  token_endpoint_auth_method: string;
  client_name: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  contacts: string | null;
  software_id: string | null;
  registration_access_token_hash: string;
  created_at: number;
  expires_at: number | null;
  registration_source: string;
}

interface OauthAuthzCodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string | null;
  resource: string | null;
  code_challenge: string;
  code_challenge_method: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

interface OauthRefreshRow {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string | null;
  resource: string | null;
  created_at: number;
  expires_at: number;
  rotated_at: number | null;
  family_id: string;
  revoked_at: number | null;
  revoke_reason: string | null;
}

interface UsersRow {
  id: string;
  email: string;
  role: 'admin' | 'member';
  external_id?: string | null;
}

interface StubState {
  clients: Map<string, OauthClientRow>;
  codes: Map<string, OauthAuthzCodeRow>;
  refresh: Map<string, OauthRefreshRow>;
  users: Map<string, UsersRow>;
  auditEvents: Array<{ action: string; result: string }>;
}

function makeStubDb(state: StubState): ServerContext['db'] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runQuery = async <T = any,>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> => {
    const s = sql.trim().toUpperCase();
    // INSERT INTO oauth_clients
    if (s.startsWith('INSERT INTO OAUTH_CLIENTS')) {
      const row: OauthClientRow = {
        client_id: String(params[0]),
        client_secret_hash: params[1] === null ? null : String(params[1]),
        redirect_uris: String(params[2]),
        grant_types: String(params[3]),
        scope: params[4] === null ? null : String(params[4]),
        token_endpoint_auth_method: String(params[5]),
        client_name: params[6] === null ? null : String(params[6]),
        client_uri: params[7] === null ? null : String(params[7]),
        logo_uri: params[8] === null ? null : String(params[8]),
        contacts: params[9] === null ? null : String(params[9]),
        software_id: params[10] === null ? null : String(params[10]),
        registration_access_token_hash: String(params[11]),
        created_at: Number(params[12]),
        expires_at: null,
        registration_source: 'dcr',
      };
      state.clients.set(row.client_id, row);
      return [];
    }
    // SELECT FROM oauth_clients
    if (s.startsWith('SELECT') && s.includes('FROM OAUTH_CLIENTS')) {
      const row = state.clients.get(String(params[0]));
      return row ? ([row] as unknown as T[]) : [];
    }
    // INSERT INTO oauth_authz_codes
    if (s.startsWith('INSERT INTO OAUTH_AUTHZ_CODES')) {
      const row: OauthAuthzCodeRow = {
        code_hash: String(params[0]),
        client_id: String(params[1]),
        user_id: String(params[2]),
        redirect_uri: String(params[3]),
        scope: params[4] === null ? null : String(params[4]),
        resource: params[5] === null ? null : String(params[5]),
        code_challenge: String(params[6]),
        code_challenge_method: String(params[7]),
        created_at: Number(params[8]),
        expires_at: Number(params[9]),
        used_at: null,
      };
      state.codes.set(row.code_hash, row);
      return [];
    }
    if (s.startsWith('SELECT') && s.includes('FROM OAUTH_AUTHZ_CODES')) {
      const row = state.codes.get(String(params[0]));
      return row ? ([row] as unknown as T[]) : [];
    }
    if (s.startsWith('UPDATE OAUTH_AUTHZ_CODES')) {
      // UPDATE oauth_authz_codes SET used_at = $1 WHERE code_hash = $2
      const row = state.codes.get(String(params[1]));
      if (row) row.used_at = Number(params[0]);
      return [];
    }
    // INSERT INTO oauth_refresh_tokens
    if (s.startsWith('INSERT INTO OAUTH_REFRESH_TOKENS')) {
      const row: OauthRefreshRow = {
        token_hash: String(params[0]),
        client_id: String(params[1]),
        user_id: String(params[2]),
        scope: params[3] === null ? null : String(params[3]),
        resource: params[4] === null ? null : String(params[4]),
        created_at: Number(params[5]),
        expires_at: Number(params[6]),
        rotated_at: null,
        family_id: String(params[7]),
        revoked_at: null,
        revoke_reason: null,
      };
      state.refresh.set(row.token_hash, row);
      return [];
    }
    if (s.startsWith('SELECT') && s.includes('FROM OAUTH_REFRESH_TOKENS')) {
      const row = state.refresh.get(String(params[0]));
      return row ? ([row] as unknown as T[]) : [];
    }
    // UPDATE oauth_refresh_tokens SET rotated_at = $1 WHERE token_hash = $2
    if (s.startsWith('UPDATE OAUTH_REFRESH_TOKENS SET ROTATED_AT')) {
      const row = state.refresh.get(String(params[1]));
      if (row) row.rotated_at = Number(params[0]);
      return [];
    }
    // UPDATE oauth_refresh_tokens SET revoked_at = $1, revoke_reason = ... WHERE family_id = $2 AND revoked_at IS NULL
    if (
      s.startsWith('UPDATE OAUTH_REFRESH_TOKENS') &&
      s.includes('REVOKED_AT') &&
      s.includes('FAMILY_ID')
    ) {
      const familyId = String(params[1]);
      const reason = s.includes("'REPLAY_DETECT'")
        ? 'replay_detect'
        : s.includes("'CLIENT_REVOKE'")
          ? 'client_revoke'
          : 'admin_revoke';
      for (const row of state.refresh.values()) {
        if (row.family_id === familyId && row.revoked_at === null) {
          row.revoked_at = Number(params[0]);
          row.revoke_reason = reason;
        }
      }
      return [];
    }
    // AS-3: SELECT external_id, email FROM users WHERE id = $1 — IdP-Claims-Lookup.
    if (s.startsWith('SELECT EXTERNAL_ID, EMAIL FROM USERS')) {
      const row = state.users.get(String(params[0]));
      if (!row) return [];
      return [
        { external_id: row.external_id ?? null, email: row.email ?? null },
      ] as unknown as T[];
    }
    // audit_log insert — swallow + record action
    if (s.startsWith('INSERT INTO AUDIT_LOG')) {
      state.auditEvents.push({
        action: String(params[0]),
        result: String(params[3]),
      });
      return [];
    }
    // No-op default.
    return [];
  };

  const raw = {
    dialect: 'postgres' as const,
    drizzle: {},
    query: runQuery,
  };

  const scoped = {
    userId: 'stub',
    dialect: 'postgres' as const,
    drizzle: {},
    query: runQuery,
  };

  return {
    dialect: 'postgres' as const,
    async scoped() {
      return scoped;
    },
    unsafe() {
      return raw;
    },
    async transaction<T>(_uid: string, fn: (tx: typeof scoped, ctx: { userId: string; dialect: 'postgres' }) => Promise<T>): Promise<T> {
      return fn(scoped, { userId: 'stub', dialect: 'postgres' });
    },
    async migrate() {
      return;
    },
    async close() {
      return;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeStubConfig(): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    ORIGIN: 'https://mcp.example.test',
    DATABASE_URL: 'postgres://stub',
    DATABASE_DIALECT: 'postgres',
    JWT_SECRET: 'x'.repeat(48),
    JWT_ISSUER: 'mcp-approval2',
    JWT_AUDIENCE: 'mcp-approval2-api',
    SESSION_TTL_SEC: 1800,
    REFRESH_TTL_SEC: 30 * 24 * 60 * 60,
    GOOGLE_CLIENT_ID: 'stub',
    GOOGLE_CLIENT_SECRET: 'stub',
    GOOGLE_REDIRECT_URI: 'http://localhost:8787/auth/google/callback',
    RP_ID: 'localhost',
    RP_NAME: 'mcp-approval2',
    RP_ORIGIN: 'http://localhost:8787',
    INVITE_TTL_SEC: 24 * 60 * 60,
    RECOVERY_TTL_SEC: 24 * 60 * 60,
    ALLOWED_ORIGINS: [],
    GOOGLE_ALLOWED_AUDIENCES: [],
  };
}

function freshState(): StubState {
  return {
    clients: new Map(),
    codes: new Map(),
    refresh: new Map(),
    users: new Map(),
    auditEvents: [],
  };
}

// PKCE-S256 helper
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function buildApp(state: StubState): Promise<Hono<AppBindings>> {
  const server: ServerContext = { config: makeStubConfig(), db: makeStubDb(state) };
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-req');
    await next();
  });
  app.route('/', oauthRoutes(server));
  return app;
}

// ----------------------------------------------------------------------------

describe('OAuth Authorization-Server', () => {
  let state: StubState;
  let app: Hono<AppBindings>;
  const userId = '11111111-2222-3333-4444-555555555555';

  beforeEach(async () => {
    state = freshState();
    state.users.set(userId, { id: userId, email: 'user@example.com', role: 'member' });
    app = await buildApp(state);
  });

  it('serves valid RFC 8414 discovery JSON', async () => {
    const res = await app.request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuthorizationServerMetadata;
    expect(body.issuer).toBe('https://mcp.example.test');
    expect(body.authorization_endpoint).toBe('https://mcp.example.test/oauth/authorize');
    expect(body.token_endpoint).toBe('https://mcp.example.test/oauth/token');
    expect(body.registration_endpoint).toBe('https://mcp.example.test/oauth/register');
    expect(body.revocation_endpoint).toBe('https://mcp.example.test/oauth/revoke');
    expect(body.jwks_uri).toBe('https://mcp.example.test/.well-known/jwks.json');
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.response_types_supported).toEqual(['code']);
    expect(body.grant_types_supported).toContain('authorization_code');
    expect(body.grant_types_supported).toContain('refresh_token');
  });

  it('exposes empty JWKS for HS256 phase', async () => {
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys).toHaveLength(0);
  });

  it('DCR: registers a new client + returns valid client_id', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://client.example.test/cb'],
        client_name: 'TestClient',
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ClientRegistrationResponse;
    expect(body.client_id).toBeTruthy();
    expect(body.client_secret).toBeTruthy();
    expect(body.registration_access_token).toBeTruthy();
    expect(body.redirect_uris).toEqual(['https://client.example.test/cb']);
    expect(body.grant_types).toContain('authorization_code');
    expect(state.clients.get(body.client_id)).toBeDefined();
  });

  it('DCR rejects malformed redirect_uris', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['not a url'] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('Authorize: full code-exchange flow returns valid JWT with aud claim', async () => {
    // 1. Register client
    const regRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://client.example.test/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    const reg = (await regRes.json()) as ClientRegistrationResponse;
    const clientId = reg.client_id;
    const clientSecret = reg.client_secret!;
    expect(clientSecret).toBeTruthy();

    // 2. Authorize (user logged in via session JWT in Bearer header)
    const cfg = makeStubConfig();
    const principal: SessionPrincipal = {
      userId,
      email: 'user@example.com',
      role: 'member',
      sessionId: 'sess-1',
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 1800,
    };
    const { token: sessionJwt } = await issueSessionJwt(
      { userId: principal.userId, email: principal.email, role: principal.role, sessionId: principal.sessionId },
      cfg,
    );
    const { verifier, challenge } = pkcePair();
    const url =
      '/oauth/authorize?' +
      new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://client.example.test/cb',
        scope: 'mcp:tools',
        state: 'xyz',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'https://api.example.test',
      }).toString();
    const authzRes = await app.request(url, {
      headers: { authorization: `Bearer ${sessionJwt}` },
    });
    expect(authzRes.status).toBe(302);
    const loc = authzRes.headers.get('location') ?? '';
    expect(loc).toMatch(/^https:\/\/client\.example\.test\/cb\?/);
    const redirectUrl = new URL(loc);
    const code = redirectUrl.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get('state')).toBe('xyz');

    // 3. Token-Exchange
    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'https://client.example.test/cb',
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
    };
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.expires_in).toBeGreaterThan(0);
    expect(tokenBody.refresh_token).toBeTruthy();

    // 4. Validate access-token (HS256) + verify aud claim
    const secret = new TextEncoder().encode(cfg.JWT_SECRET);
    const { payload } = await jwtVerify(tokenBody.access_token, secret, {
      issuer: 'https://mcp.example.test',
      audience: 'https://api.example.test',
      algorithms: ['HS256'],
    });
    expect(payload.sub).toBe(userId);
    expect(payload.aud).toBe('https://api.example.test');
    expect(payload['client_id']).toBe(clientId);
    expect(payload['scope']).toBe('mcp:tools');
    // AS-3: ohne external_id (legacy-User ohne IdP-Link): keine IdP-Claims.
    expect(payload['idp']).toBeUndefined();
    expect(payload['idp_sub']).toBeUndefined();
  });

  it('AS-3: Token includes idp=google + idp_sub + email when user has external_id', async () => {
    // Pre-arrange: User mit external_id (Google-IdP-Linked).
    const googleSub = '110248495921238';
    state.users.set(userId, {
      id: userId,
      email: 'axel@example.com',
      role: 'member',
      external_id: googleSub,
    });

    // DCR registration
    const regRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://client.example.test/cb'],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    });
    const reg = (await regRes.json()) as ClientRegistrationResponse;
    const clientId = reg.client_id;
    const clientSecret = reg.client_secret;
    expect(clientId).toBeTruthy();
    expect(clientSecret).toBeTruthy();

    const cfg = makeStubConfig();
    const { token: sessionJwt } = await issueSessionJwt(
      { userId, email: 'axel@example.com', role: 'member', sessionId: 'sess-1' },
      cfg,
    );
    const { verifier, challenge } = pkcePair();
    const authzUrl =
      '/oauth/authorize?' +
      new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://client.example.test/cb',
        scope: 'mcp:tools',
        state: 's',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'https://api.example.test',
      }).toString();
    const authzRes = await app.request(authzUrl, {
      headers: { authorization: `Bearer ${sessionJwt}` },
    });
    expect(authzRes.status).toBe(302);
    const code = new URL(authzRes.headers.get('location') ?? '').searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'https://client.example.test/cb',
        client_id: clientId,
        client_secret: clientSecret!,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as { access_token: string };
    const secret = new TextEncoder().encode(cfg.JWT_SECRET);
    const { payload } = await jwtVerify(tokenBody.access_token, secret, {
      issuer: 'https://mcp.example.test',
      audience: 'https://api.example.test',
      algorithms: ['HS256'],
    });
    expect(payload['idp']).toBe('google');
    expect(payload['idp_sub']).toBe(googleSub);
    expect(payload['email']).toBe('axel@example.com');
  });

  it('Token: rejects wrong PKCE-verifier', async () => {
    // Register + authorize + try token-exchange with wrong verifier.
    const regRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://c/cb'], token_endpoint_auth_method: 'none' }),
    });
    const reg = (await regRes.json()) as ClientRegistrationResponse;
    const cfg = makeStubConfig();
    const { token: sessionJwt } = await issueSessionJwt(
      { userId, email: 'u', role: 'member', sessionId: 's' },
      cfg,
    );
    const { challenge } = pkcePair();
    const authzRes = await app.request(
      '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: reg.client_id,
          redirect_uri: 'https://c/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString(),
      { headers: { authorization: `Bearer ${sessionJwt}` } },
    );
    const code = new URL(authzRes.headers.get('location')!).searchParams.get('code')!;
    const wrongVerifier = randomBytes(32).toString('base64url');
    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://c/cb',
        client_id: reg.client_id,
        code_verifier: wrongVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
    const body = (await tokenRes.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  it('Refresh: rotates on use — old token revoked', async () => {
    // Setup: full code-flow → obtain refresh_token.
    const cfg = makeStubConfig();
    const regRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://c/cb'], token_endpoint_auth_method: 'none' }),
    });
    const reg = (await regRes.json()) as ClientRegistrationResponse;
    const { token: sessionJwt } = await issueSessionJwt(
      { userId, email: 'u', role: 'member', sessionId: 's' },
      cfg,
    );
    const { verifier, challenge } = pkcePair();
    const authzRes = await app.request(
      '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: reg.client_id,
          redirect_uri: 'https://c/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString(),
      { headers: { authorization: `Bearer ${sessionJwt}` } },
    );
    const code = new URL(authzRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://c/cb',
        client_id: reg.client_id,
        code_verifier: verifier,
      }).toString(),
    });
    const t1 = (await tokenRes.json()) as { refresh_token: string };
    expect(t1.refresh_token).toBeTruthy();

    // Refresh once → new pair.
    const refreshRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t1.refresh_token,
        client_id: reg.client_id,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const t2 = (await refreshRes.json()) as { refresh_token: string };
    expect(t2.refresh_token).toBeTruthy();
    expect(t2.refresh_token).not.toBe(t1.refresh_token);

    // Verify state: t1 has rotated_at set, t2 does not.
    const h1 = createHash('sha256').update(t1.refresh_token).digest('hex');
    const h2 = createHash('sha256').update(t2.refresh_token).digest('hex');
    expect(state.refresh.get(h1)?.rotated_at).not.toBeNull();
    expect(state.refresh.get(h2)?.rotated_at).toBeNull();
  });

  it('Refresh-Replay: old token reused → whole family revoked', async () => {
    const cfg = makeStubConfig();
    const regRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://c/cb'], token_endpoint_auth_method: 'none' }),
    });
    const reg = (await regRes.json()) as ClientRegistrationResponse;
    const { token: sessionJwt } = await issueSessionJwt(
      { userId, email: 'u', role: 'member', sessionId: 's' },
      cfg,
    );
    const { verifier, challenge } = pkcePair();
    const authzRes = await app.request(
      '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: reg.client_id,
          redirect_uri: 'https://c/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString(),
      { headers: { authorization: `Bearer ${sessionJwt}` } },
    );
    const code = new URL(authzRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://c/cb',
        client_id: reg.client_id,
        code_verifier: verifier,
      }).toString(),
    });
    const t1 = (await tokenRes.json()) as { refresh_token: string };

    // First refresh — succeeds.
    await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t1.refresh_token,
        client_id: reg.client_id,
      }).toString(),
    });

    // Second refresh of t1 (replay!) — should fail + revoke family.
    const replayRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t1.refresh_token,
        client_id: reg.client_id,
      }).toString(),
    });
    expect(replayRes.status).toBe(400);
    const body = (await replayRes.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');

    // All refresh rows in family should be revoked now.
    for (const row of state.refresh.values()) {
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoke_reason).toBe('replay_detect');
    }

    // Audit event recorded.
    const replayAudit = state.auditEvents.find((e) => e.action === 'oauth.refresh_replay');
    expect(replayAudit).toBeDefined();
  });

  it('Revoke: revokes refresh-token family', async () => {
    const cfg = makeStubConfig();
    const regRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://c/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    const reg = (await regRes.json()) as ClientRegistrationResponse;
    const { token: sessionJwt } = await issueSessionJwt(
      { userId, email: 'u', role: 'member', sessionId: 's' },
      cfg,
    );
    const { verifier, challenge } = pkcePair();
    const authzRes = await app.request(
      '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: reg.client_id,
          redirect_uri: 'https://c/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString(),
      { headers: { authorization: `Bearer ${sessionJwt}` } },
    );
    const code = new URL(authzRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://c/cb',
        client_id: reg.client_id,
        client_secret: reg.client_secret!,
        code_verifier: verifier,
      }).toString(),
    });
    const t1 = (await tokenRes.json()) as { refresh_token: string };

    const revokeRes = await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: t1.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: reg.client_id,
        client_secret: reg.client_secret!,
      }).toString(),
    });
    expect(revokeRes.status).toBe(200);

    // Token marked revoked.
    const h1 = createHash('sha256').update(t1.refresh_token).digest('hex');
    expect(state.refresh.get(h1)?.revoked_at).not.toBeNull();

    // Try to use revoked token — should fail.
    const reuseRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t1.refresh_token,
        client_id: reg.client_id,
        client_secret: reg.client_secret!,
      }).toString(),
    });
    expect(reuseRes.status).toBe(400);
  });

  it('Authorize: rejects unknown client_id', async () => {
    const cfg = makeStubConfig();
    const { token: sessionJwt } = await issueSessionJwt(
      { userId, email: 'u', role: 'member', sessionId: 's' },
      cfg,
    );
    const { challenge } = pkcePair();
    const res = await app.request(
      '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: 'nonexistent',
          redirect_uri: 'https://c/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString(),
      { headers: { authorization: `Bearer ${sessionJwt}` } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_client');
  });

  it('Authorize: rejects mismatched redirect_uri', async () => {
    const regRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://c/cb'], token_endpoint_auth_method: 'none' }),
    });
    const reg = (await regRes.json()) as ClientRegistrationResponse;
    const cfg = makeStubConfig();
    const { token: sessionJwt } = await issueSessionJwt(
      { userId, email: 'u', role: 'member', sessionId: 's' },
      cfg,
    );
    const { challenge } = pkcePair();
    const res = await app.request(
      '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: reg.client_id,
          redirect_uri: 'https://attacker.example/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString(),
      { headers: { authorization: `Bearer ${sessionJwt}` } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('Authorize: returns 401 with login_url when no session (JSON-Client)', async () => {
    const regRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://c/cb'], token_endpoint_auth_method: 'none' }),
    });
    const reg = (await regRes.json()) as ClientRegistrationResponse;
    const { challenge } = pkcePair();
    const res = await app.request(
      '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: reg.client_id,
          redirect_uri: 'https://c/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString(),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; login_url: string };
    expect(body.error).toBe('login_required');
    expect(body.login_url).toContain('/auth/google/start');
  });

  it('AS-3 Authorize: redirects 302 to /auth/google/start when browser (Accept: text/html)', async () => {
    const regRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://c/cb'], token_endpoint_auth_method: 'none' }),
    });
    const reg = (await regRes.json()) as ClientRegistrationResponse;
    const { challenge } = pkcePair();
    const authzUrl =
      '/oauth/authorize?' +
      new URLSearchParams({
        response_type: 'code',
        client_id: reg.client_id,
        redirect_uri: 'https://c/cb',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
    const res = await app.request(authzUrl, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/auth/google/start?return=');
    // return=<encoded original /oauth/authorize URL>
    const returnParam = new URL(loc, 'https://mcp.example.test').searchParams.get('return');
    expect(returnParam).toBeTruthy();
    expect(returnParam).toContain('/oauth/authorize');
  });

  it('buildDiscoveryMetadata trims trailing slash from origin', () => {
    const meta = buildDiscoveryMetadata('https://example.test/');
    expect(meta.issuer).toBe('https://example.test');
    expect(meta.authorization_endpoint).toBe('https://example.test/oauth/authorize');
  });
});
