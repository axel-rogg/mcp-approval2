/**
 * First-Login-First-Admin Bootstrap.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.3.
 *
 * Aufgerufen vom Google-OAuth-Callback OHNE Invite-Token. Wenn `users`-Tabelle
 * leer ist (kein aktiver User), wird der einlogende Google-User als Admin
 * angelegt. Sonst → 403 `bootstrap_only`.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';
import { emitAudit } from '../services/audit.js';

export interface BootstrapInput {
  readonly externalId: string;
  readonly email: string;
  readonly displayName: string;
}

export interface BootstrapResult {
  readonly userId: string;
  readonly role: 'admin';
  readonly bootstrapped: boolean;
}

export async function bootstrapIfNeeded(db: DbAdapter, input: BootstrapInput): Promise<BootstrapResult> {
  const raw = db.unsafe('bootstrap_check_and_insert');
  const rows = await raw.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM users WHERE status = 'active'`,
  );
  const count = rows[0]?.count ?? 0;
  if (count > 0) {
    throw HttpError.forbidden('bootstrap_only', 'invite required: bootstrap already completed');
  }
  const now = Date.now();
  const inserted = await raw.query<{ id: string }>(
    `INSERT INTO users (external_id, email, display_name, role, status, created_at, last_login_at, invited_by)
     VALUES ($1, $2, $3, 'admin', 'active', $4, $4, NULL)
     RETURNING id`,
    [input.externalId, input.email.toLowerCase(), input.displayName, now],
  );
  const userId = inserted[0]?.id;
  if (!userId) throw new Error('failed to insert bootstrap admin user');

  await emitAudit(db, {
    action: 'admin.bootstrap',
    actorUserId: userId,
    result: 'success',
    details: { email: input.email.toLowerCase() },
  });

  return { userId, role: 'admin', bootstrapped: true };
}
