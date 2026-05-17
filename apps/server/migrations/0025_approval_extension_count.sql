-- =============================================================================
-- 0025_approval_extension_count.sql — TTL-Extension-Counter
-- =============================================================================
--
-- Plan-Ref: PLAN-archive-display.md Phase 3 (TTL-Pause) + User-Feedback
-- 2026-05-17 "wenn man mehr Zeit fuer eine einzelne Approval braucht".
--
-- Mechanik: User kann pro pending-Approval bis zu 3 Mal ein "+5 min"-Extend
-- klicken (= max +15 min Verlaengerungs-Budget). Mehr ist absichtlich nicht
-- erlaubt — verhindert indefinite Pause + bleibt audit-bar.
--
-- Atomar via CAS:
--   UPDATE pending_approvals
--      SET expires_at = expires_at + $1, extension_count = extension_count + 1
--    WHERE id=$2 AND user_id=$3 AND status='pending'
--      AND expires_at > $now      -- nicht schon expired
--      AND extension_count < 3    -- max-Budget
--   RETURNING expires_at, extension_count
--
-- Empty RETURNING → 409 (already-decided / expired / budget-exhausted).
-- =============================================================================

ALTER TABLE pending_approvals
  ADD COLUMN IF NOT EXISTS extension_count INTEGER NOT NULL DEFAULT 0;

-- =============================================================================
-- END 0025_approval_extension_count.sql
-- =============================================================================
