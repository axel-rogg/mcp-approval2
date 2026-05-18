-- 0029_invites_target_group.sql
--
-- P2-6 v2 — bidirectional Invite: signup + group-add als single ceremony.
--
-- Phase 1 (Mig 0001) hat `invites` als Pflicht-Signup-Invite (von Admin
-- erstellt, Empfaenger landet via /accept-invite/:token → Google-OAuth →
-- users-Row angelegt).
--
-- P2-6 v1 (groups.invite_email) erweiterte das mit einem Lookup-Tool: User
-- muss schon active-platform-user sein, dann addGroupMember. Limitation:
-- ein nicht-registrierter User kann nicht in einer Ceremony zur Plattform
-- *und* zu einer Group hinzugefuegt werden.
--
-- P2-6 v2 fuegt zwei optional-Spalten zu invites hinzu:
--   - target_group_id: KC2-Group-UUID an die der neue User nach signup
--     auto-added wird
--   - target_group_role: 'member' (default) oder 'admin'
--
-- Beide NULL = klassischer signup-only invite (backward-compat).
--
-- accept.ts-Logic: nach erfolgreichem users-INSERT, wenn target_group_id
-- gesetzt ist → POST /v1/groups/:id/members an KC2 (via internal service-
-- token, da ein frisch erzeugter User noch keinen JWT hat).

ALTER TABLE invites
  ADD COLUMN IF NOT EXISTS target_group_id   UUID,
  ADD COLUMN IF NOT EXISTS target_group_role TEXT
    CHECK (target_group_role IN ('admin', 'member'));

-- Falls target_group_id gesetzt: target_group_role muss auch gesetzt sein.
-- Anders herum darf target_group_role NICHT ohne target_group_id stehen.
ALTER TABLE invites
  ADD CONSTRAINT invites_target_group_consistency
  CHECK (
    (target_group_id IS NULL AND target_group_role IS NULL)
    OR
    (target_group_id IS NOT NULL AND target_group_role IS NOT NULL)
  );

-- Index fuer evtl. Operator-Query "welche pending invites haben target_group_id?".
CREATE INDEX IF NOT EXISTS idx_invites_target_group
  ON invites (target_group_id)
  WHERE target_group_id IS NOT NULL AND status = 'pending';
