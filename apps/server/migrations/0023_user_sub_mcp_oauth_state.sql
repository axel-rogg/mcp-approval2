-- 0023_user_sub_mcp_oauth_state.sql — OAuth-Authorize-Flow state-store.
--
-- Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md (Phase 3).
--
-- Pattern: User klickt "Authorize" auf einem Sub-MCP-Server. Approval2
-- generiert einen CSRF-State + PKCE-code-verifier, persistiert sie hier
-- mit TTL 10 min, leitet den Browser zum Sub-MCP-OAuth-Endpoint um. Der
-- Sub-MCP-Worker (oder externer Provider wie Google direkt) redirected
-- nach Consent zurueck mit ?state=...&code=... Approval2 verifiziert den
-- state in dieser Tabelle, tauscht code+verifier gegen ein Refresh-Token,
-- speichert es KMS-encrypted in user_sub_mcp_config als
-- `_oauth_refresh_token`, loescht die Pending-Row hier.
--
-- Pre-registered-Modus: User hat schon (client_id, client_secret) in
-- user_sub_mcp_config eingetragen. Approval2 nutzt die direkt fuer den
-- Token-Exchange.

CREATE TABLE IF NOT EXISTS user_sub_mcp_oauth_state (
  state          TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name   TEXT NOT NULL REFERENCES sub_mcp_servers(name) ON DELETE CASCADE,
  code_verifier  TEXT NOT NULL,  -- PKCE
  redirect_uri   TEXT NOT NULL,
  created_at     BIGINT NOT NULL,
  expires_at     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_state_user
  ON user_sub_mcp_oauth_state(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_state_expires
  ON user_sub_mcp_oauth_state(expires_at);

ALTER TABLE user_sub_mcp_oauth_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'user_sub_mcp_oauth_state'
       AND policyname = 'oauth_state_owner_only'
  ) THEN
    CREATE POLICY oauth_state_owner_only ON user_sub_mcp_oauth_state
      USING (user_id = current_setting('app.current_user', true)::UUID)
      WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
  END IF;
END $$;
