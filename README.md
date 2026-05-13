# mcp-approval2

> **Status: Phase 0 in Aufbau (2026-05-13)** — Greenfield-Replacement fuer
> [mcp-approval](https://github.com/axel-rogg/mcp-approval) als Multi-User-
> faehiger MCP-Approval-Server mit portabler Runtime.

## Was das ist

mcp-approval2 ist ein **Model Context Protocol (MCP) Server** mit:

- **Multi-User von Tag 0** — 5-15 User pro Pilot-Instance, strikte
  User-Isolation via Postgres-RLS + App-Layer-Repository-Pattern
- **Portable Runtime** — Adapter-Layer fuer Postgres-Self-Host (Primary)
  und Cloudflare Workers (Sekundaer)
- **Maximum-Hardening fuer Credentials** — OpenBao Envelope-Encryption +
  WebAuthn-PRF-Layer, Operator-Compromise-resistant
- **OAuth 2.1 + PKCE + RFC 8707** MCP-Spec-konform (Nov 2025)
- **WYSIWYS Approval-Flow** mit Push-Notification-PWA fuer State-modifying
  Tools
- **DSGVO/Compliance-tauglich** — Crypto-Shredding fuer Right-to-Erasure,
  immutable Audit-Log, EU-Region-Datenresidenz

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
- `http://localhost:8787` — MCP-Server + PWA
- `http://localhost:5432` — Postgres
- `http://localhost:8200` — OpenBao UI

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
| Phase 0 | in Aufbau | Skeleton, Tooling, Crypto, ADRs, CI |
| Phase 1 | geplant | Auth, Sessions, WebAuthn, Invite-Flow |
| Phase 2 | geplant | OpenBao + Credentials + PRF |
| Phase 3 | geplant | mcp-knowledge2 Service-Boundary |
| Phase 4 | geplant | MCP-Protocol + Tool-Surface |
| Phase 5 | geplant | Sub-MCP-Migration (cf/github/gws/gcloud/utils) |
| Phase 6 | geplant | Rate-Limit + GDPR-Tools + Pilot-Hardening |

Detail in [PLAN-architecture-v1.md](docs/plans/active/PLAN-architecture-v1.md).

## Licensing

TBD. Lehnt sich an mcp-approval an, finale Wahl in Phase 6.
