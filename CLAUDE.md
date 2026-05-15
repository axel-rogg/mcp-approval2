# mcp-approval2 — Kontext für Claude Code

> **Greenfield-Successor** zu [mcp-approval](https://github.com/axel-rogg/mcp-approval) (Cloudflare-Workers, single-user).
> Multi-User von Tag 0 (5-15 User pro Pilot-Instance), Postgres + OpenBao, EU-Region, DSGVO-tauglich.
> Schwester-Repo: [mcp-knowledge2](https://github.com/axel-rogg/mcp-knowledge2) (Storage + Search).
>
> **Status 2026-05-15:** AS-3-Code-Complete + **Generic-Object-Model implementiert** auf Branch `feat/as3-cutover`
> (15 Commits, 473 Tests grün). Cutover-Day pending — Runbook im Schwester-Repo:
> [knowledge2/docs/runbooks/runbook-as3-cutover.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-as3-cutover.md).
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
| **[PLAN-wrapper-conventions.md](docs/plans/active/PLAN-wrapper-conventions.md)** | ✅ **Live 2026-05-15** | Subtype-Konventionen (file/skill_manifest/app:*/memo/list/note/…), Body-Formate, Drift-Prevention. Kanonische Quelle nach ADR-0004 (Brief in knowledge2). |
| Master-Cutover-Plan (cross-repo) | ✅ TIER 0-3 CODE-COMPLETE | [knowledge2/docs/plans/active/PLAN-as3-bigbang.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-as3-bigbang.md) — Tier 4 (Cutover-Window) pending |
| Operator-Runbook | ✅ Live | [knowledge2/docs/runbooks/runbook-as3-cutover.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-as3-cutover.md) — Step-by-Step T-7 bis T+7d |

## Was bei Arbeit beachten

**Welcher Branch?** Pre-Cutover ist `main` der V1-Stand und `feat/as3-cutover` der AS-3-Stand. Code-Änderungen die AS-3 anfassen: auf dem Branch. Reine Doc-Änderungen: nach `main`.

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
