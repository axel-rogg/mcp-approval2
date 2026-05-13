-- =============================================================================
-- 0008_prefs.sql — user_prefs Tabelle (verschluesseltes Tool-Defaults-Blob)
-- =============================================================================
-- Plan-Ref: docs/plans/done/PLAN-prefs.md (mcp-approval), portiert nach
--           mcp-approval2 §7 (Burst 3 — Settings/Prefs-Subsystem).
--
-- Pattern: eine Row pro User mit AES-GCM-verschluesseltem JSON-Blob
--          (UserPrefsData: toolDefaults + profiles + hints + selectedProfile).
--          Crypto-Stack analog credentials (Envelope: random DEK pro Blob,
--          gewrapped via Vault-Transit). AAD = 'prefs|{user_id}'.
--
-- Lifecycle:
--   - UPSERT bei prefs.set (Caller serialisiert JSON, encrypted, schreibt Blob).
--   - DELETE bei prefs.remove({all:true}) oder GDPR-Cascade via FK ON DELETE.
--   - Lookups immer by user_id (PK), max 1 row pro User.
--
-- Size-Constraint: max 8 KiB plaintext (Caller-enforced) — der Blob ist klein
--   genug fuer ein einzelnes LIMIT-loses SELECT pro Tool-Dispatch.
--
-- RLS: owner-only Policy (current_setting('app.current_user')::uuid).
-- Idempotent: alle CREATE haben IF NOT EXISTS / DO $$-blocks.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- AES-GCM ciphertext + 12-byte nonce
  ciphertext   BYTEA NOT NULL,
  nonce        BYTEA NOT NULL,

  -- Envelope-encrypted DEK (Vault-Transit wrapped)
  wrapped_dek  BYTEA NOT NULL,

  -- AAD = 'prefs|{user_id}', plaintext-stored fuer Audit-Trail
  aad          TEXT NOT NULL,

  -- Vault-KEK-Ref ('vault://transit/keys/user-{id}' o.ae.)
  kek_ref      TEXT NOT NULL,

  -- Reserved fuer Algorithmus-Migration
  alg          TEXT NOT NULL DEFAULT 'A256GCM',

  -- Lifecycle
  updated_at   BIGINT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT user_prefs_kek_ref_check
    CHECK (length(kek_ref) > 0 AND length(kek_ref) <= 512),
  CONSTRAINT user_prefs_ciphertext_check
    CHECK (octet_length(ciphertext) > 0)
);

CREATE INDEX IF NOT EXISTS idx_user_prefs_updated
  ON user_prefs(updated_at);

-- =============================================================================
-- Row-Level-Security: owner-only
-- =============================================================================

ALTER TABLE user_prefs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'user_prefs_owner' AND tablename = 'user_prefs'
  ) THEN
    CREATE POLICY user_prefs_owner ON user_prefs
      USING (user_id = current_setting('app.current_user', TRUE)::uuid)
      WITH CHECK (user_id = current_setting('app.current_user', TRUE)::uuid);
  END IF;
END$$;

-- =============================================================================
-- END 0008_prefs.sql
-- =============================================================================
