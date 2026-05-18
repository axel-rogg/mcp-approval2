/**
 * Tool-Defaults v2 — Profile + Hints + Active-Profile-Override.
 *
 * Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase B + C + E).
 * Migration: 0028_tool_defaults_v2.sql.
 *
 * Per-User-Isolation (Plan §8 Garantie-Liste):
 *   - user_id ist Teil jedes PK
 *   - RLS-Policy nutzt current_setting('app.current_user') auf allen Tabellen
 *
 * Hinweis zu user_server_tool_defaults: die existierende Tabelle (Mig 0024)
 * wird durch 0028 erweitert (profile_name, value_json, value_kind,
 * orphan_since). Das Drizzle-Schema dieser Tabelle lebt weiterhin im Service-
 * Layer (services/user-server-tool-defaults.ts macht raw SQL, kein typed
 * drizzle-Query); deshalb hier nur die neuen Tabellen.
 */
import {
  bigint,
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * user_tool_default_profiles — pro (user × sub_mcp_name) ein Set von Profilen.
 * Genau eines pro (user, sub_mcp_name) hat `is_active=TRUE` (unique partial
 * index in 0028).
 */
export const userToolDefaultProfilesTable = pgTable(
  'user_tool_default_profiles',
  {
    userId: uuid('user_id').notNull(),
    subMcpName: text('sub_mcp_name').notNull(),
    profileName: text('profile_name').notNull(),
    description: text('description').notNull().default(''),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.subMcpName, t.profileName] }),
    byUserServer: index('idx_utdp_user_server').on(t.userId, t.subMcpName),
    oneActive: uniqueIndex('idx_utdp_one_active')
      .on(t.userId, t.subMcpName)
      .where({ raw: 'is_active = TRUE' } as never),
  }),
);

/**
 * user_tool_default_hints — Frei-Text-Hint pro (user, sub_mcp, tool, field).
 * Profile-uebergreifend (siehe v1 PLAN-prefs: "Bedeutung ist global").
 */
export const userToolDefaultHintsTable = pgTable(
  'user_tool_default_hints',
  {
    userId: uuid('user_id').notNull(),
    subMcpName: text('sub_mcp_name').notNull(),
    toolName: text('tool_name').notNull(),
    fieldName: text('field_name').notNull(),
    hintText: text('hint_text').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.userId, t.subMcpName, t.toolName, t.fieldName],
    }),
    byUserTool: index('idx_utdh_user_tool').on(
      t.userId,
      t.subMcpName,
      t.toolName,
    ),
  }),
);

/**
 * user_tool_active_profile — Per-Tool-Override des aktiven Profils.
 * Wenn nicht gesetzt: Resolver fuallt auf `user_tool_default_profiles`-
 * Active-Profil pro Sub-MCP zurueck.
 */
export const userToolActiveProfileTable = pgTable(
  'user_tool_active_profile',
  {
    userId: uuid('user_id').notNull(),
    subMcpName: text('sub_mcp_name').notNull(),
    toolName: text('tool_name').notNull(),
    profileName: text('profile_name').notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.subMcpName, t.toolName] }),
  }),
);

/** value_kind discriminator fuer user_server_tool_defaults.value_json. */
export type ToolDefaultValueKind =
  | 'text'
  | 'json'
  | 'number'
  | 'boolean'
  | 'enum';

export const TOOL_DEFAULT_VALUE_KINDS: ReadonlyArray<ToolDefaultValueKind> = [
  'text',
  'json',
  'number',
  'boolean',
  'enum',
];
