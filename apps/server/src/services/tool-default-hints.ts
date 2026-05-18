/**
 * ToolDefaultHintsService — Frei-Text-Hints pro (user, tool, field).
 *
 * Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase E).
 * Tabelle: user_tool_default_hints (Mig 0028).
 *
 * Konzept (Plan §3.4):
 *   Hints sind Frei-Text-Strings (≤500 chars), die ein Field semantisch
 *   beschreiben — z.B. "0.0 deterministisch .. 2.0 wild" für `temperature`.
 *   Sie wandern in `tools.help` (LLM-Read) + optional in den
 *   Elicitation-Pfad (DANGER-Tool ohne Default + Capability vorhanden).
 *
 *   Hints sind **profile-übergreifend** (Plan §3.4 + v1 PLAN-prefs: "Bedeutung
 *   ist global"). Daher PK ohne profile_name.
 *
 * Per-User-Isolation (Plan §8):
 *   PK enthaelt user_id + RLS-Policy `utdh_owner_only`.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolDefaultHint {
  readonly userId: string;
  readonly subMcpName: string;
  readonly toolName: string;
  readonly fieldName: string;
  readonly hintText: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SetHintArgs {
  readonly userId: string;
  readonly subMcpName: string;
  readonly toolName: string;
  readonly fieldName: string;
  readonly hintText: string;
}

export interface ToolDefaultHintsService {
  /** Alle Hints fuer (user, sub_mcp_name) — fuer PWA-Tab-Overview. */
  listByServer(
    userId: string,
    subMcpName: string,
  ): Promise<ReadonlyArray<ToolDefaultHint>>;
  /** Hints fuer ein einzelnes Tool — fuer tools.help. */
  listByTool(
    userId: string,
    subMcpName: string,
    toolName: string,
  ): Promise<ReadonlyArray<ToolDefaultHint>>;
  /** Existenz-Check (z.B. Elicit-Hook). Optimiert via COUNT. */
  hasAnyForTool(
    userId: string,
    subMcpName: string,
    toolName: string,
  ): Promise<boolean>;
  /** Upsert. hintText '' wird als delete behandelt (PWA-Convention). */
  set(args: SetHintArgs): Promise<ToolDefaultHint>;
  /** Remove einer einzelnen Hint. */
  remove(
    userId: string,
    subMcpName: string,
    toolName: string,
    fieldName: string,
  ): Promise<void>;
}

interface RawHintRow {
  readonly user_id: string;
  readonly sub_mcp_name: string;
  readonly tool_name: string;
  readonly field_name: string;
  readonly hint_text: string;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

function toNumber(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

function rowToHint(r: RawHintRow): ToolDefaultHint {
  return {
    userId: r.user_id,
    subMcpName: r.sub_mcp_name,
    toolName: r.tool_name,
    fieldName: r.field_name,
    hintText: r.hint_text,
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  };
}

const SELECT_COLS = `
  user_id, sub_mcp_name, tool_name, field_name,
  hint_text, created_at, updated_at
`;

const MAX_HINT_LEN = 500; // siehe Mig 0028 CHECK constraint.

// ---------------------------------------------------------------------------
// Service-Factory
// ---------------------------------------------------------------------------

export interface ToolDefaultHintsServiceOpts {
  readonly db: DbAdapter;
  readonly now?: () => number;
}

export function createToolDefaultHintsService(
  opts: ToolDefaultHintsServiceOpts,
): ToolDefaultHintsService {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());

  return {
    async listByServer(userId, subMcpName) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawHintRow>(
          `SELECT ${SELECT_COLS}
             FROM user_tool_default_hints
            WHERE user_id = $1 AND sub_mcp_name = $2
            ORDER BY tool_name ASC, field_name ASC`,
          [userId, subMcpName],
        );
        return rows.map(rowToHint);
      });
    },

    async listByTool(userId, subMcpName, toolName) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawHintRow>(
          `SELECT ${SELECT_COLS}
             FROM user_tool_default_hints
            WHERE user_id = $1 AND sub_mcp_name = $2 AND tool_name = $3
            ORDER BY field_name ASC`,
          [userId, subMcpName, toolName],
        );
        return rows.map(rowToHint);
      });
    },

    async hasAnyForTool(userId, subMcpName, toolName) {
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<{ exists: boolean }>(
          `SELECT 1 AS exists
             FROM user_tool_default_hints
            WHERE user_id = $1 AND sub_mcp_name = $2 AND tool_name = $3
            LIMIT 1`,
          [userId, subMcpName, toolName],
        );
        return rows.length > 0;
      });
    },

    async set(args) {
      if (typeof args.hintText !== 'string') {
        throw HttpError.badRequest('invalid_request', 'hintText must be a string');
      }
      if (args.hintText.length > MAX_HINT_LEN) {
        throw HttpError.badRequest(
          'invalid_request',
          `hintText too long (${args.hintText.length} chars, max ${MAX_HINT_LEN})`,
        );
      }
      const ts = now();
      const row = await db.transaction(args.userId, async (scoped) => {
        const rows = await scoped.query<RawHintRow>(
          `INSERT INTO user_tool_default_hints
             (user_id, sub_mcp_name, tool_name, field_name,
              hint_text, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           ON CONFLICT (user_id, sub_mcp_name, tool_name, field_name) DO UPDATE
             SET hint_text  = EXCLUDED.hint_text,
                 updated_at = EXCLUDED.updated_at
           RETURNING ${SELECT_COLS}`,
          [
            args.userId,
            args.subMcpName,
            args.toolName,
            args.fieldName,
            args.hintText,
            ts,
          ],
        );
        return rows[0];
      });
      if (!row) throw new Error('hint upsert returned no row');
      return rowToHint(row);
    },

    async remove(userId, subMcpName, toolName, fieldName) {
      await db.transaction(userId, async (scoped) => {
        await scoped.query(
          `DELETE FROM user_tool_default_hints
            WHERE user_id = $1 AND sub_mcp_name = $2
              AND tool_name = $3 AND field_name = $4`,
          [userId, subMcpName, toolName, fieldName],
        );
      });
    },
  };
}
