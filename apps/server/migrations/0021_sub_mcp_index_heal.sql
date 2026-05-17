-- 0021_sub_mcp_index_heal.sql — Heal-Migration nach 0020-Race
--
-- Hintergrund (2026-05-17):
-- Zwischen parallelen Apply-Versuchen von 0020 (3 verschiedene Versionen
-- in Folge committed: ursprüngliches DROP+CREATE-UNIQUE, dann mein
-- CASCADE-Patch, dann simplified) ist der DB-State unklar:
--
--   - idx_sub_mcp_name (UNIQUE on sub_mcp_servers(name)) könnte gedroppt sein
--     (CASCADE-Effekt aus failed-but-partial Apply)
--   - FKs aus 0018+0019 (REFERENCES sub_mcp_servers(name)) könnten mit-
--     gedroppt sein wegen CASCADE
--
-- Diese Migration ist idempotent + heal-only: legt Index + FKs wieder an
-- wenn sie fehlen, no-op wenn sie noch da sind.

-- 1. Re-create idx_sub_mcp_name wenn weg.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_mcp_name
  ON sub_mcp_servers(name);

-- 2. Re-create FK von user_sub_mcp_subscriptions wenn weg.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'user_sub_mcp_subscriptions'::regclass
       AND conname = 'user_sub_mcp_subscriptions_sub_mcp_name_fkey'
  ) THEN
    ALTER TABLE user_sub_mcp_subscriptions
      ADD CONSTRAINT user_sub_mcp_subscriptions_sub_mcp_name_fkey
      FOREIGN KEY (sub_mcp_name) REFERENCES sub_mcp_servers(name) ON DELETE CASCADE;
  END IF;
END $$;

-- 3. Re-create FK von user_sub_mcp_config wenn weg.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'user_sub_mcp_config'::regclass
       AND conname = 'user_sub_mcp_config_sub_mcp_name_fkey'
  ) THEN
    ALTER TABLE user_sub_mcp_config
      ADD CONSTRAINT user_sub_mcp_config_sub_mcp_name_fkey
      FOREIGN KEY (sub_mcp_name) REFERENCES sub_mcp_servers(name) ON DELETE CASCADE;
  END IF;
END $$;
