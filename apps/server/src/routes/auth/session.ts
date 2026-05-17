/**
 * Session-Routen — Refresh + Logout.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.5.
 */
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { auth } from '../../middleware/auth.js';
import { issueSessionJwt } from '../../auth/session/issuer.js';
import { rotateRefresh, revokeSession } from '../../auth/session/refresh.js';
import { authCookieOpts, deleteCookieOpts } from '../../lib/cookie.js';
import { resolveOrigin } from '../../lib/config.js';
import { withRequestId } from '../../lib/logger.js';

export function sessionRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post('/auth/refresh', async (c) => {
    const log = withRequestId(c.get('requestId'));
    const refresh = getCookie(c, 'refresh_token');
    const cookieHeader = c.req.header('cookie') ?? '';
    const cookieNames = cookieHeader
      .split(';')
      .map((p) => p.trim().split('=')[0])
      .filter(Boolean);
    log.info(
      {
        event: 'auth.refresh.in',
        host: new URL(c.req.url).host,
        hasRefreshCookie: !!refresh,
        refreshLen: refresh?.length ?? 0,
        cookieNames,
        origin: c.req.header('origin') ?? null,
      },
      'refresh.in',
    );
    if (!refresh) throw HttpError.unauthorized('missing refresh cookie');
    let result;
    try {
      result = await rotateRefresh(server.db, server.config, refresh);
    } catch (err) {
      log.warn(
        {
          event: 'auth.refresh.rotate_failed',
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        },
        'refresh.rotate_failed',
      );
      throw err;
    }
    const raw = server.db.unsafe('refresh_lookup_user');
    const rows = await raw.query<{ email: string; role: 'admin' | 'member' }>(
      `SELECT email, role FROM users WHERE id = $1 LIMIT 1`,
      [result.userId],
    );
    const u = rows[0];
    if (!u) {
      log.warn({ event: 'auth.refresh.user_missing', userId: result.userId }, 'refresh.user_missing');
      throw HttpError.unauthorized('user_missing');
    }
    const { token, expiresAt } = await issueSessionJwt(
      { userId: result.userId, email: u.email, role: u.role, sessionId: result.sessionId },
      server.config,
    );
    const requestOrigin = resolveOrigin(c.req.raw, server.config);
    setCookie(c, 'refresh_token', result.newToken.rawToken, authCookieOpts(server.config, { maxAge: server.config.REFRESH_TTL_SEC, requestOrigin }));
    log.info(
      { event: 'auth.refresh.ok', userId: result.userId, sessionId: result.sessionId },
      'refresh.ok',
    );
    return c.json({
      accessToken: token,
      expiresAt,
      sessionId: result.sessionId,
      // PWA-Convenience: user-Daten direkt mitgeben damit getSession nicht
      // mit leerem userId/email arbeitet (war Bug bevor Loading-Hang sichtbar
      // wurde).
      user: { id: result.userId, email: u.email, role: u.role },
    });
  });

  app.post('/auth/logout', auth(server), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    await revokeSession(server.db, {
      sessionId: principal.sessionId,
      userId: principal.userId,
      reason: 'logout',
    });
    const requestOrigin = resolveOrigin(c.req.raw, server.config);
    deleteCookie(c, 'refresh_token', deleteCookieOpts(server.config, { requestOrigin }));
    return c.json({ ok: true });
  });

  return app;
}
