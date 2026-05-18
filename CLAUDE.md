# mcp-approval2 — Kontext für Claude Code

> **Greenfield-Successor** zu [mcp-approval](https://github.com/axel-rogg/mcp-approval) (Cloudflare-Workers, single-user).
> **Drei Deployment-Szenarien** (Strategie 2026-05-17): **Familie im Haushalt** (2-5 Personen, Art. 2(2)c DSGVO greift, primärer Modus), **Self-Host für Freunde** (jeder Freund deployed eigene Instance, Axel raus aus DSGVO-Kette), **Corporate-GCP-VPC** (20-500 User, 4-6 Wochen Compliance-Programm). Postgres + Google Cloud KMS (single-region `europe-west3`, ADR-0011). Mehr in [THREAT-MODEL.md §Deployment-Kontext](THREAT-MODEL.md#deployment-kontext-drei-realistische-szenarien).
> Schwester-Repo: [mcp-knowledge2](https://github.com/axel-rogg/mcp-knowledge2) (Storage + Search).
>
> **🛡 Update 2026-05-17 abend — Family-Hardening LIVE (Commit 95e1997).** Threat-Modell auf 3-Szenarien-Modell umgestellt. Code-Changes: `securityHeaders()` Middleware (HSTS + X-Frame-Options:DENY + nosniff + Referrer-Policy + COIP/COOP), `originCheck()` Middleware (CSRF-Lite auf `/auth/*` + `/oauth/*`), `BOOTSTRAP_ADMIN_EMAIL` fail-CLOSED in production. Infra: `gcp-billing-budget.tf` mit Threshold-Alerts. Docs: [THREAT-MODEL.md](THREAT-MODEL.md) auf 3-Szenarien, [runbook-family-hardening.md](docs/runbooks/runbook-family-hardening.md) ~4h Operator-Sprint, [operator-recovery-brief.md](docs/runbooks/operator-recovery-brief.md) Safe-Brief-Template (Bus-Faktor 1 Mitigation), [docs/security/THREAT-SYNTHESIS-2026-05-17.md](docs/security/THREAT-SYNTHESIS-2026-05-17.md) konsolidiert 4 Spezialisten-Briefs.
>
> **Status 2026-05-15:** AS-3-Code-Complete + **Generic-Object-Model** + **PWA-Subtype-Renderer** + **Tool-Wrapper-Familien (lists/notes/bookmarks/recipes)** + **Vulnerabilities-Fix** (`npm audit` = 0 Vulns) auf Branch `feat/as3-cutover`. Cutover-Day pending — Runbook im Schwester-Repo:
> [knowledge2/docs/runbooks/runbook-as3-cutover.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-as3-cutover.md).
>
> **⚡ Update 2026-05-17 abend — Write-Mode + Passkey-Pipeline LIVE.** [PLAN-writemode.md](docs/plans/active/PLAN-writemode.md) komplett deployed: WebAuthn-Passkey-Enroll (Settings → Passkeys), Write-Mode-Aktivierung mit Touch-ID (15/60/240 min), Auto-Bypass für `sensitivity=write`-Tools (danger bleibt approval-pflichtig), Topbar-Countdown-Pill. **Dynamic per-request RP-ID** für Multi-Origin (PWA auf `app2.ai-toolhub.org`, `mcp-approval2.fly.dev`, `mcp2.ai-toolhub.org` — jede Origin == eigene Passkey-Domain). **8 versteckte Plumbing-Bugs** beim Rollout gefixt: Schema-Drift `sign_count`→`counter` (Mig 0015), Multi-Machine Challenge-Store DB-backed (Mig 0022), `db.scoped()` Orphan-Tx → `db.transaction()`, base64url-Encoding für Assertion-Felder, JSONB-transports auto-parse, dual-encoding credential_id-Lookup, enroll-Route-Name + Bearer-Auth-Fix, Migration-Number-Race-Renumber. Pipeline-Härtung: Fly health-check `grace_period` 60s, `--wait-timeout 10m`, auto-retry 1×. Full Lessons-Learned-Tabelle in [PLAN-writemode.md §Deployment Lessons](docs/plans/active/PLAN-writemode.md).
>
> **🛡 Update 2026-05-17 abend — Security-Audit Phase A+B FIXED + Multi-User Tier 1 LIVE.** 14 Security-Findings gefixt (8 BLOCKER + 6 HIGH, alle in [docs/security/SECURITY_ISSUES.md](docs/security/SECURITY_ISSUES.md) mit FIXED-Banner). EmailAdapter (Resend + Console-Fallback) + persistente `email_outbox`-Tabelle (Migration 0013) + PWA-Admin-Tab unter `#/admin` (Users/Invites/Outbox/Audit, shield-Icon im Header für admins). Für Family-Modus (primär) ist die Multi-User-Tier-1-Infrastruktur Defense-in-Depth-Ballast, nicht Pflicht-Workflow — Family-Onboarding läuft via Direkt-Login. Wenn jemand doch >Familie pilotet: Operator-Sequenz [docs/runbooks/runbook-pilot-open.md](docs/runbooks/runbook-pilot-open.md). Doppler-Knobs: `BOOTSTRAP_ADMIN_EMAIL` (**Pflicht in prod seit Family-Hardening**), `DCR_OPEN=false`, `DCR_INITIAL_ACCESS_TOKEN`, `EMAIL_PROVIDER=console` (Default solange Resend-DNS pending) — alle via [terraform/environments/privat/approval2-app-secrets.tf](terraform/environments/privat/approval2-app-secrets.tf).
>
> **Update 2026-05-17 Multi-User-Sprint (cross-repo):** approval2-Seite des knowledge2-Sicherheits-Sprints (commit 9c4813f). Drei Änderungen am KnowledgeAdapter:
> 1. **Scope-spezifische Service-Tokens** (`MCP_KNOWLEDGE_SERVICE_TOKEN_ERASE`/`_SYNC`/`_OPS`) — `HttpKnowledgeAdapter.pickServiceToken(path)` wählt per-Route; Fallback auf legacy `MCP_KNOWLEDGE_SERVICE_TOKEN` solange KC2 das master-Secret noch enabled hat (SEC-K-009).
> 2. **`JwtSigner.signEraseReceipt()`** als optionale Methode — Adapter sendet bei `eraseUser()` einen `x-erase-receipt`-Header mit `payload.sub === userId`, signed mit demselben RS256-Key wie OBO (SEC-K-016 + MUSS-§4.1.2). KC2 verifiziert via JWKS, audience='mcp-knowledge2:erase'.
> 3. **`EraseUserArgs.approvalId`** optional — wandert als `payload.approval_id` in den Receipt-JWS damit KC2 die Erase-Spur einem approval2-Approval zuordnen kann.
>
> Aktivierung (User-Hand): Doppler set `MCP_KNOWLEDGE_SERVICE_TOKEN_ERASE/SYNC/OPS` auf gleiche Werte wie KC2's `SERVICE_TOKEN_ERASE/SYNC/OPS`. Dann KC2 `REQUIRE_ERASE_RECEIPT=true` + KC2 legacy `SERVICE_TOKEN` rotate auf ungültig. Details + Status aller Findings in [knowledge2 docs/security/SECURITY_ISSUES.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/security/SECURITY_ISSUES.md) Sprint-Stand-Block.
>
> **Update 2026-05-17 (Pilot-Deploy-Day):** Beide Services sind erstmals end-to-end live auf Fly.io:
> - `https://mcp2.ai-toolhub.org/health` → `{"status":"ok"}` (2 Machines fra, shared-IPv4 + dediziertes IPv6, TLS-Cert validiert)
> - `https://mcp-knowledge2.fly.dev/health/ready` → `{"status":"ready","checks":{"db":"ok","blob":"ok"}}`
> - **MCP-Protokoll-Smoke:** DCR-Registration → HTTP 201, `/.well-known/oauth-authorization-server` korrekt, JWKS live (kid `key-2026-05-14`), `/oauth/authorize` redirected Browser zu Google-OIDC, `/mcp` gibt 401 ohne Bearer.
> - **Postgres:** Neon Free Tier (eu-central-1 Frankfurt) statt Fly MPG, 10 Migrations (0001-0010) auf approval2 + 12 auf knowledge2 angewendet. `release_command` in `fly.toml` lässt Migrations automatisch beim Deploy laufen (idempotent via `_migrations`-Tracking-Tabelle).
> - **KEK-Provider:** Google Cloud KMS (**single-region `europe-west3`** statt `eu` multi-region — bekannter google-Provider-6.x-Bug `KMS_RESOURCE_NOT_FOUND_IN_LOCATION`, Cost-identisch, Failover für 1 Solo-Key überdimensioniert). KeyRing `mcp-approval2-privat` + CryptoKey `user-dek-master` (90d auto-rotate) + 3 SAs.
> - **R2:** EU-Jurisdiction-Buckets, `BLOB_ENDPOINT` MUSS `.eu.r2.cloudflarestorage.com` enthalten (sonst 403). Drift-Bug behoben in [terraform/environments/privat/r2-blob.tf](terraform/environments/privat/r2-blob.tf) + Doppler-Wert.
>
> **5 Live-Bug-Wave gefixt (2026-05-17, abend, alles auf `feat/as3-cutover`)** — End-to-end Browser-Login via PWA → Google → Approval-Inbox läuft jetzt clean. Lessons-Learned-Sammlung für künftige Multi-Origin/Postgres-Setups:
>
> | # | Symptom | Root-Cause | Fix-Commit | Affected |
> |---|---|---|---|---|
> | 1 | `invalid input syntax for type inet: "client_ip, proxy_ip"` beim Login | `c.req.header('x-forwarded-for')` direkt in INET-Column geschoben — hinter Fly+CF kommt CSV | `6cb8914` | [apps/server/src/routes/auth/google.ts](apps/server/src/routes/auth/google.ts) — bevorzugt `fly-client-ip` (single IP, Edge-verifiziert), Fallback auf `.split(',')[0]?.trim()` |
> | 2 | `missing oauth state cookie` nach Google-Callback | Multi-Origin: Cookie auf `app2.ai-toolhub.org` gesetzt, Callback auf `mcp2.ai-toolhub.org` sieht es nicht | `2e26089` | NEU [apps/server/src/lib/cookie.ts](apps/server/src/lib/cookie.ts) Helper + `COOKIE_DOMAIN`-Config-var. Doppler: `COOKIE_DOMAIN=.ai-toolhub.org` (mit führendem Punkt). 5 setCookie/deleteCookie-Stellen umgestellt |
> | 3 | `TypeError: Cannot read properties of undefined (reading 'parsers')` bei jedem User-scoped Request | Drizzle's `construct()` greift auf `client.options.parsers[type]`; `sql.reserve()` + `sql.begin()`-Callback geben Wrapper ohne `.options` zurück (die liegt auf parent Sql) | `2e85dfa` | [packages/adapters/src/db/postgres.ts](packages/adapters/src/db/postgres.ts) — `(reserved as { options: unknown }).options = this.sql.options` Hack vor `drizzle()`-Init in `scoped()` und `transaction()` |
> | 4 | Nach OAuth-Callback bleibt User auf JSON-Page bei `mcp2.../auth/google/callback`, kommt nicht zurück zur PWA | PWA-Button sendet `?next=` ohne Wert; Server akzeptiert nur `?return=`; selbst mit Param würde `isSafeReturnPath` Cross-Subdomain ablehnen | `1a3e2d0` | PWA [apps/web/src/auth.ts](apps/web/src/auth.ts) defaultet `return=${window.location.origin}/`; Server akzeptiert `?return=` UND `?next=` (Alias), validiert gegen `ORIGIN + ALLOWED_ORIGINS` |
> | 5 | `column "target_user_id" of relation "audit_log" does not exist` (silent — emitAudit ist fail-soft, Login lief trotzdem durch) | Schema-Drift: Code wollte 4 Spalten/Werte einfügen die Schema (0001_initial.sql) nicht hat oder anders nennt (`ts` statt `created_at`, kein `target_user_id`, `actor_type` NOT NULL nicht gesetzt, result-Enum unterschiedlich) | `202aa04` | [apps/server/src/services/audit.ts](apps/server/src/services/audit.ts) — Code-an-Schema angepasst (kein Migration nötig). `targetUserId` wandert in `details.targetUserId`. `mapResult()`-Helper: `failure→error`, `noop→denied` |
>
> Token-Rotation (wegen Doppler-Leak 2026-05-16) + GCP-Console-Redirect-URI-Fix (`knowledge.` → `knowledge2.`) noch offen für 2026-05-18.
>
> **Generic-Object-Model (ADR-0004 in knowledge2, 2026-05-15)**: KC2-API spricht nicht mehr `kind` sondern free-form `subtype: string`. Adapter (`packages/adapters/src/knowledge/`) + Apps-Subsystem + Service+Tool-Layer + PWA komplett umgestellt. Apps nutzen Subtype-Namespacing `app:<typ>` (z.B. `app:composable`, `app:shopping-list`). Siehe Brief im Schwester-Repo: [knowledge2/GENERIC-DATA-MODEL.md](https://github.com/axel-rogg/mcp-knowledge2/blob/feat/as3-cutover/GENERIC-DATA-MODEL.md) + lokal [docs/plans/active/PLAN-wrapper-conventions.md](docs/plans/active/PLAN-wrapper-conventions.md).

## Architektur (Stand 2026-05-15)

```
   Claude.ai-MCP-Client                Browser-PWA
        │                                   │
        │ OAuth-2.1 + PKCE + DCR             │ Cookie-Session (Google-OIDC)
        ▼                                   ▼
   ┌────────────────────────────────────────────────┐
   │  mcp-approval2                                 │
   │  • Auth / Sessions / WebAuthn / PRF            │
   │  • Approval-Flow (WYSIWYS + IPI-Filter)        │
   │  • Tool-Surface (native + Sub-MCP-Gateways)    │
   │  • KEK-Provider (Google Cloud KMS, ADR-0011)   │
   │  • PWA (Approval-Display, Storage-Tab)         │
   │  • DCR-OAuth-Facade für MCP-Clients            │
   └─────────────────────┬──────────────────────────┘
                         │  S2S: X-On-Behalf-Of + SERVICE_TOKEN
                         ▼
                  mcp-knowledge2 (separate Repo)
                  Storage / Sharing / Hybrid-Search
```

**Single-Tenant strikt**: 1 Firma = 1 Instance. Zweite Firma = fork und neue Instance.
**Identity-Provider (AS-3, Code-Complete 2026-05-15)**: Google OIDC. mcp-approval2 ist Resource-Server gegenüber Google, betreibt seine DCR-OAuth-2.1-Facade unter `apps/server/src/mcp/oauth/` für Claude.ai-MCP-Clients (mit `idp=google`-Claim in Tokens). S2S an KC2 via OBO-JWT + `SERVICE_TOKEN`.

## Plan-Index

Status-Banner oben in jedem PLAN-File.

| Plan | Status | Zweck |
|---|---|---|
| [PLAN-architecture-v1.md](docs/plans/active/PLAN-architecture-v1.md) | ✅ Decisions complete (§3 Identity erweitert durch AS-3) | 22-Decisions-Baseline aus Session 2026-05-13 |
| [PLAN-architecture-v0.md](docs/plans/active/PLAN-architecture-v0.md) | Vorgänger | Subagent-Recherche, Pattern-Options |
| [PLAN-hetzner-deployment.md](docs/plans/active/PLAN-hetzner-deployment.md) | ⚠️ Spec | Multi-Instance auf Hetzner + GCP |
| **[PLAN-as3-autonomous.md](docs/plans/active/PLAN-as3-autonomous.md)** | ✅ **CODE-COMPLETE 2026-05-15** | AS-3-Migration: approval2 als Proxy vor autonomem KC2. A1-A12 + T3 auf `feat/as3-cutover`. |
| **[PLAN-wrapper-conventions.md](docs/plans/active/PLAN-wrapper-conventions.md)** | ✅ **Live 2026-05-15** | Subtype-Konventionen (doc/skill_manifest/app:*/memo/list/note/bookmark/recipe), Body-Formate, Drift-Prevention. Kanonische Quelle nach ADR-0004. |
| **[PLAN-pwa-subtype-renderers.md](docs/plans/active/PLAN-pwa-subtype-renderers.md)** | ✅ **Live 2026-05-15** | PWA-Renderer pro Subtype (markdown/list/memo/skill-manifest/app-link/binary/code). Dispatcher in `apps/web/src/renderers/` mit marked@18 + dompurify@3. |
| **[PLAN-vulnerabilities-2026-05-15.md](docs/plans/active/PLAN-vulnerabilities-2026-05-15.md)** | ✅ **Live 2026-05-15** | npm audit 0 Vulnerabilities. drizzle-orm@0.45.2 (HIGH-Fix GHSA-gpj5-g38j-94v9) + vite@8 + vitest@4 + esbuild-override. |
| Master-Cutover-Plan (cross-repo) | ✅ TIER 0-3 CODE-COMPLETE | [knowledge2/docs/plans/active/PLAN-as3-bigbang.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-as3-bigbang.md) — Tier 4 (Cutover-Window) pending |
| Operator-Runbook | ✅ Live | [knowledge2/docs/runbooks/runbook-as3-cutover.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-as3-cutover.md) — Step-by-Step T-7 bis T+7d |
| **[privat.md](docs/privat.md)** | ✅ **Aktiv 2026-05-17 (Fly-Switch)** | Private-Mode-Setup für approval2 auf **Fly.io** (statt Hetzner) + Shared-Resource-Strategie mit knowledge2, Provider-Switch-Matrix zu Google Cloud (business-mode), Cost-Estimate ~10-13 €/mo vs ~120 €/mo. |

## Was bei Arbeit beachten

**Welcher Branch?** Pre-Cutover ist `main` der V1-Stand und `feat/as3-cutover` der AS-3-Stand. Code-Änderungen die AS-3 anfassen: auf dem Branch. Reine Doc-Änderungen: nach `main`.

**Deploy-Pfade — Realitäts-Check (Stand 2026-05-17):**

- **Fly.io (privat-Mode) — primär.** Code-Ready: `apps/server/src/index.ts:121-175` hat die **5-stufige KEK-Provider-Selection** (CloudKms > AppRole > StaticToken > LocalKek > none — Cloud-KMS ist Default seit 2026-05-17, siehe ADR-0011 + [docs/privat.md §9.3](docs/privat.md)), Auth-Helpers re-exportiert aus `packages/adapters/src/index.ts`. Fly-Configs in `fly.toml` + `deploy/fly/Dockerfile.server` + `deploy/fly/deploy.sh`. **Cloud-KMS-Setup ist 100% TF-managed:** [terraform/environments/privat/gcp-kms.tf](terraform/environments/privat/gcp-kms.tf) legt KeyRing + CryptoKey + Service-Accounts + Doppler-Pipe in einem Apply an (Projekt `axelrogg-ai-tools`, Location `eu` multi-region). OpenBao-Path (`fly.openbao.toml` + `deploy/fly/Dockerfile.openbao` + `terraform/environments/privat-openbao/`) bleibt als alternative Selfhosting-Variante dokumentiert, ist aber nicht aktiv im Default-Plan. Doppler-Werte aus [docs/privat.md §6](docs/privat.md) als Source-of-Truth.
- **GCP Cloud Run (business-Mode) — sekundär, Skeleton-Phase.** `terraform/environments/business/` und `terraform/modules/gcp-mcp-instance/` existieren. Migration Fly→GCP via Doppler-Config-Werte tauschen + redeploy, kein Code-Refactor (Adapter-Factory-Pattern). `CloudKmsKekProvider` ist noch zu implementieren wenn business-Mode angegangen wird.
- **Hetzner-VM (historischer Pfad) — deprecated.** Code in `deploy/hetzner/`, Skripte in `scripts/vm-*`, Runbooks in `docs/runbooks/runbook-hetzner-*` bleiben als Audit-Trail / Notfall-Reset-Material. Switch-Begründung in [docs/privat.md §9.4](docs/privat.md): Solo-Operator-Realismus bei Security-Wartung (OS-Patches, SSH-Hygiene, Reboots) — Fly.io übernimmt die Infrastructure-Layer-Security.
- **Cloudflare Workers — sekundär, ~50% bereit, NICHT für AS-3 deploybar.** [cf/README.md](apps/server/src/cf/README.md) ist ehrlich über die Gaps: D1-Migrations 0002–0010 noch nicht portiert (nur 0001 da, d.h. kein OAuth-DCR, **kein Approval-Flow**, kein Sub-MCP-Gateway), [cf/app-factory-cf.ts:149-161](apps/server/src/cf/app-factory-cf.ts#L149-L161) verkabelt weder `knowledge` noch `kcProxy` (kc_wrappers + PWA-Proxy laufen nicht), R2-BlobAdapter fehlt komplett, keine CF-spezifischen Tests. Nur als Solo-Operator-Pfad ohne KC2 theoretisch wieder-aktivierbar.

Detail-Status in [docs/STATUS.md](docs/STATUS.md).

- **KnowledgeAdapter-Code** (`packages/adapters/src/knowledge/`): auf `feat/as3-cutover` von Bearer-JWT auf OBO + `SERVICE_TOKEN` umgestellt. Neue Methode: `signOBO()` im `JwtSigner`-Interface. `syncUser()` ist neu für UserSync-Push. **ADR-0004 (2026-05-15)**: `ObjectKind` raus. Adapter exportiert `KnowledgeObject.subtype?: string | null`, `CreateObjectArgs.subtype?: string`, `SearchArgs.subtypes?: ReadonlyArray<string>`. Keine `kind`-Werte in Body/Query mehr. Scope ist `objects:read/write` (kind-agnostisch). Wire-Format-Drift gegen KC2 wird durch `tests/contract/manifest-roundtrip.test.ts` + `kc-tools-call.test.ts` fixiert.
- **Apps-Subsystem** (`apps/server/src/apps/api.ts`): **Subtype-Namespacing** `app:<typ>` (z.B. `app:composable`). Helpers `appSubtype()`/`appTypeFromSubtype()`/`isAppObject()` kapseln die Konvention. Read-Guards via `isAppObject(obj)`. **listApps nutzt serverseitig `subtypePrefix='app:'`** (2026-05-15) — kein client-side filter mehr.
- **Tool-Wrappers** (`apps/server/src/tools/`): 4 neue Familien (2026-05-15, Commit `25aed39`):
  - `lists.*` (6 Tools) — Markdown-Checkbox, `validateListBody`-Validator, Toggle via Match-String oder Line-Index
  - `notes.*` (5 Tools) — Free-form Markdown, optional vector-embed
  - `bookmarks.*` (4 Tools) — URL in `meta.url`, Markdown-Body
  - `recipes.*` (5 Tools) — Optional YAML-Frontmatter
  - Konstanten in `tools/types.ts`: `LIST_SUBTYPE`/`NOTE_SUBTYPE`/`BOOKMARK_SUBTYPE`/`RECIPE_SUBTYPE`
- **PWA Subtype-Renderer** (`apps/web/src/renderers/`): 7 dispatch-Renderer (markdown/list/memo/skill-manifest/app-link/binary/code). marked + DOMPurify XSS-safe. `dispatchRenderer(obj)` per `subtype` + `contentType`. Raw-Toggle als Fallback.
- **subtype_prefix Cross-Repo** (2026-05-15): KC2 + Adapter unterstützen `subtype_prefix=app:`-Query für effiziente Namespace-Filter. Apps-Subsystem + PWA nutzen es.
- **OAuth-Facade** (`apps/server/src/mcp/oauth/`): auf `feat/as3-cutover` erweitert um Google-IdP-Redirect-Flow in `authorize.ts`, Token mit `idp=google` + `idp_sub` Claims. Inbound-ID-Token-Verify via `verifyIdToken()` in `apps/server/src/auth/idp/google.ts`.
- **kc-proxy-Route** (`apps/server/src/routes/kc-proxy.ts`): NEU auf `feat/as3-cutover`. PWA → `/admin/kc-proxy/*` → builds OBO from session-user → forwards to KC2.
- **kc_wrappers Auto-Generator** (`apps/server/src/tools/kc_wrappers/`): NEU auf `feat/as3-cutover`. Beim Boot via `tools/list` von KC2, refresh per `*/5 * * * *` cron. Tools fehlen graceful wenn `MCP_KNOWLEDGE_URL` ungesetzt.
- **Approval-Flow**: `ToolContext.approvalId` propagiert via `resumeApproval` durch in den OBO-JWT — KC2-Audit-Trail hat `approval_id` + `via_proxy=true`.
- **`MCP_KNOWLEDGE_URL` optional**: approval2 startet ohne KC2-Anbindung sauber (Native Tools + Gateways verfügbar, KC-Wrappers fehlen).
- **Contract-Tests** (`apps/server/tests/contract/`): Wire-Format zwischen approval2 ↔ KC2 ist hier ausführbar fixiert. Bei Änderungen am OBO-Format / kc_wrappers / kc-proxy: Tests anfassen, sonst bricht der Cutover.
- **Sub-MCP-Gateways** (`apps/server/src/mcp/gateway/`, live 2026-05-17 + erweitert 2026-05-18): zwei Kategorien.

  **A. Satellite-Worker** (eigener Code, auf Cloudflare Workers, Bearer-outer-auth approval2 ↔ Worker). Bisher `seedCfGateways`/`DEFAULT_CF_GATEWAYS` benannt — irreführend weil "CF" auch den offiziellen Cloudflare-MCP meinte. Sprint 2026-05-18 renamed zu `seedSatelliteWorkers`/`DEFAULT_SATELLITE_WORKERS` (Datei `seed_satellites.ts`):

  | Gateway | URL | Env-Var (Doppler) | Tools | Inner-Auth |
  |---|---|---|---|---|
  | `utils` | workers.dev | `SUB_MCP_TOKEN_UTILS` | 8 (now/cal/diagram) | — |
  | `gws` | workers.dev | `SUB_MCP_TOKEN_GWS` | 59 (Google Workspace) | per-User Google-OAuth (shared-app) → `x-google-access-token` |
  | `gcloud` | workers.dev | `SUB_MCP_TOKEN_GCLOUD` | 4 (GCP) | per-User Google-OAuth (shared-app) ODER SA-Key (lokal JWT-Bearer-Grant) → `x-google-access-token` + `x-gcp-project-id` |

  **B. Catalog-OAuth-Server** (externe MCPs, auth_mode='oauth' outer, Datei `seed_oauth_catalog.ts`):

  | Gateway | URL | OAuth-Kind | Notes |
  |---|---|---|---|
  | `cf` | `bindings.mcp.cloudflare.com/sse` | DCR (RFC 7591) | Cloudflare-MCP — approval2 macht auto-Registrierung beim ersten Authorize |
  | `github` | (user-managed) | pre-registered | User legt eigene GitHub-App an + manuelle config; KEIN Catalog-Seed um existing User-Setup nicht zu überschreiben |

  Boot-Sequenz: `seedSatelliteWorkers` + `seedOAuthCatalogServers` (idempotent) → initialer `refreshSubMcpToolCache` (global cache für service_bearer-Server) → `buildSubMcpWrapperTools` (registriert wrapper-tools in Haupt-Registry).

  **Per-User-OAuth-Pipeline** (Sprint 2026-05-18):
  - `user_sub_mcp_config` (Mig 0019) — per-User OAuth-Credentials (KMS-encrypted)
  - `user_sub_mcp_oauth_state` (Mig 0023) — PKCE-State während Authorize-Roundtrip
  - `user_sub_mcp_subscriptions` (Mig 0018) — per-User Server-Aktivierung (sichtbar in PWA, gefiltert in tools/list)
  - `user_sub_mcp_tool_cache` (Mig 0026) — per-User Tool-Set für OAuth-Server (Multi-Tenant-Vorbereitung)
  - `UserServerOAuthService.start/callback` mit kind='dcr'|'pre'|'shared-app'. `shared-app` nutzt env `GOOGLE_WORKSPACE_CLIENT_ID/SECRET` (Fallback: `GOOGLE_CLIENT_ID/SECRET` vom Login-Flow) — Operator-Setup einmalig, refresh-token bleibt per-User.
  - `SubMcpAuthEnricher` mit Strategy `google-oauth-or-sa` (gcloud-Hybrid: SA-JSON Prio, OAuth-Fallback). SA-JSON wird lokal via `services/google/sa-jwt-bearer.ts` in access_token getauscht (Private-Key verlässt approval2 nicht mehr).
  - `refreshUserSubMcpToolCache` für per-User-Discovery; post-OAuth-callback ruft `applyGatewayDiscovery` (rebuilds wrapper-tools live ohne Restart).
  - `tools/list`-Filter in transport.ts: pro User nur subscribed Sub-MCP-Server. Native Tools + KC-Wrapper immer sichtbar.
  - Wrapper-Owner-Check pre-flight: tool/call ohne Subscription → 403 statt 401 vom Worker.
  - Cron `sweep-oauth-state`: TTL für pending oauth_state-Rows (10min) + stale tool_cache-Eintraege (30d).
  - PWA `server-config.ts` zeigt pro kind den passenden Button ("Verbinden mit Google" / "OAuth starten" / "Neu verbinden").

  Tool-Naming: `<gw>.<remote-name>` (z.B. `utils.now`, `gws.calendar.list`, `gcloud.projects.list`, `cf.kv_namespace_list`). Discovery-Refresh: `*/5`-Cron + post-OAuth + admin-rediscover. Worker bleiben auf Cloudflare; ihr SERVICE_TOKEN ist identisch zwischen v1-Hub und approval2 — keine Worker-Code-Änderung außer mcp-gcloud das jetzt `x-google-access-token` zusätzlich akzeptiert (Backwards-kompatibel mit `x-gcp-sa-json`).

## Repo-Struktur (Wiederholung aus README)

```
mcp-approval2/
├── docs/plans/active/   — aktive Implementation-Specs
├── packages/
│   ├── core/            — geteilte Typen, Crypto, Utils
│   └── adapters/        — DbAdapter / BlobAdapter / KekProvider / AiAdapter / KnowledgeAdapter
├── apps/
│   ├── server/          — Hono.js (Postgres oder CF Workers Target)
│   └── web/             — Approval-PWA (vanilla TS + WebAuthn)
├── docker-compose.yml   — lokaler Stack
└── package.json         — npm workspaces root
```

## Tech-Stack

- **Web:** Hono.js (Multi-Runtime via Adapter)
- **DB:** Postgres 16 + pgvector (primary), D1 (CF-Adapter, secondary)
- **ORM:** Drizzle mit Postgres-RLS
- **Auth:** OAuth-2.1 + PKCE + DCR, WebAuthn mit PRF-Extension
- **IdP:** Google OIDC (AS-3, siehe oben)
- **Crypto:** AES-256-GCM, HKDF, Google Cloud KMS (multi-region EU, Master-wrapped-Pattern) — OpenBao bleibt als alternative Selfhosting-Variante im Repo, nicht Default-Pfad seit ADR-0011 (2026-05-17)
- **AI:** Vertex AI (Gemini + text-embedding-005, EU)
- **Lang:** TypeScript strict, `noUncheckedIndexedAccess`

## Test-Strategie

- `npm run test` — alle Workspaces. **Stand 2026-05-16: 711 passed / 1 skipped** (adapters 129+1skip, core 47, server 519, web 16).
- `npm run typecheck` — strict + `noUncheckedIndexedAccess`, clean über alle 4 Workspaces.
- Pilot-Smoke: `bash scripts/pilot-smoke.sh` (lokal gegen `npm run dev`) bzw. `pilot-smoke-hetzner-{local,remote}.sh` gegen Compose-Stack. 3/3 grün am 2026-05-14 vor VM-Destroy.
- **Kein `smoke.sh`-Skript existiert** — Runbook verweist auf das pilot-smoke-Tooling. Ein Pendant zu mcp-approval's `scripts/smoke-prod.sh` (mit Throttle/Retry gegen CF-Rate-Limits) ist offen.

## Branch / Push

- `main` ist Default-Branch
- Branch-Strategie: direkt auf `main`, kleine atomare Commits
- **`[deploy]`-Tag in Commit-Subject ist der einzige Auto-Deploy-Trigger.** `Deploy to Fly.io` UND `Build & Push Container` haben einen Job-Level-Guard
  `if: github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/') || contains(join(github.event.commits.*.message, ' '), '[deploy]')`.
  Ohne `[deploy]`-Tag: Workflow startet kurz, Job skipped sofort — **kein Docker-Build, kein Fly-Deploy**. Erspart Compute + reduziert Lärm in der Actions-UI. (Konvention von mcp-approval v1 übernommen — `commits.*` statt nur `head_commit` fängt Multi-Commit-Pushes ab, bei denen `[deploy]` in einem buried Commit steckt.)
- Manueller Deploy: `gh workflow run deploy-fly.yml` (workflow_dispatch) — z.B. um eine Doku-Korrektur ohne Code-Change zu deployen.
- CI (`ci.yml`) läuft auf jedem Push (Branches: `'**'`) mit `paths-ignore` für `**/*.md`, `docs/**`, `terraform/**`, `deploy/**`, `scripts/**`, `.claude/**`, `.vscode/**` und einige Root-Dotfiles. Atomare Doc-/Plan-/Terraform-/Cosmetic-Pushes triggern damit weder die Postgres+OpenBao-Service-Container noch build/typecheck/lint/test. Concurrency-Cancel-in-progress bleibt als Fallback für rapid-fire-Code-Pushes aktiv.
- Co-Authored-By-Footer für Claude-generierte Commits

### Atomar-Commit-Pattern (gegen parallel laufende Cloud-Agents)

Cloud-Agents arbeiten parallel auf `main` und können staged Files mit-committen wenn das Race-Window offen ist. Pflicht-Sequenz pro Commit als **EIN Bash-Aufruf** mit `&&`-Chain:

```bash
cd /workspaces/mcp-approval2 && \
  git status --short && \                  # 1. fremde Files identifizieren
  git pull --rebase 2>&1 | tail -3 && \   # 2. fast-forward
  git add <file1> <file2> && \             # 3. NUR explizite Files, nie -A/-.
  git diff --cached --stat && \            # 4. sanity-check vor commit
  git commit -m "..." && \                 # 5. atomar
  git push 2>&1 | tail -6                  # 6. sofort raus
```

Sechs Regeln: `cd` immer am Anfang (Shell-State kann reset werden), `pull --rebase` IMMER, explizite Pfad-Liste, `diff --cached --stat` als Pre-Commit-Check, kein Tool-Call zwischen `add` und `commit`, `push` sofort. Bei `push` non-fast-forward: erneut pullen, dann pushen. Niemals `--force` / `--no-verify` / `add -A` / `add .`.

**Cross-Repo-Reihenfolge:** Wenn Feature beide Repos braucht (approval2 + mcp-knowledge2): **KC2 zuerst** vollständig committen+pushen (Producer-Side), **dann approval2** (Consumer-Side). Niemals beide in einer Bash-Sequence.

Volle Memory-Doku: `feedback_cloud_agent_staging_race.md` (auto-Memory). Beobachtete Multi-Repo-Isolation funktioniert: KC2-Build läuft problemlos parallel zu approval2-Cloud-Agent-Work.

## Konventionen

- Plan-Files haben Status-Banner oben (✅ live / ⚠️ Spec / ⚠️ Draft)
- Spec-Files für noch nicht implementierte Architektur-Aspekte: `docs/plans/active/PLAN-<topic>.md`
- ADRs in `docs/adr/` für engere Architektur-Entscheidungen (nicht Plan-Klasse)
- Cross-Repo-Referenzen via GitHub-URL (nicht relative Paths), da Repos separate Working-Copies haben können

## Infrastructure-Policy: alles via Terraform

**Default: Infrastruktur-Änderungen werden in `terraform/` gemacht, NICHT im Dashboard.**

Gilt für: Cloudflare-Resources (DNS, AI Gateway, API-Tokens, Workers, Rulesets,
Zone-Settings, Cert-Packs, R2-Buckets), Hetzner-Resources (VM, Volumes, Firewall,
Networks), Doppler-Project/Configs/Placeholders/Secrets, GitHub-Repo-Settings +
Secrets, Google Cloud Resources (Cloud-Run/SQL/GCS für Phase-2).

`terraform/environments/privat/` ist der Root für die Single-Tenant-Instance —
auch für das Schwester-Repo `mcp-knowledge2` (Doppler-Project, AI Gateway,
DNS-Records, Tokens). KC2 hat **keinen eigenen TF-State**; alles läuft hier.

**Workflow:**
1. Datei unter `terraform/environments/privat/*.tf` (oder neues Modul unter
   `terraform/modules/`) editieren
2. `bash scripts/doppler-run-terraform.sh plan -target=... -out=/tmp/x.tfplan`
3. User reviewed Diff
4. `bash scripts/doppler-run-terraform.sh apply /tmp/x.tfplan`
5. Live verifizieren (`curl`, Dashboard-Stichprobe)
6. Commit + push

**Anti-Reflex-Test:** Wenn du gerade Dashboard-Klicks aufschreibst ("CF-Dashboard
→ ...", "Doppler-UI → ...", "Hetzner-Console → ..."): stop, prüfe ob es einen
TF-Provider dafür gibt. Token-Werte und Geheimnisse können meist via TF-Resource-
Outputs direkt in Doppler-Secrets gepiped werden — kein Copy-Paste durch den
User nötig.

**Dokumentierte Ausnahmen** (Dashboard-Pfad legitim):
- Provider unterstützt die Ressource nicht (z.B. CF AI Gateway Authentication
  Token ist gateway-intern, kein eigenes TF-Resource — fallback: Authenticated=false)
- Einmalige Operations-Tasks (Token-Revoke, Cache-Purge, Notfall-Toggle)
- Out-of-Band-Resources die in `terraform/README.md` so markiert sind
