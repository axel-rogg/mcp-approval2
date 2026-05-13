-- =============================================================================
-- 0005_approvals.sql — pending_approvals Tabelle (WYSIWYS-Approval-Queue)
-- =============================================================================
-- Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 5), §11 Phase 4.
--
-- Inhalt:
--   1. pending_approvals — Approval-Queue fuer State-modifying Tools.
--   2. Indizes fuer User-Listing + Expire-Sweep + Time-Range.
--   3. RLS-Policy: owner-only.
--
-- Idempotent (alle CREATE haben IF NOT EXISTS, Policy in DO $$ Block).
-- =============================================================================

CREATE TABLE IF NOT EXISTS pending_approvals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name          TEXT NOT NULL,
  tool_input         JSONB NOT NULL,

  -- WYSIWYS-Display
  display_template   TEXT,
  display_rendered   TEXT,

  -- Klassifikation
  sensitivity        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',

  -- WebAuthn-Sign-Off
  approval_challenge TEXT,
  approval_signature BYTEA,
  approved_at        BIGINT,
  rejected_at        BIGINT,
  rejection_reason   TEXT,
  expired_at         BIGINT,

  -- PRF (in-memory-session-handle)
  prf_session_id     TEXT,

  -- Result
  result_json        JSONB,
  result_emitted_at  BIGINT,

  -- Origin
  request_id         UUID,
  origin_ip          INET,

  -- Lifecycle
  created_at         BIGINT NOT NULL,
  expires_at         BIGINT NOT NULL,

  CONSTRAINT pending_approvals_sensitivity_check
    CHECK (sensitivity IN ('write', 'danger')),
  CONSTRAINT pending_approvals_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_approvals_user_pending
  ON pending_approvals(user_id, status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_approvals_expires
  ON pending_approvals(expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_approvals_created
  ON pending_approvals(created_at DESC);

-- =============================================================================
-- Row-Level-Security: owner-only
-- =============================================================================

ALTER TABLE pending_approvals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'owner_only_approvals' AND tablename = 'pending_approvals'
  ) THEN
    CREATE POLICY owner_only_approvals ON pending_approvals
      USING (user_id = current_setting('app.current_user', TRUE)::uuid)
      WITH CHECK (user_id = current_setting('app.current_user', TRUE)::uuid);
  END IF;
END$$;

-- =============================================================================
-- END 0005_approvals.sql
-- =============================================================================
