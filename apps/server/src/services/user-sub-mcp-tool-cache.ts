/**
 * UserSubMcpToolCacheService — Per-User tools/list-Cache fuer OAuth-Sub-MCPs.
 *
 * Plan-Ref: Sprint 2026-05-18 (Per-User-OAuth-Pipeline).
 *
 * Hintergrund: service_bearer-Server (utils/gws/gcloud) cachen tools/list
 * global in sub_mcp_servers.tools_cache — alle User sehen dasselbe Tool-Set
 * (Worker ist user-agnostisch beim tools/list-Call). OAuth-Server (cf,
 * github) sind aber per-User — discovery braucht einen User-spezifischen
 * access_token. Daher: separater Cache pro (user_id, sub_mcp_id).
 *
 * Caller:
 *   - Discovery (services/user-sub-mcp-discovery.ts oder integriert in
 *     mcp/gateway/discovery.ts): schreibt nach erfolgreichem tools/list.
 *   - Wrapper-Tools beim tools/list-Request: liest, baut wrapper-tools pro
 *     User dynamisch.
 *   - Cron (sweep): wirft alte Eintraege weg (>30 Tage ohne Refresh).
 *
 * Pool-Hygiene: nutzt db.transaction(userId, ...) — RLS-Policy
 * `utcache_owner_only` enforced user_id-match.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';

export interface ToolEntry {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

export interface UserToolCacheEntry {
  readonly userId: string;
  readonly subMcpId: string;
  readonly subMcpName: string;
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly cachedAt: number;
}

export interface UserSubMcpToolCacheService {
  /** Liefert den Per-User-Cache fuer einen Server. null wenn nie discovered. */
  read(userId: string, subMcpName: string): Promise<UserToolCacheEntry | null>;
  /** Listet alle gecachten (user, server)-Paare des Users. */
  listForUser(userId: string): Promise<ReadonlyArray<UserToolCacheEntry>>;
  /** Upsert nach erfolgreichem tools/list-Roundtrip. */
  write(args: {
    userId: string;
    subMcpId: string;
    subMcpName: string;
    tools: ReadonlyArray<ToolEntry>;
  }): Promise<void>;
  /** Loescht einen Cache-Eintrag (z.B. bei OAuth-Disconnect). */
  remove(userId: string, subMcpName: string): Promise<void>;
  /**
   * Background-Cleanup: wirft Eintraege weg die seit `staleBefore` (Unix-ms)
   * nicht refreshed wurden. Returns count.
   */
  cleanupStale(staleBefore: number): Promise<number>;
}

interface CacheRow {
  readonly user_id: string;
  readonly sub_mcp_id: string;
  readonly sub_mcp_name: string;
  readonly tools_json: ReadonlyArray<ToolEntry> | string;
  readonly cached_at: number | string;
}

export interface UserSubMcpToolCacheServiceOpts {
  readonly db: DbAdapter;
  readonly now?: () => number;
}

export function createUserSubMcpToolCacheService(
  opts: UserSubMcpToolCacheServiceOpts,
): UserSubMcpToolCacheService {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());

  function parseToolsJson(raw: ReadonlyArray<ToolEntry> | string): ReadonlyArray<ToolEntry> {
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as ReadonlyArray<ToolEntry>;
      } catch {
        return [];
      }
    }
    return raw;
  }

  function parseCachedAt(raw: number | string): number {
    return typeof raw === 'number' ? raw : Number(raw);
  }

  function rowToEntry(row: CacheRow): UserToolCacheEntry {
    return {
      userId: row.user_id,
      subMcpId: row.sub_mcp_id,
      subMcpName: row.sub_mcp_name,
      tools: parseToolsJson(row.tools_json),
      cachedAt: parseCachedAt(row.cached_at),
    };
  }

  return {
    async read(userId, subMcpName) {
      return db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<CacheRow>(
          `SELECT user_id, sub_mcp_id, sub_mcp_name, tools_json, cached_at
             FROM user_sub_mcp_tool_cache
            WHERE user_id = $1 AND sub_mcp_name = $2
            LIMIT 1`,
          [userId, subMcpName],
        );
        const r = rows[0];
        return r ? rowToEntry(r) : null;
      });
    },

    async listForUser(userId) {
      return db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<CacheRow>(
          `SELECT user_id, sub_mcp_id, sub_mcp_name, tools_json, cached_at
             FROM user_sub_mcp_tool_cache
            WHERE user_id = $1
            ORDER BY sub_mcp_name`,
          [userId],
        );
        return rows.map(rowToEntry);
      });
    },

    async write({ userId, subMcpId, subMcpName, tools }) {
      const ts = now();
      const toolsJson = JSON.stringify(tools);
      await db.transaction(userId, async (scoped) => {
        await scoped.query(
          `INSERT INTO user_sub_mcp_tool_cache
             (user_id, sub_mcp_id, sub_mcp_name, tools_json, cached_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (user_id, sub_mcp_id) DO UPDATE
             SET sub_mcp_name = EXCLUDED.sub_mcp_name,
                 tools_json   = EXCLUDED.tools_json,
                 cached_at    = EXCLUDED.cached_at`,
          [userId, subMcpId, subMcpName, toolsJson, ts],
        );
      });
    },

    async remove(userId, subMcpName) {
      await db.transaction(userId, async (scoped) => {
        await scoped.query(
          `DELETE FROM user_sub_mcp_tool_cache
            WHERE user_id = $1 AND sub_mcp_name = $2`,
          [userId, subMcpName],
        );
      });
    },

    async cleanupStale(staleBefore) {
      // service-pfad: unsafe() (kein per-User-RLS-Setting, bypasst Policy).
      const raw = db.unsafe('user_sub_mcp_tool_cache_cleanup');
      const result = await raw.query<{ count: number }>(
        `WITH deleted AS (
           DELETE FROM user_sub_mcp_tool_cache
            WHERE cached_at < $1
            RETURNING 1
         )
         SELECT count(*)::int AS count FROM deleted`,
        [staleBefore],
      );
      return result[0]?.count ?? 0;
    },
  };
}
