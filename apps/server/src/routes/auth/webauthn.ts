/**
 * WebAuthn / Passkey-Routen.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.4.
 *
 *   POST /auth/webauthn/enroll/begin   — User logged in via OAuth, enroll first passkey
 *   POST /auth/webauthn/enroll/finish  — Verify attestation, persist credential
 *   POST /auth/webauthn/login/begin    — { email? } → options + challenge
 *   POST /auth/webauthn/login/finish   — assertion → session
 *
 * Challenges werden serverseitig in `webauthn_challenges` (Tabelle vom Schema-
 * Layer) gespeichert mit TTL 5 min. Vor Implementation der Tabelle nutzen wir
 * In-Memory-Map (siehe `challengeStore` — Phase 1 minimal, NICHT prod-ready
 * fuer multi-instance).
 */
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { auth } from '../../middleware/auth.js';
import { beginRegistration, finishRegistration } from '../../auth/webauthn/registration.js';
import { beginAuthentication, finishAuthentication } from '../../auth/webauthn/authentication.js';
import { issueSessionJwt } from '../../auth/session/issuer.js';
import { issueInitialRefresh } from '../../auth/session/refresh.js';
import { setCookie } from 'hono/cookie';
import { findUserByEmail } from '../../services/user.js';

/**
 * Minimaler In-Memory-Challenge-Store. PRODUCTION-TODO: in DB persistieren.
 * Single-Instance-only.
 */
const challengeStore = new Map<string, { challenge: string; userId: string | null; expiresAt: number }>();

function putChallenge(key: string, challenge: string, userId: string | null): void {
  challengeStore.set(key, { challenge, userId, expiresAt: Date.now() + 5 * 60 * 1000 });
}

function takeChallenge(key: string): { challenge: string; userId: string | null } | null {
  const v = challengeStore.get(key);
  if (!v) return null;
  challengeStore.delete(key);
  if (v.expiresAt < Date.now()) return null;
  return { challenge: v.challenge, userId: v.userId };
}

const finishRegSchema = z.object({
  challengeId: z.string().min(1),
  response: z.unknown(),
});

const loginBeginSchema = z.object({
  email: z.string().email().optional(),
});

const loginFinishSchema = z.object({
  challengeId: z.string().min(1),
  response: z.unknown(),
});

export function webauthnRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // -- Enrollment (requires existing session) ------------------------------
  app.post('/auth/webauthn/enroll/begin', auth(server), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const prfSalt = randomBytes(32);
    const { options, challenge } = await beginRegistration(server.config, {
      userId: principal.userId,
      email: principal.email,
      displayName: principal.email,
      prfSalt,
    });
    const challengeId = randomBytes(16).toString('base64url');
    putChallenge(`reg:${challengeId}`, challenge, principal.userId);
    return c.json({ challengeId, options, prfSalt: Buffer.from(prfSalt).toString('base64url') });
  });

  app.post(
    '/auth/webauthn/enroll/finish',
    auth(server),
    zValidator('json', finishRegSchema),
    async (c) => {
      const principal = c.get('user');
      if (!principal) throw HttpError.unauthorized();
      const body = c.req.valid('json');
      const stored = takeChallenge(`reg:${body.challengeId}`);
      if (!stored) throw HttpError.badRequest('webauthn_challenge_mismatch', 'challenge expired or unknown');
      if (stored.userId !== principal.userId) {
        throw HttpError.forbidden('challenge userId mismatch');
      }
      const result = await finishRegistration(server.config, server.db, {
        userId: principal.userId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: body.response as any,
        expectedChallenge: stored.challenge,
      });
      return c.json({
        credentialId: result.credentialId,
        prfSupported: result.prfSupported,
        transports: result.transports,
      });
    },
  );

  // -- Login ---------------------------------------------------------------
  app.post('/auth/webauthn/login/begin', zValidator('json', loginBeginSchema), async (c) => {
    const body = c.req.valid('json');
    let userId: string | undefined;
    if (body.email) {
      const u = await findUserByEmail(server.db, body.email);
      if (u && u.status === 'active') userId = u.id;
    }
    const { options, challenge } = await beginAuthentication(
      server.config,
      server.db,
      userId ? { userId } : {},
    );
    const challengeId = randomBytes(16).toString('base64url');
    putChallenge(`login:${challengeId}`, challenge, userId ?? null);
    return c.json({ challengeId, options });
  });

  app.post(
    '/auth/webauthn/login/finish',
    zValidator('json', loginFinishSchema),
    async (c) => {
      const body = c.req.valid('json');
      const stored = takeChallenge(`login:${body.challengeId}`);
      if (!stored) throw HttpError.badRequest('webauthn_challenge_mismatch', 'challenge expired or unknown');

      const result = await finishAuthentication(server.config, server.db, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: body.response as any,
        expectedChallenge: stored.challenge,
      });

      // User-Row laden
      const raw = server.db.unsafe('webauthn_login_get_user');
      const rows = await raw.query<{ email: string; role: 'admin' | 'member' }>(
        `SELECT email, role FROM users WHERE id = $1 AND status = 'active' LIMIT 1`,
        [result.userId],
      );
      const u = rows[0];
      if (!u) throw HttpError.unauthorized('user_inactive');

      // Session erstellen
      const now = Date.now();
      const expiresAt = now + server.config.SESSION_TTL_SEC * 1000;
      const sessions = await raw.query<{ id: string }>(
        `INSERT INTO sessions (user_id, created_at, expires_at, last_seen_at)
         VALUES ($1, $2, $3, $2) RETURNING id`,
        [result.userId, now, expiresAt],
      );
      const sessionId = sessions[0]?.id;
      if (!sessionId) throw new Error('failed to create session');

      const { token, expiresAt: accessExp } = await issueSessionJwt(
        { userId: result.userId, email: u.email, role: u.role, sessionId },
        server.config,
      );
      const refresh = await issueInitialRefresh(server.db, server.config, { sessionId, userId: result.userId });
      setCookie(c, 'refresh_token', refresh.rawToken, {
        httpOnly: true,
        secure: server.config.NODE_ENV === 'production',
        sameSite: 'Lax',
        maxAge: server.config.REFRESH_TTL_SEC,
        path: '/',
      });

      return c.json({
        accessToken: token,
        expiresAt: accessExp,
        sessionId,
        user: { id: result.userId, email: u.email, role: u.role },
      });
    },
  );

  return app;
}
