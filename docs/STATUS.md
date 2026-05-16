# Status: mcp-approval2 (2026-05-17, Fly.io-Switch von Hetzner)

> Snapshot vor dem Fly-Erst-Deploy. Branch `feat/as3-cutover` enthält die
> letzten Wellen seit dem 14.05. Pilot-Destroy:
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
> [privat.md](privat.md) — kanonische Fly.io-Architektur-Wahrheit.

## Test-Baseline (lokal, 2026-05-16)

| Workspace | Tests | Anmerkung |
|---|---|---|
| `packages/adapters` | 129 passed, 1 skipped | inkl. OpenBao AppRole + StaticToken + Knowledge-Client |
| `packages/core` | 47 passed | crypto, AAD, types |
| `apps/server` | 519 passed | Routes, Services, Tools, Cron-Dispatcher, kc_wrappers, contract-Tests gegen KC2-Wire |
| `apps/web` | 16 passed | PWA-Renderer-Dispatch + WebAuthn-PRF-Service |
| **Total** | **711 passed, 1 skipped** | `npm run typecheck` clean über alle Workspaces |

## Deploy-Status (2026-05-17, pre-Fly-Deploy)

**Aktuell:** Hetzner-VM destroyed seit 2026-05-14, Fly.io-Stack vorbereitet
aber noch nicht deployed. Cost-aktuell **0 EUR/Tag**.

| Komponente | Status | Anmerkung |
|---|---|---|
| Terraform-State (R2-Backend EU) | ✅ intakt | module.doppler + module.github + cloudflare_zone bleibt; Hetzner-Module wird in Phase 6 entfernt |
| Fly.io-Apps (`mcp-approval2`, `mcp-approval2-pg`, `mcp-approval2-openbao`) | ⏳ vorbereitet, nicht deployed | `fly.toml` + `fly.openbao.toml` + `deploy/fly/deploy.sh` ready. Aktivierung via `bash deploy/fly/deploy.sh`. |
| Hetzner-VM `privat-mcp` | ❌ destroyed (historisch) | seit 2026-05-14 |
| Cloudflare-DNS-Records (mcp2/app2 A+AAAA) | ❌ destroyed | wird durch CNAME → `mcp-approval2.fly.dev` ersetzt (via `fly certs add` + manuell in CF Dashboard oder terraform) |
| Cloudflare-Zone `ai-toolhub.org` | ✅ intakt | data-block-Reference, war nie terraform-owned |
| Cloudflare AI Gateway `knowledge2-kc2` | ✅ live | seit 2026-05-14, EU-Region |
| Cloudflare R2 Buckets (4 stück) | ⏳ zu erstellen | `mcp-approval2-blob` + `mcp-approval2-backup` (+ knowledge2 Pendants) via Terraform |
| Doppler-Project `mcp-approval2/privat` | ⏳ Werte umzustellen | Hetzner-spezifische Werte (VAULT_ADDR Compose-DNS, BASE_URL mcp2-A-record) auf Fly-Werte (.internal-DNS, fly.dev-URL bzw. Custom-Domain) |
| Doppler-Project `mcp-approval2/business` (GCP-Phase-2) | ⚠️ Stub | TF-Module liegt, GCP-Resources sind Placeholder |
| Doppler-Service-Tokens (VM + GH-Actions) | ✅ intakt | weiter gültig für neue VM |
| GitHub-Repo Settings + Branch-Protection | ✅ intakt | DOPPLER_TOKEN_GHA + hetzner-production env unangetastet |
| Docker-Volumes auf der VM | ❌ destroyed | pgdata, vault-data, caddy-data alle weg (Pilot war leer, kein Daten-Verlust) |
| OpenBao Root-Token + Unseal-Keys (alte) | ⚠ unbrauchbar | Vault-Daten weg → alte Keys können nichts mehr entschlüsseln. Beim Re-Provisioning werden NEUE generiert. |

**Restart-Pfad:** [runbook-vm-destroy-recreate.md](runbooks/runbook-vm-destroy-recreate.md) +
[scripts/vm-destroy-recreate.sh](../scripts/vm-destroy-recreate.sh) ohne
`destroy`-Phase (= Steps 5–17). Geschätzte Restart-Zeit: 15–22 min
inklusive Let's-Encrypt-Cert-Issuance.

## Deploy-Pfade — Realitäts-Check

### Self-Host (Hetzner + Postgres + OpenBao) — primär, ~95% bereit

Verkabelt + gegen den Pilot getestet (14.05.):

- [fly.toml](../fly.toml) (sek. Self-Host-Variante) + [fly.openbao.toml](../fly.openbao.toml) — Fly-Apps `mcp-approval2` + `mcp-approval2-openbao`, Postgres via `fly postgres attach`.
- [deploy/hetzner/docker-compose.yml](../deploy/hetzner/docker-compose.yml) — 5 Services im `internal` Bridge-Netz: `postgres` (pgvector/pg16), `openbao`, `mcp-approval2`, `mcp-knowledge2`, `caddy`, plus `watchtower` für Auto-Update.
- [terraform/environments/privat/](../terraform/environments/privat/) provisioniert Hetzner-VM + Cloudflare-DNS + Doppler-Project + AI Gateway.
- 10 Postgres-Migrations (0001-0010) komplett.
- Cron-Architektur: **External-Scheduler-Pattern** ([cron/index.ts](../apps/server/src/cron/index.ts)) — keine in-process-Cron, statt-dessen HTTP-POST `/internal/v1/cron/:task`. systemd-timer / k8s-CronJob / GH-Actions triggert.

**Verbleibender Code-Gap (~5%, OpenBao-Wiring):**

- [apps/server/src/index.ts:119-127](../apps/server/src/index.ts#L119-L127) warnt noch: `"VAULT_ADDR set but OpenBao boot-path is not yet wired through @mcp-approval2/adapters (need StaticTokenAuth re-export). Falling back to no-credentials-mode."`
- Reality: `StaticTokenAuth`, `AppRoleAuth`, `VaultAuthError` existieren in [packages/adapters/src/kek/openbao-auth.ts](../packages/adapters/src/kek/openbao-auth.ts) und sind voll getestet (`packages/adapters/src/kek/openbao.test.ts` — 26 Tests). Sie werden nur nicht aus [packages/adapters/src/index.ts](../packages/adapters/src/index.ts) re-exportiert.
- **Workaround (aktueller Pilot-Pfad):** `MASTER_KEY_BASE64` in Doppler → `LocalKekProvider`-Branch greift. Funktional, aber das Threat-Model verschiebt sich (Master-Key liegt in Doppler statt in Vault).
- **One-Liner-Fix:** 3 Re-Exports im Adapter-Index + Wiring-Branch im Boot.

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

## Security-Follow-Ups (Pflicht vor Re-Production)

Im aktuellen Session-Transcript exponierte Tokens. Müssen rotiert werden
**bevor** das System wieder produktiv genutzt wird:

| Token | Wo | Rotation |
|---|---|---|
| Vault Root-Token `s.DGRR2JbFZneufIjHEQZJFZ1r` | `/opt/mcp-approval2/.vault-init-output.json` (VM, chmod 600) + Doppler `VAULT_TOKEN` — VM gerade weg, Token aber im Transcript erhalten. Beim Re-Provisioning neu erzeugt. | `bao token create -policy=root` → neuer Token, alter via `bao token revoke` |
| 3 Vault Unseal-Keys | gleiches File | `bao operator rekey -init -key-shares=3 -key-threshold=2`, neue Keys offline, alte vernichten |
| Doppler Personal-Token (`dp.pt....`) | `.dev.vars` lokal | Dashboard → Profile → Tokens → revoke + new |

## Roadmap bis Pilot-Production

### P0 — Blocker für einen Re-Deploy

1. **AS-3-Cutover-Day** im Schwester-Repo durchziehen — Operator-Runbook `knowledge2/docs/runbooks/runbook-as3-cutover.md`. Tier 4 (Cutover-Window) ist der letzte verbleibende Schritt.
2. **VM-Re-Provisioning** wenn der Pilot wieder live soll: `terraform apply` aus `terraform/environments/privat/` → 11 Ressourcen werden re-created. Restart-Steps in [runbook-vm-destroy-recreate.md](runbooks/runbook-vm-destroy-recreate.md).

### P1 — Code-Gaps für saubere Self-Host-Production

3. **OpenBao-Auth-Export.** [packages/adapters/src/index.ts](../packages/adapters/src/index.ts) muss `StaticTokenAuth`, `AppRoleAuth`, `VaultAuthError` re-exportieren, und [apps/server/src/index.ts:119-134](../apps/server/src/index.ts#L119) muss den OpenBao-Branch aktivieren statt nur zu warnen. **Bis dahin:** Pilot läuft mit `MASTER_KEY_BASE64` in Doppler (Workaround dokumentiert in `deploy/hetzner/setup.sh`).
4. **Token-Rotation** vor dem nächsten Apply (siehe §Security-Follow-Ups).
5. **`smoke.sh`-Pendant für Production** (gibt es nur als `pilot-smoke-hetzner-{local,remote}.sh` + `pilot-smoke.sh`/`pilot-smoke.test.ts` — Pendant zu mcp-approval's `scripts/smoke-prod.sh` mit Throttle-/Retry-Logik fehlt).

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
