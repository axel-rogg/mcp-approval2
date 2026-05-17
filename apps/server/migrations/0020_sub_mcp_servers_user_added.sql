-- 0017_sub_mcp_servers_user_added.sql — sub_mcp_servers erweitert um
-- user-added Server + Catalog-Default-Marker + Config-Schema-Cache.
--
-- Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md
--
-- Vorher: jeder Server in sub_mcp_servers war operator-managed (Catalog).
-- Jetzt: User koennen eigene Server hinzufuegen. owner_user_id=NULL bedeutet
-- "Catalog-Default" (alle User sehen den); owner_user_id != NULL bedeutet
-- "user-added" (nur dieser User sieht den).
--
-- config_schema kommt aus tools/list._meta.config_fields beim Discovery-
-- Refresh und wird hier gecached, damit die PWA das Drawer-Form dynamisch
-- rendern kann ohne pro-Render-Call gegen den Worker.

ALTER TABLE sub_mcp_servers
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS is_catalog_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS config_schema JSONB;

-- Bestehende Server als Catalog-Defaults markieren (utils/gws/gcloud + ggf.
-- andere die bereits seeded sind).
UPDATE sub_mcp_servers
   SET is_catalog_default = TRUE
 WHERE name IN ('utils', 'gws', 'gcloud')
   AND owner_user_id IS NULL;

-- Index fuer Owner-Filter (multi-user-perf):
CREATE INDEX IF NOT EXISTS idx_submcp_owner
  ON sub_mcp_servers(owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Unique-Constraint anpassen: name darf wiederholt werden wenn owner unter-
-- schiedlich (user-A hat 'mygithub' UND user-B hat 'mygithub' = OK). Aber
-- innerhalb owner_user_id muss name unique sein. Catalog-Defaults
-- (owner_user_id IS NULL) sind auch unique.
--
-- 0018 + 0019 haben FKs REFERENCES sub_mcp_servers(name). Postgres laesst
-- den Index nicht droppen solange die FKs auf dem unique-constraint haengen.
-- Loesung: erst FKs droppen, dann index swap, dann FKs gegen neuen unique-
-- composite re-erstellen. ON DELETE CASCADE bleibt.
ALTER TABLE user_sub_mcp_subscriptions DROP CONSTRAINT IF EXISTS user_sub_mcp_subscriptions_sub_mcp_name_fkey;
ALTER TABLE user_sub_mcp_config        DROP CONSTRAINT IF EXISTS user_sub_mcp_config_sub_mcp_name_fkey;

-- CASCADE: deploy-Fail-Workaround. Die DROP CONSTRAINT statements oben
-- erwischen die FK-namen nicht (Postgres autogen kann variieren),
-- daher Catch-All via CASCADE. Drops gleichzeitig FK + Index.
-- Die FKs werden danach (Lines 54-59) sauber wieder erstellt.
DROP INDEX IF EXISTS idx_sub_mcp_name CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_submcp_name_per_owner
  ON sub_mcp_servers(name, COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::UUID));

-- Catalog-only FK rekonstituieren: 0018/0019-Tabellen referenzieren NUR
-- Catalog-Defaults (owner_user_id IS NULL). Daher partial unique-index
-- mit WHERE-clause genug fuer Catalog-FK-Target. Wenn spaeter user-added
-- subscriptions noetig, eigene Tabelle dafuer mit FK auf (name, owner_user_id).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_submcp_catalog_name
  ON sub_mcp_servers(name) WHERE owner_user_id IS NULL;

ALTER TABLE user_sub_mcp_subscriptions
  ADD CONSTRAINT user_sub_mcp_subscriptions_sub_mcp_name_fkey
  FOREIGN KEY (sub_mcp_name) REFERENCES sub_mcp_servers(name) ON DELETE CASCADE;
ALTER TABLE user_sub_mcp_config
  ADD CONSTRAINT user_sub_mcp_config_sub_mcp_name_fkey
  FOREIGN KEY (sub_mcp_name) REFERENCES sub_mcp_servers(name) ON DELETE CASCADE;

-- RLS: catalog-defaults sind fuer alle sichtbar (owner_user_id IS NULL),
-- user-added nur fuer den Owner. Operator-Pool (BYPASSRLS) sieht alles.
ALTER TABLE sub_mcp_servers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'sub_mcp_servers'
       AND policyname = 'submcp_owner_or_catalog'
  ) THEN
    CREATE POLICY submcp_owner_or_catalog ON sub_mcp_servers
      USING (
        owner_user_id IS NULL
        OR owner_user_id = current_setting('app.current_user', true)::UUID
      )
      WITH CHECK (
        owner_user_id IS NULL
        OR owner_user_id = current_setting('app.current_user', true)::UUID
      );
  END IF;
END $$;
