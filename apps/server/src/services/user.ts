/**
 * User-CRUD-Service.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.1, §4.
 *
 * Owner-scoped Repository-Pattern: alle Read/Update-Methoden nehmen einen
 * `actorUserId` und nutzen entweder `db.scoped()` (RLS) ODER `db.unsafe()`
 * mit explizitem Reason fuer Admin-Operationen (User-Liste etc.).
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';

export interface UserRow {
  readonly id: string;
  readonly externalId: string | null;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'admin' | 'member';
  readonly status: 'active' | 'invited' | 'suspended' | 'deleted';
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
  readonly invitedBy: string | null;
  readonly deletedAt: number | null;
}

export async function findUserByExternalId(db: DbAdapter, externalId: string): Promise<UserRow | null> {
  const raw = db.unsafe('login_lookup_by_external_id');
  const rows = await raw.query<UserRow>(
    `SELECT id, external_id AS "externalId", email, display_name AS "displayName",
            role, status, created_at AS "createdAt", last_login_at AS "lastLoginAt",
            invited_by AS "invitedBy", deleted_at AS "deletedAt"
       FROM users WHERE external_id = $1 LIMIT 1`,
    [externalId],
  );
  return rows[0] ?? null;
}

export async function findUserByEmail(db: DbAdapter, email: string): Promise<UserRow | null> {
  const raw = db.unsafe('login_lookup_by_email');
  const rows = await raw.query<UserRow>(
    `SELECT id, external_id AS "externalId", email, display_name AS "displayName",
            role, status, created_at AS "createdAt", last_login_at AS "lastLoginAt",
            invited_by AS "invitedBy", deleted_at AS "deletedAt"
       FROM users WHERE email = $1 LIMIT 1`,
    [email.toLowerCase()],
  );
  return rows[0] ?? null;
}

export async function getOwnProfile(db: DbAdapter, userId: string): Promise<UserRow> {
  const scoped = await db.scoped(userId);
  const rows = await scoped.query<UserRow>(
    `SELECT id, external_id AS "externalId", email, display_name AS "displayName",
            role, status, created_at AS "createdAt", last_login_at AS "lastLoginAt",
            invited_by AS "invitedBy", deleted_at AS "deletedAt"
       FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw HttpError.notFound('user not found');
  return row;
}

export async function touchLastLogin(db: DbAdapter, userId: string): Promise<void> {
  // db.transaction() statt db.scoped() — letzteres oeffnet BEGIN aber
  // niemand ruft release() → COMMIT fehlt → UPDATE verloren.
  await db.transaction<void>(userId, async (scoped) => {
    await scoped.query(`UPDATE users SET last_login_at = $1 WHERE id = $2`, [Date.now(), userId]);
  });
}
