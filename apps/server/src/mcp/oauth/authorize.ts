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
  readonly clientName: string | null;
  readonly redirectUris: ReadonlyArray<string>;
  readonly expiresAt: number | null;
  readonly registrationSource: string | null;
}

async function loadClient(
  server: ServerContext,
  clientId: string,
): Promise<OauthClientRow | null> {
  const raw = server.db.unsafe('oauth_authorize_load_client');
  const rows = await raw.query<{
    client_id: string;
    client_name: string | null;
    redirect_uris: ReadonlyArray<string> | string;
    expires_at: number | null;
    registration_source: string | null;
  }>(
    `SELECT client_id, client_name, redirect_uris, expires_at, registration_source
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
    clientName: row.client_name,
    redirectUris: uris,
    expiresAt: row.expires_at,
    registrationSource: row.registration_source,
  };
}

/**
 * SEC-005: prueft ob (userId, clientId) bereits eine Consent-Row hat.
 * Return-Wert true = User hat dem Client schon mal explizit zugestimmt.
 */
async function hasConsent(
  server: ServerContext,
  userId: string,
  clientId: string,
): Promise<boolean> {
  const scoped = await server.db.scoped(userId);
  const rows = await scoped.query<{ consentedAt: number }>(
    `SELECT consented_at AS "consentedAt"
       FROM oauth_client_consents
      WHERE user_id = $1 AND client_id = $2
      LIMIT 1`,
    [userId, clientId],
  );
  return rows.length > 0;
}

/**
 * Persist consent + return so naechster Authorize-Call durchfluschen kann.
 */
async function recordConsent(
  server: ServerContext,
  userId: string,
  clientId: string,
  scope: string | null,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  const scoped = await server.db.scoped(userId);
  await scoped.query(
    `INSERT INTO oauth_client_consents (user_id, client_id, scope_granted, consented_at, consented_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, client_id) DO UPDATE
       SET scope_granted = EXCLUDED.scope_granted,
           consented_at = EXCLUDED.consented_at,
           consented_ip = EXCLUDED.consented_ip,
           user_agent = EXCLUDED.user_agent`,
    [userId, clientId, scope, Date.now(), ip, userAgent],
  );
}

/**
 * Minimaler HTML-Consent-Renderer. Wir bauen kein Template-System dafuer —
 * inline-string mit HTML-Escape ueber den dynamischen Werten. Form posted
 * an /oauth/authorize mit allen Original-Query-Parametern + consent=allow.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderConsentHtml(args: {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  scope: string | null;
  state: string | null;
  codeChallenge: string;
  responseType: string;
  resource: string | null;
  userEmail: string;
}): string {
  const clientLabel = args.clientName
    ? `${escapeHtml(args.clientName)} (${escapeHtml(args.clientId)})`
    : escapeHtml(args.clientId);
  const scopeList = args.scope
    ? args.scope.split(/\s+/).filter(Boolean).map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('')
    : '<li><em>default scopes (server-defined)</em></li>';
  const hiddenFields = [
    ['client_id', args.clientId],
    ['redirect_uri', args.redirectUri],
    ['code_challenge', args.codeChallenge],
    ['code_challenge_method', 'S256'],
    ['response_type', args.responseType],
    ['scope', args.scope ?? ''],
    ['state', args.state ?? ''],
    ['resource', args.resource ?? ''],
    ['consent', 'allow'],
  ]
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k!)}" value="${escapeHtml(v!)}"/>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Authorize ${clientLabel}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 1.5rem; color: #1c1c1c; }
  h1 { font-size: 1.4rem; }
  .card { border: 1px solid #d8d8d8; border-radius: 8px; padding: 1.5rem; background: #fafafa; }
  .warn { background: #fff3cd; padding: 0.75rem; border-radius: 6px; font-size: 0.9rem; }
  ul { padding-left: 1.5rem; }
  button { padding: 0.5rem 1.5rem; margin-right: 0.5rem; font-size: 1rem; border-radius: 6px; cursor: pointer; border: 1px solid #c4c4c4; }
  .primary { background: #1f7a3a; color: white; border-color: #1f7a3a; }
  .secondary { background: #e1e1e1; }
  code { background: #eee; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style></head><body>
<h1>Authorize new application</h1>
<div class="card">
  <p>Signed in as <strong>${escapeHtml(args.userEmail)}</strong></p>
  <p>Application <strong>${clientLabel}</strong> is requesting access:</p>
  <ul>${scopeList}</ul>
  <p>Redirect destination after consent:<br/><code>${escapeHtml(args.redirectUri)}</code></p>
  <p class="warn">Only allow if you initiated this authorization yourself. Allowing gives the application long-lived API access on your behalf.</p>
  <form method="POST" action="/oauth/authorize">
${hiddenFields}
    <button type="submit" class="primary">Allow</button>
    <button type="submit" name="consent" value="deny" class="secondary" formnovalidate>Deny</button>
  </form>
</div>
</body></html>`;
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

/**
 * SEC-005 Helper: gemeinsame Code-Issue-Logik fuer GET (pre-consented) und
 * POST (just-consented). Schreibt den AuthZ-Code in die DB und redirected.
 */
async function issueCodeAndRedirect(
  c: Context<AppBindings>,
  server: ServerContext,
  q: z.infer<typeof QuerySchema>,
  client: OauthClientRow,
  user: { userId: string; email: string },
): Promise<Response> {
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
      // AS-3 (§1.1): Browser-Flow startet Google-IdP transparent. Wir
      // unterscheiden zwischen:
      //   - Browser/HTML-User-Agent (Accept enthaelt `text/html`): direkter
      //     302-Redirect zu /auth/google/start mit Return-URL → User klickt
      //     genau einmal "weiter mit Google", landet automatisch wieder hier.
      //   - Non-Browser-Caller (Claude.ai-MCP-Client): JSON-Hint mit
      //     `login_required` + `login_url`. Client orchestriert das selbst.
      //
      // Beide Pfade fuehren letztlich zu /auth/google/callback. Phase-A5
      // sorgt dafuer dass der callback die OAuth-Authorize-URL via
      // `?return=` als 302 fortsetzt (siehe routes/auth/google.ts).
      const base = server.config.ORIGIN.replace(/\/$/, '');
      const returnTo = encodeURIComponent(c.req.url);
      const loginUrl = `${base}/auth/google/start?return=${returnTo}`;

      const accept = c.req.header('accept') ?? '';
      const isBrowser = accept.includes('text/html');
      if (isBrowser) {
        return c.redirect(loginUrl, 302);
      }
      return c.json(
        {
          error: 'login_required',
          error_description: 'user is not authenticated; redirect to login first',
          login_url: loginUrl,
        },
        401,
        { 'cache-control': 'no-store' },
      );
    }

    // SEC-005: Consent-Check. Wenn der User dem Client noch nicht zugestimmt
    // hat, kommt KEIN automatischer Code-Issue. Browser-Caller sehen die
    // HTML-Consent-Page, Non-Browser-Clients bekommen JSON `consent_required`.
    // First-party-clients (registration_source != 'dcr') ueberspringen den
    // Consent-Schritt — DCR ist die Attack-Surface.
    const isDcr = client.registrationSource === 'dcr';
    const alreadyConsented = isDcr
      ? await hasConsent(server, user.userId, client.clientId)
      : true;
    if (!alreadyConsented) {
      const accept = c.req.header('accept') ?? '';
      const isBrowser = accept.includes('text/html');
      if (isBrowser) {
        const html = renderConsentHtml({
          clientId: client.clientId,
          clientName: client.clientName,
          redirectUri: q.redirect_uri,
          scope: q.scope ?? null,
          state: q.state ?? null,
          codeChallenge: q.code_challenge,
          responseType: q.response_type,
          resource: q.resource ?? null,
          userEmail: user.email,
        });
        return c.html(html, 200, { 'cache-control': 'no-store' });
      }
      return c.json(
        {
          error: 'consent_required',
          error_description: `user has not consented to client ${client.clientId}; redirect to /oauth/authorize via a browser`,
        },
        401,
        { 'cache-control': 'no-store' },
      );
    }

    return issueCodeAndRedirect(c, server, q, client, user);
  });

  // SEC-005 POST handler: form-submit aus der HTML-Consent-Page.
  // Akzeptiert dieselben Felder wie GET +
  //   consent=allow|deny — wenn deny: redirect mit error=access_denied.
  //   wenn allow: schreibt Consent-Row + delegiert an issueCodeAndRedirect.
  app.post('/oauth/authorize', async (c) => {
    const formRaw = await c.req.formData().catch(() => null);
    if (!formRaw) return oauthError(c, 400, 'invalid_request', 'form body required');
    const formObj: Record<string, string> = {};
    formRaw.forEach((v, k) => {
      if (typeof v === 'string') formObj[k] = v;
    });
    // Empty strings (aus hidden inputs) wieder zu undefined konvertieren,
    // damit das Schema die Default-Logik anwendet.
    for (const k of ['scope', 'state', 'resource']) {
      if (formObj[k] === '') delete formObj[k];
    }

    const consentValue = formObj['consent'] ?? '';
    const parsed = QuerySchema.safeParse(formObj);
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
      return oauthError(c, 401, 'login_required', 'session expired during consent — please re-login');
    }

    if (consentValue === 'deny') {
      // Per OAuth 2.1 §5.2: User-Cancel-Path redirected mit error=access_denied
      // an die registrierte redirect_uri (NICHT an attacker.com — wir haben
      // ja schon validiert dass q.redirect_uri in client.redirectUris ist).
      const u = new URL(q.redirect_uri);
      u.searchParams.set('error', 'access_denied');
      u.searchParams.set(
        'error_description',
        'The user denied the authorization request.',
      );
      if (q.state) u.searchParams.set('state', q.state);
      return c.redirect(u.toString(), 302);
    }

    if (consentValue !== 'allow') {
      return oauthError(c, 400, 'invalid_request', 'consent must be "allow" or "deny"');
    }

    // Allow → Consent-Row schreiben + Code ausstellen.
    const ip =
      c.req.header('fly-client-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      null;
    const ua = c.req.header('user-agent') ?? null;
    await recordConsent(server, user.userId, client.clientId, q.scope ?? null, ip, ua);
    return issueCodeAndRedirect(c, server, q, client, user);
  });

  return app;
}
