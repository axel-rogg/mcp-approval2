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
import { authCookieOpts } from '../../lib/cookie.js';
import { resolveOrigin, resolveRpId } from '../../lib/config.js';
import { beginRegistration, finishRegistration } from '../../auth/webauthn/registration.js';
import { beginAuthentication, finishAuthentication } from '../../auth/webauthn/authentication.js';
import { issueSessionJwt } from '../../auth/session/issuer.js';
import { issueInitialRefresh } from '../../auth/session/refresh.js';
import { setCookie } from 'hono/cookie';
import { findUserByEmail } from '../../services/user.js';

/**
 * DB-backed Challenge-Store (Migration 0022). In-Memory war Single-Instance-
 * only — Fly hat 2+ Machines, begin/finish hatten oft separate Targets →
 * 'webauthn_challenge_mismatch'. Postgres ist die Source-of-Truth, alle
 * Instances sehen denselben Zustand.
 *
 * Key-Konvention: "reg:<challengeId>" | "login:<challengeId>" — gleich wie
 * vorher, aber wir splitten beim Insert in kind+id.
 */
async function putChallenge(
  db: ServerContext['db'],
  key: string,
  challenge: string,
  userId: string | null,
  rpId: string,
  origin: string,
): Promise<void> {
  const colonIdx = key.indexOf(':');
  const kind = colonIdx > 0 ? key.slice(0, colonIdx) : 'reg';
  const challengeId = colonIdx > 0 ? key.slice(colonIdx + 1) : key;
  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000;
  const raw = db.unsafe('webauthn_challenge_put');
  await raw.query(
    `INSERT INTO webauthn_challenges (challenge_id, challenge, kind, user_id, rp_id, origin, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (challenge_id) DO UPDATE SET
       challenge=EXCLUDED.challenge, kind=EXCLUDED.kind, user_id=EXCLUDED.user_id,
       rp_id=EXCLUDED.rp_id, origin=EXCLUDED.origin, created_at=EXCLUDED.created_at,
       expires_at=EXCLUDED.expires_at`,
    [challengeId, challenge, kind, userId, rpId, origin, now, expiresAt],
  );
}

async function takeChallenge(
  db: ServerContext['db'],
  key: string,
): Promise<{ challenge: string; userId: string | null; rpId: string; origin: string } | null> {
  const colonIdx = key.indexOf(':');
  const kind = colonIdx > 0 ? key.slice(0, colonIdx) : 'reg';
  const challengeId = colonIdx > 0 ? key.slice(colonIdx + 1) : key;
  const now = Date.now();
  const raw = db.unsafe('webauthn_challenge_take');
  // DELETE ... RETURNING ist atomic — kein TOCTOU-Race zwischen 2 finish-Calls.
  const rows = await raw.query<{
    challenge: string;
    user_id: string | null;
    rp_id: string;
    origin: string;
    expires_at: number | string;
  }>(
    `DELETE FROM webauthn_challenges
      WHERE challenge_id = $1 AND kind = $2
      RETURNING challenge, user_id, rp_id, origin, expires_at`,
    [challengeId, kind],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (Number(row.expires_at) < now) return null;
  return {
    challenge: row.challenge,
    userId: row.user_id,
    rpId: row.rp_id,
    origin: row.origin,
  };
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
  // Multi-Origin: RP-ID + expectedOrigin werden pro-Request aus dem
  // tatsächlichen Request-Origin abgeleitet, sodass Passkeys auf
  // app2.ai-toolhub.org, mcp-approval2.fly.dev, mcp2.ai-toolhub.org separat
  // registriert + verifiziert werden können (jede Origin == eigene RP-ID
  // == eigene Credential-Domain).
  app.post('/auth/webauthn/enroll/begin', auth(server), async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const requestOrigin = resolveOrigin(c.req.raw, server.config);
    const rpId = resolveRpId(requestOrigin, server.config);
    const prfSalt = randomBytes(32);
    const { options, challenge } = await beginRegistration(server.config, {
      userId: principal.userId,
      email: principal.email,
      displayName: principal.email,
      prfSalt,
      rpId,
    });
    const challengeId = randomBytes(16).toString('base64url');
    await putChallenge(server.db, `reg:${challengeId}`, challenge, principal.userId, rpId, requestOrigin);
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
      const stored = await takeChallenge(server.db, `reg:${body.challengeId}`);
      if (!stored) throw HttpError.badRequest('webauthn_challenge_mismatch', 'challenge expired or unknown');
      if (stored.userId !== principal.userId) {
        throw HttpError.forbidden('challenge userId mismatch');
      }
      const result = await finishRegistration(server.config, server.db, {
        userId: principal.userId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: body.response as any,
        expectedChallenge: stored.challenge,
        rpId: stored.rpId,
        expectedOrigin: stored.origin,
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
    const requestOrigin = resolveOrigin(c.req.raw, server.config);
    const rpId = resolveRpId(requestOrigin, server.config);
    const { options, challenge } = await beginAuthentication(
      server.config,
      server.db,
      userId ? { userId, rpId } : { rpId },
    );
    const challengeId = randomBytes(16).toString('base64url');
    await putChallenge(server.db, `login:${challengeId}`, challenge, userId ?? null, rpId, requestOrigin);
    return c.json({ challengeId, options });
  });

  app.post(
    '/auth/webauthn/login/finish',
    zValidator('json', loginFinishSchema),
    async (c) => {
      const body = c.req.valid('json');
      const stored = await takeChallenge(server.db, `login:${body.challengeId}`);
      if (!stored) throw HttpError.badRequest('webauthn_challenge_mismatch', 'challenge expired or unknown');

      const result = await finishAuthentication(server.config, server.db, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: body.response as any,
        expectedChallenge: stored.challenge,
        rpId: stored.rpId,
        expectedOrigin: stored.origin,
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
      setCookie(c, 'refresh_token', refresh.rawToken, authCookieOpts(server.config, { maxAge: server.config.REFRESH_TTL_SEC, requestOrigin: resolveOrigin(c.req.raw, server.config) }));

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
