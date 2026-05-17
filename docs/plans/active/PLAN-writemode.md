## PLAN-writemode — User-facing Write-Mode in approval2

✅ **Status: LIVE** (2026-05-17, prod auf mcp-approval2.fly.dev)

End-to-End verifiziert: Passkey-Enrollment + Write-Mode-Aktivierung + Auto-Bypass
fuer write-Tools + Header-Countdown-Pill. Alle 6 Slices + 4 Hot-Fixes (siehe
unten "Deployment Lessons") sind in main.

### Ziel

Port des Write-Mode-Features aus mcp-approval v1: User kann für ein
Zeitfenster (15 / 60 / 240 min) per WebAuthn-Signature einen Auto-Approve-
Modus aktivieren, in dem Tools mit `sensitivity='write'` ohne Click
durchgelassen werden. `sensitivity='danger'` bleibt IMMER approval-pflichtig.

### Lücke zu v1

| Komponente | v1 | v2 |
|---|---|---|
| Persistente DB-Tabelle | `write_mode` (D1) | fehlt |
| `/writemode/status` (GET, public) | ✅ | fehlt |
| `/writemode/activate` (POST, Cookie + WebAuthn-Sig) | ✅ | fehlt |
| `/writemode/deactivate` (POST, Cookie) | ✅ | fehlt |
| `/writemode/start` + `stop` (HMAC, smoke-only) | ✅ | ✅ schon da, bleibt unverändert |
| Auto-Bypass im Registry-Dispatch | 3 Call-Sites in meta_tools | fehlt |
| PWA-Tab + WebAuthn-Aktivierungs-Flow | `viewWriteMode()` | fehlt |

### Multi-User-Subtilität

In v1 ist Write-Mode global (Single-User-System). In v2 muss er strikt
**pro User** sein:
- DB-Tabelle hat `user_id`-FK
- `isWritemodeActive(env, userId)` filtert per user_id
- WebAuthn-Cred-Owner-Check: `cred.user_id === sessionUserId` (sonst
  401 `webauthn_credential_owner_mismatch`, analog `approval-verify.ts:94`)
- RLS-Policy auf `write_mode` (owner-only)

### Auto-Bypass-Semantik

Eingriff in `registry.ts:159`:

```ts
if (tool.sensitivity !== 'read' && !bypassApproval) {
  if (tool.sensitivity === 'write' && await isWritemodeActive(db, ctx.userId)) {
    // fällt durch zu Execute, kein Throw
  } else {
    throw new ApprovalRequiredError(...);
  }
}
```

`danger` triggert IMMER ApprovalRequiredError, auch wenn Write-Mode aktiv ist.

### Slice-Plan (atomic commits, jeder push direkt)

| # | Slice | Files | Tests | `[deploy]`? |
|---|---|---|---|---|
| 1 | **Plan-File** | `docs/plans/active/PLAN-writemode.md` | — | nein |
| 2 | **Migration `0013_write_mode.sql`** | `apps/server/migrations/0013_write_mode.sql` | — | nein |
| 3 | **WritemodeService** (`activate`, `deactivate`, `isActive`, `listActive`) | `apps/server/src/services/writemode.ts` + `.test.ts` | unit | nein |
| 4 | **HTTP-Routes** `status` / `activate` / `deactivate` mit WebAuthn-Verifier | `apps/server/src/routes/writemode.ts` (extend) + `.test.ts` extend | unit | nein |
| 5 | **app-factory + Registry-Bypass-Hook** | `apps/server/src/app-factory.ts`, `apps/server/src/mcp/protocol/registry.ts`, ggf. `tool.ts` für Context-Erweiterung | unit + factory-test | **ja** |
| 6 | **PWA-Tab** | `apps/web/src/writemode-tab.ts` (neu) + `apps/web/src/main.ts` (Route) + Topbar-Link | optional vitest-dom | **ja** |

### Sicherheit

- **Challenge**: kanonisches JSON über `{action: 'writemode.activate', duration, ts}`,
  base64url-utf8 (Byte-identisch zu v1, damit PWA-Client wiederverwendbar wäre).
  Server akzeptiert nur `duration ∈ {15, 60, 240}` und `|now - ts| < 5 min`.
- **WebAuthn-Verify**: `requireUserVerification: true`, Counter atomic anheben.
  Nutzt denselben Pattern wie `approval-verify.ts` (eigene Factory, keine
  Wiederverwendung — Challenge ist anders).
- **Counter-Replay**: identisch zu v1 (nonzero_seen sticky flag wenn die
  Tabelle ihn hat; sonst klassische `newCounter > storedCounter`-Regel).
- **Smoke-Window-Compat**: HMAC-`/writemode/start`+`/stop` läuft weiter
  parallel. `isWritemodeActive()` ODER-verknüpft DB-Session + in-memory
  Smoke-Window. Der Smoke-Pfad bleibt für Pilot-Smoke-Tests erhalten.

### Audit

`emitAudit` für:
- `writemode.activate` (`result='success'` oder `'denied'`)
- `writemode.deactivate` (`result='success'`)
- `tool.invoke.bypassed_via_writemode` (in der Dispatch-Pipeline, wenn die
  Bypass-Klausel greift) — damit das Forensik-Bild stimmt

### Abhängigkeiten

- `@simplewebauthn/server` ist schon im Server-Workspace (siehe
  `approval-verify.ts`). Keine neuen npm-Deps.
- PWA: `@simplewebauthn/browser` (oder Vanilla via Webauthn-PRF-Lib in
  `apps/web/src/webauthn-prf.ts` — der existierende Code nutzt
  `navigator.credentials.get` direkt; passt für Activation-Sign-Off).

### Working-Discipline

Pro Slice:
1. `git pull --rebase`
2. Edits machen
3. `git add <files> && git commit -m "..."` in **einem** Bash-Aufruf
4. `git push` sofort danach

Slice 5 + 6 mit `[deploy]`-Tag — vorher Vitest lokal grün, sonst kein Push.

### Akzeptanzkriterien

- [x] User klickt im PWA-Tab "Write-Mode" auf "1 h" → Passkey-Prompt → Session aktiv
- [x] Countdown zählt runter, `status.textContent` ist grün, "Jetzt deaktivieren"-Button da
- [x] Während aktiv: ein `docs.put` (sensitivity=write) Tool-Call geht durch ohne approval_required-Response
- [x] Während aktiv: ein `docs.delete` (sensitivity=danger) Tool-Call wirft immer noch ApprovalRequiredError
- [x] Session-Ablauf in DB + UI synchron
- [x] User B kann User A's Write-Mode nicht missbrauchen (RLS-Test)
- [x] Topbar-Countdown-Pill (gelb, klickbar) zeigt verbleibende Zeit
- [x] Per-Origin-Passkey-Binding (PWA auf fly.dev + ai-toolhub-Subdomains funktionieren separat)

### Deployment Lessons (2026-05-17)

Beim Live-Rollout sind acht versteckte Bugs explodiert, die nichts mit dem
Write-Mode-Code selbst zu tun hatten — sondern mit dem WebAuthn-Plumbing
generell. Festhalten damit die Wiederholung morgen 5min statt 3h dauert:

| # | Symptom | Root-Cause | Fix |
|---|---|---|---|
| 1 | `column "counter" does not exist` | Migration 0001 hatte `sign_count INTEGER`, Runtime-Code (registration/auth/approval-verify) liest `counter`. Drift seit Phase 1. | Migration `0015_webauthn_counter_rename.sql` idempotenter ALTER COLUMN RENAME |
| 2 | Migration-Apply blockiert (drift) | Parallel-Agent committed `0015_user_sub_mcp_*.sql` neben meinem `0015_webauthn_*.sql` → Runner sieht zwei Files mit selber Version-Nummer, refuses apply | Renumber 0015→0018, 0016→0019, 0017→0020 (Content unverändert) |
| 3 | "Passkey-enrollment finish failed: HTTP 400" (alle Versionen) | PWA call ging an `/auth/webauthn/enroll/start` aber Server-Route heißt `/begin`. Body-Shape stimmte auch nicht. Plus: Bearer fehlte (cookie-only-fetch). | `apps/web/src/auth.ts` enrollPasskey() komplett überarbeitet: `/begin`, `authedFetch`, korrektes `{challengeId, response:RegistrationResponseJSON}`-Body |
| 4 | "RP-ID nicht ein registrable suffix" | PWA auf `app2.ai-toolhub.org`, RP-ID auf `mcp2.ai-toolhub.org` — Geschwister-Subdomains, keine Suffix-Relation. Apex `ai-toolhub.org` als Workaround: Apex hat **keinen A-Record** → Related-Origin-Fallback `/.well-known/webauthn` failt. | Dynamic RP-ID pro Request: `resolveRpId(origin, config)` returnt `config.RP_ID` wenn es Suffix der Request-Host ist, sonst Host-FQDN. Challenge-Store hält rpId+origin zusammen mit Challenge. Konsequenz: jede Origin == eigene Passkey-Domain. |
| 5 | `webauthn_challenge_mismatch` beim Enroll-Finish | In-Memory-Map als Challenge-Store, Fly hat 2 Machines mit auto-stop → Begin Machine A, Finish Machine B → Challenge unbekannt. War schon als TODO im Code markiert. | Migration `0022_webauthn_challenges.sql` (Postgres-Tabelle). putChallenge/takeChallenge async + DB-backed, atomic DELETE…RETURNING gegen TOCTOU. |
| 6 | `webauthn_credential_unknown` trotz erfolgreichem Enroll (silent) | `db.scoped(userId)` öffnet `BEGIN`, macht **kein automatisches COMMIT** — Caller muss `release()` aufrufen. registration.ts hat das nicht gemacht, INSERT verschwand in Orphan-Transaction, server returnte 200, PWA + iCloud sahen Passkey, Postgres rollbacked die Transaktion beim Connection-Idle. Code-Comment in `packages/adapters/src/db/postgres.ts:75-82` hatte das explizit gewarnt. | 4 Write-Sites (registration + 3 counter-UPDATEs) auf `db.transaction(userId, async (scoped) => …)` umgestellt — committed automatisch beim Callback-Resolve. |
| 7 | `Unexpected token 'h', "hybrid,internal" is not valid JSON` | `transports` ist JSONB-Spalte, postgres-js parsed JSONB automatisch zurück zu JS-Array. Verifier rief `JSON.parse(cred.transports)` → array.toString() = `"hybrid,internal"` → JSON.parse failt. | Defensive Helper in 3 Verifiern: Array → direkt, String → JSON.parse, sonst undefined. |
| 8 | `Credential response authenticatorData was not a base64url string` | PWA encoded authenticatorData/signature/clientDataJSON mit plain `bytesToB64` (`+/=` chars). simplewebauthn-server akzeptiert nur base64url (`-_`, no padding). | `bytesToB64Url` für alle assertion-Felder in writemode-tab.ts + approval-decision.ts. |

Plus eine Pipeline-Härtung weil 2x in 10min Fly-Health-Check-Timeout passiert
ist (transient): `grace_period` 10s→60s, `--wait-timeout 10m`, automatischer
1-fach Retry im Workflow.

### Folgearbeit

- **Schema-Cleanup**: `credential_id` ist BYTEA mit Dual-Encoding-Fallback im
  Code. Sauberer Pfad: TEXT-Spalte mit base64url-String, eine einzige Lookup-
  Form. Migration: `ALTER COLUMN credential_id TYPE TEXT USING encode(...)`.
- **Related-Origin-Requests**: aktuell muss man pro Domain einen separaten
  Passkey enrollen. Für 1-Passkey-für-alle-Domains: Cloudflare-Worker am Apex
  `ai-toolhub.org/.well-known/webauthn` mit JSON `{"origins":[…]}` + RP-ID
  zurück auf `ai-toolhub.org`. Optional, nur wenn UX-Problem spürbar wird.
- **DB-backed Audit-Log** für `tool.invoke.bypassed_via_writemode` ist implementiert,
  noch kein UI-Filter. PWA "Audit-Log"-Sub-Tab unter Settings könnte das zeigen.
