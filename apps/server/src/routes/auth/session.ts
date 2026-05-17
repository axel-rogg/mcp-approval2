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
import { findUserByEmail } from '../../services/user.js';
import { authCookieOpts, deleteCookieOpts } from '../../lib/cookie.js';
import { resolveOrigin } from '../../lib/config.js';

export function sessionRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post('/auth/refresh', async (c) => {
    const refresh = getCookie(c, 'refresh_token');
    if (!refresh) throw HttpError.unauthorized('missing refresh cookie');
    const result = await rotateRefresh(server.db, server.config, refresh);
    // Wir brauchen email + role aus DB
    const userRow = await findUserByEmail(server.db, ''); // dummy; we re-fetch by id below
    void userRow;
    const raw = server.db.unsafe('refresh_lookup_user');
    const rows = await raw.query<{ email: string; role: 'admin' | 'member' }>(
      `SELECT email, role FROM users WHERE id = $1 LIMIT 1`,
      [result.userId],
    );
    const u = rows[0];
    if (!u) throw HttpError.unauthorized('user_missing');
    const { token, expiresAt } = await issueSessionJwt(
      { userId: result.userId, email: u.email, role: u.role, sessionId: result.sessionId },
      server.config,
    );
    const requestOrigin = resolveOrigin(c.req.raw, server.config);
    setCookie(c, 'refresh_token', result.newToken.rawToken, authCookieOpts(server.config, { maxAge: server.config.REFRESH_TTL_SEC, requestOrigin }));
    return c.json({ accessToken: token, expiresAt, sessionId: result.sessionId });
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
