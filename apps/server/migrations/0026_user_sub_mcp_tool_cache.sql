-- =============================================================================
-- 0026_user_sub_mcp_tool_cache.sql — Per-User Tool-Cache fuer OAuth-Sub-MCPs
-- =============================================================================
--
-- Plan-Ref: Sprint 2026-05-18 — Per-User OAuth-Pipeline.
--
-- Problem (vorher): sub_mcp_servers.tools_cache ist EIN tool_cache pro Server,
-- global fuer alle User. Funktioniert fuer service_bearer-Server (gws/gcloud/
-- utils — alle User sehen das gleiche Tool-Set des Workers). Funktioniert NICHT
-- fuer OAuth-Server (cf, github) wo die discovery einen User-spezifischen
-- access_token braucht:
--   - Wenn der "operator" keinen refresh-token hat → discovery scheitert →
--     tool_cache leer → KEIN User sieht Tools (auch nicht die, die selbst
--     refresh-tokens haben).
--   - Bei Multi-User: tools/list haengt von User-Permissions ab. Single global
--     cache verraet User A's Tools an User B.
--
-- Loesung: separater per-User-Cache fuer OAuth-Server. Discovery laeuft pro
-- (user_id, sub_mcp_id) — pro User mit eigenem access_token. wrapper_tools.ts
-- liest den per-User-Cache zur Tool-Auflistung.
--
-- Schema:
--   - Pro (user_id, sub_mcp_id) eine Row.
--   - tools_json: das `result.tools[]`-Array aus tools/list (gleiche Form wie
--     sub_mcp_servers.tools_cache fuer service_bearer-Server).
--   - cached_at: Unix-ms-Timestamp letztes Discovery.
--
-- RLS:
--   - SELECT/INSERT/UPDATE/DELETE nur fuer user_id = auth.user_id().
--   - service_role bypasst RLS (Background-Discovery-Cron lese-/schreib-Zugriff).
--
-- CASCADE: ON DELETE sub_mcp_servers → tool_cache-Rows weg.
-- CASCADE: ON DELETE users          → tool_cache-Rows weg.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_sub_mcp_tool_cache (
  user_id        UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_id     UUID    NOT NULL REFERENCES sub_mcp_servers(id) ON DELETE CASCADE,
  sub_mcp_name   TEXT    NOT NULL,
  tools_json     JSONB   NOT NULL,
  cached_at      BIGINT  NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sub_mcp_tool_cache_user
  ON user_sub_mcp_tool_cache(user_id);

CREATE INDEX IF NOT EXISTS idx_user_sub_mcp_tool_cache_cached_at
  ON user_sub_mcp_tool_cache(cached_at);

-- RLS — per-User-Sichtbarkeit. unsafe()/service_role bypassed.
ALTER TABLE user_sub_mcp_tool_cache ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'user_sub_mcp_tool_cache'
       AND policyname = 'utcache_owner_only'
  ) THEN
    CREATE POLICY utcache_owner_only ON user_sub_mcp_tool_cache
      USING (user_id = current_setting('app.current_user', true)::UUID)
      WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
  END IF;
END $$;

-- =============================================================================
-- END 0026_user_sub_mcp_tool_cache.sql
-- =============================================================================
