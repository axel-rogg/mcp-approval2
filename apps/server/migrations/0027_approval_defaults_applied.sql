-- =============================================================================
-- 0027_approval_defaults_applied.sql — defaults_applied-Spalte fuer WYSIWYS
-- =============================================================================
--
-- Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase A).
--
-- Wenn der Hub vor Tool-Dispatch Defaults aus user_server_tool_defaults
-- mergt, persistieren wir bei Approval-Enqueue eine Attribution-Liste
-- (welcher Wert kam vom User, welcher vom Default-System). Die Approval-
-- PWA zeigt das pro Feld als Badge ("from profile=prod"); Resume-Pfad
-- dispatched mit dem in tool_input persistierten resolved Input, nicht
-- re-resolved → keine Race zwischen Approval-Issue und Approve-Touch.
--
-- Shape (jsonb-Array):
--   [{ "field": string,
--      "from": "user-input" | "tool-default",
--      "profile"?: string,        -- gesetzt wenn from='tool-default' (Phase C+)
--      "scope"?: string }]        -- reserviert fuer kuenftige Scope-Hierarchie
--
-- Default '[]'::jsonb damit bestehende Approval-Rows + neue Code-Pfade ohne
-- toolDefaults-Service (Tests, dev) gleich antworten.
-- =============================================================================

ALTER TABLE pending_approvals
  ADD COLUMN IF NOT EXISTS defaults_applied JSONB NOT NULL DEFAULT '[]'::jsonb;

-- =============================================================================
-- END 0027_approval_defaults_applied.sql
-- =============================================================================
