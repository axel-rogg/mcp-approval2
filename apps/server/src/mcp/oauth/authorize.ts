/**
 * Authorization-Endpoint (OAuth 2.1 Authorization-Code-Flow + PKCE).
 *
 *   GET  /oauth/authorize         → Validation + Consent-UI / Auto-Approve
 *   POST /oauth/authorize         → User-Submit-Approve → Issue Code
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4.
 *
 * Flow:
 *   1. GET /oauth/authorize?response_type=code&client_id=...&redirect_uri=...
 *      &code_challenge=...&code_challenge_method=S256&scope=...&state=...
 *      &resource=...
 *   2. Validation:
 *      - client_id existiert + nicht expired.
 *      - redirect_uri EXACT-match in oauth_clients.redirect_uris.
 *      - response_type='code', code_challenge_method='S256'.
 *      - code_challenge >= 43 chars (PKCE-Spec base64url(SHA256)).
 *   3. Wenn User nicht eingeloggt: 401 mit `login_required` + Hint auf
 *      /auth/google/start?return=... — der Caller (PWA-Front) orchestriert.
 *      Phase 1 single-tenant: wir validieren Session via Bearer-Header oder
 *      via Cookie. Wenn weder noch: 401.
 *   4. Wenn eingeloggt: issue code, persist hash, redirect zu redirect_uri
 *      mit ?code=<raw>&state=<state> (browser-redirect 302).
 *
 * Hinweis: Eine echte Consent-UI (HTML-Page) ist in Phase 1 nicht im Scope —
 * Single-Tenant + Invite-gated heisst: User implizit zustimmend. Spaeter
 * koennen wir eine PWA-Approval-Surface davorhaengen (eigene Route, eigenes
 * Token-Round-Trip).
 */
import { Hono, type Context } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { oauthError } from './errors.js';
import { verifySessionJwt } from '../../auth/session/issuer.js';
import { getCookie } from 'hono/cookie';

const AUTHZ_CODE_TTL_MS = 60 * 1000; // 60s per RFC 7636

const QuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z
    .string()
    .min(43, 'code_challenge must be >= 43 chars (base64url-S256)')
    .max(128, 'code_challenge must be <= 128 chars'),
  code_challenge_method: z.literal('S256'),
  resource: z.string().url().optional(),
});

interface OauthClientRow {
  readonly clientId: string;
  readonly redirectUris: ReadonlyArray<string>;
  readonly expiresAt: number | null;
}

async function loadClient(
  server: ServerContext,
  clientId: string,
): Promise<OauthClientRow | null> {
  const raw = server.db.unsafe('oauth_authorize_load_client');
  const rows = await raw.query<{
    client_id: string;
    redirect_uris: ReadonlyArray<string> | string;
    expires_at: number | null;
  }>(
    `SELECT client_id, redirect_uris, expires_at
       FROM oauth_clients WHERE client_id = $1 LIMIT 1`,
    [clientId],
  );
  const row = rows[0];
  if (!row) return null;
  const uris =
    typeof row.redirect_uris === 'string'
      ? (JSON.parse(row.redirect_uris) as ReadonlyArray<string>)
      : row.redirect_uris;
  return {
    clientId: row.client_id,
    redirectUris: uris,
    expiresAt: row.expires_at,
  };
}

/**
 * Aktuelle User-Session aus Bearer-Header ODER Access-Token-Cookie aufloesen.
 * Returns null falls keine valide Session vorliegt.
 */
async function resolveCurrentUser(
  c: Context<AppBindings>,
  server: ServerContext,
): Promise<{ userId: string; email: string } | null> {
  const header = c.req.header('authorization');
  let token: string | null = null;
  if (header && header.toLowerCase().startsWith('bearer ')) {
    token = header.slice(7).trim();
  }
  if (!token) {
    // Fallback: same-origin browser flow — read session_jwt cookie if set
    // (Phase 1 hat keinen access-token-Cookie; placeholder fuer PWA-Future).
    token = getCookie(c, 'session_jwt') ?? null;
  }
  if (!token) return null;
  try {
    const principal = await verifySessionJwt(token, server.config);
    return { userId: principal.userId, email: principal.email };
  } catch {
    return null;
  }
}

export function authorizeRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/oauth/authorize', async (c) => {
    const queryRaw = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    const parsed = QuerySchema.safeParse(queryRaw);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return oauthError(c, 400, 'invalid_request', msg);
    }
    const q = parsed.data;

    const client = await loadClient(server, q.client_id);
    if (!client) return oauthError(c, 400, 'invalid_client', 'unknown client_id');
    if (client.expiresAt !== null && client.expiresAt < Date.now()) {
      return oauthError(c, 400, 'invalid_client', 'client registration expired');
    }
    if (!client.redirectUris.includes(q.redirect_uri)) {
      return oauthError(c, 400, 'invalid_redirect_uri', 'redirect_uri must exact-match a registered URI');
    }

    const user = await resolveCurrentUser(c, server);
    if (!user) {
      // MCP-Spec erlaubt 401 + Hint, der Client soll dann Browser-Flow starten.
      // Wir geben eine konkrete URL als Hint zurueck.
      const base = server.config.ORIGIN.replace(/\/$/, '');
      const returnTo = encodeURIComponent(c.req.url);
      return c.json(
        {
          error: 'login_required',
          error_description: 'user is not authenticated; redirect to login first',
          login_url: `${base}/auth/google/start?return=${returnTo}`,
        },
        401,
        { 'cache-control': 'no-store' },
      );
    }

    // Issue Code, persist hash, redirect.
    const rawCode = randomBytes(32).toString('base64url');
    const codeHash = createHash('sha256').update(rawCode).digest('hex');
    const now = Date.now();
    const expiresAt = now + AUTHZ_CODE_TTL_MS;

    const raw = server.db.unsafe('oauth_authorize_issue_code');
    await raw.query(
      `INSERT INTO oauth_authz_codes (
        code_hash, client_id, user_id, redirect_uri, scope, resource,
        code_challenge, code_challenge_method, created_at, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        codeHash,
        client.clientId,
        user.userId,
        q.redirect_uri,
        q.scope ?? null,
        q.resource ?? null,
        q.code_challenge,
        q.code_challenge_method,
        now,
        expiresAt,
      ],
    );

    const redirectUrl = new URL(q.redirect_uri);
    redirectUrl.searchParams.set('code', rawCode);
    if (q.state) redirectUrl.searchParams.set('state', q.state);
    return c.redirect(redirectUrl.toString(), 302);
  });

  return app;
}
