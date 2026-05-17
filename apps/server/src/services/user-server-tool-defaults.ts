/**
 * UserServerToolDefaultsService — per-User pro-Tool Default-Werte.
 *
 * Plan-Ref: docs/plans/active/PLAN-tools-tab-ux-refactor.md (Phase D).
 *
 * Tabelle: user_server_tool_defaults (Migration 0024).
 *
 * sub_mcp_name kann 'native'|'knowledge2'|<sub_mcp_servers.name> sein.
 * Cascade bei sub_mcp_servers-Delete via Trigger (siehe Migration).
 *
 * Connection-Pool-Hygiene: db.transaction() statt db.scoped() (siehe
 * Lessons-Learned in user-subscriptions.ts).
 */
import type { DbAdapter } from '@mcp-approval2/adapters';

export interface ToolDefault {
  readonly userId: string;
  readonly subMcpName: string;
  readonly toolName: string;
  readonly fieldName: string;
  readonly value: string;
  readonly isSecret: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UserServerToolDefaultsService {
  /** Alle Defaults eines Users fuer einen Server. */
  listByServer(userId: string, subMcpName: string): Promise<ReadonlyArray<ToolDefault>>;
  /** Defaults fuer ein spezifisches Tool. */
  listByTool(userId: string, subMcpName: string, toolName: string): Promise<ReadonlyArray<ToolDefault>>;
  /** Upsert einer einzelnen Default. value='' = remove (delete-Variante). */
  set(
    userId: string,
    subMcpName: string,
    toolName: string,
    fieldName: string,
    value: string,
    isSecret?: boolean,
  ): Promise<ToolDefault>;
  /** Loescht eine Default. */
  remove(userId: string, subMcpName: string, toolName: string, fieldName: string): Promise<void>;
  /** Loescht alle Defaults eines Users fuer einen Server. */
  removeAllForServer(userId: string, subMcpName: string): Promise<void>;
}

interface RawRow {
  readonly user_id: string;
  readonly sub_mcp_name: string;
  readonly tool_name: string;
  readonly field_name: string;
  readonly value_text: string;
  readonly is_secret: boolean;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

function toNumber(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

function rowToEntry(r: RawRow): ToolDefault {
  return {
    userId: r.user_id,
    subMcpName: r.sub_mcp_name,
    toolName: r.tool_name,
    fieldName: r.field_name,
    value: r.value_text,
    isSecret: r.is_secret,
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  };
}

const SELECT_COLS = `
  user_id, sub_mcp_name, tool_name, field_name,
  value_text, is_secret, created_at, updated_at
`;

export interface UserServerToolDefaultsServiceOpts {
  readonly db: DbAdapter;
  readonly now?: () => number;
}

export function createUserServerToolDefaultsService(
  opts: UserServerToolDefaultsServiceOpts,
): UserServerToolDefaultsService {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());

  return {
    async listByServer(userId, subMcpName) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawRow>(
          `SELECT ${SELECT_COLS} FROM user_server_tool_defaults
            WHERE user_id = $1 AND sub_mcp_name = $2
            ORDER BY tool_name ASC, field_name ASC`,
          [userId, subMcpName],
        );
        return rows.map(rowToEntry);
      });
    },

    async listByTool(userId, subMcpName, toolName) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawRow>(
          `SELECT ${SELECT_COLS} FROM user_server_tool_defaults
            WHERE user_id = $1 AND sub_mcp_name = $2 AND tool_name = $3
            ORDER BY field_name ASC`,
          [userId, subMcpName, toolName],
        );
        return rows.map(rowToEntry);
      });
    },

    async set(userId, subMcpName, toolName, fieldName, value, isSecret = false) {
      const ts = now();
      const row = await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawRow>(
          `INSERT INTO user_server_tool_defaults
             (user_id, sub_mcp_name, tool_name, field_name,
              value_text, is_secret, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           ON CONFLICT (user_id, sub_mcp_name, tool_name, field_name) DO UPDATE
             SET value_text = EXCLUDED.value_text,
                 is_secret  = EXCLUDED.is_secret,
                 updated_at = EXCLUDED.updated_at
           RETURNING ${SELECT_COLS}`,
          [userId, subMcpName, toolName, fieldName, value, isSecret, ts],
        );
        return rows[0];
      });
      if (!row) throw new Error('tool_defaults upsert returned no row');
      return rowToEntry(row);
    },

    async remove(userId, subMcpName, toolName, fieldName) {
      await db.transaction(userId, async (scoped) => {
        await scoped.query(
          `DELETE FROM user_server_tool_defaults
            WHERE user_id = $1 AND sub_mcp_name = $2
              AND tool_name = $3 AND field_name = $4`,
          [userId, subMcpName, toolName, fieldName],
        );
      });
    },

    async removeAllForServer(userId, subMcpName) {
      await db.transaction(userId, async (scoped) => {
        await scoped.query(
          `DELETE FROM user_server_tool_defaults
            WHERE user_id = $1 AND sub_mcp_name = $2`,
          [userId, subMcpName],
        );
      });
    },
  };
}
