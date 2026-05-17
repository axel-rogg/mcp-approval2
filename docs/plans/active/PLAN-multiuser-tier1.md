# PLAN: Multi-User Tier 1 — Email + Outbox + Admin-UI

> ✅ **LIVE 2026-05-17** auf `mcp2.ai-toolhub.org` (Fly.io, image
> `deployment-01KRTZ88177D4EH6K1SWRQ6BF4`, 2 Machines `fra` 1/1 healthy).
> Audit-Trail-Plan für die Tagesarbeit; keine offenen Tasks innerhalb dieser
> Phase. Tier 2-Backlog am Ende.

## Hintergrund

Nach Security-Phase-A/B (14 Findings gefixt) zeigte ein Multi-User-Reife-
Audit, dass das System auf Code-Ebene Multi-User-tauglich ist (RLS, per-User-
DEK, Cross-User-Auth) — aber drei Operator-Surfaces UX-roh waren:

1. **Invite-Flow generierte Magic-Links**, versendete sie aber NICHT — Admin
   musste `curl POST /admin/invites` machen + `acceptUrl` aus JSON kopieren +
   manuell per Mail an den Tester.
2. **Recovery-Flow generierte Recovery-Links**, ebenfalls ohne Versand —
   blockierte den Pfad "User verliert Passkey".
3. **Admin-Surfaces (suspend/unsuspend/role/audit) existierten als API**,
   aber kein PWA-UI — Admin musste alles via curl + Bearer-Token machen.

Für einen Pilot mit 2-3 Testern war das die einzige reelle Reibung.

## Implementation-Scope (Tier 1)

| # | Komponente | Files | Commit |
|---|---|---|---|
| 1 | EmailAdapter (Resend + Console + EmailSendError) | [packages/adapters/src/email/](../../../packages/adapters/src/email/) | `99c1c80` |
| 2 | Email-Templates für Invite + Recovery | [apps/server/src/auth/invite/email-template.ts](../../../apps/server/src/auth/invite/email-template.ts), [apps/server/src/auth/recovery/email-template.ts](../../../apps/server/src/auth/recovery/email-template.ts) | `5ad97f3` |
| 3 | EmailOutboxService (sendAndPersist/listOutbox/markDispatched) | [apps/server/src/services/email-outbox.ts](../../../apps/server/src/services/email-outbox.ts) | `5ad97f3` |
| 4 | Migration `0013_email_outbox` (append-only, admin-only-read app-layer-gated) | [apps/server/migrations/0013_email_outbox.sql](../../../apps/server/migrations/0013_email_outbox.sql) | `5ad97f3` |
| 5 | Invite-Route nutzt EmailOutboxService | [apps/server/src/routes/auth/invite.ts](../../../apps/server/src/routes/auth/invite.ts) | `5ad97f3` |
| 6 | Recovery-Route nutzt EmailOutboxService + userFound-flag | [apps/server/src/routes/auth/recovery.ts](../../../apps/server/src/routes/auth/recovery.ts), [apps/server/src/auth/recovery/email.ts](../../../apps/server/src/auth/recovery/email.ts) | `5ad97f3` |
| 7 | Config-Knobs (EMAIL_PROVIDER/RESEND_API_KEY/EMAIL_FROM/EMAIL_REPLY_TO) | [apps/server/src/lib/config.ts](../../../apps/server/src/lib/config.ts) | `5ad97f3` |
| 8 | AdminService.changeRole + softDeleteUser | [apps/server/src/services/admin.ts](../../../apps/server/src/services/admin.ts) | `9fc8292` |
| 9 | Admin-Routes (POST /role, DELETE user, GET/POST email-outbox) | [apps/server/src/routes/admin.ts](../../../apps/server/src/routes/admin.ts) | `9fc8292` |
| 10 | PWA Admin-API-Client | [apps/web/src/api-admin.ts](../../../apps/web/src/api-admin.ts) | `89dd1b8` |
| 11 | PWA Admin-Tab (4 Subtabs + Shield-Icon) | [apps/web/src/admin-tab.ts](../../../apps/web/src/admin-tab.ts), [apps/web/src/components/header.ts](../../../apps/web/src/components/header.ts), [apps/web/src/main.ts](../../../apps/web/src/main.ts) | `89dd1b8` |
| 12 | Doppler-Secrets via TF (EMAIL_PROVIDER/EMAIL_FROM/RESEND_API_KEY-placeholder) | [terraform/environments/privat/approval2-app-secrets.tf](../../../terraform/environments/privat/approval2-app-secrets.tf) | `f11ba8f` |
| 13 | Deploy-Trigger | `[deploy]`-Commit | `a9eb146` |
| 14 | Bug-Fix: admin-tab fmtDate akzeptiert BIGINT-as-string von postgres-js | [apps/web/src/admin-tab.ts](../../../apps/web/src/admin-tab.ts), [apps/web/src/api-admin.ts](../../../apps/web/src/api-admin.ts) | `7167053` |
| 15 | Operator-Runbook | [docs/runbooks/runbook-pilot-open.md](../../runbooks/runbook-pilot-open.md) | `7167053` |

**Tests:** 828 passed (vorher 711 vor Phase A) — 8 EmailAdapter + diverse
SEC-Tests. typecheck clean über alle 4 Workspaces. Migration 0013 idempotent
via `fly.toml` release_command applied.

## Design-Entscheidungen

### Email-Provider: Adapter-Pattern statt direkte Resend-Bindung

Motivation: Pilot-Start ohne externe Abhängigkeit. Console-Adapter loggt nur
(plus persistiert in `email_outbox`) — User kann sofort Tester einladen ohne
Resend-Account/DNS-Setup zu warten.

Switch zu Resend ist Config-only (EMAIL_PROVIDER=resend + RESEND_API_KEY),
kein Code-Deploy.

Implementiert in `packages/adapters/src/email/`:
- `interface.ts`: EmailAdapter / EmailMessage / EmailSendError
- `console.ts`: pseudo-id, capture-Array für Tests
- `resend.ts`: REST-API + AbortController-Timeout 10s

### email_outbox-Tabelle: append-only, admin-only-read app-layer-gated

Analog zu `audit_log` — Admin-only-Read wird im Service `requireAdmin()`-
geprüft, KEINE RLS-Policy (RLS auf admin-only ist Phase 2 wenn Multi-Tenant
kommt, dann via `app.current_role`-Setting).

Body wird mit-persistiert auch bei `EMAIL_PROVIDER=resend` — dient als
Audit-Trail + Resend-Fallback bei Send-Fail (Admin kann Body kopieren und
manuell zustellen).

### no-enumeration-leak im Recovery-Flow

`requestRecovery` returnt jetzt `userFound: boolean`. Email wird NUR
gesendet wenn `userFound=true` — sonst leakt der `email_outbox`-Eintrag
die Existenz des Users. API-Response bleibt identisch (kein Status-Code-
Unterschied).

### Admin-UI Self-Protect

- Suspend/Delete-Buttons sind für den eigenen User-Account `disabled`.
- Role-Change: Self-demote ist erlaubt (User darf sich selbst zum member
  machen — sinnvoll bei Owner-Übergabe), aber SEC-008 `one_active_admin`-
  Constraint blockt einen 2. promote-to-admin.
- Delete: Self-delete explizit `throw HttpError.forbidden`-geblockt im
  Service (nicht nur UI).

## Operator-Setup

Siehe [docs/runbooks/runbook-pilot-open.md](../../runbooks/runbook-pilot-open.md).

Kurzfassung:
1. Doppler-Secrets via TF gesetzt (TF-managed, kein UI-Click)
2. Operator-Login mit `BOOTSTRAP_ADMIN_EMAIL` → automatisch role=admin
3. Passkey enrollen (SEC-009 UV-required)
4. Im Admin-Tab → Invites → Email eingeben → Link out-of-band an Tester
5. Outbox-Tab beobachten

## Tier 2 Backlog (offen)

| # | Feature | Begründung |
|---|---|---|
| 1 | Logout-All-Devices Endpoint | User-Hygiene bei Device-Verlust |
| 2 | Recovery-Codes (10× base64 bei Passkey-Enroll) | Wenn Passkey + Email gleichzeitig weg |
| 3 | R2-Storage-Quota pro User (`user_storage_quota` Tabelle) | Anti-Abuse ab dem 5+ User |
| 4 | `/admin/users/:id/relink` (SEC-010 Pattern) | Zweiter Admin gegen-signiert external_id-Re-Link |
| 5 | PWA Recovery-Form | Heute nur API-Endpunkt |
| 6 | Resend-DNS via Terraform | Mit `cloudflare_record`-Resourcen (Resend hat keinen TF-Provider) |
| 7 | Real-Email-Versand-Test (post-Resend-Setup) | Smoke-Test gegen Resend-API |

## Pilot-Sign-off-Kriterien

- [x] Operator kann sich als admin einloggen
- [x] Operator kann ersten Tester via Admin-Tab einladen
- [x] Outbox zeigt den generierten Link, Operator kann ihn copy-pasten
- [x] Tester-Flow funktioniert E2E (invite-accept → Google-Login → Passkey-Enroll)
- [x] Admin kann Tester suspenden/unsuspenden
- [x] Audit-Tab zeigt alle Aktionen
- [ ] (optional, Phase 2) Echter Resend-Email-Versand mit DNS-Verify
