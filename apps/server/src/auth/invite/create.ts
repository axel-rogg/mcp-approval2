/**
 * Invite-Erstellung (Admin-only).
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.2.
 *
 * Flow:
 *   POST /admin/invites { email }
 *     → invites-Row mit token_hash = sha256(rawToken)
 *     → Signed Magic-Link an User: <ORIGIN>/accept-invite?token=<rawToken>
 *     → 24h TTL
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../../lib/config.js';
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../../lib/errors.js';
import { emitAudit } from '../../services/audit.js';

export interface CreateInviteInput {
  readonly email: string;
  readonly invitedBy: string;
}

export interface CreateInviteResult {
  readonly inviteId: string;
  readonly rawToken: string;
  readonly acceptUrl: string;
  readonly expiresAt: number;
}

export async function createInvite(
  db: DbAdapter,
  config: AppConfig,
  input: CreateInviteInput,
): Promise<CreateInviteResult> {
  const normEmail = input.email.toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normEmail)) {
    throw HttpError.badRequest('invalid_request', 'invalid email');
  }

  // Prevent duplicate active invite for same email
  const adminScoped = await db.scoped(input.invitedBy);
  const existing = await adminScoped.query<{ id: string }>(
    `SELECT id FROM invites
      WHERE email = $1 AND status = 'pending' AND expires_at > $2
      LIMIT 1`,
    [normEmail, Date.now()],
  );
  if (existing[0]) {
    throw HttpError.conflict('invite already pending for this email', { inviteId: existing[0].id });
  }

  const raw = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(raw).digest('hex');
  const now = Date.now();
  const expiresAt = now + config.INVITE_TTL_SEC * 1000;

  const inserted = await adminScoped.query<{ id: string }>(
    `INSERT INTO invites (email, invited_by, token_hash, created_at, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [normEmail, input.invitedBy, tokenHash, now, expiresAt],
  );
  const inviteId = inserted[0]?.id;
  if (!inviteId) throw new Error('failed to insert invite row');

  const acceptUrl = `${config.ORIGIN}/accept-invite/${encodeURIComponent(raw)}`;

  await emitAudit(db, {
    action: 'invite.create',
    actorUserId: input.invitedBy,
    result: 'success',
    details: { inviteId, email: normEmail },
  });

  return { inviteId, rawToken: raw, acceptUrl, expiresAt };
}
