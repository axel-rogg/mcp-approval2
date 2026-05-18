# PLAN-sharing-phase-2 — Group-Sharing Phase 2

> **Status:** ✅ **Code-Complete 2026-05-18**, ⚠️ Deploy-PENDING (Operator-Block).
> **Scope:** 8 Items + 4 Followups die Phase-1-Group-Sharing zu einem End-to-End-feature ausbauen.
> **Cross-Repo:** mcp-approval2 (UI + Tool-Surface + Audit) + mcp-knowledge2 (RLS + Storage + async-Worker).

## Status-Banner

| Item | Repo | Status | Commit |
|---|---|---|---|
| P2-1 — 7 weitere Tools + listSharedWithMe | approval2 | ✅ LIVE | `f80b1e8` |
| P2-2 — Cross-Member-Visibility | knowledge2 | ✅ Code (Deploy pending) | `b9ee58a` |
| P2-3 — Co-Edit (scope='write') | beide | ✅ Code (Deploy pending) | `1cf4204` + `cb15e50` |
| P2-4 — Owner-Transfer | beide | ✅ Code (Deploy pending) | `7ad5061` + `ad09266` |
| P2-5 — PWA Shared-with-me + Cascade-Preview + Transfer-UI | approval2 | ✅ LIVE | `b44dbe6` + `0dac4ff` |
| P2-6 — Email-Invite (MVP via email-lookup) | approval2 | ✅ LIVE | `72988e6` |
| P2-7 — Async Re-Wrap-Worker | knowledge2 | ✅ Code (Deploy pending) | `639b964` |
| P2-8 — WORM-Audit-Sink (GcsWormSink) | approval2 | ✅ LIVE (dormant) | `66278c2` |
| **Followups:** | | | |
| F2.1 — Rewrap-Cron (GH-Actions */2 min) | knowledge2 | ✅ LIVE | `16b9091` |
| F2.2 — GCS-Bucket Terraform + Runbook | approval2 | ✅ LIVE | `159f0ee` |
| F2.3 — Bidirectional Invite (target_group_id) | approval2 | ✅ LIVE | `eb5f6ac` |
| F2.4 — Share-Skill-Modal mit Cascade-Preview | approval2 | ✅ LIVE | `0dac4ff` |

**Deploy-Blocker:** Neon-Role-Grant. Operator-Step in [knowledge2 docs/runbooks/runbook-neon-role-grants.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-neon-role-grants.md).

## Quick-Map: Was kann das System jetzt

### Tool-Surface (13 Group-Sharing-Tools insgesamt, +1 bidirectional)

| Tool | sensitivity | Zweck |
|---|---|---|
| `groups.create` | write | Neue Gruppe anlegen |
| `groups.list` | read | Eigene + member-of Groups |
| `groups.get` | read | Group + Member-Liste |
| `groups.list_members` | read | Convenience: nur Member-Liste |
| `groups.add_member` | write | User by UUID hinzufuegen |
| `groups.remove_member` | write | Member entfernen (triggert Master-Rotate) |
| `groups.archive` | write | Soft-delete einer Group |
| `groups.set_read_audit` | write | Read-Audit-Flag toggle |
| `groups.transfer_ownership` | **danger** | Owner-Transfer |
| `groups.invite_email` | write | Email-basierter Add (P2-6 MVP) |
| `skills.share_with_group` | write | Skill teilen + Cascade |
| `docs.share_with_group` | write | Single-Doc teilen |
| `shares.revoke` | write | Grant-Revoke (Group + User-Grants) |
| `shares.list_my_shares` | read | Inbound-View "was wurde mir geteilt" |

Plus: **bidirectional Invite** ueber `/admin/invites` API mit optionalen `target_group_id` + `target_group_role` Felder (signup + group-add in einer Ceremony).

### KC2-Storage-Erweiterungen

| Migration | Inhalt |
|---|---|
| `0023_group_members_see_each_other.sql` | RLS-Policy `group_members_visibility` um `is_active_member_of` erweitert |
| `0024_group_write_scope.sql` | `owner_or_writer_modify` um group-write-Pfad erweitert |
| `0025_groups_owner_transfer.sql` | `groups_owner_modify` (FOR ALL) split in INSERT/DELETE + UPDATE-Policy mit transfer-CHECK |
| `0026_rewrap_jobs.sql` | Tabelle fuer async-Worker-Queue bei >1000 Grants |

### PWA-UI

- **#/admin/groups** (Phase 1) erweitert um:
  - "📥 Mit mir geteilt"-Section (collapsible, listSharedWithMe)
  - Transfer-Owner-Button in Group-Detail-Modal (Danger-Zone)
- **#/storage/:id** Storage-Detail-View:
  - Share-with-Group-Button im Action-Bar (Connect-Icon)
  - Modal mit Group-Dropdown + Scope-Toggle + Cascade-Preview

### Async-Worker

- **GH-Actions Cron**: `*/2 * * * *` POST `/v1/internal/rewrap-tick`
- Idempotent via `group_master_version < new_master_version` Filter
- Issue-Auto-Open bei Cron-Fail (label `rewrap-failure`)
- Family-Mode: tickt idle (keine Groups >1000)

### Compliance (dormant, Aktivierung optional)

- **GcsWormSink** als 4. Audit-Sink-Mode (`pg+gcs`, `combined+gcs`)
- TF-Modul anlegen Bucket mit `retention_policy + versioning + uniform-access`
- Operator-Aktivierung in [docs/runbooks/runbook-audit-worm.md](../../runbooks/runbook-audit-worm.md)

## Trade-Offs (was bewusst NICHT in Phase 2 ist)

| Item | Begruendung |
|---|---|
| Multi-Recipient-Sharing Crypto (BFE) | Per-Object-DEK + Group-Master ist gut genug fuer Family. Multi-Recipient-Sharing (X25519-DEK-Encapsulation pro Recipient) ist Phase 3 wenn echte Multi-Tenancy kommt. |
| Per-User-KEK statt Per-Object-DEK | Ueberkompliziert; KMS-Master-Wrap reicht. |
| Cross-Region-DR | Single-region (EU-WEST-3), Family-Mode + ADR-0011 |
| Compliance-Officer Audit-Reader-Role | Nur freischalten wenn Compliance-Audit ansteht (out-of-band IAM) |

## Test-Coverage

- approval2: 648 server-tests gruen (incl. tools.test.ts mit allen P2-Tools)
- knowledge2: 34 RLS-Integration-Tests (incl. p2-3-a/b/c + p2-4-a/b/c)
- Integration-Tests laufen nicht im CI (kein Container-Runtime); lokal/Pilot via Testcontainer

## Lessons Learned (P2-Sprint 2026-05-18)

1. **Cloud-Agent-Race im Working-Tree**: Phase-B-tool-defaults-Agent committed parallel; atomare commits + selective staging via `git apply` rettete den day.
2. **Neon-Role-Privileges nicht intuitiv**: REVOKE ALL + selective GRANT mit absichtlich-fehlendem REFERENCES → Migration-Block. Operator-Runbook ist Pflicht.
3. **Async-Rewrap-Pattern**: KMS-wrap des old-Master in der Queue + neuer Master als TX-1-Rotate; Worker entpackt aus DB-Spalte, post-completion-wipe.

## Phase 3 — was als naechstes (NICHT in Scope)

- Multi-Recipient-Sharing Crypto fuer Self-Host-fuer-Freunde-Szenario
- Group-Notifications (Push wenn jemand was geteilt hat)
- Group-Activity-Log (UI fuer audit-log-Filter auf group-id)
- Member-Invitation-Confirmation (zwei-Klick: Owner sendet, Member akzeptiert)

## Cross-Reference

- [docs/adr/0024-group-sharing-architecture.md](../../adr/0024-group-sharing-architecture.md) — Phase-1-Architektur-Decision (gilt fuer Phase 2)
- [knowledge2 docs/plans/active/PLAN-sharing-group-phase-1.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-sharing-group-phase-1.md) — Phase-1-Plan
- [docs/runbooks/operator-checklist-2026-05-18.md](../../runbooks/operator-checklist-2026-05-18.md) — Operator-Checklist post-Sprint
- [docs/runbooks/runbook-audit-worm.md](../../runbooks/runbook-audit-worm.md) — WORM-Aktivierung
- [knowledge2 docs/runbooks/runbook-neon-role-grants.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-neon-role-grants.md) — Deploy-Blocker-Fix
