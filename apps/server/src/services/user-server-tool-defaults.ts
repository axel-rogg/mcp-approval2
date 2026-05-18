/**
 * UserServerToolDefaultsService — typed Per-User-Per-Tool-Defaults.
 *
 * Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase B).
 * Tabelle: user_server_tool_defaults (Mig 0024 + 0028).
 *
 * Schema-Evolution:
 *   - 0024: flat row, `value_text TEXT NOT NULL` als Plain-String.
 *   - 0028: + `profile_name TEXT DEFAULT 'default'`, `value_json JSONB`,
 *           `value_kind TEXT DEFAULT 'text'`, `orphan_since BIGINT NULL`.
 *           PK auf (user_id, sub_mcp_name, profile_name, tool_name, field_name).
 *
 * Lazy-Read-Migration: `value_json` ist bevorzugt; wenn null faellt der
 * Service auf `value_text` zurueck (string-typed). Schreibpfad (`set`)
 * persistiert IMMER beides — value_json (typed) und value_text (string-Cast
 * fuer BC) bis Phase F das alte Feld dropt.
 *
 * Per-User-Isolation (Plan §8): `db.transaction(userId, ...)` setzt
 * `app.current_user`, RLS-Policy `usttd_owner_only` enforct DB-seitig.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import type { ToolDefaultValueKind } from '../schema/postgres/tool-defaults-v2.js';
import { TOOL_DEFAULT_VALUE_KINDS } from '../schema/postgres/tool-defaults-v2.js';
import { HttpError } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolDefault {
  readonly userId: string;
  readonly subMcpName: string;
  readonly profileName: string;
  readonly toolName: string;
  readonly fieldName: string;
  /**
   * Typed value (JSON-parseable). `string | number | boolean | object | array | null`.
   * Caller muss `valueKind` lesen um zu interpretieren — z.B. `null` bei `kind='json'`
   * ist legitim, `null` bei `kind='boolean'` waere Schema-Bug.
   */
  readonly value: unknown;
  readonly valueKind: ToolDefaultValueKind;
  readonly isSecret: boolean;
  /** Set wenn das Field nicht (mehr) im Tool-Schema vorhanden ist. */
  readonly orphanSince: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SetToolDefaultArgs {
  readonly userId: string;
  readonly subMcpName: string;
  /** Default `'default'`. Phase-C-Caller setzen explizit. */
  readonly profileName?: string;
  readonly toolName: string;
  readonly fieldName: string;
  readonly value: unknown;
  readonly valueKind?: ToolDefaultValueKind;
  readonly isSecret?: boolean;
}

export interface MarkOrphanArgs {
  readonly userId: string;
  readonly subMcpName: string;
  readonly profileName: string;
  readonly toolName: string;
  readonly fieldName: string;
  /** `null` setzt die Markierung zurueck (Field ist zurueck im Schema). */
  readonly orphanSince: number | null;
}

export interface UserServerToolDefaultsService {
  /** Alle Defaults eines Users fuer einen Server (alle Profile). */
  listByServer(userId: string, subMcpName: string): Promise<ReadonlyArray<ToolDefault>>;
  /** Defaults fuer ein spezifisches Tool im aktiven oder gegebenen Profil. */
  listByTool(
    userId: string,
    subMcpName: string,
    toolName: string,
    profileName?: string,
  ): Promise<ReadonlyArray<ToolDefault>>;
  /** Upsert eines Defaults. Typed Value + Schema-Validation an Caller-Seite. */
  set(args: SetToolDefaultArgs): Promise<ToolDefault>;
  /** Loescht ein Default. */
  remove(
    userId: string,
    subMcpName: string,
    toolName: string,
    fieldName: string,
    profileName?: string,
  ): Promise<void>;
  /** Loescht alle Defaults eines Users fuer einen Server (Profile-uebergreifend). */
  removeAllForServer(userId: string, subMcpName: string): Promise<void>;
  /** Markiert ein Field als orphan oder unset es (Drift-Detection). */
  markOrphan(args: MarkOrphanArgs): Promise<void>;
}

// ---------------------------------------------------------------------------
// Konstanten — Entscheidungen 2026-05-18
// ---------------------------------------------------------------------------

/**
 * Plan §10 Entscheidung ④: Felder mit diesen Suffixen koennen Secrets sein.
 * `set()` wirft 400 wenn ein solches Field mit valueKind='text' gesetzt wird.
 * Mitigation gegen leakende API-Keys/Tokens in Tool-Defaults (Klartext-Storage).
 */
const SECRET_FIELD_SUFFIX_RE = /_(?:key|token|secret|password)$/i;

/** Profile-Name-Pattern (Plan §3 + Mig 0028 CHECK). */
const PROFILE_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// ---------------------------------------------------------------------------
// Row-Mapping
// ---------------------------------------------------------------------------

interface RawRow {
  readonly user_id: string;
  readonly sub_mcp_name: string;
  readonly profile_name: string;
  readonly tool_name: string;
  readonly field_name: string;
  readonly value_text: string;
  readonly value_json: unknown;
  readonly value_kind: string;
  readonly is_secret: boolean;
  readonly orphan_since: number | string | null;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

function toNumber(v: number | string): number {
  return typeof v === 'number' ? v : Number(v);
}

function toNumberOrNull(v: number | string | null): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : Number(v);
}

function isValueKind(v: string): v is ToolDefaultValueKind {
  return (TOOL_DEFAULT_VALUE_KINDS as ReadonlyArray<string>).includes(v);
}

/**
 * Bestimmt den effective `value` einer Row. Bevorzugt `value_json`, sonst
 * faellt zurueck auf `value_text` (legacy bei pre-0028-Rows die noch nicht
 * upgraded sind).
 */
function effectiveValue(row: RawRow): unknown {
  if (row.value_json !== null && row.value_json !== undefined) {
    return row.value_json;
  }
  return row.value_text;
}

function rowToEntry(r: RawRow): ToolDefault {
  const kind: ToolDefaultValueKind = isValueKind(r.value_kind)
    ? r.value_kind
    : 'text';
  return {
    userId: r.user_id,
    subMcpName: r.sub_mcp_name,
    profileName: r.profile_name,
    toolName: r.tool_name,
    fieldName: r.field_name,
    value: effectiveValue(r),
    valueKind: kind,
    isSecret: r.is_secret,
    orphanSince: toNumberOrNull(r.orphan_since),
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  };
}

const SELECT_COLS = `
  user_id, sub_mcp_name, profile_name, tool_name, field_name,
  value_text, value_json, value_kind, is_secret,
  orphan_since, created_at, updated_at
`;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw HttpError.badRequest(
      'invalid_request',
      `profile name '${name}' is not a valid slug (a-z 0-9 _ -, max 64 chars)`,
    );
  }
}

/**
 * Validiert dass `value` zu `valueKind` passt. Wirft 400 bei Mismatch.
 * Schema-Conformance gegen das *Tool*-Schema ist Caller-Pflicht (z.B. via
 * Zod-`safeParse` in der HTTP-Route oder im MCP-Tool).
 */
function assertTypeMatchesKind(value: unknown, kind: ToolDefaultValueKind): void {
  switch (kind) {
    case 'text':
      if (typeof value !== 'string') {
        throw HttpError.badRequest(
          'invalid_request',
          `value_kind='text' requires string value, got ${typeof value}`,
        );
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw HttpError.badRequest(
          'invalid_request',
          `value_kind='number' requires finite number, got ${typeof value}`,
        );
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw HttpError.badRequest(
          'invalid_request',
          `value_kind='boolean' requires boolean, got ${typeof value}`,
        );
      }
      return;
    case 'enum':
      // enum hat keinen Type-Constraint hier — der Caller prueft gegen die
      // konkrete Werteliste im Tool-Schema. Wir akzeptieren string/number/
      // boolean.
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw HttpError.badRequest(
          'invalid_request',
          `value_kind='enum' requires string|number|boolean, got ${typeof value}`,
        );
      }
      return;
    case 'json':
      // jsonb akzeptiert alles JSON-encodable. Hier nur eine Sanity-Check
      // gegen funktion / undefined.
      if (typeof value === 'function') {
        throw HttpError.badRequest(
          'invalid_request',
          `value_kind='json' does not accept function values`,
        );
      }
      return;
  }
}

/**
 * Plan §10 Entscheidung ④: Soft-Block fuer Felder die nach Secrets aussehen.
 * Wirft 400 mit Hinweis auf den Auth-Tab.
 */
function assertNotSecretField(fieldName: string, valueKind: ToolDefaultValueKind): void {
  if (valueKind !== 'text') return;
  if (!SECRET_FIELD_SUFFIX_RE.test(fieldName)) return;
  throw HttpError.badRequest(
    'invalid_request',
    `field '${fieldName}' sieht nach Secret aus — verwende den Auth-Tab des Servers, nicht Tool-Defaults.`,
  );
}

// ---------------------------------------------------------------------------
// Service-Factory
// ---------------------------------------------------------------------------

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
            ORDER BY profile_name ASC, tool_name ASC, field_name ASC`,
          [userId, subMcpName],
        );
        return rows.map(rowToEntry);
      });
    },

    async listByTool(userId, subMcpName, toolName, profileName) {
      const params: unknown[] = [userId, subMcpName, toolName];
      let sql = `SELECT ${SELECT_COLS} FROM user_server_tool_defaults
                  WHERE user_id = $1 AND sub_mcp_name = $2 AND tool_name = $3`;
      if (profileName !== undefined) {
        params.push(profileName);
        sql += ` AND profile_name = $${params.length}`;
      }
      sql += ` ORDER BY profile_name ASC, field_name ASC`;
      return await db.transaction(userId, async (scoped) => {
        const rows = await scoped.query<RawRow>(sql, params);
        return rows.map(rowToEntry);
      });
    },

    async set(args) {
      const profile = args.profileName ?? 'default';
      assertProfileName(profile);
      const kind: ToolDefaultValueKind = args.valueKind ?? inferValueKind(args.value);
      assertTypeMatchesKind(args.value, kind);
      assertNotSecretField(args.fieldName, kind);
      const isSecret = args.isSecret ?? false;
      const ts = now();
      const valueText = stringifyForLegacy(args.value, kind);
      const row = await db.transaction(args.userId, async (scoped) => {
        const rows = await scoped.query<RawRow>(
          `INSERT INTO user_server_tool_defaults
             (user_id, sub_mcp_name, profile_name, tool_name, field_name,
              value_text, value_json, value_kind, is_secret,
              orphan_since, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5,
                   $6, $7::jsonb, $8, $9,
                   NULL, $10, $10)
           ON CONFLICT (user_id, sub_mcp_name, profile_name, tool_name, field_name) DO UPDATE
             SET value_text  = EXCLUDED.value_text,
                 value_json  = EXCLUDED.value_json,
                 value_kind  = EXCLUDED.value_kind,
                 is_secret   = EXCLUDED.is_secret,
                 orphan_since = NULL,
                 updated_at  = EXCLUDED.updated_at
           RETURNING ${SELECT_COLS}`,
          [
            args.userId,
            args.subMcpName,
            profile,
            args.toolName,
            args.fieldName,
            valueText,
            JSON.stringify(args.value),
            kind,
            isSecret,
            ts,
          ],
        );
        return rows[0];
      });
      if (!row) throw new Error('tool_defaults upsert returned no row');
      return rowToEntry(row);
    },

    async remove(userId, subMcpName, toolName, fieldName, profileName) {
      const profile = profileName ?? 'default';
      await db.transaction(userId, async (scoped) => {
        await scoped.query(
          `DELETE FROM user_server_tool_defaults
            WHERE user_id = $1 AND sub_mcp_name = $2
              AND profile_name = $3
              AND tool_name = $4 AND field_name = $5`,
          [userId, subMcpName, profile, toolName, fieldName],
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

    async markOrphan(args) {
      await db.transaction(args.userId, async (scoped) => {
        await scoped.query(
          `UPDATE user_server_tool_defaults
              SET orphan_since = $1
            WHERE user_id = $2 AND sub_mcp_name = $3
              AND profile_name = $4
              AND tool_name = $5 AND field_name = $6`,
          [
            args.orphanSince,
            args.userId,
            args.subMcpName,
            args.profileName,
            args.toolName,
            args.fieldName,
          ],
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (exported fuer Tests + REST-Route)
// ---------------------------------------------------------------------------

export function inferValueKind(v: unknown): ToolDefaultValueKind {
  if (typeof v === 'string') return 'text';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'json';
}

/**
 * Plain-String-Rendering fuer value_text (BC mit Mig-0024-only-Tabellen).
 * Wird in Phase F obsolete wenn die Spalte gedroppt wird.
 */
function stringifyForLegacy(value: unknown, kind: ToolDefaultValueKind): string {
  if (kind === 'text') return String(value);
  if (kind === 'number' || kind === 'boolean' || kind === 'enum') {
    return String(value);
  }
  return JSON.stringify(value);
}

export { SECRET_FIELD_SUFFIX_RE };
