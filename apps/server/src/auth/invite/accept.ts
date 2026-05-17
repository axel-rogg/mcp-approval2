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
  // SEC-010: 3 zusaetzliche Sperren auf existing-User-Pfad:
  //   1. status='suspended' → refuse. Admin muss erst explizit
  //      unsuspenden, sonst kann ein Invite einen vorher suspendierten
  //      Admin still wieder-aktivieren ohne Re-Vetting.
  //   2. external_id-Drift: wenn die existing-Row schon eine external_id
  //      hat die NICHT mit der einlogenden uebereinstimmt, refuse. Damit
  //      kann ein Angreifer der Bobs Email-Account uebernommen hat
  //      (Domain-Takeover) NICHT seinen eigenen Google-sub auf Bobs
  //      existing-Row mappen. Admin muss explizit re-linken
  //      (separater Flow).
  //   3. role=admin → optional doppelt-bestaetigt. Phase A: log warn
  //      und audit, weil ein zweiter Admin-Workflow noch nicht existiert.
  const existing = await raw.query<{
    id: string;
    role: 'admin' | 'member';
    status: string;
    externalId: string | null;
  }>(
    `SELECT id, role, status, external_id AS "externalId" FROM users WHERE email = $1 LIMIT 1`,
    [input.email.toLowerCase()],
  );
  let userId: string;
  let role: 'admin' | 'member';
  if (existing[0]) {
    const e = existing[0];
    if (e.status === 'suspended') {
      await emitAudit(db, {
        action: 'invite.accept.rejected',
        actorUserId: null,
        result: 'failure',
        details: {
          inviteId: invite.id,
          reason: 'user_suspended_use_admin_unsuspend',
          existingUserId: e.id,
          email: input.email.toLowerCase(),
        },
      }).catch(() => {
        /* audit failure non-fatal */
      });
      throw HttpError.forbidden(
        'forbidden',
        'invite rejected: matching user is suspended; ask an admin to unsuspend',
      );
    }
    if (e.externalId !== null && e.externalId !== input.externalId) {
      await emitAudit(db, {
        action: 'invite.accept.rejected',
        actorUserId: null,
        result: 'failure',
        details: {
          inviteId: invite.id,
          reason: 'external_id_mismatch',
          existingUserId: e.id,
          email: input.email.toLowerCase(),
        },
      }).catch(() => {
        /* audit failure non-fatal */
      });
      throw HttpError.forbidden(
        'forbidden',
        'invite rejected: matching user has a different IdP linkage; ask an admin to relink',
      );
    }
    if (e.role === 'admin') {
      // Phase A: log + audit, kein hard-reject — second-admin-confirm
      // flow ist Phase B+.
      // eslint-disable-next-line no-console
      console.warn(
        `[invite.accept] resurrecting admin-role user ${e.id} via invite ${invite.id} — no second-admin-confirm flow yet (SEC-010 follow-up)`,
      );
      await emitAudit(db, {
        action: 'invite.accept.admin_resurrected',
        actorUserId: null,
        result: 'noop',
        details: {
          inviteId: invite.id,
          existingUserId: e.id,
          email: input.email.toLowerCase(),
        },
      }).catch(() => {
        /* audit failure non-fatal */
      });
    }
    userId = e.id;
    role = e.role;
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
