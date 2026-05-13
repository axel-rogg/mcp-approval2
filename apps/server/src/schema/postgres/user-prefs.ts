/**
 * user_tool_prefs — flache Per-Row Tool-Defaults (additiv zu user_prefs).
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md (mcp-approval), Burst 3 (Settings/Prefs).
 *
 * Eine Row pro (user_id, tool_name, field, scope). Wert ist beliebiges JSON
 * (string / number / boolean / object / array) im jsonb-Feld.
 *
 * `scope` (Default 'user'): zukuenftige Erweiterung fuer tenant-/session-Scopes.
 * Heute schreibt nur 'user' an — Resolution prueft 'session' > 'user' > 'tenant'.
 *
 * RLS: 'user_tool_prefs_owner' Policy in 0009_user_prefs.sql.
 */
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const userToolPrefsTable = pgTable(
  'user_tool_prefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    toolName: text('tool_name').notNull(),
    field: text('field').notNull(),
    valueJson: jsonb('value_json').notNull().$type<unknown>(),
    scope: text('scope').notNull().default('user'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    uniqIdx: uniqueIndex('idx_user_tool_prefs_unique').on(
      t.userId,
      t.toolName,
      t.field,
      t.scope,
    ),
    lookupIdx: index('idx_user_tool_prefs_lookup').on(t.userId, t.toolName),
  }),
);

export type PrefScope = 'user' | 'tenant' | 'session';
