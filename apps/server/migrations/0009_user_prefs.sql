-- =============================================================================
-- 0009_user_prefs.sql — Per-Row Tool-Defaults (additiv zu 0008_prefs)
-- =============================================================================
-- Plan-Ref: docs/plans/done/PLAN-prefs.md (mcp-approval), Burst 3 (Settings/Prefs).
--
-- Hintergrund: 0008_prefs hat `user_prefs` als 1-row-per-user encrypted-blob
-- (UserPrefsData mit toolDefaults+profiles+hints) angelegt. Diese Migration
-- ergaenzt eine flache per-Row-Tabelle `user_tool_prefs` fuer den vereinfachten
-- {toolName, field, value}-Surface, den die neuen prefs.get/set/remove Tools
-- + resolveForTool() verwenden. Die beiden Tabellen koexistieren — die alte
-- bleibt fuer Profiles/Hints reserviert, die neue ist die operative.
--
-- Schema:
--   - id          UUID PK
--   - user_id     UUID FK users(id) ON DELETE CASCADE
--   - tool_name   text (z.B. 'gws:gmail.send', 'docs.put')
--   - field       text (der Argument-Name, z.B. 'model', 'language')
--   - value_json  jsonb (beliebige JSON-Werte: string|number|bool|obj|array)
--   - scope       text 'user' | 'tenant' | 'session' (Default 'user')
--   - created_at / updated_at  bigint Unix-ms
--   - UNIQUE (user_id, tool_name, field, scope)
--
-- RLS: owner-only Policy (current_setting('app.current_user', TRUE)::uuid).
-- Idempotent: alle CREATE haben IF NOT EXISTS / DO $$-blocks.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_tool_prefs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL,
  field        TEXT NOT NULL,
  value_json   JSONB NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'user',
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,

  CONSTRAINT user_tool_prefs_scope_check
    CHECK (scope IN ('user', 'tenant', 'session')),
  CONSTRAINT user_tool_prefs_tool_name_len
    CHECK (length(tool_name) BETWEEN 1 AND 128),
  CONSTRAINT user_tool_prefs_field_len
    CHECK (length(field) BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tool_prefs_unique
  ON user_tool_prefs(user_id, tool_name, field, scope);

CREATE INDEX IF NOT EXISTS idx_user_tool_prefs_lookup
  ON user_tool_prefs(user_id, tool_name);

-- =============================================================================
-- Row-Level-Security: owner-only
-- =============================================================================

ALTER TABLE user_tool_prefs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'user_tool_prefs_owner' AND tablename = 'user_tool_prefs'
  ) THEN
    CREATE POLICY user_tool_prefs_owner ON user_tool_prefs
      USING (user_id = current_setting('app.current_user', TRUE)::uuid)
      WITH CHECK (user_id = current_setting('app.current_user', TRUE)::uuid);
  END IF;
END$$;

-- =============================================================================
-- END 0009_user_prefs.sql
-- =============================================================================
