-- 0016_user_sub_mcp_config.sql — per-User-per-Server Config-Werte (KMS-encrypted).
--
-- Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md
--
-- Pro User pro Server beliebig viele config-keys. Konvention:
--   - `_`-Prefix = secret (z.B. `_oauth_refresh_token`, `_oauth_access_token`,
--     `_oauth_client_secret`, `_bearer_token`) → password-input + masked-display
--   - sonst plain (z.B. `default_calendar`, `default_timezone`, `client_id`)
--
-- KMS-encrypted analog credentials.ts: per-row DEK, gewrappt mit user-KEK.
-- Alle drei Spalten (wrapped_dek, kek_ref, ciphertext, nonce) sind Pflicht.
-- Die `is_secret`-Spalte ist UI-Hint, nicht crypto-relevant (alle Werte
-- werden encrypted, auch non-secret — damit kein Drift bei spaeterer
-- Re-Klassifizierung).

CREATE TABLE IF NOT EXISTS user_sub_mcp_config (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name TEXT NOT NULL REFERENCES sub_mcp_servers(name) ON DELETE CASCADE,
  config_key   TEXT NOT NULL,
  -- KMS-encrypted payload (analog credentials):
  wrapped_dek  BYTEA NOT NULL,
  kek_ref      TEXT NOT NULL,
  ciphertext   BYTEA NOT NULL,
  nonce        BYTEA NOT NULL,
  -- UI-Hint: starts with '_' → display as secret (masked).
  is_secret    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name, config_key)
);

CREATE INDEX IF NOT EXISTS idx_uconf_user
  ON user_sub_mcp_config(user_id);
CREATE INDEX IF NOT EXISTS idx_uconf_server
  ON user_sub_mcp_config(user_id, sub_mcp_name);

-- RLS owner-only.
ALTER TABLE user_sub_mcp_config ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'user_sub_mcp_config'
       AND policyname = 'uconf_owner_only'
  ) THEN
    CREATE POLICY uconf_owner_only ON user_sub_mcp_config
      USING (user_id = current_setting('app.current_user', true)::UUID)
      WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
  END IF;
END $$;
