-- 0015_user_sub_mcp_subscriptions.sql — per-User-Subscription auf Sub-MCP-Server.
--
-- Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md
--
-- Jeder User entscheidet selbst welche Sub-MCP-Server (utils, gws, gcloud,
-- ggf. user-added) er nutzen will. Default beim First-Login: NICHTS aktiv —
-- User muss opt-in via UI. Catalog-Defaults werden lazy beim ersten Inventory-
-- Read fuer den User in die Tabelle gestreut (alle enabled=FALSE).
--
-- Multi-User-Pflicht: ohne diese Trennung sehen alle User dieselben Tools.

CREATE TABLE IF NOT EXISTS user_sub_mcp_subscriptions (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name TEXT NOT NULL REFERENCES sub_mcp_servers(name) ON DELETE CASCADE,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name)
);

CREATE INDEX IF NOT EXISTS idx_subs_user
  ON user_sub_mcp_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_enabled
  ON user_sub_mcp_subscriptions(user_id) WHERE enabled = TRUE;

-- RLS: jeder User sieht nur eigene Rows. Operator-Pool (BYPASSRLS) ignoriert
-- die Policy fuer Boot-Seed/Admin-Ops.
ALTER TABLE user_sub_mcp_subscriptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'user_sub_mcp_subscriptions'
       AND policyname = 'ums_owner_only'
  ) THEN
    CREATE POLICY ums_owner_only ON user_sub_mcp_subscriptions
      USING (user_id = current_setting('app.current_user', true)::UUID)
      WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
  END IF;
END $$;
