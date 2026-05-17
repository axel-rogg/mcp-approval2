/**
 * Dynamic Client Registration (RFC 7591).
 *
 * POST /oauth/register
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4, MCP-Spec Nov 2025.
 *
 * SEC-005 (Phase A): /oauth/register ist per Default geschlossen. Operator
 * muss eines der drei Tore oeffnen:
 *
 *   1. `DCR_OPEN=true` — public-open (NICHT empfohlen, nur dev/test).
 *   2. `Authorization: Bearer <DCR_INITIAL_ACCESS_TOKEN>` — RFC 7591 §3
 *      Initial-Access-Token. Operator generiert das Token einmalig + verteilt
 *      es an Whitelist-of-MCP-Clients out-of-band.
 *   3. Logged-in-User-Session (Cookie ODER Bearer) — die PWA-User registriert
 *      einen Claude.ai-Client fuer sich selbst.
 *
 * Wenn KEINS davon: 403 `dcr_not_authorized`. Erfolgreiche Registrierung
 * wird audit-logged mit actor-userId (falls bekannt) + IP.
 *
 * redirect_uris-Validation:
 *   - https://... erlaubt (host kann via DCR_ALLOWED_REDIRECT_HOSTS gegated
 *     werden).
 *   - http://localhost:* + http://127.0.0.1:* + http://[::1]:* erlaubt
 *     (Loopback-only fuer Claude-Code-Desktop u.ae.).
 *   - Andere Schemes (javascript:, data:, file:, vbscript:) wie auch plain
 *     http:// auf non-loopback-Hosts werden abgelehnt.
 *
 * Wir generieren:
 *
 *   - `client_id`              — random UUID
 *   - `client_secret`          — random 32-byte base64url (NULL bei
 *                                 token_endpoint_auth_method='none')
 *   - `registration_access_token` — RFC 7592 Update/Delete-Token
 *
 * Validation (RFC 7591 §2.0):
 *   - redirect_uris: Pflicht, mind. 1, alle valid-URL, scheme/host nach
 *     SEC-005-Regel oben.
 *   - grant_types: optional, default ['authorization_code','refresh_token'].
 *     Allowed: ['authorization_code', 'refresh_token'].
 *   - response_types: optional. Allowed: ['code'].
 *   - token_endpoint_auth_method: 'client_secret_post'|'client_secret_basic'|'none'.
 */
import { Hono, type Context } from 'hono';
import { randomBytes, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getCookie } from 'hono/cookie';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { oauthError } from './errors.js';
import { emitAudit } from '../../services/audit.js';
import { verifySessionJwt } from '../../auth/session/issuer.js';
import type {
  ClientRegistrationResponse,
} from './types.js';

const ALLOWED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
const ALLOWED_AUTH_METHODS = ['client_secret_post', 'client_secret_basic', 'none'] as const;
const ALLOWED_RESPONSE_TYPES = ['code'] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * SEC-005: Schema-Level-Validierung der redirect_uris. Bewusst eng:
 *   - https:// auf beliebigem Host (Host-Allowlist greift in route-Layer).
 *   - http:// nur auf Loopback (localhost/127.0.0.1/[::1]).
 *   - alle anderen Schemes (javascript/data/file/vbscript/...) abgelehnt.
 *   - Fragment-Identifier (`#`) per RFC 6749 §3.1.2 verboten.
 */
function isAllowedRedirectUri(raw: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (u.hash !== '') {
    return { ok: false, reason: 'fragment identifier not allowed' };
  }
  if (u.protocol === 'https:') return { ok: true };
  if (u.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return { ok: true };
    return { ok: false, reason: 'plain http:// only allowed for loopback hosts' };
  }
  return { ok: false, reason: `scheme ${u.protocol} not allowed` };
}

const RegisterBodySchema = z
  .object({
    redirect_uris: z
      .array(z.string().url(), { invalid_type_error: 'redirect_uris must be array of URLs' })
      .min(1, 'redirect_uris must contain at least one URI'),
    grant_types: z
      .array(z.enum(ALLOWED_GRANT_TYPES))
      .optional()
      .default(['authorization_code', 'refresh_token']),
    response_types: z.array(z.enum(ALLOWED_RESPONSE_TYPES)).optional().default(['code']),
    scope: z.string().optional(),
    token_endpoint_auth_method: z
      .enum(ALLOWED_AUTH_METHODS)
      .optional()
      .default('client_secret_post'),
    client_name: z.string().min(1).max(200).optional(),
    client_uri: z.string().url().optional(),
    logo_uri: z.string().url().optional(),
    contacts: z.array(z.string().email()).optional(),
    software_id: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * Konstante-Zeit Vergleich fuer den initial_access_token. Beide Strings
 * werden auf gleiche Laenge gepadded vor dem timingSafeEqual.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve current user (from session JWT in Authorization-Bearer or
 * session_jwt cookie). Returns null if no valid session. Wird zum DCR-Gating
 * benutzt — wenn ein User eingeloggt ist, darf er sich Clients registrieren.
 */
async function resolveSessionUser(
  c: Context<AppBindings>,
  server: ServerContext,
): Promise<{ userId: string; email: string } | null> {
  const header = c.req.header('authorization');
  let token: string | null = null;
  if (header && header.toLowerCase().startsWith('bearer ')) {
    token = header.slice(7).trim();
  }
  if (!token) token = getCookie(c, 'session_jwt') ?? null;
  if (!token) return null;
  try {
    const principal = await verifySessionJwt(token, server.config);
    return { userId: principal.userId, email: principal.email };
  } catch {
    return null;
  }
}

export function registerRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post('/oauth/register', async (c) => {
    const config = server.config;
    const ip =
      c.req.header('fly-client-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      null;

    // SEC-005 Gating: bei geschlossener DCR muss ENTWEDER der
    // initial_access_token korrekt sein, ODER der Caller ein
    // logged-in-User-Session-Token mitbringen.
    let actorUserId: string | null = null;
    let gateMode: 'open' | 'token' | 'session' = 'open';
    if (!config.DCR_OPEN) {
      const auth = c.req.header('authorization');
      const bearer = auth && auth.toLowerCase().startsWith('bearer ')
        ? auth.slice(7).trim()
        : null;
      const expectedToken = config.DCR_INITIAL_ACCESS_TOKEN;

      let authorized = false;
      // 1. Initial-Access-Token-Pfad.
      if (expectedToken && bearer && tokensMatch(bearer, expectedToken)) {
        authorized = true;
        gateMode = 'token';
      }
      // 2. Logged-in-Session-Pfad.
      if (!authorized) {
        const user = await resolveSessionUser(c, server);
        if (user) {
          authorized = true;
          gateMode = 'session';
          actorUserId = user.userId;
        }
      }
      if (!authorized) {
        await emitAudit(server.db, {
          action: 'oauth.dcr.denied',
          actorUserId: null,
          result: 'failure',
          ...(ip ? { ip } : {}),
          details: {
            reason: 'no_initial_access_token_and_no_session',
            dcr_open: false,
          },
        }).catch(() => {
          /* audit failure non-fatal */
        });
        return oauthError(
          c,
          403,
          'invalid_token',
          'DCR closed: provide DCR_INITIAL_ACCESS_TOKEN bearer or sign in as a registered user',
        );
      }
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, 400, 'invalid_client_metadata', 'request body must be JSON');
    }
    const parsed = RegisterBodySchema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return oauthError(c, 400, 'invalid_client_metadata', msg);
    }
    const meta = parsed.data;

    // SEC-005 redirect_uri Scheme + Host-Allowlist-Check.
    const allowedHosts = config.DCR_ALLOWED_REDIRECT_HOSTS;
    for (const uri of meta.redirect_uris) {
      const check = isAllowedRedirectUri(uri);
      if (!check.ok) {
        return oauthError(
          c,
          400,
          'invalid_redirect_uri',
          `redirect_uri "${uri}" rejected: ${check.reason}`,
        );
      }
      if (allowedHosts.length > 0) {
        const host = new URL(uri).hostname.toLowerCase();
        if (!allowedHosts.includes(host) && !LOOPBACK_HOSTS.has(host)) {
          return oauthError(
            c,
            400,
            'invalid_redirect_uri',
            `redirect_uri host "${host}" not in DCR_ALLOWED_REDIRECT_HOSTS`,
          );
        }
      }
    }

    // Generate identity.
    const clientId = randomUUID();
    const isPublicClient = meta.token_endpoint_auth_method === 'none';
    const clientSecretRaw = isPublicClient ? null : randomBytes(32).toString('base64url');
    const clientSecretHash = clientSecretRaw
      ? createHash('sha256').update(clientSecretRaw).digest('hex')
      : null;
    const registrationAccessToken = randomBytes(32).toString('base64url');
    const registrationAccessTokenHash = createHash('sha256')
      .update(registrationAccessToken)
      .digest('hex');

    const createdAt = Date.now();

    // Persist via unsafe (Service-Rolle, kein User-Scope).
    const raw = server.db.unsafe('oauth_register_client');
    await raw.query(
      `INSERT INTO oauth_clients (
        client_id, client_secret_hash, redirect_uris, grant_types, scope,
        token_endpoint_auth_method, client_name, client_uri, logo_uri, contacts,
        software_id, registration_access_token_hash, created_at, expires_at,
        registration_source
      ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5,
                $6, $7, $8, $9, $10::jsonb,
                $11, $12, $13, NULL, 'dcr')`,
      [
        clientId,
        clientSecretHash,
        JSON.stringify(meta.redirect_uris),
        JSON.stringify(meta.grant_types),
        meta.scope ?? null,
        meta.token_endpoint_auth_method,
        meta.client_name ?? null,
        meta.client_uri ?? null,
        meta.logo_uri ?? null,
        meta.contacts ? JSON.stringify(meta.contacts) : null,
        meta.software_id ?? null,
        registrationAccessTokenHash,
        createdAt,
      ],
    );

    // SEC-005 audit: jede erfolgreiche Registration ist nachverfolgbar.
    await emitAudit(server.db, {
      action: 'oauth.dcr.registered',
      actorUserId,
      result: 'success',
      ...(ip ? { ip } : {}),
      details: {
        client_id: clientId,
        client_name: meta.client_name ?? null,
        redirect_uris: meta.redirect_uris,
        gate_mode: gateMode,
        token_endpoint_auth_method: meta.token_endpoint_auth_method,
      },
    }).catch(() => {
      /* audit failure non-fatal */
    });

    const response: ClientRegistrationResponse = {
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt / 1000),
      ...(clientSecretRaw
        ? {
            client_secret: clientSecretRaw,
            client_secret_expires_at: 0,
          }
        : {}),
      registration_access_token: registrationAccessToken,
      registration_client_uri: `${server.config.ORIGIN.replace(/\/$/, '')}/oauth/register/${clientId}`,
      redirect_uris: meta.redirect_uris,
      grant_types: meta.grant_types,
      token_endpoint_auth_method: meta.token_endpoint_auth_method,
      ...(meta.client_name !== undefined ? { client_name: meta.client_name } : {}),
      ...(meta.client_uri !== undefined ? { client_uri: meta.client_uri } : {}),
      ...(meta.logo_uri !== undefined ? { logo_uri: meta.logo_uri } : {}),
      ...(meta.contacts !== undefined ? { contacts: meta.contacts } : {}),
      ...(meta.software_id !== undefined ? { software_id: meta.software_id } : {}),
      ...(meta.scope !== undefined ? { scope: meta.scope } : {}),
    };

    return c.json(response, 201);
  });

  return app;
}
