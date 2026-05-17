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

-- Unique-Constraint auf `name` BLEIBT global (idx_sub_mcp_name). Postgres
-- erlaubt nur volle UNIQUE-Indexes als FK-Target — weder WHERE-partial
-- noch COALESCE-Expr. 0018 + 0019 haben FKs auf name → die brauchen den
-- global-uniq-index.
--
-- Multi-User-different-name use case (user-A hat 'mygithub' UND user-B hat
-- 'mygithub') wird daher NICHT in 0020 geloest — kommt spaeter via eigener
-- aliases-Tabelle mit (user_id, alias, name-FK) compos. PRIMARY KEY.
-- 2026-05-17: Migration verein­facht damit release_command nicht fail't.

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
