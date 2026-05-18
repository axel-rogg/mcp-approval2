-- =============================================================================
-- 0028_tool_defaults_v2.sql — typed values + profiles + hints + orphan_since
-- =============================================================================
--
-- Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase B Schema-Anteil
-- + Phase-C-Profile-Vorbereitung).
--
-- Diese Migration baut auf Mig 0024 (user_server_tool_defaults flat) und
-- 0027 (defaults_applied auf approvals) auf. Sie macht drei Dinge:
--
-- 1. Erweitert user_server_tool_defaults um typed Storage (value_json) +
--    Profile-Diskriminator + orphan_since (Drift-Detection, Plan §10
--    Entscheidung ⑤).
-- 2. Legt user_tool_default_profiles + user_tool_active_profile +
--    user_tool_default_hints an (Phase-C + Phase-E Vorbereitung).
-- 3. RLS-Policies (owner-only) auf allen neuen Tabellen.
--
-- Per-User-Isolation: alle Tabellen mit user_id-PK + RLS via
-- current_setting('app.current_user'). Plan §8 Garantie-Liste.
--
-- Backward-Compatibility: value_text bleibt erhalten (NOT NULL DEFAULT '').
-- Service-Layer migriert value_text → value_json lazy beim ersten Read
-- (siehe Phase-B-Code). Phase-F dropt die Spalte spaeter (Mig 0030).
-- =============================================================================

BEGIN;

-- ── 1. user_tool_default_profiles ─────────────────────────────────────────
-- Pro (user, sub_mcp_name) gibt es N Profile mit unique profile_name.
-- Genau eines davon ist is_active=TRUE (partial-unique-Index).
CREATE TABLE IF NOT EXISTS user_tool_default_profiles (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name, profile_name),
  CHECK (profile_name ~ '^[a-z][a-z0-9_-]{0,63}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_utdp_one_active
  ON user_tool_default_profiles(user_id, sub_mcp_name)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_utdp_user_server
  ON user_tool_default_profiles(user_id, sub_mcp_name);

ALTER TABLE user_tool_default_profiles ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'user_tool_default_profiles'
       AND policyname = 'utdp_owner_only'
  ) THEN
    CREATE POLICY utdp_owner_only ON user_tool_default_profiles
      USING (user_id = current_setting('app.current_user', true)::UUID)
      WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
  END IF;
END $$;

-- ── 2. user_server_tool_defaults: + profile_name + value_json + orphan ────
ALTER TABLE user_server_tool_defaults
  ADD COLUMN IF NOT EXISTS profile_name TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS value_json   JSONB,
  ADD COLUMN IF NOT EXISTS value_kind   TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS orphan_since BIGINT NULL;

-- PK-Swap: alt = (user, sub_mcp, tool, field); neu = + profile_name.
-- Bestehende Rows kriegen profile_name='default' via DEFAULT (s.o.).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_server_tool_defaults_pkey'
       AND conrelid = 'user_server_tool_defaults'::regclass
  ) THEN
    -- Pruefe ob die alte PK schon profile_name enthaelt — wenn ja, skip.
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.conname = 'user_server_tool_defaults_pkey'
         AND a.attname = 'profile_name'
    ) THEN
      ALTER TABLE user_server_tool_defaults
        DROP CONSTRAINT user_server_tool_defaults_pkey;
      ALTER TABLE user_server_tool_defaults
        ADD CONSTRAINT user_server_tool_defaults_pkey
        PRIMARY KEY (user_id, sub_mcp_name, profile_name, tool_name, field_name);
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_usttd_user_server_profile
  ON user_server_tool_defaults(user_id, sub_mcp_name, profile_name);

-- Seed: pro existing (user, sub_mcp_name) ein 'default'-Profil mit is_active=TRUE.
-- Idempotent via ON CONFLICT DO NOTHING.
INSERT INTO user_tool_default_profiles
  (user_id, sub_mcp_name, profile_name, description, is_active, created_at, updated_at)
SELECT DISTINCT
  user_id,
  sub_mcp_name,
  'default',
  'Auto-created on 0028 migration',
  TRUE,
  EXTRACT(EPOCH FROM now()) * 1000,
  EXTRACT(EPOCH FROM now()) * 1000
FROM user_server_tool_defaults
ON CONFLICT (user_id, sub_mcp_name, profile_name) DO NOTHING;

-- ── 3. user_tool_default_hints (Phase E Storage-Vorbereitung) ─────────────
-- Hints sind global pro (user, tool, field) — profile-uebergreifend.
CREATE TABLE IF NOT EXISTS user_tool_default_hints (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  field_name   TEXT NOT NULL,
  hint_text    TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name, tool_name, field_name),
  CHECK (length(hint_text) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_utdh_user_tool
  ON user_tool_default_hints(user_id, sub_mcp_name, tool_name);

ALTER TABLE user_tool_default_hints ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'user_tool_default_hints'
       AND policyname = 'utdh_owner_only'
  ) THEN
    CREATE POLICY utdh_owner_only ON user_tool_default_hints
      USING (user_id = current_setting('app.current_user', true)::UUID)
      WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
  END IF;
END $$;

-- ── 4. user_tool_active_profile (Per-Tool Override, Phase C Stretch) ──────
CREATE TABLE IF NOT EXISTS user_tool_active_profile (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name, tool_name)
);

ALTER TABLE user_tool_active_profile ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'user_tool_active_profile'
       AND policyname = 'utap_owner_only'
  ) THEN
    CREATE POLICY utap_owner_only ON user_tool_active_profile
      USING (user_id = current_setting('app.current_user', true)::UUID)
      WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
  END IF;
END $$;

-- ── 5. Cascade-Cleanup-Trigger erweitern fuer sub_mcp_servers DELETE ──────
-- Mig 0024 hat trg_usttd_cascade_submcp_delete fuer user_server_tool_defaults.
-- Wir erweitern den Funktionsrumpf damit auch die neuen Tabellen mit-droppen.
CREATE OR REPLACE FUNCTION usttd_cascade_on_submcp_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM user_server_tool_defaults  WHERE sub_mcp_name = OLD.name;
  DELETE FROM user_tool_default_profiles WHERE sub_mcp_name = OLD.name;
  DELETE FROM user_tool_default_hints    WHERE sub_mcp_name = OLD.name;
  DELETE FROM user_tool_active_profile   WHERE sub_mcp_name = OLD.name;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- =============================================================================
-- END 0028_tool_defaults_v2.sql
-- =============================================================================
