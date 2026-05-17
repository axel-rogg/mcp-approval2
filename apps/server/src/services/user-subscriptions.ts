/**
 * UserSubscriptionsService — per-User-Sub-MCP-Subscription-Mgmt.
 *
 * Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md (Phase 1).
 *
 * Jeder User entscheidet welche Sub-MCP-Server er aktiviert. Defaults beim
 * First-Login: alle Catalog-Defaults werden lazy in user_sub_mcp_subscriptions
 * eingestreut mit enabled=FALSE (per-User-Decision: opt-in).
 *
 * RLS: User sieht nur eigene Rows (Migration 0015). Service nutzt
 * `db.scoped(userId)` damit current_setting('app.current_user') greift.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';

export interface UserSubscription {
  readonly userId: string;
  readonly subMcpName: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UserSubscriptionsService {
  /** Liefert alle Subscription-Rows fuer den User (inkl. enabled=FALSE). */
  list(userId: string): Promise<ReadonlyArray<UserSubscription>>;
  /** Enabled-only Liste — fuer Inventory-Filtering. */
  listEnabled(userId: string): Promise<ReadonlyArray<UserSubscription>>;
  /** Toggle enabled/disabled. Upsert wenn Row noch nicht existiert. */
  setEnabled(userId: string, subMcpName: string, enabled: boolean): Promise<void>;
  /** Check ob User den Server aktiviert hat (default false wenn keine Row). */
  isEnabled(userId: string, subMcpName: string): Promise<boolean>;
  /**
   * Idempotenter Lazy-Insert beim ersten Inventory-Read fuer den User:
   * legt fuer jeden Catalog-Default eine Row mit enabled=FALSE an, falls
   * noch nicht vorhanden. Wird vom Inventory-Endpoint aufgerufen.
   */
  ensureCatalogRows(userId: string): Promise<void>;
}

interface SubscriptionRowRaw {
  readonly user_id: string;
  readonly sub_mcp_name: string;
  readonly enabled: boolean;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

function toNumber(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

function rowToSubscription(r: SubscriptionRowRaw): UserSubscription {
  return {
    userId: r.user_id,
    subMcpName: r.sub_mcp_name,
    enabled: r.enabled,
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  };
}

export interface UserSubscriptionsServiceOpts {
  readonly db: DbAdapter;
  /** Override fuer Tests / deterministische Zeit. */
  readonly now?: () => number;
}

export function createUserSubscriptionsService(
  opts: UserSubscriptionsServiceOpts,
): UserSubscriptionsService {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());

  return {
    async list(userId) {
      const scoped = await db.scoped(userId);
      const rows = await scoped.query<SubscriptionRowRaw>(
        `SELECT user_id, sub_mcp_name, enabled, created_at, updated_at
           FROM user_sub_mcp_subscriptions
          WHERE user_id = $1
          ORDER BY sub_mcp_name ASC`,
        [userId],
      );
      return rows.map(rowToSubscription);
    },

    async listEnabled(userId) {
      const scoped = await db.scoped(userId);
      const rows = await scoped.query<SubscriptionRowRaw>(
        `SELECT user_id, sub_mcp_name, enabled, created_at, updated_at
           FROM user_sub_mcp_subscriptions
          WHERE user_id = $1 AND enabled = TRUE
          ORDER BY sub_mcp_name ASC`,
        [userId],
      );
      return rows.map(rowToSubscription);
    },

    async setEnabled(userId, subMcpName, enabled) {
      const scoped = await db.scoped(userId);
      const ts = now();
      // Upsert: erste Aktivierung legt die Row an. updated_at immer setzen.
      await scoped.query(
        `INSERT INTO user_sub_mcp_subscriptions
           (user_id, sub_mcp_name, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (user_id, sub_mcp_name) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               updated_at = EXCLUDED.updated_at`,
        [userId, subMcpName, enabled, ts],
      );
    },

    async isEnabled(userId, subMcpName) {
      const scoped = await db.scoped(userId);
      const rows = await scoped.query<{ enabled: boolean }>(
        `SELECT enabled FROM user_sub_mcp_subscriptions
          WHERE user_id = $1 AND sub_mcp_name = $2 LIMIT 1`,
        [userId, subMcpName],
      );
      return rows[0]?.enabled === true;
    },

    async ensureCatalogRows(userId) {
      // Idempotent: alle Catalog-Defaults (owner_user_id IS NULL) die der
      // User noch nicht in user_sub_mcp_subscriptions hat, mit enabled=FALSE
      // einfuegen. Damit erscheint jeder Server in der "Verfuegbar"-Liste
      // ohne dass der User explizit Rows anlegen muss.
      const scoped = await db.scoped(userId);
      const ts = now();
      await scoped.query(
        `INSERT INTO user_sub_mcp_subscriptions
           (user_id, sub_mcp_name, enabled, created_at, updated_at)
         SELECT $1, name, FALSE, $2, $2
           FROM sub_mcp_servers
          WHERE is_catalog_default = TRUE
            AND (owner_user_id IS NULL OR owner_user_id = $1)
         ON CONFLICT (user_id, sub_mcp_name) DO NOTHING`,
        [userId, ts],
      );
    },
  };
}
