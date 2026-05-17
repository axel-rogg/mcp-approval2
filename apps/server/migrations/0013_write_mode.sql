-- =============================================================================
-- 0013_write_mode.sql — Write-Mode Sessions (Auto-Approve-Window pro User)
-- =============================================================================
-- Plan-Ref: docs/plans/active/PLAN-writemode.md
--
-- Inhalt:
--   1. write_mode — eine Row pro aktivierter Session, mit user_id-FK + expiry.
--   2. Indizes fuer "ist Session aktiv?" (user_id + expires_at) und Sweep.
--   3. RLS-Policy: owner-only (User A darf User B's Session nicht sehen).
--
-- Semantik: ein Lookup `WHERE user_id = $1 AND expires_at > now-ms` der eine
-- Row liefert == Write-Mode aktiv. Mehrere parallele Sessions sind erlaubt
-- (Re-Activation verlaengert nicht — neue Row, alte laeuft regulaer aus).
--
-- Multi-User: v1 hatte ein global table (single-user). v2 ist multi-tenant —
-- User-Isolation via FK + RLS-Policy.
--
-- Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS write_mode (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Lifecycle (Millis-Unix)
  activated_at             BIGINT NOT NULL,
  expires_at               BIGINT NOT NULL,

  -- Provenance: welcher Credential hat die Aktivierung gesignt?
  -- Free-text (TEXT) statt FK damit ein gesperrter Credential die History
  -- nicht kaputt macht; das WebAuthn-Lookup laeuft separat.
  activated_by_credential  TEXT NOT NULL,

  -- Authenticator-Method der Aktivierung (Bookkeeping; default 'webauthn').
  -- 'smoke' nur fuer Layer-3-Tests (HMAC-Pfad nutzt die in-memory state,
  -- diese Spalte ist hier reserviert falls wir den DB-Pfad spaeter teilen).
  method                   TEXT NOT NULL DEFAULT 'webauthn',

  CONSTRAINT write_mode_method_check
    CHECK (method IN ('webauthn', 'smoke'))
);

-- Hot-Path-Index fuer `isWritemodeActive(userId)`. Partial-Index reicht weil
-- abgelaufene Rows fuer den Check egal sind (cleanup-Sweep liest separat).
CREATE INDEX IF NOT EXISTS idx_write_mode_user_active
  ON write_mode(user_id, expires_at);

-- Sweep-Index (cron loescht abgelaufene Rows).
CREATE INDEX IF NOT EXISTS idx_write_mode_expires
  ON write_mode(expires_at);

-- =============================================================================
-- Row-Level-Security: owner-only
-- =============================================================================

ALTER TABLE write_mode ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'owner_only_write_mode' AND tablename = 'write_mode'
  ) THEN
    CREATE POLICY owner_only_write_mode ON write_mode
      USING (user_id = current_setting('app.current_user', TRUE)::uuid)
      WITH CHECK (user_id = current_setting('app.current_user', TRUE)::uuid);
  END IF;
END$$;

-- =============================================================================
-- END 0013_write_mode.sql
-- =============================================================================
