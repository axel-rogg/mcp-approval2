/**
 * Invite-Accept-Logik.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.2.
 *
 * Aufgerufen vom Google-OAuth-Callback, NACHDEM `IdpProfile` erfolgreich
 * geholt wurde. Validiert den Invite (Hash, Status, Expiry, Email-Match) und
 * legt die `users`-Row an.
 */
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../lib/config.js';
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../../lib/errors.js';
import { emitAudit } from '../../services/audit.js';

export interface AcceptInviteInput {
  readonly rawToken: string;
  /** Aus IdP-Callback: ueber den User identifiziert (Google sub + email). */
  readonly externalId: string;
  readonly email: string;
  readonly displayName: string;
}

export interface InviteRow {
  readonly id: string;
  readonly email: string;
  readonly invitedBy: string;
  readonly status: string;
  readonly expiresAt: number;
  readonly acceptedAt: number | null;
}

export interface AcceptInviteResult {
  readonly userId: string;
  readonly role: 'admin' | 'member';
}

export async function acceptInvite(
  db: DbAdapter,
  _config: AppConfig,
  input: AcceptInviteInput,
): Promise<AcceptInviteResult> {
  const tokenHash = createHash('sha256').update(input.rawToken).digest('hex');
  const now = Date.now();
  const raw = db.unsafe('invite_lookup_and_accept');

  const invites = await raw.query<InviteRow>(
    `SELECT id, email, invited_by AS "invitedBy", status, expires_at AS "expiresAt",
            accepted_at AS "acceptedAt"
       FROM invites WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const invite = invites[0];
  if (!invite) throw HttpError.badRequest('invalid_request', 'unknown invite token');
  if (invite.status === 'accepted') {
    throw HttpError.conflict('invite_already_used', { inviteId: invite.id });
  }
  if (invite.status !== 'pending') {
    throw HttpError.badRequest('invalid_request', `invite status: ${invite.status}`);
  }
  if (invite.expiresAt < now) {
    throw HttpError.badRequest('invite_expired', 'invite token expired');
  }
  if (invite.email !== input.email.toLowerCase()) {
    throw HttpError.forbidden('invite_email_mismatch', {
      inviteEmail: invite.email,
      loginEmail: input.email,
    });
  }

  // Mark invite as accepted FIRST (idempotency-leaning).
  await raw.query(
    `UPDATE invites SET status = 'accepted', accepted_at = $1 WHERE id = $2 AND status = 'pending'`,
    [now, invite.id],
  );

  // Insert or upsert user row.
  const existing = await raw.query<{ id: string; role: 'admin' | 'member'; status: string }>(
    `SELECT id, role, status FROM users WHERE email = $1 LIMIT 1`,
    [input.email.toLowerCase()],
  );
  let userId: string;
  let role: 'admin' | 'member';
  if (existing[0]) {
    userId = existing[0].id;
    role = existing[0].role;
    await raw.query(
      `UPDATE users SET status = 'active', external_id = $1, display_name = $2, last_login_at = $3
       WHERE id = $4`,
      [input.externalId, input.displayName, now, userId],
    );
  } else {
    const inserted = await raw.query<{ id: string; role: 'admin' | 'member' }>(
      `INSERT INTO users (external_id, email, display_name, role, status, created_at, last_login_at, invited_by)
       VALUES ($1, $2, $3, 'member', 'active', $4, $4, $5)
       RETURNING id, role`,
      [input.externalId, input.email.toLowerCase(), input.displayName, now, invite.invitedBy],
    );
    if (!inserted[0]) throw new Error('failed to insert user row');
    userId = inserted[0].id;
    role = inserted[0].role;
  }

  await emitAudit(db, {
    action: 'invite.accept',
    actorUserId: userId,
    result: 'success',
    details: { inviteId: invite.id },
  });

  return { userId, role };
}
