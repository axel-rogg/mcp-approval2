# mcp-approval2 — Kontext für Claude Code

> **Greenfield-Successor** zu [mcp-approval](https://github.com/axel-rogg/mcp-approval) (Cloudflare-Workers, single-user).
> Multi-User von Tag 0 (5-15 User pro Pilot-Instance), Postgres + OpenBao, EU-Region, DSGVO-tauglich.
> Schwester-Repo: [mcp-knowledge2](https://github.com/axel-rogg/mcp-knowledge2) (Storage + Search).
>
> **Status 2026-05-15:** AS-3-Code-Complete auf Branch `feat/as3-cutover`
> (14 Commits, 645 Tests grün). Cutover-Day pending — Runbook im Schwester-Repo:
> [knowledge2/docs/runbooks/runbook-as3-cutover.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-as3-cutover.md).

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
**Identity-Provider (AS-3, Code-Complete 2026-05-15)**: Google OIDC. mcp-approval2 ist Resource-Server gegenüber Google, betreibt seine DCR-OAuth-2.1-Facade unter `apps/server/src/mcp/oauth/` für Claude.ai-MCP-Clients (mit `idp=google`-Claim in Tokens). S2S an KC2 via OBO-JWT + `SERVICE_TOKEN`.

## Plan-Index

Status-Banner oben in jedem PLAN-File.

| Plan | Status | Zweck |
|---|---|---|
| [PLAN-architecture-v1.md](docs/plans/active/PLAN-architecture-v1.md) | ✅ Decisions complete (§3 Identity erweitert durch AS-3) | 22-Decisions-Baseline aus Session 2026-05-13 |
| [PLAN-architecture-v0.md](docs/plans/active/PLAN-architecture-v0.md) | Vorgänger | Subagent-Recherche, Pattern-Options |
| [PLAN-hetzner-deployment.md](docs/plans/active/PLAN-hetzner-deployment.md) | ⚠️ Spec | Multi-Instance auf Hetzner + GCP |
| **[PLAN-as3-autonomous.md](docs/plans/active/PLAN-as3-autonomous.md)** | ✅ **CODE-COMPLETE 2026-05-15** | AS-3-Migration: approval2 als Proxy vor autonomem KC2. A1-A12 + T3 auf `feat/as3-cutover`. |
| Master-Cutover-Plan (cross-repo) | ✅ TIER 0-3 CODE-COMPLETE | [knowledge2/docs/plans/active/PLAN-as3-bigbang.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-as3-bigbang.md) — Tier 4 (Cutover-Window) pending |
| Operator-Runbook | ✅ Live | [knowledge2/docs/runbooks/runbook-as3-cutover.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-as3-cutover.md) — Step-by-Step T-7 bis T+7d |

## Was bei Arbeit beachten

**Welcher Branch?** Pre-Cutover ist `main` der V1-Stand und `feat/as3-cutover` der AS-3-Stand. Code-Änderungen die AS-3 anfassen: auf dem Branch. Reine Doc-Änderungen: nach `main`.

- **KnowledgeAdapter-Code** (`packages/adapters/src/knowledge/`): auf `feat/as3-cutover` von Bearer-JWT auf OBO + `SERVICE_TOKEN` umgestellt. Neue Methode: `signOBO()` im `JwtSigner`-Interface. `syncUser()` ist neu für UserSync-Push.
- **OAuth-Facade** (`apps/server/src/mcp/oauth/`): auf `feat/as3-cutover` erweitert um Google-IdP-Redirect-Flow in `authorize.ts`, Token mit `idp=google` + `idp_sub` Claims. Inbound-ID-Token-Verify via `verifyIdToken()` in `apps/server/src/auth/idp/google.ts`.
- **kc-proxy-Route** (`apps/server/src/routes/kc-proxy.ts`): NEU auf `feat/as3-cutover`. PWA → `/admin/kc-proxy/*` → builds OBO from session-user → forwards to KC2.
- **kc_wrappers Auto-Generator** (`apps/server/src/tools/kc_wrappers/`): NEU auf `feat/as3-cutover`. Beim Boot via `tools/list` von KC2, refresh per `*/5 * * * *` cron. Tools fehlen graceful wenn `MCP_KNOWLEDGE_URL` ungesetzt.
- **Approval-Flow**: `ToolContext.approvalId` propagiert via `resumeApproval` durch in den OBO-JWT — KC2-Audit-Trail hat `approval_id` + `via_proxy=true`.
- **`MCP_KNOWLEDGE_URL` optional**: approval2 startet ohne KC2-Anbindung sauber (Native Tools + Gateways verfügbar, KC-Wrappers fehlen).
- **Contract-Tests** (`apps/server/tests/contract/`): Wire-Format zwischen approval2 ↔ KC2 ist hier ausführbar fixiert. Bei Änderungen am OBO-Format / kc_wrappers / kc-proxy: Tests anfassen, sonst bricht der Cutover.

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
