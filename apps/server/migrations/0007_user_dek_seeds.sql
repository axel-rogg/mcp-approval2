-- =============================================================================
-- 0007_user_dek_seeds.sql — Per-User persistent DEK-Seeds.
-- =============================================================================
-- Plan-Ref: ADR-0001 (DEK-Resolution-Strategy, Variant B). mcp-knowledge2 holt
--           pro Encrypt/Decrypt-Operation den DEK via /internal/v1/dek/resolve.
--           Storage hier:
--
--             user_dek_seeds.wrapped_dek  = OpenBao-ciphertext-envelope eines
--                                            random 32-byte DEK, gewrapped mit
--                                            der per-User transit-key
--                                            `vault://transit/keys/user-dek-<uid>`.
--
-- Lifecycle:
--   - INSERT bei ersten Resolve-Call eines Users (idempotent via PK + ON
--     CONFLICT DO NOTHING).
--   - UPDATE bei `rotateUserDek` (wrapped_dek + kek_ref + rotated_at).
--   - DELETE im Rahmen GDPR Art. 17 (ON DELETE CASCADE auf users).
--
-- RLS: KEINE Policy. Diese Tabelle wird ausschliesslich vom DekService via
--      `db.unsafe()` mit explizitem reason='dek_*' angesprochen (Service-
--      Layer enforct das user_id-Filtering). Andere Code-Pfade duerfen sie
--      nicht lesen.
--
-- Idempotent: alle CREATE haben IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_dek_seeds (
  user_id     UUID PRIMARY KEY,
  wrapped_dek BYTEA NOT NULL,
  kek_ref     TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  rotated_at  BIGINT,
  CONSTRAINT user_dek_seeds_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT user_dek_seeds_kek_ref_check
    CHECK (length(kek_ref) > 0 AND length(kek_ref) <= 512),
  CONSTRAINT user_dek_seeds_wrapped_dek_check
    CHECK (octet_length(wrapped_dek) > 0)
);

CREATE INDEX IF NOT EXISTS idx_user_dek_seeds_created
  ON user_dek_seeds(created_at);

-- =============================================================================
-- END 0007_user_dek_seeds.sql
-- =============================================================================
