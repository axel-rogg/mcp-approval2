-- =============================================================================
-- 0015_webauthn_counter_rename.sql — Schema-Code-Drift fix
-- =============================================================================
--
-- Hintergrund: Migration 0001 hat die Spalte `sign_count INTEGER` angelegt,
-- aber der gesamte Runtime-Code (registration.ts/authentication.ts/
-- approval-verify.ts/writemode-activation-verify.ts) liest+schreibt
-- `counter`. Daher schlaegt jeder Insert/Update auf webauthn_credentials in
-- Production mit `column "counter" of relation ... does not exist` fehl.
-- Folge: Passkey-Enrollment + Approval-Sign-Off + Writemode-Aktivierung
-- waren bisher non-functional.
--
-- Fix: ALTER COLUMN sign_count -> counter (zusätzlich aliased), idempotent
-- damit eine bereits manuell migrierte DB ebenfalls funktioniert.
--
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'webauthn_credentials' AND column_name = 'sign_count'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'webauthn_credentials' AND column_name = 'counter'
  ) THEN
    ALTER TABLE webauthn_credentials RENAME COLUMN sign_count TO counter;
  END IF;
END$$;

-- Falls die DB schon weiter ist und beide Spalten irgendwie nebeneinander
-- existieren (z.B. wegen separater Hand-Patches), tun wir hier nichts —
-- der Caller-Code nutzt 'counter' und ein eventueller leerer sign_count
-- wird beim Hard-Cleanup (Folge-Migration) entfernt.

-- =============================================================================
-- END 0015_webauthn_counter_rename.sql
-- =============================================================================
