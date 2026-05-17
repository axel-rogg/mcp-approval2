/**
 * Email-Magic-Link-Recovery (Passkey verloren).
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.4 (Recovery).
 *
 * Flow:
 *   1. User klickt 'Forgot Passkey' → POST /auth/recovery/request { email }
 *   2. Wir schicken Magic-Link an Email-Adresse (24h TTL).
 *   3. Link-Click → GET /auth/recovery/verify?token=... → Google-Re-Auth-Redirect.
 *   4. Nach Re-Auth: alter Passkey wird als `invalidated` markiert,
 *      User wird auf Passkey-Re-Enrollment geleitet.
 *
 * Storage: nutzt `password_recovery_requests` Tabelle (Schema-Owner legt sie
 * an; falls noch nicht da, koennen wir auf `invites` mit subtype recyclen —
 * TODO Phase 1.1).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../../lib/config.js';
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../../lib/errors.js';
import { emitAudit } from '../../services/audit.js';

export interface RecoveryRequestInput {
  readonly email: string;
}

export interface RecoveryRequestResult {
  /** Returned to caller only in dev — production should deliver via email. */
  readonly rawToken: string;
  readonly verifyUrl: string;
  readonly expiresAt: number;
  /** true wenn die Email-Adresse einem aktiven User entspricht. Caller
   *  nutzt das um Email-Versand zu gaten (no enumeration leak via outbox). */
  readonly userFound: boolean;
  /** Nur gesetzt wenn userFound=true. */
  readonly userId?: string;
}

export async function requestRecovery(
  db: DbAdapter,
  config: AppConfig,
  input: RecoveryRequestInput,
): Promise<RecoveryRequestResult> {
  const email = input.email.toLowerCase().trim();
  const raw = db.unsafe('recovery_request_lookup_user');
  const users = await raw.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1 AND status = 'active' LIMIT 1`,
    [email],
  );
  const user = users[0];
  // Niemals leaken, ob es den User gibt — immer ein "Token" generieren, aber
  // bei unbekanntem User nicht persistieren.
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const now = Date.now();
  const expiresAt = now + config.RECOVERY_TTL_SEC * 1000;

  if (user) {
    await raw.query(
      `INSERT INTO password_recovery_requests
         (user_id, token_hash, created_at, expires_at, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [user.id, tokenHash, now, expiresAt],
    );
    await emitAudit(db, {
      action: 'recovery.request',
      actorUserId: user.id,
      result: 'success',
      details: { email },
    });
  } else {
    await emitAudit(db, {
      action: 'recovery.request',
      actorUserId: null,
      result: 'noop',
      details: { email, reason: 'unknown_user' },
    });
  }

  return {
    rawToken,
    verifyUrl: `${config.ORIGIN}/auth/recovery/verify?token=${encodeURIComponent(rawToken)}`,
    expiresAt,
    userFound: !!user,
    ...(user ? { userId: user.id } : {}),
  };
}

export interface RecoveryVerifyResult {
  readonly userId: string;
  /** Bool: alle bestehenden Passkeys werden im naechsten Step invalidated. */
  readonly mustReenroll: true;
}

export async function verifyRecovery(
  db: DbAdapter,
  rawToken: string,
): Promise<RecoveryVerifyResult> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const raw = db.unsafe('recovery_verify');
  const rows = await raw.query<{
    id: string;
    userId: string;
    status: string;
    expiresAt: number;
  }>(
    `SELECT id, user_id AS "userId", status, expires_at AS "expiresAt"
       FROM password_recovery_requests WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) throw HttpError.badRequest('invalid_request', 'unknown recovery token');
  if (row.status !== 'pending') {
    throw HttpError.badRequest('invalid_request', `recovery status: ${row.status}`);
  }
  if (row.expiresAt < Date.now()) {
    throw HttpError.badRequest('invite_expired', 'recovery token expired');
  }

  await raw.query(
    `UPDATE password_recovery_requests SET status = 'verified', verified_at = $1 WHERE id = $2`,
    [Date.now(), row.id],
  );
  // Mark all existing passkeys for this user as invalidated.
  await raw.query(
    `UPDATE webauthn_credentials SET invalidated_at = $1 WHERE user_id = $2 AND invalidated_at IS NULL`,
    [Date.now(), row.userId],
  );

  await emitAudit(db, {
    action: 'passkey.recovery.completed',
    actorUserId: row.userId,
    result: 'success',
    details: { recoveryId: row.id },
  });

  return { userId: row.userId, mustReenroll: true };
}
