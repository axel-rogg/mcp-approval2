/**
 * PrefsService — Tool-Defaults / Profiles / Hints fuer den `user_tool_prefs`-
 * Surface (additiv zu 0008_prefs.user_prefs encrypted-blob).
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md (mcp-approval), Burst 3.
 *
 * Verantwortung:
 *   - CRUD ueber `user_tool_prefs`-Rows (owner-scoped via RLS).
 *   - `resolveForTool(userId, toolName, userInput)` — Hub-side `applyDefaults`-
 *     Hook. Mergt die gespeicherten Defaults in den Tool-Input, ohne explizit
 *     gesetzte User-Args zu ueberschreiben (Args WIN), und liefert eine
 *     Attribution-Liste fuer WYSIWYS-Display.
 *
 * Scope-Hierarchie (heute nur 'user' beschreibbar, Resolution zukunftssicher):
 *   session > user > tenant. Bei Konflikt zwischen zwei Scopes fuer dasselbe
 *   field gewinnt der hoehere — session > user > tenant. Tenant-Defaults
 *   waeren admin-managed, session-Defaults waeren request-scoped.
 *
 * Owner-Only: `db.scoped(userId)` setzt `app.current_user`; die RLS-Policy
 * in 0009 enforct das DB-seitig.
 */
import type { DbAdapter, ScopedDb } from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';

export type PrefScope = 'user' | 'tenant' | 'session';

export interface ToolDefault {
  readonly toolName: string;
  readonly field: string;
  readonly value: unknown;
  readonly scope: PrefScope;
}

export interface GetPrefsArgs {
  readonly userId: string;
  readonly toolName?: string;
  readonly field?: string;
}

export interface SetPrefArgs {
  readonly userId: string;
  readonly toolName: string;
  readonly field: string;
  readonly value: unknown;
  readonly scope?: PrefScope;
}

export interface RemovePrefArgs {
  readonly userId: string;
  readonly toolName: string;
  readonly field: string;
  readonly scope?: PrefScope;
}

export interface ResolveForToolArgs {
  readonly userId: string;
  readonly toolName: string;
  readonly userInput: Record<string, unknown>;
}

export interface AppliedDefault {
  readonly field: string;
  readonly from: 'user-input' | 'tool-default' | 'profile';
  readonly scope?: PrefScope;
}

export interface ResolveForToolResult {
  readonly resolvedInput: Record<string, unknown>;
  readonly defaultsApplied: AppliedDefault[];
}

export interface PrefsService {
  get(args: GetPrefsArgs): Promise<ToolDefault[]>;
  set(args: SetPrefArgs): Promise<void>;
  remove(args: RemovePrefArgs): Promise<void>;
  resolveForTool(args: ResolveForToolArgs): Promise<ResolveForToolResult>;
}

export interface PrefsServiceOptions {
  readonly db: DbAdapter;
}

// ---------------------------------------------------------------------------
// Row-Helpers
// ---------------------------------------------------------------------------

interface PrefRowRaw {
  readonly tool_name: string;
  readonly field: string;
  readonly value_json: unknown;
  readonly scope: string;
}

function rowToDefault(row: PrefRowRaw): ToolDefault {
  return {
    toolName: row.tool_name,
    field: row.field,
    value: row.value_json,
    scope: row.scope as PrefScope,
  };
}

const VALID_SCOPES: ReadonlyArray<PrefScope> = ['user', 'tenant', 'session'];

function assertScope(scope: PrefScope | undefined): PrefScope {
  const s = scope ?? 'user';
  if (!VALID_SCOPES.includes(s)) {
    throw HttpError.badRequest('invalid_request', `invalid scope: ${s}`);
  }
  return s;
}

function assertField(name: string, value: string, max = 128): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw HttpError.badRequest('invalid_request', `${name} must be a non-empty string`);
  }
  if (value.length > max) {
    throw HttpError.badRequest('invalid_request', `${name} exceeds ${max} chars`);
  }
}

// Postgres jsonb-Parameter: drizzle-postgres erwartet string-encoded JSON beim
// bind() — node-postgres serialisiert Plain-Objects automatisch, aber primitive
// (string/number/bool) muessen explizit als JSON-Literal encoded werden.
function toJsonbParam(value: unknown): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createPrefsService(opts: PrefsServiceOptions): PrefsService {
  const { db } = opts;

  async function withScoped<T>(
    userId: string,
    fn: (scoped: ScopedDb) => Promise<T>,
  ): Promise<T> {
    return db.transaction(userId, async (scoped) => fn(scoped));
  }

  return {
    async get(args) {
      return withScoped(args.userId, async (scoped) => {
        const conditions: string[] = ['user_id = $1'];
        const params: unknown[] = [args.userId];
        if (args.toolName !== undefined) {
          assertField('toolName', args.toolName);
          params.push(args.toolName);
          conditions.push(`tool_name = $${params.length}`);
        }
        if (args.field !== undefined) {
          assertField('field', args.field);
          params.push(args.field);
          conditions.push(`field = $${params.length}`);
        }
        const rows = await scoped.query<PrefRowRaw>(
          `SELECT tool_name, field, value_json, scope
             FROM user_tool_prefs
            WHERE ${conditions.join(' AND ')}
            ORDER BY tool_name, field, scope`,
          params,
        );
        return rows.map(rowToDefault);
      });
    },

    async set(args) {
      assertField('toolName', args.toolName);
      assertField('field', args.field);
      const scope = assertScope(args.scope);
      const now = Date.now();
      await withScoped(args.userId, async (scoped) => {
        await scoped.query(
          `INSERT INTO user_tool_prefs
             (user_id, tool_name, field, value_json, scope, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6)
           ON CONFLICT (user_id, tool_name, field, scope)
           DO UPDATE SET
             value_json = EXCLUDED.value_json,
             updated_at = EXCLUDED.updated_at`,
          [args.userId, args.toolName, args.field, toJsonbParam(args.value), scope, now],
        );
      });
    },

    async remove(args) {
      assertField('toolName', args.toolName);
      assertField('field', args.field);
      const scope = assertScope(args.scope);
      await withScoped(args.userId, async (scoped) => {
        await scoped.query(
          `DELETE FROM user_tool_prefs
            WHERE user_id = $1 AND tool_name = $2 AND field = $3 AND scope = $4`,
          [args.userId, args.toolName, args.field, scope],
        );
      });
    },

    async resolveForTool(args) {
      assertField('toolName', args.toolName);
      return withScoped(args.userId, async (scoped) => {
        const rows = await scoped.query<PrefRowRaw>(
          `SELECT tool_name, field, value_json, scope
             FROM user_tool_prefs
            WHERE user_id = $1 AND tool_name = $2`,
          [args.userId, args.toolName],
        );

        // Scope-Hierarchie: session > user > tenant — bei Konflikten gewinnt
        // der hoehere. Wir builden eine Map<field, ToolDefault> in dieser
        // Prioritaets-Reihenfolge auf.
        const SCOPE_RANK: Record<PrefScope, number> = {
          tenant: 0,
          user: 1,
          session: 2,
        };
        const winnerByField = new Map<string, PrefRowRaw>();
        for (const row of rows) {
          const existing = winnerByField.get(row.field);
          if (
            !existing ||
            SCOPE_RANK[row.scope as PrefScope] > SCOPE_RANK[existing.scope as PrefScope]
          ) {
            winnerByField.set(row.field, row);
          }
        }

        const resolvedInput: Record<string, unknown> = { ...args.userInput };
        const defaultsApplied: AppliedDefault[] = [];
        for (const field of Object.keys(args.userInput)) {
          if (args.userInput[field] !== undefined) {
            defaultsApplied.push({ field, from: 'user-input' });
          }
        }
        for (const [field, row] of winnerByField) {
          const userVal = resolvedInput[field];
          if (userVal === undefined || userVal === null) {
            resolvedInput[field] = row.value_json;
            defaultsApplied.push({
              field,
              from: 'tool-default',
              scope: row.scope as PrefScope,
            });
          }
        }
        return { resolvedInput, defaultsApplied };
      });
    },
  };
}
