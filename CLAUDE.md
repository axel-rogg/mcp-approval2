# mcp-approval2 — Kontext für Claude Code

> **Greenfield-Successor** zu [mcp-approval](https://github.com/axel-rogg/mcp-approval) (Cloudflare-Workers, single-user).
> Multi-User von Tag 0 (5-15 User pro Pilot-Instance), Postgres + OpenBao, EU-Region, DSGVO-tauglich.
> Schwester-Repo: [mcp-knowledge2](https://github.com/axel-rogg/mcp-knowledge2) (Storage + Search).

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
   │  • Credentials-Vault (OpenBao Transit)         │
   │  • PWA (Approval-Display, Storage-Tab)         │
   │  • DCR-OAuth-Facade für MCP-Clients            │
   └─────────────────────┬──────────────────────────┘
                         │  S2S: X-On-Behalf-Of + SERVICE_TOKEN
                         ▼
                  mcp-knowledge2 (separate Repo)
                  Storage / Sharing / Hybrid-Search
```

**Single-Tenant strikt**: 1 Firma = 1 Instance. Zweite Firma = fork und neue Instance.
**Identity-Provider (Ziel-Architektur AS-3)**: Google OIDC. mcp-approval2 ist Resource-Server, betreibt aber eine DCR-OAuth-2.1-Facade für Claude.ai-MCP-Clients (weil Google kein DCR anbietet).

## Plan-Index

Status-Banner oben in jedem PLAN-File.

| Plan | Status | Zweck |
|---|---|---|
| [PLAN-architecture-v1.md](docs/plans/active/PLAN-architecture-v1.md) | ✅ Decisions complete, Phase 0-6 dokumentiert | 22-Decisions-Baseline aus Session 2026-05-13 |
| [PLAN-architecture-v0.md](docs/plans/active/PLAN-architecture-v0.md) | Vorgänger | Subagent-Recherche, Pattern-Options |
| [PLAN-hetzner-deployment.md](docs/plans/active/PLAN-hetzner-deployment.md) | ⚠️ Spec | Multi-Instance auf Hetzner + GCP |
| **[PLAN-as3-autonomous.md](docs/plans/active/PLAN-as3-autonomous.md)** | ⚠️ **SPEC (2026-05-15)** | **AS-3-Migration: approval2 als Proxy vor autonomem KC2**. Definiert OBO-Pattern, KnowledgeAdapter-Umstellung, kc-proxy-Route, KC-Tool-Auto-Wrapper. Lies das _vor_ Auth-/KC-Adapter-Arbeit. |
| Master-Cutover-Plan (cross-repo) | ⚠️ SPEC | [mcp-knowledge2/docs/plans/active/PLAN-as3-bigbang.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-as3-bigbang.md) — Ein-Wurf-Reihenfolge für AS-3-Cutover beider Repos. |

## Was bei Arbeit beachten

- **KnowledgeAdapter-Code** (`packages/adapters/src/knowledge/`): aktuell auf v1-Pattern (JwtSigner → Bearer-JWT direkt an KC2). Bei jeder Änderung **erst** [PLAN-as3-autonomous.md §1.2](docs/plans/active/PLAN-as3-autonomous.md) lesen — das Pattern wechselt zu OBO + SERVICE_TOKEN. Keine neuen Calls im alten Pattern hinzufügen.
- **OAuth-Facade** (`apps/server/src/mcp/oauth/`): existiert bereits (Discovery, DCR, Authorize, Token, JWKS, Revoke). AS-3 erweitert das um Google-IdP-Redirect-Step in `authorize.ts` und `idp=google`-Claims in `token.ts`.
- **Approval-Flow + State-Changing Tools**: Approval-Resolver muss `approval_id` im OBO-JWT setzen damit KC2-Audit den Trail sehen kann (siehe §1.5 + 2.1 im AS-3-Spec).
- **`MCP_KNOWLEDGE_URL` optional**: approval2 muss auch ohne KC2-Anbindung sauber starten (Native Tools + Gateways verfügbar, KC-Wrappers fehlen).

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
- **Crypto:** AES-256-GCM, HKDF, OpenBao Transit-Engine
- **AI:** Vertex AI (Gemini + text-embedding-005, EU)
- **Lang:** TypeScript strict, `noUncheckedIndexedAccess`

## Test-Strategie

- `npm run test` — alle Workspaces (148+ Tests grün als Baseline aus PLAN v1)
- `npm run typecheck` — strict + `noUncheckedIndexedAccess`
- `bash scripts/smoke.sh` — Layer-2 E2E (siehe scripts/)
- Pilot-Smoke: 3/3 grün am 2026-05-14 (VM später destroyed, Doppler+GH intakt)

## Branch / Push

- `main` ist Default-Branch
- Branch-Strategie: direkt auf `main`, kleine atomare Commits
- `[deploy]`-Tag in Commit-Subject **nur** wenn Runtime tatsächlich deployed werden soll (Pilot heute idle)
- Co-Authored-By-Footer für Claude-generierte Commits

## Konventionen

- Plan-Files haben Status-Banner oben (✅ live / ⚠️ Spec / ⚠️ Draft)
- Spec-Files für noch nicht implementierte Architektur-Aspekte: `docs/plans/active/PLAN-<topic>.md`
- ADRs in `docs/adr/` für engere Architektur-Entscheidungen (nicht Plan-Klasse)
- Cross-Repo-Referenzen via GitHub-URL (nicht relative Paths), da Repos separate Working-Copies haben können
