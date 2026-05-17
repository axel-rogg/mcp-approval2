-- 0024_user_server_tool_defaults.sql — per-User pro-Tool Defaults.
--
-- Plan-Ref: docs/plans/active/PLAN-tools-tab-ux-refactor.md (Phase D).
--
-- Bisher lebten Tool-Defaults unter user_profile.tool_defaults (8 KiB-Blob).
-- Phase D macht das pro-Server modelliert: ein Server (sub_mcp_servers oder
-- 'native'/'knowledge2'-special) hat 0..n Tools, jedes Tool hat 0..n
-- Default-Felder.
--
-- Storage:
--   - sub_mcp_name: 'native' | 'knowledge2' | <sub_mcp_server.name>
--     'native' und 'knowledge2' sind virtuelle Server (kein FK), die anderen
--     haben FK auf sub_mcp_servers.name (ON DELETE CASCADE).
--     → FK-Constraint ist nur partial (CHECK + Trigger waeren overkill);
--     stattdessen: KEIN FK, sondern application-side-Check.
--   - tool_name: Tool-Identifier (z.B. 'gws.calendar.list')
--   - field_name: Default-Feld (z.B. 'default_calendar')
--   - value_text: Plain-Wert (NICHT KMS-encrypted — Defaults sind keine Secrets)
--   - Optionaler is_secret-Flag bleibt fuer spaeter (z.B. Default-API-Key
--     pro Tool).
--
-- RLS: User sieht nur eigene Rows.

CREATE TABLE IF NOT EXISTS user_server_tool_defaults (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name  TEXT NOT NULL,           -- 'native' | 'knowledge2' | sub_mcp_servers.name
  tool_name     TEXT NOT NULL,           -- e.g. 'gws.calendar.list'
  field_name    TEXT NOT NULL,           -- e.g. 'default_calendar'
  value_text    TEXT NOT NULL DEFAULT '',
  is_secret     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name, tool_name, field_name)
);

-- Cascade-Delete bei sub_mcp_server-Removal: wir koennen kein FK setzen
-- (sub_mcp_name kann 'native'/'knowledge2' sein), aber wir wollen die Rows
-- mit-droppen wenn ein user-owned Server geloescht wird. Trigger:
CREATE OR REPLACE FUNCTION usttd_cascade_on_submcp_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM user_server_tool_defaults
   WHERE sub_mcp_name = OLD.name;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_usttd_cascade_submcp_delete ON sub_mcp_servers;
CREATE TRIGGER trg_usttd_cascade_submcp_delete
  AFTER DELETE ON sub_mcp_servers
  FOR EACH ROW EXECUTE FUNCTION usttd_cascade_on_submcp_delete();

CREATE INDEX IF NOT EXISTS idx_usttd_user_server
  ON user_server_tool_defaults(user_id, sub_mcp_name);
CREATE INDEX IF NOT EXISTS idx_usttd_user_tool
  ON user_server_tool_defaults(user_id, tool_name);

-- RLS: jeder User sieht nur eigene Rows.
ALTER TABLE user_server_tool_defaults ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'user_server_tool_defaults'
       AND policyname = 'usttd_owner_only'
  ) THEN
    CREATE POLICY usttd_owner_only ON user_server_tool_defaults
      USING (user_id = current_setting('app.current_user', true)::UUID)
      WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
  END IF;
END $$;
