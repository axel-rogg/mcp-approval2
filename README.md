# mcp-approval2

> **Status 2026-05-17 abend: Family-Hardening LIVE** (Commit 95e1997 auf
> main). Threat-Modell auf **drei Deployment-Szenarien** umgestellt:
> **Familie im Haushalt** (primär, Art. 2(2)c DSGVO greift),
> **Self-Host für Freunde** (jeder eigene Instance, Axel raus aus
> DSGVO-Kette), **Corporate-GCP-VPC** (eigenes 4-6 Wochen Compliance-
> Programm). Code-Hardening: `securityHeaders()` + `originCheck()`
> Middleware + `BOOTSTRAP_ADMIN_EMAIL` fail-CLOSED in production. Details
> in [THREAT-MODEL.md](THREAT-MODEL.md) +
> [docs/runbooks/runbook-family-hardening.md](docs/runbooks/runbook-family-hardening.md).
>
> AS-3 code-complete + Generic-Object-Model (2026-05-15) lief auf Branch
> `feat/as3-cutover`; Pilot-Deploy seit 2026-05-17 live auf Fly.io.
> Operator-Runbook im Schwester-Repo
> [knowledge2/docs/runbooks/runbook-as3-cutover.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-as3-cutover.md).
>
> Greenfield-Replacement fuer
> [mcp-approval](https://github.com/axel-rogg/mcp-approval) als
> Multi-User-faehiger MCP-Approval-Server mit portabler Runtime.

## Was das ist

mcp-approval2 ist ein **Model Context Protocol (MCP) Server** mit:

- **Multi-User-tauglich** — strikte User-Isolation via Postgres-RLS +
  App-Layer-Repository-Pattern. Im **Familie-Modus** (primär seit
  2026-05-17) auf 2-5 Personen ausgelegt; Multi-User-Tier-1-Infrastruktur
  (Invite/Outbox/Admin-Tab) bleibt als Defense-in-Depth + Self-Host-
  Default für Freunde.
- **Portable Runtime** — Adapter-Layer fuer Postgres-Self-Host (Primary)
  und Cloudflare Workers (Sekundaer)
- **Maximum-Hardening fuer Credentials** — OpenBao Envelope-Encryption
  (alternative Selfhosting-Variante) bzw. Google Cloud KMS (Default seit
  ADR-0011) + WebAuthn-PRF-Layer, Operator-Compromise-resistant
- **OAuth 2.1 + PKCE + RFC 8707** MCP-Spec-konform (Nov 2025)
- **WYSIWYS Approval-Flow** mit Push-Notification-PWA fuer State-modifying
  Tools
- **DSGVO-tauglich für Pilot- und Corporate-Modus** (Crypto-Shredding,
  Audit-Log, EU-Region-Datenresidenz). Familie-Modus nutzt Art. 2(2)c-
  Ausnahme — DSGVO-Compliance ist Defense-in-Depth, keine Pflicht.

## Architektur

Zwei-Repo-Setup:

| Repo | Verantwortung |
|---|---|
| **mcp-approval2** (dieses Repo) | Auth, Sessions, Approval-Flow, Tool-Surface, Credential-Vault |
| **mcp-knowledge2** (Schwester-Repo) | Storage fuer Docs/Skills/Apps/Memos, Sharing, Hybrid-Search |

Service-Boundary via signiertem JWT (mcp-approval2 ist OAuth-2.1-Issuer,
mcp-knowledge2 ist Resource-Server). Vollstaendige Architektur in
[docs/plans/active/PLAN-architecture-v1.md](docs/plans/active/PLAN-architecture-v1.md).

## Quickstart (Development)

```bash
# Voraussetzung: Node 20+, Docker, Docker Compose

# 1. Repo + Dependencies
git clone https://github.com/axel-rogg/mcp-approval2
cd mcp-approval2
npm install

# 2. Local Stack (Postgres + pgvector + OpenBao)
docker compose up -d

# 3. Migrations
npm run db:migrate

# 4. Dev-Server
npm run dev
```

Default-Endpoints (Dev):
- `http://localhost:8787` — MCP-Server + PWA (Hono.js auf Node)
- `http://localhost:5432` — Postgres 16 + pgvector
- `http://localhost:8200` — OpenBao API (Vault-fork, dev-mode in `docker-compose.yml`)
- `http://localhost:9001` — MinIO Console (S3-Local-Substitute, Login `minioadmin/minioadmin`)

## Project Layout

```
mcp-approval2/
├── docs/
│   ├── adr/                — Architecture Decision Records
│   └── plans/active/       — Detailed implementation plans
├── packages/
│   ├── core/               — Shared types, crypto, utils
│   └── adapters/           — DbAdapter / BlobAdapter / KekProvider / AiAdapter
├── apps/
│   ├── server/             — Hono.js HTTP server (Postgres or CF Workers)
│   └── web/                — Approval PWA (vanilla TS + WebAuthn)
├── docker-compose.yml      — Local development stack
└── package.json            — npm workspaces root
```

## Tech-Stack

- **Web:** Hono.js (multi-runtime)
- **DB:** Postgres 16 + pgvector (primary), D1 (Cloudflare adapter)
- **ORM:** Drizzle (with Postgres-RLS)
- **Auth:** OAuth 2.1 + PKCE, WebAuthn with PRF-Extension
- **Crypto:** AES-256-GCM, HKDF, OpenBao Transit-Engine
- **AI:** Google Vertex AI (Gemini + text-embedding-005, EU-Region)
- **Lang:** TypeScript strict + `noUncheckedIndexedAccess`

## Status

| Phase | Status | Inhalt |
|---|---|---|
| Phase 0–6 | ✅ Single-shot baseline (2026-05-13) | Skeleton+Auth+Credentials+Tools+Sub-MCP+GDPR |
| Pilot-Deploy | ✅ live verifiziert (2026-05-14) | 3/3 Smoke grün auf Hetzner CX22 (Postgres+OpenBao+approval2+knowledge2+Caddy), danach VM-destroyed (Restart via `terraform apply`) |
| AS-3 | ✅ Code-complete (2026-05-15) | Cross-Service-Auth (OBO + Service-Token), Google OIDC, DCR-OAuth-Facade |
| ADR-0004 | ✅ Implemented (2026-05-15) | Generic Object Model: subtype free-form statt kind-enum, app:-Namespacing, Tool-Wrappers (lists/notes/bookmarks/recipes), PWA Subtype-Renderer |
| Vulnerabilities | ✅ Patched (2026-05-15) | drizzle-orm HIGH SQL-injection gefixt, vite+vitest@8/4, esbuild override |
| Tests | ✅ 711 passed / 1 skipped (2026-05-16) | adapters 129+1skip · core 47 · server 519 · web 16 — typecheck strict clean |
| Cutover-Day | ⏳ pending | Operator-Runbook in knowledge2 |
| CF-Deploy-Pfad | ⚠️ ~50%, blockiert für AS-3 | nur D1-Migration 0001 portiert (kein Approval-Flow), kc-proxy/kc_wrappers nicht verkabelt, R2-Adapter fehlt — siehe [STATUS.md](docs/STATUS.md) |

**Aktuelle Tool-Familien** (`apps/server/src/tools/`):
- `docs.*` (subtype=`doc`) — Markdown/Code/Binary mit summary+embed
- `skills.*` (subtype=`skill_manifest`) — YAML-Frontmatter Skills mit Resource-Refs
- `apps.*` (subtype=`app:<typ>`) — Composable-Apps mit CAS-State
- `memorize.*` (subtype=`memo`) — Atomare Facts, semantic recall
- `lists.*` (subtype=`list`) — Markdown-Checkbox-Liste mit tick/untick
- `notes.*` (subtype=`note`) — Free-form Markdown
- `bookmarks.*` (subtype=`bookmark`) — URL + Notes
- `recipes.*` (subtype=`recipe`) — YAML-Frontmatter Rezepte

Detail in [PLAN-architecture-v1.md](docs/plans/active/PLAN-architecture-v1.md)
+ [PLAN-wrapper-conventions.md](docs/plans/active/PLAN-wrapper-conventions.md).

## Licensing

TBD. Lehnt sich an mcp-approval an, finale Wahl in Phase 6.
