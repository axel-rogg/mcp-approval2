/**
 * Admin-Service — read-only view auf User + Audit.
 *
 * Plan-Ref: PLAN-architecture-v1.md §4.1 (admin sieht nur User-Liste + Audit
 * + Quotas, KEINE User-Inhalte).
 */

import type { DbAdapter } from '@mcp-approval2/adapters';
import { emitAudit, type AuditEvent } from './audit.js';
import type { UserSyncService } from './user-sync.js';

export interface AdminUserSummary {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'member';
  status: 'active' | 'invited' | 'suspended' | 'deleted';
  created_at: number;
  last_login_at: number | null;
}

export interface AdminAuditEntry {
  id: string;
  ts: number;
  actor_user_id: string | null;
  actor_type: string;
  action: string;
  resource_kind: string | null;
  resource_id: string | null;
  ip: string | null;
  result: string;
}

export interface AdminService {
  listUsers(args?: { limit?: number; offset?: number; status?: AdminUserSummary['status'] }): Promise<AdminUserSummary[]>;
  getUser(args: { id: string }): Promise<AdminUserSummary | null>;
  suspendUser(args: { id: string; reason?: string; actorUserId: string }): Promise<void>;
  unsuspendUser(args: { id: string; actorUserId: string }): Promise<void>;
  listAuditForUser(args: { userId: string; limit?: number; offset?: number }): Promise<AdminAuditEntry[]>;
  listSystemAudit(args?: { limit?: number; offset?: number; action?: string }): Promise<AdminAuditEntry[]>;
}

export interface AdminServiceOptions {
  db: DbAdapter;
  /**
   * AS-3 (A11): Optional UserSyncService. Wenn gesetzt: bei
   * suspend/unsuspend pushed admin den neuen State an KC2.
   * Fire-and-forget — Failure ist non-blocking, audit-only.
   */
  userSync?: UserSyncService;
}

export function createAdminService(opts: AdminServiceOptions): AdminService {
  const { db, userSync } = opts;
  const audit = {
    async emit(event: AuditEvent) {
      await emitAudit(db, event);
    },
  };

  return {
    async listUsers(args = {}) {
      const limit = Math.min(args.limit ?? 50, 200);
      const offset = args.offset ?? 0;
      const status = args.status;

      // Use raw because admin operations bypass per-user RLS.
      const scoped = db.unsafe('admin.listUsers — read-only system view');
      const where = status ? `WHERE status = $3` : '';
      const params = status ? [limit, offset, status] : [limit, offset];
      const rows = await scoped.query<AdminUserSummary>(
        `SELECT id, email, display_name, role, status, created_at, last_login_at
         FROM users
         ${where}
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        params,
      );
      return rows;
    },

    async getUser({ id }) {
      const scoped = db.unsafe('admin.getUser — read-only system view');
      const rows = await scoped.query<AdminUserSummary>(
        `SELECT id, email, display_name, role, status, created_at, last_login_at
         FROM users WHERE id = $1 LIMIT 1`,
        [id],
      );
      return rows[0] ?? null;
    },

    async suspendUser({ id, reason, actorUserId }) {
      const scoped = db.unsafe('admin.suspendUser');
      await scoped.query(
        `UPDATE users SET status = 'suspended' WHERE id = $1 AND status = 'active'`,
        [id],
      );
      await scoped.query(
        `UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`,
        [Date.now(), id],
      );
      await audit.emit({
        action: 'admin.user.suspended',
        actorUserId,
        targetUserId: id,
        result: 'success',
        ...(reason ? { details: { reason } } : {}),
      });
      // AS-3 (A11): push state to KC2 (fire-and-forget; audit-on-failure).
      if (userSync) {
        const userRow = await scoped.query<{
          email: string;
          display_name: string;
          external_id: string | null;
        }>(
          `SELECT email, display_name, external_id FROM users WHERE id = $1 LIMIT 1`,
          [id],
        );
        const row = userRow[0];
        if (row) {
          await userSync.push({
            userId: id,
            email: row.email,
            displayName: row.display_name,
            status: 'suspended',
            ...(row.external_id ? { externalId: row.external_id } : {}),
          });
        }
      }
    },

    async unsuspendUser({ id, actorUserId }) {
      const scoped = db.unsafe('admin.unsuspendUser');
      await scoped.query(
        `UPDATE users SET status = 'active' WHERE id = $1 AND status = 'suspended'`,
        [id],
      );
      await audit.emit({
        action: 'admin.user.unsuspended',
        actorUserId,
        targetUserId: id,
        result: 'success',
      });
      if (userSync) {
        const userRow = await scoped.query<{
          email: string;
          display_name: string;
          external_id: string | null;
        }>(
          `SELECT email, display_name, external_id FROM users WHERE id = $1 LIMIT 1`,
          [id],
        );
        const row = userRow[0];
        if (row) {
          await userSync.push({
            userId: id,
            email: row.email,
            displayName: row.display_name,
            status: 'active',
            ...(row.external_id ? { externalId: row.external_id } : {}),
          });
        }
      }
    },

    async listAuditForUser({ userId, limit = 100, offset = 0 }) {
      const scoped = db.unsafe('admin.listAuditForUser');
      const rows = await scoped.query<AdminAuditEntry>(
        `SELECT id, ts, actor_user_id, actor_type, action, resource_kind,
                resource_id, ip, result
         FROM audit_log
         WHERE actor_user_id = $1
         ORDER BY ts DESC
         LIMIT $2 OFFSET $3`,
        [userId, Math.min(limit, 500), offset],
      );
      return rows;
    },

    async listSystemAudit(args = {}) {
      const limit = Math.min(args.limit ?? 100, 500);
      const offset = args.offset ?? 0;
      const scoped = db.unsafe('admin.listSystemAudit');
      const where = args.action ? `WHERE action = $3` : '';
      const params = args.action ? [limit, offset, args.action] : [limit, offset];
      const rows = await scoped.query<AdminAuditEntry>(
        `SELECT id, ts, actor_user_id, actor_type, action, resource_kind,
                resource_id, ip, result
         FROM audit_log
         ${where}
         ORDER BY ts DESC
         LIMIT $1 OFFSET $2`,
        params,
      );
      return rows;
    },
  };
}
