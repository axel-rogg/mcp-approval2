/**
 * Session-JWT-Issuer.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.5.
 *
 * Format:
 *   sub:   user.id (UUID)
 *   email: user.email
 *   role:  user.role
 *   jti:   sessions.id (UUID)
 *   iat / exp / iss / aud  — Standard
 *
 * HS256 mit `config.JWT_SECRET`. Wir nutzen `jose` (im core-Paket schon
 * vorhanden) — falls Import dort fehlschlaegt, fallen wir auf `@noble/hashes`
 * + Web-Crypto zurueck (nicht hier).
 */
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from '../../lib/config.js';
import type { SessionPrincipal } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';

export interface IssueSessionInput {
  readonly userId: string;
  readonly email: string;
  readonly role: 'admin' | 'member';
  readonly sessionId: string;
}

export interface IssueSessionResult {
  readonly token: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function secretBytes(config: AppConfig): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

export async function issueSessionJwt(input: IssueSessionInput, config: AppConfig): Promise<IssueSessionResult> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.SESSION_TTL_SEC;
  const token = await new SignJWT({
    email: input.email,
    role: input.role,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.userId)
    .setJti(input.sessionId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .sign(secretBytes(config));
  return { token, issuedAt: now, expiresAt: exp };
}

export async function verifySessionJwt(token: string, config: AppConfig): Promise<SessionPrincipal> {
  const { payload } = await jwtVerify(token, secretBytes(config), {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    algorithms: ['HS256'],
  });
  if (!payload.sub || !payload.jti || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw HttpError.unauthorized('malformed session jwt');
  }
  const role = payload['role'];
  if (role !== 'admin' && role !== 'member') {
    throw HttpError.unauthorized('invalid role claim');
  }
  const email = payload['email'];
  if (typeof email !== 'string') {
    throw HttpError.unauthorized('missing email claim');
  }
  return {
    userId: payload.sub,
    email,
    role,
    sessionId: payload.jti,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}
