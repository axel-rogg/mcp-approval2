# Runbook: Pilot-Smoke

**Status:** Draft (Phase 7 Pilot-Readiness)
**Last update:** 2026-05-13
**Plan-Reference:** [PLAN-architecture-v1.md](../plans/active/PLAN-architecture-v1.md) §11 Phase 7
**Audience:** Operator / Engineer — vor jedem Pilot-Deploy + nach jedem mcp-approval2-Release

Ziel: Sicherstellen, dass ein frischer mcp-approval2-Stack lokal/staging end-to-end laeuft, bevor wir
Tenant-Daten anfassen.

Dieses Runbook hat **drei Test-Schichten**:

1. **Layer 1 — In-Memory Integration**: vitest gegen Stub-DB. ~5 s.
2. **Layer 2 — Docker-Compose-Smoke**: realer Stack (postgres + openbao + minio) ohne externe APIs. ~60 s.
3. **Layer 3 — Testcontainers (Optional)**: realer Postgres im Test-Prozess. ~30 s, braucht Docker.

Vor einem Pilot-Cutover: **alle drei** muessen gruen sein.

---

## 1. Voraussetzungen

- **Node 22+** (siehe `.nvmrc`)
- **Docker** + `docker compose` v2 (fuer Layer 2 + 3)
- **`.env.local`** mit minimalen Dev-Werten (kopieren von `.env.example`)
  - `MCP_APPROVAL_INTERNAL_TOKEN=dev-internal-token` (sonst werden /internal/v1/* nicht gemounted)
  - `JWT_SECRET=<32+ char>`
  - `KEK_PROVIDER=local` (oder `openbao` wenn der Stack laeuft)
- **`npm ci`** ausgefuehrt im Repo-Root

---

## 2. Layer 1 — In-Memory Integration (immer)

```bash
npm -w apps/server run test -- tests/integration/pilot-smoke.test.ts
```

Was wird geprueft:
- `/health` antwortet 200
- `/.well-known/oauth-authorization-server` ist public
- `/.well-known/jwks.json` ist public (leer in Dev = OK)
- `/mcp` ohne Bearer → 401
- `/internal/v1/dek/resolve` ohne Service-Token → 401, **mit** Service-Token → 200 + `dek_b64` (32 bytes)
- `/internal/v1/dek/resolve` akzeptiert sowohl `Authorization: Bearer` als auch `X-Service-Token`
- `/internal/v1/credentials/resolve` ohne Service-Token → 401
- Ohne `internalServiceToken` werden `/internal/v1/*`-Routes **nicht** gemounted (404)
- Bearer-gated Routes (`/v1/approvals`, `/v1/credentials`) → 401 ohne Bearer

Soll-Dauer: < 10 s. Bei Fail erst hier debugn — die anderen Schichten sind teurer.

---

## 3. Layer 2 — Docker-Compose-Smoke (vor jedem Release)

```bash
bash scripts/pilot-smoke.sh
```

Was passiert:

1. `docker compose up -d` (postgres, openbao, minio + minio-init)
2. Warten auf `postgres`-Healthcheck
3. `npm -w apps/server run db:migrate`
4. `npm -w apps/server run dev` im Background (boot Hono-Server auf :8787)
5. HTTP-Smoke gegen 6 Endpoints (Liste siehe Skript)
6. Server runterfahren, exit 0/1

Env-Vars:

| Var | Default | Zweck |
|---|---|---|
| `MCP_APPROVAL_BASE_URL` | `http://localhost:8787` | Zielserver |
| `MCP_APPROVAL_INTERNAL_TOKEN` | `dev-internal-token` | Service-Token fuer /internal/v1/* |
| `PILOT_SMOKE_SKIP_COMPOSE` | unset | Stack nicht hoch/runter-fahren (CI-Runner) |
| `PILOT_SMOKE_SKIP_SERVER` | unset | Server-Boot ueberspringen (CI-Runner hat eigene Service) |
| `PILOT_SMOKE_DEEP` | unset | Zusatztest mit gueltigem Service-Token (haengt von KEK-Setup ab) |

Soll-Dauer: 60-90 s (Container-Boot dominiert).

### Bei Fail

Logs:
- Server: `tail -100 /tmp/pilot-smoke-server.log`
- Container: `docker compose logs postgres`, `docker compose logs openbao`

Haeufige Probleme:
- **`/health` antwortet nicht**: Migrate failed? `npm -w apps/server run db:status` zeigt Stand.
- **`/internal/v1/dek/resolve` ist 401 trotz richtigem Token**: `MCP_APPROVAL_INTERNAL_TOKEN` fehlt im
  Server-Boot-Env. Skript exportiert es, aber Verifikation: `curl localhost:8787/health` reicht nicht — das
  Mount-Logging in der Server-Log checken (`'INTERNAL_SERVICE_TOKEN not set'`).
- **`docker compose up`-Fehler "port already in use"**: anderer Postgres laeuft auf :5432. `docker ps`,
  killen oder `docker-compose.yml` editieren.

---

## 4. Layer 3 — Testcontainers (CI, Optional)

```bash
# 1. Devdep installieren (einmalig pro Devmaschine / CI-Image)
npm i -D @testcontainers/postgresql testcontainers

# 2. Test laufen lassen
PILOT_SMOKE_TESTCONTAINERS=1 npm -w apps/server run test -- scripts/pilot-smoke.test.ts
```

> ⚠ Ohne das Flag wird der Test **geskippt** (`describe.skip`). So bleibt die normale Test-Suite schnell.

Was passiert:
- `pgvector/pgvector:pg16` als ephemerer Container gestartet
- Connection-URI an Drizzle uebergeben
- Migrate + Smoke-Test gegen real-DB

Soll-Dauer: 30-60 s (Pull beim ersten Mal: +60 s).

---

## 5. CI-Setup (GitHub-Actions)

Beispiel-Step im Workflow:

```yaml
- name: Layer 1 — In-Memory Integration
  run: npm -w apps/server run test -- tests/integration/pilot-smoke.test.ts

- name: Layer 2 — Docker-Compose-Smoke
  run: bash scripts/pilot-smoke.sh
  env:
    MCP_APPROVAL_INTERNAL_TOKEN: ${{ secrets.PILOT_INTERNAL_TOKEN_CI }}

- name: Layer 3 — Testcontainers (Optional, daily)
  if: ${{ github.event_name == 'schedule' }}
  run: PILOT_SMOKE_TESTCONTAINERS=1 npm -w apps/server run test -- scripts/pilot-smoke.test.ts
```

Daily-Cron empfehlenswert fuer Layer 3 — Pull-Cost amortisiert sich nicht pro Commit.

---

## 6. Vor einem Pilot-Cutover

1. Alle drei Layer **gegen Pilot-Staging** mit echten Secrets gruen
2. `runbook-pilot-onboarding.md` Checklist abgearbeitet
3. Sub-MCP-Worker (gws, utils, cf, ...) migriert nach
   [sub-mcp-server-migration-guide.md](../migration/sub-mcp-server-migration-guide.md)
4. Token-Rotation-Plan steht (`runbook-token-rotation.md`)

---

## 7. Troubleshooting Quick-Lookup

| Test schlaegt fehl | Wahrscheinlichste Ursache |
|---|---|
| `/health` 200 → not reached | Server-Boot, Port-Konflikt, db:migrate failed |
| `/.well-known/jwks.json` 500 | PEM mal-formatted in `JWT_RS256_PUBLIC_KEY_PEM` |
| `/internal/v1/dek/resolve` 401 mit korrektem Token | `MCP_APPROVAL_INTERNAL_TOKEN`-Env fehlt im Server-Prozess |
| `/internal/v1/dek/resolve` 500 | KEK-Provider down (OpenBao sealed o.ae.) |
| `/mcp` POST 200 obwohl ohne Bearer | Auth-Middleware nicht gemounted — createApp regressed |
| Tests in `pilot-smoke.test.ts` 404 statt 401 | `internalServiceToken` wurde nicht im Test-Setup gesetzt |

---

## 8. Referenzen

- Skript: [scripts/pilot-smoke.sh](../../scripts/pilot-smoke.sh)
- Vitest (in-memory): [apps/server/tests/integration/pilot-smoke.test.ts](../../apps/server/tests/integration/pilot-smoke.test.ts)
- Vitest (testcontainers, optional): [scripts/pilot-smoke.test.ts](../../scripts/pilot-smoke.test.ts)
- Migration-Guide fuer Sub-MCP-Worker: [docs/migration/sub-mcp-server-migration-guide.md](../migration/sub-mcp-server-migration-guide.md)
