# Status: mcp-approval2 (2026-05-17 abend, Family-Hardening LIVE)

> **🏠 Family-Hardening Sprint LIVE 2026-05-17 abend (Commit 95e1997 auf main).**
> THREAT-MODEL umgestellt auf **3-Szenarien-Modell** (Familie im Haushalt /
> Self-Host für Freunde / Corporate-GCP-VPC) statt der bisherigen "Privat
> 5-15 Tester"-Annahme. Code-Hardening: `securityHeaders()` Middleware
> (HSTS + X-Frame-Options:DENY + nosniff + Referrer-Policy + COIP/COOP),
> `originCheck()` Middleware (CSRF-Lite auf `/auth/*` + `/oauth/*`),
> `BOOTSTRAP_ADMIN_EMAIL` fail-CLOSED in production. Infra:
> `gcp-billing-budget.tf` mit Threshold-Alerts (50/90/100% auf 20€/Mo).
> Docs: [THREAT-MODEL.md](../THREAT-MODEL.md), [runbook-family-hardening.md](runbooks/runbook-family-hardening.md)
> mit ~4h Operator-Sprint, [operator-recovery-brief.md](runbooks/operator-recovery-brief.md)
> Safe-Brief-Template (Bus-Faktor 1 Mitigation), [docs/security/THREAT-SYNTHESIS-2026-05-17.md](security/THREAT-SYNTHESIS-2026-05-17.md)
> konsolidiert 4 Spezialisten-Briefs (Crypto/Identity/Ops/Privacy).
>
> **Pending Operator-Tasks (~3h manuell):** Google-Passkey + Recovery-Codes
> für Axel + Familie, Fallback-Login-Pfade (TOTP) bei
> GitHub/Fly/Doppler/CF/Resend, R2 Object-Lock + Versioning (CF-Dashboard,
> out-of-band weil Provider nicht TF-fähig), Restore-Drill scharf fahren,
> GCP-Billing-Budget aktivieren (`doppler secrets set TF_VAR_gcp_billing_account_id=XXX`),
> Recovery-Brief ausfüllen + Safe + Treuhänder-Kopie.
>
> **🛡 Security-Audit Phase A+B + Multi-User-Tier-1 deployed 2026-05-17 (Vormittag).**
> 14 Security-Findings gefixt (8 BLOCKER + 6 HIGH). EmailAdapter (Resend +
> Console-Fallback) + persistente `email_outbox` + PWA-Admin-Tab
> (Users/Invites/Outbox/Audit) live. Im Family-Modus ist die Tier-1-
> Infrastruktur Defense-in-Depth + Self-Host-Default für Freunde, nicht
> Pflicht-Workflow. Wenn jemand doch >Familie pilotet: Operator-Sequenz
> [runbooks/runbook-pilot-open.md](runbooks/runbook-pilot-open.md).
>
> **🚀 Pilot-Live seit 2026-05-17:** Beide Services erstmals end-to-end auf Fly.io
> erreichbar. `https://mcp2.ai-toolhub.org/health` → `{"status":"ok"}` (2 Machines fra),
> `https://mcp-knowledge2.fly.dev/health/ready` → `{"status":"ready","checks":{"db":"ok","blob":"ok"}}`.
> MCP-Protokoll-Smoke grün: DCR-Registration HTTP 201 (mit
> `DCR_INITIAL_ACCESS_TOKEN` aus SEC-005-Gating), OAuth-AS-Metadata + JWKS
> (`kid=key-2026-05-14`) korrekt, `/oauth/authorize` redirected Browser zu
> Google-OIDC (AS-3-Flow), `/mcp` ohne Bearer → HTTP 401.
>
> Snapshot. Branch `feat/as3-cutover` enthält die letzten Wellen seit dem 14.05.
> Pilot-Destroy:
>
> 1. **AS-3 Code-Complete** (PLAN-as3-autonomous): KC2 wird autonom, approval2
>    läuft als optionaler Approval-Proxy davor. OBO-JWT + Shared `SERVICE_TOKEN`,
>    DCR-OAuth-Facade mit Google-IdP-Redirect, kc-proxy-Route für die PWA.
> 2. **Generic-Object-Model (ADR-0004)**: KC2 spricht free-form `subtype: string`
>    statt enum. Adapter + Apps + Tool-Wrapper-Familien (lists/notes/bookmarks/recipes)
>    + PWA-Subtype-Renderer komplett umgestellt.
> 3. **Vulnerabilities-Fix (2026-05-15)**: `npm audit` = 0 Vulns nach
>    drizzle-orm 0.45.2 + vite@8 + vitest@4 + esbuild-override.
> 4. **Compute-Switch Hetzner → Fly.io (2026-05-17)**: User-Decision wegen
>    Operations-Last-Realismus bei Solo-Operator. OpenBao bleibt als separate
>    Fly-App (`mcp-approval2-openbao`). Adapter-Pattern + Provider-Switch-
>    Matrix unverändert — GCP-business-Mode-Pfad bleibt vollständig erhalten.
>    Hetzner-Material (`deploy/hetzner/`, `scripts/vm-*`, `runbook-hetzner-*`)
>    bleibt als Audit-Trail / Notfall-Reset-Material.
>
> Diese Datei ist Single-Source-of-Truth für "wo stehen wir + was fehlt
> bis Pilot-Production". Bei Aenderungen: Datum oben bumpen + entsprechende
> Sektion editieren.
>
> Plan-Refs:
> [PLAN-architecture-v1](plans/active/PLAN-architecture-v1.md) (Baseline),
> [PLAN-as3-autonomous](plans/active/PLAN-as3-autonomous.md),
> [PLAN-wrapper-conventions](plans/active/PLAN-wrapper-conventions.md),
> [PLAN-pwa-subtype-renderers](plans/active/PLAN-pwa-subtype-renderers.md),
> [PLAN-vulnerabilities-2026-05-15](plans/active/PLAN-vulnerabilities-2026-05-15.md),
> [PLAN-multiuser-tier1](plans/active/PLAN-multiuser-tier1.md) (Email + Outbox + Admin-UI),
> [security/SECURITY_ISSUES](security/SECURITY_ISSUES.md) (14 fixed in Phase A+B),
> [runbooks/runbook-pilot-open](runbooks/runbook-pilot-open.md) (Operator-Sequenz),
> [privat.md](privat.md) — kanonische Fly.io-Architektur-Wahrheit.

## Test-Baseline (lokal, 2026-05-17 nach Multi-User-Tier-1)

| Workspace | Tests | Anmerkung |
|---|---|---|
| `packages/adapters` | 137 passed, 1 skipped | + 8 EmailAdapter-Tests (Console + Resend, fail-cases) |
| `packages/core` | 47 passed | crypto, AAD, types |
| `apps/server` | 617 passed | + Bootstrap-SEC-008, Approval-SEC-001/004/018, OAuth-SEC-005-DCR-Consent, KC-Wrapper-SEC-006, EmailOutbox, Admin-Role/Delete |
| `apps/web` | 27 passed | + isSafeUrl-SEC-021, config-SEC-003, Admin-Tab compile-checks |
| **Total** | **828 passed, 1 skipped** | `npm run typecheck` clean über alle 4 Workspaces |

## Deploy-Status (2026-05-17, Pilot LIVE)

**Aktuell:** Beide Services produktiv auf Fly.io erreichbar. Cost-aktuell
~3-7 EUR/Monat erwartet (Free-Tier-Allowances + Vertex hobby-load).

| Komponente | Status | Anmerkung |
|---|---|---|
| Terraform-State (R2-Backend EU) | ✅ intakt | module.doppler + module.github + cloudflare_zone bleibt; Hetzner-Module ist entfernt |
| Fly.io-Apps (`mcp-approval2`, `mcp-knowledge2`, optional `mcp-approval2-openbao`) | ✅ **live 2026-05-17** | approval2: 2 Machines `fra`, shared-IPv4 + dediziertes IPv6. knowledge2: 1 Machine `fra`. OpenBao-App gate-flagged off (`enable_openbao_fly=false`) — Cloud-KMS ist Default-KEK. |
| Hetzner-VM `privat-mcp` | ❌ destroyed (historisch) | seit 2026-05-14, Pfad deprecated |
| Cloudflare-DNS-Records (mcp2/app2 CNAME → fly.dev) | ✅ **live 2026-05-17** | TLS-Cert via `fly certs add` validiert, Custom-Domain `mcp2.ai-toolhub.org` antwortet |
| Cloudflare-Zone `ai-toolhub.org` | ✅ intakt | data-block-Reference, war nie terraform-owned |
| Cloudflare AI Gateway `knowledge2-kc2` | ✅ live | seit 2026-05-14, EU-Region |
| Cloudflare R2 Buckets (4 stück) | ✅ **live** | `mcp-approval2-blob` + `mcp-approval2-backup` (+ knowledge2 Pendants) via Terraform. **Wichtig:** EU-Jurisdiction → `BLOB_ENDPOINT` muss `<account>.eu.r2.cloudflarestorage.com` enthalten (sonst 403). Fixed in `terraform/environments/privat/r2-blob.tf` outputs. |
| Cloudflare Zone-Ratelimit-Ruleset (knowledge2) | ⏸ gate-flagged off | `enable_cf_zone_ratelimit=false` — CF Free-Plan max 1 zone-ruleset per phase, v1-Worker hat den Slot |
| Google Cloud KMS (privat) | ✅ **live 2026-05-17** | **single-region `europe-west3`** (statt `eu` multi-region — `hashicorp/google` 6.x Provider-Bug `KMS_RESOURCE_NOT_FOUND_IN_LOCATION, request misrouted to global`). KeyRing `mcp-approval2-privat`, CryptoKey `user-dek-master` (90d auto-rotate), 3 SAs (approval2, knowledge2, knowledge2-vertex). Cost-identisch, Failover für 1 Solo-Key überdimensioniert. |
| Neon-Postgres-Projects (approval2 + knowledge2) | ✅ **live 2026-05-17** | beide eu-central-1 Frankfurt, Free Tier. 10 Migrations auf approval2 (0001-0010) + 12 auf knowledge2 angewendet. `release_command` in `fly.toml` lässt Migrations bei jedem Deploy idempotent laufen (via `_migrations`-Tracking-Tabelle). |
| Doppler-Project `mcp-approval2/fly` (privat) | ✅ **live 2026-05-17** | Werte auf Fly + Neon + Cloud-KMS umgestellt, Drift-Bug bei `BLOB_ENDPOINT` (`.eu.`-Prefix) gefixt |
| Doppler-Project `mcp-approval2/business` (GCP-Phase-2) | ⚠️ Stub | TF-Module liegt, GCP-Resources sind Placeholder |
| Doppler-Service-Tokens (Fly + GH-Actions) | ✅ intakt | weiter gültig |
| GitHub-Repo Settings + Branch-Protection | ✅ intakt | DOPPLER_TOKEN_GHA + fly-production env aktiv |

**MCP-Protokoll-Smoke (2026-05-17, alle grün):**
- `GET /.well-known/oauth-authorization-server` → OAuth-AS-Metadata korrekt (issuer, endpoints, scopes `mcp:tools`/`mcp:resources`, PKCE-S256, DCR enabled, grant_types `authorization_code`+`refresh_token`)
- `GET /.well-known/jwks.json` → RSA RS256 mit `kid=key-2026-05-14`
- `POST /oauth/register` (DCR) → HTTP 201 mit `client_id` + `registration_access_token`
- `GET /oauth/authorize?...` (Browser Accept) → HTTP 302 zu `/auth/google/start?return=...` (AS-3-Flow)
- `GET /mcp` ohne Bearer → HTTP 401 `{"error":{"code":"unauthorized","message":"missing bearer token"}}`

## Deploy-Pfade — Realitäts-Check

### Fly.io (privat-Mode) — primär, ✅ LIVE seit 2026-05-17

Verkabelt + smoke-tested gegen Production:

- [fly.toml](../fly.toml) (primärer Deploy-Pfad seit Fly-Switch 2026-05-17) + [fly.openbao.toml](../fly.openbao.toml) (deprecated; OpenBao-Pfad ersetzt durch Cloud-KMS) — Fly-App `mcp-approval2` (TF-managed via `fly_app.approval2`), Postgres als **Neon Free Tier** (TF-managed in `terraform/environments/privat/neon-approval2.tf`, Connection-Strings landen automatisch in Doppler).
- [deploy/hetzner/docker-compose.yml](../deploy/hetzner/docker-compose.yml) — 5 Services im `internal` Bridge-Netz: `postgres` (pgvector/pg16), `openbao`, `mcp-approval2`, `mcp-knowledge2`, `caddy`, plus `watchtower` für Auto-Update.
- [terraform/environments/privat/](../terraform/environments/privat/) provisioniert Hetzner-VM + Cloudflare-DNS + Doppler-Project + AI Gateway.
- 10 Postgres-Migrations (0001-0010) komplett.
- Cron-Architektur: **External-Scheduler-Pattern** ([cron/index.ts](../apps/server/src/cron/index.ts)) — keine in-process-Cron, statt-dessen HTTP-POST `/internal/v1/cron/:task`. systemd-timer / k8s-CronJob / GH-Actions triggert.

**Pilot-Code-Stand:** Cloud-KMS-Default greift, OpenBao-Pfad ist alternative
Selfhosting-Variante (gate-flagged off). OpenBao-Auth-Re-Export-Gap (Adapter-Index
+ Boot-Wiring-Branch) ist nur noch für eine spätere Selfhost-Aktivierung
relevant, nicht für den Pilot — Cloud-KMS hat Vorrang in der 5-stufigen
KEK-Provider-Selection (siehe [`apps/server/src/index.ts:121-175`](../apps/server/src/index.ts#L121-L175) + [docs/privat.md §9.3](privat.md)).

### Cloudflare Workers — sekundär, ~50% bereit, NICHT für AS-3 deploybar

Architektonisch sauber strukturiert ([cf/README.md](../apps/server/src/cf/README.md) ist ehrlich über Gaps), aber feature-incomplete:

| Aspekt | Status |
|---|---|
| Worker-Entry [cf/worker.ts](../apps/server/src/cf/worker.ts) | ✅ |
| D1-Adapter, Vectorize-Adapter, Workers-AI-Adapter, LocalKek | ✅ |
| Migrations-D1 [migrations-d1/0001_initial.sql](../apps/server/migrations-d1/) | ⚠️ **nur 0001 portiert** — 0002 oauth, 0003 sub-mcp, 0005 approvals, 0008-0010 prefs/push fehlen. Approval-Flow + OAuth-DCR funktionieren auf CF nicht. |
| R2-BlobAdapter | ❌ kein Interface-Adapter, nur `globalThis.__cfRuntime.blob` exposed |
| AS-3 kc-proxy + kc_wrappers in CF-Factory | ❌ [cf/app-factory-cf.ts:149-161](../apps/server/src/cf/app-factory-cf.ts#L149-L161) baut `deps` ohne `knowledge` und ohne `kcProxy` |
| Cron-Triggers in [wrangler.jsonc](../wrangler.jsonc) | ❌ nicht definiert. External-Scheduler-Pattern kann aber von außen triggern (gleicher Mechanismus wie Hetzner). |
| CF-spezifische Tests | ❌ keine. Contract-Tests laufen nur gegen Postgres-Stub. |
| Deploy-Script [deploy/cloudflare/deploy.sh](../deploy/cloudflare/deploy.sh) | ✅ idempotent, gut dokumentiert |

**Fazit CF-Pfad:** für Solo-Operator-Use-Case ohne KC2-Anbindung und ohne Approval-Flow theoretisch wieder-aktivierbar — aber für den AS-3-Pilot ist Hetzner/Fly der einzige Weg.

## Security-Audit (2026-05-17): Phase A+B FIXED, Phase C+ Backlog

| Phase | Findings | Status | Commits |
|---|---|---|---|
| A (BLOCKER) | SEC-001/002/004/005/006/007/008/009/018 (8) | ✅ FIXED | 246d284, b2ec20f, 79c137d, 1535534, c7adb89, 72df0c0 |
| B (HIGH) | SEC-003/010/011/019/020/021 (6) | ✅ FIXED | daa4dcf, 1a49347, 3de9e19, f055448, 8d74e45, 25b2d2a |
| C (HIGH, offen) | SEC-012/013/014/015/016/017/022/023/024/025/026 (11) | ⚠ Backlog | nicht-blockend für Pilot |
| MEDIUM (offen) | SEC-027..035+ | ⚠ Backlog | post-pilot |

Vollständige Details mit FIXED-Bannern + Commit-Refs in
[security/SECURITY_ISSUES.md](security/SECURITY_ISSUES.md).

**Operator-Setup nach Phase A+B (Doppler `mcp-approval2/fly`, TF-managed
via [terraform/environments/privat/approval2-app-secrets.tf](../terraform/environments/privat/approval2-app-secrets.tf)):**

- `BOOTSTRAP_ADMIN_EMAIL=axelrogg@gmail.com` (SEC-008 race-Schutz)
- `DCR_OPEN=false` + `DCR_INITIAL_ACCESS_TOKEN=GoIc...11Hx1Urw` (SEC-005)
- `DCR_ALLOWED_REDIRECT_HOSTS=` (leer = nur Scheme-Check)

## Multi-User Tier 1 (2026-05-17): LIVE

Email-Adapter + Persistente Outbox + PWA-Admin-Tab. Pilot kann mit 2-3
Testern eröffnet werden ohne weiteren Code-Setup. Operator-Sequenz:
[runbooks/runbook-pilot-open.md](runbooks/runbook-pilot-open.md).

| Komponente | Status | Anmerkung |
|---|---|---|
| `packages/adapters/src/email/` (EmailAdapter + Resend + Console) | ✅ live | 8 Tests, Resend-API + AbortController-Timeout |
| Migration `0013_email_outbox.sql` | ✅ applied | append-only, admin-only-read app-layer-gated |
| `services/email-outbox.ts` (sendAndPersist + listOutbox + markDispatched) | ✅ live | fail-soft bei Send-Fail, Outbox bleibt |
| Invite + Recovery wire EmailAdapter | ✅ live | no-enumeration-leak bei unknown-email |
| `AdminService.changeRole + softDeleteUser` | ✅ live | one_active_admin-constraint mapped auf 409 |
| `routes/admin.ts` (POST role, DELETE user, GET/POST email-outbox) | ✅ live | adminOnly-middleware |
| PWA Admin-Tab (`#/admin`) mit 4 Subtabs | ✅ live | Shield-Icon nur für admins sichtbar |
| Doppler-Secrets (`EMAIL_PROVIDER`, `EMAIL_FROM`, `RESEND_API_KEY`) | ✅ via TF | Default-Mode `console` — Resend-Switch ist optional |
| Resend-DNS-Verify | ⚠ pending | Operator-out-of-band: resend.com signup + DNS in CF einpflegen |

**Multi-User Phase 2 Backlog** (kein Pilot-Blocker):
- Logout-All-Devices Endpoint
- Recovery-Codes (2-Faktor-Fallback)
- R2-Storage-Quota pro User
- `/admin/users/:id/relink` für SEC-010-Pattern
- PWA-Recovery-Form (heute nur API-Endpunkt)

## Security-Follow-Ups (offen für 2026-05-18)

Doppler-Leak-Hygiene aus 2026-05-16: Tokens müssen rotiert werden, sind aktuell
noch live aber im Session-Transcript gesehen worden. Mostly external-console-
work (~5 Minuten pro Service):

| Token | Wo | Rotation |
|---|---|---|
| R2 API-Tokens (BLOB + BACKUP) | Doppler `mcp-approval2/fly` + `mcp-knowledge2/fly` | CF-Dashboard → R2 → API Tokens → revoke + new (Tokens an sich waren OK — nur `BLOB_ENDPOINT`-Drift) |
| FLY_API_TOKEN | Doppler + GH-Actions | `fly tokens create org -o personal -x 8760h`, alte via Dashboard revoke |
| GITHUB_TOKEN (GH-Actions PAT für Doppler-Push) | GH-Repo-Secrets | Personal-Tokens-Page → revoke + new |
| Google-OAuth-Client-Secrets (2× — approval2 + knowledge2) | Doppler | GCP-Console → APIs & Services → Credentials → reset secret pro Client |
| NEON_API_KEY | Doppler (TF-Provider) | Neon-Console → Account-Settings → API-Keys |
| HCLOUD_TOKEN + Hetzner-SSH-Key | Doppler (historisch, Hetzner deprecated) | Hetzner-Console → Security → revoke. Low-Prio weil Pfad deprecated. |
| JWT-Keys (RS256 priv/pub + JWT_SECRET + JWT_KID) | Doppler | `openssl genpkey` neu, `JWT_KID=key-<YYYY-MM-DD>`, deploy triggert JWKS-Rotation |
| MASTER_KEY_BASE64 (Fallback) | Doppler | `openssl rand -base64 32`, deploy — affects nur Fallback-Pfad (Cloud-KMS ist Default) |
| Internal-Tokens (`SERVICE_TOKEN`, `MCP_APPROVAL_INTERNAL_TOKEN`) | Doppler (beide Services!) | `openssl rand -hex 32`, gleicher Wert in beiden Doppler-Configs |
| Doppler Personal-Token (`dp.pt....`) | `.dev.vars` lokal | Dashboard → Profile → Tokens → revoke + new |

**GCP-Console-Edit (1 Klick, offen für 2026-05-18):** knowledge2-OAuth-Client
Redirect-URI von `https://knowledge.ai-toolhub.org/auth/google/callback` auf
`https://knowledge2.ai-toolhub.org/auth/google/callback` umstellen. console.cloud.google.com
→ APIs & Services → Credentials.

## Roadmap

### P0 — Offen für 2026-05-18

1. **Token-Rotation** durchziehen (siehe §Security-Follow-Ups).
2. **GCP-Console-Edit:** knowledge2-OAuth-Client Redirect-URI auf `knowledge2.ai-toolhub.org` umstellen.
3. **End-to-End-MCP-Test:** Claude.ai gegen `https://mcp2.ai-toolhub.org/mcp` verbinden, DCR + OAuth durchspielen, Tool-Liste sehen.

### P1 — Code- und Ops-Polish

4. **OpenBao-Auth-Export** (nur falls je Selfhost-Switch zurück): [packages/adapters/src/index.ts](../packages/adapters/src/index.ts) muss `StaticTokenAuth`, `AppRoleAuth`, `VaultAuthError` re-exportieren, [apps/server/src/index.ts:121-175](../apps/server/src/index.ts#L121-L175) hat den OpenBao-Branch bereits — Pilot läuft mit Cloud-KMS, nicht load-bearing.
5. **`smoke.sh`-Pendant für Production** (gibt es nur als `pilot-smoke.sh`/`pilot-smoke.test.ts` — Pendant zu mcp-approval's `scripts/smoke-prod.sh` mit Throttle-/Retry-Logik fehlt).

### P2 — wenn CF-Pfad ernsthaft Production wird

6. D1-Migrations 0002–0010 portieren (`apps/server/migrations-d1/`). Prio: 0005_approvals (sonst kein Approval-Flow).
7. R2-BlobAdapter implementieren, `knowledge` + `kcProxy` in [cf/app-factory-cf.ts](../apps/server/src/cf/app-factory-cf.ts) verkabeln, `triggers.crons` in wrangler.jsonc (oder external-scheduler dokumentieren).
8. CF-spezifische Test-Suite (D1-Adapter Round-Trip, Vectorize-Lag-Awareness, Workers-AI-Smoke).

### P3 — Doku- und Ops-Polish

9. STATUS.md (diese Datei) regelmäßig synchron halten — Datum oben bumpen wenn sich was bewegt.
10. **GCP-Phase-2** (Business-Workspace): `terraform/environments/business/` Module ist seit `544041d` da (Cloud SQL + GCS + KMS Spec), aber noch unangewendet — Apply erst wenn Pilot-Erfolg.
11. **Sub-MCP-Server-Migration** (cf/github/gws/gcloud/utils Worker auf X-User-JWT-Header in [docs/migration/sub-mcp-server-migration-guide.md](migration/sub-mcp-server-migration-guide.md)) — separate Repos, separat zu treiben.

## Boot-Reihenfolge (Node-Pfad)

```
main()
 └── createServerContext(env)
      ├── translateBootEnv(env)        # Compose → zod-Schema-Aliases
      ├── loadConfig(env)              # zod-validation
      └── createDbAdapter(config)      # Postgres oder SQLite
 └── waitForDb(server)                  # exponential-backoff 30s
 └── preflightJwtKeys(env)              # PEM-Parse, fail-fast
 └── buildOptionalDeps(server, bootEnv)
      ├── (optional) LocalKekProvider via MASTER_KEY_BASE64
      ├── (optional) KnowledgeService via KNOWLEDGE_URL + JWT-PEM
      ├── (optional) internalServiceToken
      └── (optional) kcProxy (KNOWLEDGE_URL + MCP_KNOWLEDGE_SERVICE_TOKEN)
 └── createApp(server, deps)            # gemeinsame Hono-Wireup für Node + CF
 └── serve({fetch: app.fetch, port})
```

CF-Pfad geht über [cf/worker.ts](../apps/server/src/cf/worker.ts) → [cf/app-factory-cf.ts](../apps/server/src/cf/app-factory-cf.ts) zur selben `createApp`-Funktion, baut `deps` aber aus CF-Bindings statt aus Env-Vars.
