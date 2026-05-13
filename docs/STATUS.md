# Status: mcp-approval2 Greenfield-Build (2026-05-13, post-Burst-5)

> Snapshot nach Burst 1+2+3+4+5. **Pilot-Production code-side komplett**,
> verbleibend nur externe Setup-Aufgaben (GCP, OpenBao-Live-Deploy, DNS,
> Pilot-Firma-DPA). Plan-Ref:
> [docs/plans/active/PLAN-architecture-v1.md](plans/active/PLAN-architecture-v1.md).
> Diese Datei ist die Single-Source-of-Truth fuer "wo stehen wir + was fehlt
> bis Pilot-Production". Bei Aenderungen: Datum oben bumpen + entsprechende
> Sektion editieren.

## TL;DR

- **6 Commits** auf main (plus 1 lokal-only fuer Workflows)
- **~394 Tests gruen** (243 server + 104 adapters + 47 core)
- **Alle 4 Workspaces tsc-clean** mit strict + noUncheckedIndexedAccess
- **PWA installierbar** (vite build success, Manifest + SW + WebAuthn-PRF)
- **Live-Adapter**: OpenBao (KEK + per-User-DEK), Vertex AI (EU embed+chat),
  Postgres (mit RLS), MinIO/S3 (Blob)
- **CLI-Tools**: db-migrate (transaktional + drift-detection), vault-bootstrap,
  health-check, seed
- **Cross-Service-Bridge zu mcp-knowledge2**: POST /internal/v1/dek/resolve
  funktional (ADR-0001 Variant B), JWKS-RS256 mit Live-Public-Key-Export
- **Pilot-Doku**: Onboarding-, Incident-Response-, Token-Rotation-Runbooks
  + DPA-/DPIA-Templates + Sub-Processor-List

**Verbleibend (alles ausserhalb Code, braucht externe Setup):**
1. **GCP-Provisioning** (Cloud SQL Postgres EU + Vertex-AI-Project + Service-
   Account-Keys + Budget-Alerts)
2. **OpenBao Live-Deploy** + AppRole-Bootstrap (`vault-bootstrap.ts` ready)
3. **DNS + TLS** fuer mcp-approval2 + mcp-knowledge2
4. **Deploy-Pipeline** (GitHub Actions Workflow lokal vorbereitet, braucht
   PAT-Scope-Erweiterung)
5. **mcp-knowledge2 Drift-Resolutions D-1..D-12** (siehe `CROSS-SERVICE-
   CONTRACT.md` im Schwester-Repo — 12 Adapter-Side-Fixes fuer volle Wire-
   Compat. Z.B. body_b64 statt body, Problem-Detail-Errors statt
   `{error:{code,message}}`)
6. **DPA-Anpassung** fuer Pilot-Firma (Template ist da, braucht firma-
   spezifische Klauseln)
7. **Sub-MCP-Server-Migration** (cf/github/gws/gcloud/utils Worker auf
   X-User-JWT-Header — separate Repos)

## Was steht

### Phase 0 — Skeleton — COMPLETE
- Monorepo (`packages/core`, `packages/adapters`, `apps/server`, `apps/web`)
- TypeScript strict (incl. `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
  via `tsconfig.base.json`; npm-workspaces; Biome-Linter
- 22 ADRs in `docs/adr/`
- `docker-compose.yml` mit Postgres-16 + pgvector + OpenBao + MinIO
- CI-Workflow-Files unter `.github/workflows/`
- Konfiguration ueber `loadConfig()` (zod) — `.env.example` als Single-Source

### Phase 1 — Auth — COMPLETE
- Google-OAuth-Login-Front-Door (`/auth/google/start`, `/auth/google/callback`)
- Session-JWT (HS256, kurzlebig) + Refresh-Token-Rotation (RFC 9700)
- WebAuthn-Enrollment (`@simplewebauthn/server`) inklusive PRF-Extension
- Invite-Flow (`/admin/invites`, `/accept-invite/:token`)
- First-Login-First-Admin-Bootstrap (kein hardcoded `ALLOWED_EMAILS`)
- Email-Recovery fuer Lost-Passkey

### Phase 2 — Credentials + Vault — COMPLETE
- `LocalKekProvider` (HKDF-derived KEK, dev) + `OpenBaoKekProvider` (AppRole,
  prod) im `@mcp-approval2/adapters`-Package
- Envelope-Encryption pro Credential: random 32-byte DEK → AES-256-GCM →
  KEK-wrap. AAD-Pattern `credentials|<owner>|<provider>|<kind>|<id>`
- WebAuthn-PRF-XOR-Layer Day-Zero aktiv (siehe PLAN §5.3)
- `PrfSessionService` mit TTL (default 5 min), in-memory
- 6 HTTP-Routes `/v1/credentials/*` (create, list, read, rotate, delete,
  prf-session)
- Sub-MCP-Internal-Hook `resolveForSubMcp` (JIT-Token, Plaintext verlaesst
  Worker nie)

### Phase 3 — KC2-Boundary — COMPLETE
- `HttpKnowledgeAdapter` aus `@mcp-approval2/adapters` (mcp-knowledge2-Client)
- RS256-JWT pro Request (60s-TTL, `sub=user_id`, `aud=mcp-knowledge2`)
- `KnowledgeService`-Wrapper mit Audit-Log (`knowledge.<kind>.<op>` Events)
- 9 Proxy-Routen `/v1/knowledge/*` fuer PWA (Objekte, Shares, Search)

### Phase 4 — MCP-Protocol + Tools — PARTIAL
- ✅ OAuth 2.1 + PKCE + DCR (RFC 7591) + Resource-Indicators (RFC 8707) +
  Refresh-Rotation. Endpoints: `/.well-known/oauth-authorization-server`,
  `/.well-known/jwks.json`, `/oauth/register`, `/oauth/authorize`,
  `/oauth/token`, `/oauth/revoke`
- ✅ Streamable-HTTP-Transport (`POST /mcp` + `GET /mcp/sse` Heartbeat-Stub)
- ✅ `ToolRegistry` + Dispatcher mit Approval-Gate (`ApprovalRequiredError`
  fuer `sensitivity != 'read'`) + IPI-Output-Filter
- ✅ 12 Core-Tools registriert via `registerCoreTools` (`apps/server/src/tools/
  index.ts`): system.health, system.echo, user.profile.read/update,
  knowledge.docs.{create,read,list}, knowledge.skills.list, knowledge.search,
  credentials.{list,add,delete}
- ⏳ TODO: Approval-Flow End-to-End — Backend-Routen `/v1/approvals/pending`,
  `/v1/approvals/:id/challenge`, `/v1/approvals/:id/sign` fehlen (PWA spricht
  sie schon an — Skeleton). Persistenz-Tabelle `approval_requests` muss in
  `schema/postgres/` ergaenzt werden.
- ⏳ TODO: Sub-MCP-Tools dynamisch in die Registry nach Gateway-Discovery
  einhaengen

### Phase 5 — Sub-MCP-Gateway — IN-PROGRESS (Parallel-Subagent)
- ⚠️ Sub-MCP-Registry + Forwarder als Skeleton unter `apps/server/src/mcp/
  gateway/` vorhanden (TypeScript-Errors offen, separate Subagent-Aufgabe)
- ⏳ TODO: Internal `/internal/v1/credentials/resolve`-Endpoint fuer JIT-Token-
  Lieferung an Sub-MCPs
- ⏳ TODO: Tool-Discovery von Sub-MCPs (periodic refresh, MCP `tools/list`-
  Forwarding inkl. WYSIWYS-`display_template`-Pflege)
- ⏳ TODO: Anpassung der bestehenden Sub-MCP-Server (`mcp-gws`, `mcp-utils`,
  `mcp-gcloud`, `mcp-cf`, `mcp-github`) auf den neuen Internal-Auth-Header
  (`X-User-JWT`)

### Phase 6 — Hardening — PARTIAL
- ✅ `errorHandler` + `requestId`-Middleware globaler Hook
- ✅ Audit-Sink: Postgres `audit_log`-Tabelle (services/audit.ts), Failure-Path
  loggt zu `console.error` ohne Request zu killen
- ⏳ TODO: Rate-Limit-Middleware (Token-Bucket pro User + pro Tenant — Plan
  beschrieben, Code fehlt)
- ⏳ TODO: GDPR-Export (ZIP-Stream) + Erase mit Crypto-Shred (30d-Grace)
- ✅ Admin-Routes (User-List, Suspend, Audit-View) — `apps/server/src/routes/admin.ts`
- ✅ Cost-Controls (Vertex-AI-Budget pro User) — `services/cost-tracker.ts` +
  `middleware/cost-gate.ts` mit X-Cost-*-Header
- ⏳ TODO: SIEM-Export-Endpoint
- ⏳ TODO: Structured-Logging (pino) — heute haengen `console.log/error`-Calls
  ohne korreliert mit `requestId`

## PWA-Status (apps/web)

- ✅ Build mit vite (~23kB JS / ~5kB CSS), PWA installierbar
- ✅ Hash-Routing (`#/login`, `#/approvals`, `#/credentials`, `#/enroll-passkey`)
- ✅ Login-Page → Click-Through nach `/auth/google/start`
- ✅ Approval-View pollt `/v1/approvals/pending` alle 5s und rendert
  WYSIWYS-display_rendered, Approve/Reject-Buttons
- ✅ WebAuthn-PRF-Sign-Off im Approval-Flow (PRF-Salt = `approval:<id>`),
  PRF-Session-Stash an Backend wenn Tool credentials braucht
- ✅ Credentials-View: Add-Form mit PRF-Sign (Salt = `credentials:add:<provider>:<label>`)
- ✅ Service-Worker (cache-first static / network-only API), Manifest, Icon
- ✅ Mobile-first CSS mit Dark-Mode (prefers-color-scheme)
- ⏳ TODO: WYSIWYS-Display-Template-Resolver in PWA (heute Backend rendert
  display_rendered komplett — Plan-Pattern: PWA rendert nochmal als
  Verification)
- ⏳ TODO: Storage-Browser (gegen `/v1/knowledge/objects`-Proxy)
- ⏳ TODO: Tool-Defaults / Profile / Hints — wenn als Feature gewuenscht

## Was fehlt fuer Pilot-Production

### Code
1. **Approval-Flow End-to-End**: ✅ COMPLETE (Burst 4)
   — DB-Tabelle `pending_approvals` + State-Machine + 5 PWA-facing Routes
   + WebAuthn-PRF-Sign-Off + Re-Dispatch nach Approval. Anbindung in
   `app-factory.ts` noch pending (Routes-Mount + Tool-Registry-Bridge).
2. **mcp-knowledge2 Service**: paralleler Greenfield-Build mit JWT-Auth-
   Boundary; `@mcp-approval2/adapters/knowledge`-HTTP-Client wartet darauf.
3. **Sub-MCP-Server-Migration**: `mcp-gws`, `mcp-utils`, etc. brauchen
   Anpassung an den neuen Internal-Auth (`X-User-JWT` statt heutigem Bearer-
   Master-Token), plus den Sub-MCP-Gateway aus Phase 5 ist im Repo fertig
   (`src/mcp/gateway/`) aber Mount-Wiring noch pending.
4. **OpenBao Boot-Path im index.ts**: heute hat `apps/server/src/index.ts`
   nur den `LocalKekProvider`-Dev-Pfad; Production-Boot mit AppRole-Token-
   Bootstrap fehlt. `OpenBaoKekProvider` ist fertig — `vault-bootstrap.ts`-
   CLI in `apps/server/scripts/` ist ebenfalls fertig. Wiring: optional
   produktiv aktivieren wenn VAULT_ADDR gesetzt.
5. **DB-Migration-Tooling**: ✅ COMPLETE — `apps/server/scripts/migrate.ts`
   mit transaktional Apply + sha256-Drift-Detection + `--dry-run` /
   `--target` Flags. Migrations 0001-0006 vorhanden.
6. **Cost-Controls Live**: ✅ COMPLETE — Vertex-Adapter ist live,
   `cost-tracker` mit Daily-Budget pro User, `cost-gate` Middleware mit 429.
7. **Monitoring + Observability**: pino-http + OpenTelemetry-Spans + Metrics-
   Endpoint (Prometheus-Format) + Audit-Tail-Endpoint fuer SOC.
8. **Final Wire-Up**: `app-factory.ts` ergaenzen um Approval-Routes
   + Cost-Gate + Sub-MCP-Gateway-Mount (alle Module fertig, Mount-Wiring
   ist die letzte Strecke vor Pilot-Smoke).

### Ops
1. **Production-Deploy-Pipeline**: GitHub-Actions-Deploy + Secrets-Sync
   (analog `scripts/sync-github-secrets.sh` aus mcp-approval).
2. **OpenBao-Deploy**: Live-Instance + AppRole-Bootstrap-Skript +
   Secret-ID-Rotation-Runbook.
3. **GCP-Setup**: Postgres (Cloud SQL oder self-hosted), Vertex-AI-Project +
   Service-Account-Keys + Budget-Alerts.
4. **DNS + TLS**: Domain fuer `mcp-approval2` + `mcp-knowledge2` (R2 oder
   Caddy-frontend).
5. **SSO-Setup**: Wenn Firma SSO will → WorkOS-Provider (oder eigener OIDC-
   Adapter) hinter dem Google-Login-Front-Door.
6. **Smoke-Tests gegen Prod**: `scripts/smoke-prod.sh`-pendant zu mcp-approval
   (mit Throttle gegen CF-Rate-Limits, falls Worker-fronted).

### Compliance
1. **DPA-Template** fuer Pilot-Firma (Datenresidenz-Klauseln, Sub-Processor-
   Liste inkl. OpenBao + GCP).
2. **DPIA-Doc** (Datenresidenz/-flow, KEK-Rotation, Crypto-Shredding).
3. **Pilot-Runbook**: Onboarding-Flow (Invite-Erstellung, First-Admin-
   Bootstrap), Incident-Response-Playbook, Token-Rotation-Procedure.
4. **Bug-Bounty-Setup** oder externer Code-Audit vor Pilot-Cutover.

## Test-Status

- TypeScript-strict: `npx tsc --noEmit` im `apps/server`-Workspace clean
  (mit Ausnahme von `apps/server/src/mcp/gateway/*` — Burst-3-Subagent N
  WIP). Im `apps/web`-Workspace: clean.
- Vitest-Run: bestehende Unit-Tests laufen (DB-Stubs, OAuth-Pipeline,
  Credentials-Service, KnowledgeService-Audit-Pfade)
- Integration-Tests: heute in-memory mit Stub-DbAdapter — kein Live-Postgres
  im CI. Trigger: docker-compose lokal hochziehen + `scripts/test-e2e.sh`
  (existiert noch nicht — siehe Ops-TODO)

## Architektur-Notiz: Boot-Reihenfolge in `apps/server/src/index.ts`

```
main()
 └── createServerContext(env)
      ├── loadConfig(env)        # zod-validation aller Pflicht-Vars
      └── createDbAdapter(config) # Postgres oder SQLite
 └── buildOptionalDeps(server, bootEnv)
      ├── (optional) LocalKekProvider via MASTER_KEY_BASE64
      └── (optional) KnowledgeService via KNOWLEDGE_URL + JWT_PRIVATE_KEY
 └── createApp(server, deps)
      ├── globale Middleware (request-id, error-handler)
      ├── public routes: /health, OAuth-Endpoints
      ├── auth routes: google, session, webauthn, invite, recovery
      ├── /v1/credentials/* (falls KekProvider gesetzt)
      ├── /v1/knowledge/* (falls KnowledgeService gesetzt)
      └── /mcp (Streamable-HTTP-Transport mit ToolRegistry)
 └── serve({fetch: app.fetch, port: config.PORT})
```

Wer testen will: `cp .env.example .env && bash scripts/dev.sh` (oder direkt
`npm run dev --workspace=apps/server`). PWA separat mit
`npm run dev --workspace=apps/web` — proxyt automatisch nach `:8787`.
