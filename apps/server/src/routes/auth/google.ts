/**
 * Google OAuth-Routen.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.2, §3.3.
 *
 *   GET  /auth/google/start          — Redirect zu Google + State-Cookie
 *   GET  /auth/google/callback       — Code-Exchange + User-Resolve + Session
 *
 * Carry-Through fuer Invite-Token: query-parameter `invite=<rawToken>` wird
 * im State-Cookie zusammen mit `state` und `nonce` mitgefuehrt.
 */
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { authCookieOpts, deleteCookieOpts } from '../../lib/cookie.js';
import { GoogleOAuthProvider } from '../../auth/idp/google.js';
import { acceptInvite } from '../../auth/invite/accept.js';
import { bootstrapIfNeeded } from '../../auth/bootstrap.js';
import { findUserByExternalId, findUserByEmail, touchLastLogin } from '../../services/user.js';
import { issueSessionJwt } from '../../auth/session/issuer.js';
import { issueInitialRefresh } from '../../auth/session/refresh.js';
import { emitAudit } from '../../services/audit.js';

const STATE_COOKIE = 'oauth_state';

interface StateCookiePayload {
  readonly state: string;
  readonly nonce: string;
  readonly inviteToken?: string;
  /**
   * AS-3 (§1.1): Wenn `/oauth/authorize` einen Browser-Caller ohne Session
   * sah und auf `/auth/google/start?return=<authz-url>` weitergeleitet hat,
   * tragen wir die return-URL hier mit, damit der Callback den User nach
   * Session-Erstellung wieder auf den OAuth-Authorize-Flow zurueckwirft.
   *
   * Nur same-origin URLs werden akzeptiert (Open-Redirect-Schutz im Callback).
   */
  readonly returnTo?: string;
}

export function googleAuthRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const idp = new GoogleOAuthProvider(server.config);

  app.get('/auth/google/start', async (c) => {
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const inviteToken = c.req.query('invite');
    // AS-3 (§1.1): nimm `?return=<path>` mit ins State-Cookie. NUR same-
    // origin Pfade — kein Open-Redirect erlauben (auch keine externen
    // Hostnames wenn der Caller das durchgeschmuggelt hat).
    const returnRaw = c.req.query('return');
    let returnTo: string | undefined;
    if (returnRaw) {
      try {
        // Decode wenn vom Authorize-Endpoint encoded uebergeben.
        const decoded = decodeURIComponent(returnRaw);
        if (isSafeReturnPath(decoded, server.config.ORIGIN)) {
          returnTo = decoded;
        }
      } catch {
        // ignore — kein returnTo
      }
    }
    const payload: StateCookiePayload = {
      state,
      nonce,
      ...(inviteToken ? { inviteToken } : {}),
      ...(returnTo ? { returnTo } : {}),
    };
    setCookie(c, STATE_COOKIE, JSON.stringify(payload), authCookieOpts(server.config, { maxAge: 10 * 60 }));
    const startArgs = inviteToken ? { state, nonce, inviteToken } : { state, nonce };
    const { authorizationUrl } = await idp.start(startArgs);
    return c.redirect(authorizationUrl);
  });

  app.get('/auth/google/callback', async (c) => {
    const code = c.req.query('code');
    const stateQ = c.req.query('state');
    const error = c.req.query('error');
    if (error) throw HttpError.badRequest('invalid_request', `google oauth error: ${error}`);
    if (!code || !stateQ) throw HttpError.badRequest('invalid_request', 'missing code/state');

    const cookieRaw = getCookie(c, STATE_COOKIE);
    if (!cookieRaw) throw HttpError.badRequest('invalid_request', 'missing oauth state cookie');
    let stateCookie: StateCookiePayload;
    try {
      stateCookie = JSON.parse(cookieRaw) as StateCookiePayload;
    } catch {
      throw HttpError.badRequest('invalid_request', 'corrupt oauth state cookie');
    }
    deleteCookie(c, STATE_COOKIE, deleteCookieOpts(server.config));

    const profile = await idp.complete({
      code,
      state: stateQ,
      expectedState: stateCookie.state,
      nonce: stateCookie.nonce,
    });

    // Auflosung: existierender User? Invite? Bootstrap?
    let userId: string;
    let role: 'admin' | 'member';

    const existingByExt = await findUserByExternalId(server.db, profile.externalId);
    if (existingByExt && existingByExt.status === 'active') {
      userId = existingByExt.id;
      role = existingByExt.role;
    } else {
      const existingByEmail = await findUserByEmail(server.db, profile.email);
      if (stateCookie.inviteToken) {
        const accepted = await acceptInvite(server.db, server.config, {
          rawToken: stateCookie.inviteToken,
          externalId: profile.externalId,
          email: profile.email,
          displayName: profile.displayName,
        });
        userId = accepted.userId;
        role = accepted.role;
      } else if (existingByEmail && existingByEmail.status === 'active') {
        // Email-Match ohne externalId → erste Verknuepfung
        const raw = server.db.unsafe('link_external_id');
        await raw.query(
          `UPDATE users SET external_id = $1, last_login_at = $2 WHERE id = $3`,
          [profile.externalId, Date.now(), existingByEmail.id],
        );
        userId = existingByEmail.id;
        role = existingByEmail.role;
      } else {
        // Bootstrap-Versuch
        const bs = await bootstrapIfNeeded(server.db, {
          externalId: profile.externalId,
          email: profile.email,
          displayName: profile.displayName,
        });
        userId = bs.userId;
        role = bs.role;
      }
    }

    // Sitzung erstellen
    const now = Date.now();
    const expiresAt = now + server.config.SESSION_TTL_SEC * 1000;
    // INET-Column erwartet single-IP, kein CSV. Hinter Fly + CF kommen
    // mehrere Hops in X-Forwarded-For ("client, cf-edge, fly-edge"). Fly
    // setzt zusaetzlich Fly-Client-IP (immer single IP, vom Edge gepruefte
    // Originator-IP) — bevorzugen wir.
    const flyIp = c.req.header('fly-client-ip');
    const xffFirst = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    const ip = flyIp ?? xffFirst ?? null;
    const ua = c.req.header('user-agent') ?? null;
    const raw = server.db.unsafe('create_session');
    const sessions = await raw.query<{ id: string }>(
      `INSERT INTO sessions (user_id, created_at, expires_at, device_id, ip, user_agent, last_seen_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $2) RETURNING id`,
      [userId, now, expiresAt, ip, ua],
    );
    const sessionId = sessions[0]?.id;
    if (!sessionId) throw new Error('failed to create session row');

    const { token: accessToken, expiresAt: accessExp } = await issueSessionJwt(
      { userId, email: profile.email, role, sessionId },
      server.config,
    );
    const refresh = await issueInitialRefresh(server.db, server.config, { sessionId, userId });

    await touchLastLogin(server.db, userId);
    await emitAudit(server.db, {
      action: 'auth.login',
      actorUserId: userId,
      result: 'success',
      details: { sessionId, idp: 'google' },
    });

    // Refresh-Token als HTTP-only-Cookie
    setCookie(c, 'refresh_token', refresh.rawToken, authCookieOpts(server.config, { maxAge: server.config.REFRESH_TTL_SEC }));

    // AS-3 (§1.1): wenn die Login-Start-Phase eine `returnTo` mitgegeben
    // hat (z.B. /oauth/authorize-Browser-Flow), redirect dorthin nach
    // Session-Bake. Wir setzen ein same-origin-Session-Cookie (`session_jwt`)
    // damit der nachgelagerte Authorize-Endpoint den User wiedererkennt.
    if (stateCookie.returnTo && isSafeReturnPath(stateCookie.returnTo, server.config.ORIGIN)) {
      setCookie(c, 'session_jwt', accessToken, authCookieOpts(server.config, { maxAge: server.config.SESSION_TTL_SEC }));
      return c.redirect(stateCookie.returnTo, 302);
    }

    return c.json({
      accessToken,
      expiresAt: accessExp,
      sessionId,
      user: { id: userId, email: profile.email, role },
    });
  });

  return app;
}

/**
 * Sicherheits-Check fuer `?return=<path>`-Carry-Throughs (AS-3).
 *
 * Wir akzeptieren NUR:
 *   - Absolute URLs deren Origin == config.ORIGIN (same-origin)
 *   - Pfade die mit `/` beginnen und KEIN Backslash- oder Whitespace-Trick enthalten
 *
 * Alles andere (externe Hosts, `javascript:`-URLs, Whitespace-Smuggling) wird
 * verworfen — kein Open-Redirect.
 */
function isSafeReturnPath(candidate: string, origin: string): boolean {
  if (!candidate || candidate.length > 2048) return false;
  // Reject Control-Chars + Whitespace-Smuggling.
  if (/[\s\x00-\x1f\x7f]/.test(candidate)) return false;
  // Same-origin absolute URL?
  try {
    const url = new URL(candidate);
    const allow = new URL(origin);
    return url.origin === allow.origin;
  } catch {
    // Relative path: muss mit '/' starten, darf nicht protocol-relative sein.
    return candidate.startsWith('/') && !candidate.startsWith('//');
  }
}
