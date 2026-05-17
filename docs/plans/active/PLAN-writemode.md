## PLAN-writemode — User-facing Write-Mode in approval2

⚠️ **Status: Draft** (2026-05-17)

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

- [ ] User klickt im PWA-Tab "Write-Mode" auf "1 h" → Passkey-Prompt → Session aktiv
- [ ] Countdown zählt runter, `status.textContent` ist grün, "Jetzt deaktivieren"-Button da
- [ ] Während aktiv: ein `docs.put` (sensitivity=write) Tool-Call vom MCP-Client geht durch ohne approval_required-Response
- [ ] Während aktiv: ein `docs.delete` (sensitivity=danger) Tool-Call wirft immer noch ApprovalRequiredError
- [ ] Session-Ablauf in DB + UI synchron
- [ ] User B kann User A's Write-Mode nicht missbrauchen (RLS-Test)
