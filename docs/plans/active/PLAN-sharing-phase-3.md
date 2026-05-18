# PLAN-sharing-phase-3 — Group-Sharing Phase 3 (Draft)

> **Status:** ⚠️ **Draft 2026-05-18** — Diskussions-Basis, nicht implementation-ready.
> **Scope:** 4 Items die Phase-2-Trade-Offs aufloesen, sobald echte Multi-Tenancy (>1 Familie / >1 Self-Host-Group) kommt.
> **Cross-Repo:** beide Repos analog Phase 2.

## Trigger fuer Phase 3

Phase 2 hat bewusst diese Items wegelassen (siehe PLAN-sharing-phase-2.md §Trade-Offs):

| Item | Phase-2-Begruendung |
|---|---|
| Multi-Recipient-Sharing Crypto (BFE) | Per-Object-DEK + Group-Master reicht fuer Family |
| Group-Notifications | UI-Push war nicht im Critical-Path |
| Group-Activity-Log | audit_log filter-by-group reicht heute |
| Member-Invitation-Confirmation | bidirectional invite hat das overlay |

Phase 3 wird relevant wenn **mindestens eines** von diesen Triggern eintritt:
1. >1 Familie pro Instance (Cross-Familien-Sharing-Use-Case)
2. Self-Host-Pilot mit ≥3 Groups, jeweils ≥5 Members
3. Compliance-Audit verlangt nachweisbare Member-Aktions-Historie
4. Operator-Feedback: "Member-Add wird laut/seltsam, will Confirm-Loop"

## Item-Inventur

### P3-1: Multi-Recipient-Sharing Crypto (Broadcast Encryption / BFE)

**Problem:** Phase 2 nutzt Per-Object-DEK + Group-Master-Encapsulation. Master-Key ist sym (AES-256). Wenn N Members in einer Group: jeder Member hat den wrappedGroupDek mit eigenem KEK. Bei Member-Remove → Master-Rotation + N-1 Re-Wraps + alle Grant-Wraps re-wrappen. Cost: O(N + M) wo M = active grants.

Cost-Sprung bei N > ~50 oder M > 1000 (async-Worker-Threshold).

**Phase-3-Option:** Tree-Based Broadcast-Encryption (e.g. Subset-Difference / LSD). Member-Remove invalidiert nur log(N) Keys statt N. Re-Wrap-Cost = O(M log N) statt O(M N).

**Komplexitaet:** sehr hoch. Library-Auswahl (X3DH/HPKE-based BFE), Threat-Modell-Review, Migration-Pfad fuer existing Per-Object-DEKs.

**Skip-Begruendung wenn nicht noetig:** Family 5 Members + 100 Grants → Rotation 0.5s. Self-Host-Pilot 20 Members + 500 Grants → ~10s. Beide acceptable. Phase 3 erst bei >100 Members oder >5000 Grants.

### P3-2: Group-Notifications (Push-API)

**Was:** Push-Subscription pro User wenn jemand etwas in seine Group teilt.

**Existing-Infra:** push-Service ist gebaut (apps/server/src/services/push.ts), Web-Push-Subscriptions in DB.

**Phase-3-Code:**
- Hook in KC2 createShareWithGroup → emit `group_share_added`-Event
- approval2 push-relay-Endpoint `POST /internal/v1/notify/group-share`
- PWA service-worker zeigt: "User X hat 'Filename' in Group 'Y' geteilt"
- User-Setting: Notification opt-in pro Group

**Komplexitaet:** mittel. Event-Bus zwischen KC2 + approval2 ist neu (heute nur synchron OBO). 3-4 Tage Arbeit.

### P3-3: Group-Activity-Log (UI fuer audit_log-Filter)

**Was:** PWA Sub-Tab unter `#/admin/groups/:id/activity` mit:
- Wer hat was wann in der Group geteilt
- Welche Member kamen wann dazu / wurden entfernt
- Welche Objects wurden gelesen (wenn `read_audit_enabled=true`)

**Existing-Infra:** audit_log hat alle Events, filterable by `details.groupId` / `resourceId`. Brauchen nur Query + UI.

**Komplexitaet:** klein. ~1 Tag. Eher UI-Aufgabe als Crypto.

### P3-4: Member-Invitation-Confirmation (zwei-Klick)

**Heute:** Owner ruft `groups.add_member(user_id)` → User ist sofort drin, sieht alle group-shared Content. Bidirectional Invite (P2-6 v2) macht es bei Neu-User automatisch.

**Phase-3:** Owner ruft `groups.invite(user)` → Invite-Row in DB, User bekommt Email + PWA-Notification → User klickt "Accept" / "Decline" → erst dann wird er Member.

**Tabelle:** `group_invites (id, group_id, target_user_id, invited_by, status pending/accepted/declined, created_at, decided_at, expires_at)`.

**Crypto-Impact:** keine — der wrappedGroupDek wird erst beim accept generiert.

**UI-Impact:**
- PWA `#/admin/groups/:id`: pending invites in Member-Liste mit Status-Pill
- PWA Topbar-Bell: Notification "X moechte dich in Group Y einladen"
- PWA Approval-Inbox: 2-Klick-Modal Accept/Decline

**Komplexitaet:** mittel. Schema + 4 Tools (invite/accept/decline/list) + PWA-UI. ~3 Tage.

## Reihenfolge (vorgeschlagen)

```
P3-4 (Invite-Confirmation, Trust-Improvement)
  ↓
P3-3 (Activity-Log, Transparenz)
  ↓
P3-2 (Notifications, Push-Hygiene)
  ↓
P3-1 (BFE, nur bei echtem Skalierungs-Bedarf)
```

P3-4 ist das einzige Item mit User-Story-relevantem Privacy-Gewinn ("nicht ungefragt in Group landen"). P3-3 macht audit-Trail praktisch nutzbar. P3-2 ist Hygiene. P3-1 ist "wenn-wir-mal-skalieren".

## Trade-Offs zwischen Items

- **P3-4 vs P3-2:** Beide nutzen Push. P3-4 zuerst → Notification-System hat sofort einen Use-Case, der eindeutig nuetzlich ist (Invite-Approval). P3-2 wird dann ein Side-Effect.
- **P3-1 vs alles:** P3-1 ist 10× Aufwand der anderen drei. Nur lohnenswert bei klarem Skalierungs-Signal.
- **P3-3 als Quick-Win:** vor allen anderen machbar wenn UI-Capacity da ist.

## Open Questions

1. Soll `read_audit_enabled` (Phase-1 Setting auf Group-Level) per-Default `true` werden? Heute false weil audit-Volume schreckt ab.
2. P3-4 Invite-TTL: 24h analog Platform-Invites (Mig 0001)? Oder 7d weil Group-Member-Decisions weniger urgent?
3. P3-1 BFE-Library: Wenn dann lieber HPKE-basiert (RFC 9180) oder eine Solo-Subset-Difference-Implementation?
4. P3-2 Notification-Opt-Out-Granularitaet: Group-weise oder global?

## Pre-Implementation-Checks

Vor P3-Start:
- [ ] Production-Feedback aus Phase-2 (mindestens 2 Wochen Live-Erfahrung)
- [ ] Operator-Hand-Test des Multi-User-Flows (mindestens 2 echte User in einer echten Group)
- [ ] User-Survey: welches der 4 Items wird tatsaechlich gewollt
- [ ] Cost-Schaetzung pro Item (1 Sprint vs. 2 vs. 4)

## Cross-Reference

- [PLAN-sharing-phase-2.md](PLAN-sharing-phase-2.md) — Phase-2-Trade-Offs (Quelle der Phase-3-Liste)
- [docs/adr/0024-group-sharing-architecture.md](../../adr/0024-group-sharing-architecture.md) — Phase-1-Architektur-Decision
- [feedback_neon_pooler_set_role.md](memory) — Neon-Lessons-Learned aus Phase-2-Deploy-Saga, gilt fuer alle P3-Migrations
