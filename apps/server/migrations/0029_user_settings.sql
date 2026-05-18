-- =============================================================================
-- 0029_user_settings.sql — per-User Agent-Settings (key/value JSONB store)
-- =============================================================================
--
-- Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase E).
--
-- Heute: ein einziges Setting `elicit_on_missing_defaults` (boolean) das
-- den MCP-Elicitation-Hook im Transport schaltet (Plan-Entscheidung ②).
--
-- Generisches key/value-Schema damit kuenftige Phasen weitere Per-User-Settings
-- (z.B. UI-Themes, Notification-Toggles) hier persistieren koennen ohne neue
-- Migrationen.
--
-- Per-User-Isolation: PK (user_id, key) + RLS owner-only.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, key),
  CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$')
);

CREATE INDEX IF NOT EXISTS idx_user_settings_user
  ON user_settings(user_id);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'user_settings'
       AND policyname = 'user_settings_owner_only'
  ) THEN
    CREATE POLICY user_settings_owner_only ON user_settings
      USING (user_id = current_setting('app.current_user', true)::UUID)
      WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- END 0029_user_settings.sql
-- =============================================================================
