# PLAN — Coop-Zscaler-Bypass via fly.dev URL

> **Status:** ⚠️ Entwurf 2026-05-17 — wartet auf User-Go, dann Implementierung.
> **Owner:** Axel
> **Auslöser:** Coop-Firmen-Zscaler blockt `*.ai-toolhub.org` ("newly registered domain"). Damit User die Approval-PWA + MCP-Surface vom Coop-Laptop nutzen können, brauchen wir eine alternative Origin-URL die Zscaler durchlässt. Parallel-Pattern zum v1-Setup (`mcp-approval.axelrogg.workers.dev` als Coop-Bypass für v1-mcp-approval, dokumentiert in v1-CLAUDE.md "Multi-Domain-Mechanik").

## 1. Was schon da ist (nichts neu bauen nötig)

**Fly hostnames sind bereits live** (one-shot allocate seit Fly-App-Erstellung):
- `https://mcp-approval2.fly.dev` → approval2-App (shared-IPv4 + dediziertes IPv6, TLS-Cert von Fly auto-managed)
- `https://mcp-knowledge2.fly.dev` → knowledge2-App (gleich)

**Code unterstützt Multi-Origin bereits** ([apps/server/src/lib/config.ts:148](apps/server/src/lib/config.ts#L148-L162)):
- `resolveOrigin(request, config)` liest pro Request den `Origin`-Header bzw. `X-Forwarded-Host`, prüft gegen `ALLOWED_ORIGINS`-Whitelist (Anti-Spoofing). Fallback auf `config.RP_ORIGIN` für Cron-Kontext ohne Request.
- `resolveRpId(origin)` deriviert die WebAuthn-RP-ID aus der Origin-FQDN.
- Multi-Domain-Support ist also kein Code-Change, nur Config.

**Bottleneck:** `ALLOWED_ORIGINS` + `WEBAUTHN_ORIGINS` in Doppler/Fly enthalten aktuell nur `mcp2.ai-toolhub.org` + `app2.ai-toolhub.org`. Requests von `mcp-approval2.fly.dev` werden mit 403 abgelehnt obwohl die Fly-App selbst antwortet.

## 2. WebAuthn-Realität (wichtig vorab zu wissen)

WebAuthn bindet Passkeys an die **RP-ID** (= eTLD+1 der Origin). Konsequenz:
- Ein Passkey enrolled auf `mcp2.ai-toolhub.org` hat RP-ID `mcp2.ai-toolhub.org` (oder `ai-toolhub.org` bei wildcard) und funktioniert **nicht** auf `mcp-approval2.fly.dev` (andere RP-ID).
- Wer Coop-Laptop + Privat-Gerät über *unterschiedliche* Origins nutzt, muss **pro Origin** separat enrollen.
- Soft-Workaround: Google-OAuth-Login (passwort-frei via Browser-Session) funktioniert über alle Origins ohne Re-Enroll, falls die Approval-PWA das ohne Passkey-Pflicht akzeptiert. Hard-Mode (WebAuthn-Pflicht für Approvals) verlangt Re-Enroll.

User-Decision nötig: **lockern wir WebAuthn auf Google-Session für Approvals** im Coop-Fall, oder akzeptieren wir das Re-Enroll? Mein Bauchgefühl: Google-Session reicht für privat-Pilot (2-5 User), und der Re-Enroll auf Coop-Laptop ist eine 30s-Aktion (Touch-ID/PIN, ein Klick). Pro Origin separate Passkeys sind das saubere Modell.

## 3. Schritte (geschätzte Zeit: 15 Min Operator + 1 Min Code-Change)

### 3.1 Doppler-Update — `ALLOWED_ORIGINS` + `WEBAUTHN_ORIGINS` erweitern
```bash
# Sind aktuell ohne fly.dev — kommazepariert anhängen.
# (Doppler-Wert wird direkt gesetzt, nicht ins Transcript geechoed.)
doppler secrets set ALLOWED_ORIGINS \
  --project mcp-approval2 --config fly --silent \
  --value "https://mcp2.ai-toolhub.org,https://app2.ai-toolhub.org,https://mcp-approval2.fly.dev"

doppler secrets set WEBAUTHN_ORIGINS \
  --project mcp-approval2 --config fly --silent \
  --value "https://mcp2.ai-toolhub.org,https://mcp-approval2.fly.dev"
```

### 3.2 Doppler→Fly-Sync — neue Werte in Fly-Secrets propagieren
```bash
FLY_API_TOKEN="$(doppler secrets get FLY_API_TOKEN --plain --project mcp-approval2 --config fly)"
export FLY_API_TOKEN
for k in ALLOWED_ORIGINS WEBAUTHN_ORIGINS; do
  v="$(doppler secrets get $k --plain --project mcp-approval2 --config fly)"
  fly secrets set --app mcp-approval2 "${k}=${v}" >/dev/null
done
# fly secrets set triggert automatischen Machine-Restart (rolling).
```

### 3.3 GCP-Console-Edit (User-Hand, 1 Klick)
- console.cloud.google.com/apis/credentials?project=axelrogg-ai-tools
- approval2-OAuth-Client editieren
- **Authorized redirect URIs**: hinzufügen
  - `https://mcp-approval2.fly.dev/auth/google/callback`
- **Authorized JavaScript origins**: hinzufügen
  - `https://mcp-approval2.fly.dev`
- Save

### 3.4 fly.toml `[env]` Cosmetic-Update (commit + redeploy)
- `ALLOWED_ORIGINS` env in `fly.toml` updaten (für Code-Repo-Audit-Trail; Doppler-Wert überschreibt im Runtime, aber `fly.toml` ist die kanonische Quelle für "was sollte hier sein"):
  ```toml
  [env]
    ALLOWED_ORIGINS = "https://mcp2.ai-toolhub.org,https://app2.ai-toolhub.org,https://mcp-approval2.fly.dev"
    WEBAUTHN_ORIGINS = "https://mcp2.ai-toolhub.org,https://mcp-approval2.fly.dev"
  ```
- Commit + push (kein `[deploy]`-Tag nötig, da Werte aus Doppler-Sync bereits wirken)

### 3.5 Smoke-Test (vom Codespace, simuliert Coop-Browser)
```bash
# Health bleibt 200
curl -4 -s https://mcp-approval2.fly.dev/health

# PWA-Index erreichbar (gleicher Catch-all wie auf mcp2.ai-toolhub.org)
curl -4 -sI https://mcp-approval2.fly.dev/ | head -3

# OAuth-Flow von fly.dev-Origin: /auth/google/start mit Accept: text/html
# muss 302 zu Google-OAuth-URL geben mit dem fly.dev-Callback eingebettet
curl -4 -sI -H 'accept: text/html' https://mcp-approval2.fly.dev/auth/google/start

# MCP-Endpoint gibt weiter 401 (kein Bearer)
curl -4 -s https://mcp-approval2.fly.dev/mcp
```

Vom **Coop-Laptop** danach:
- `https://mcp-approval2.fly.dev/` öffnen → PWA lädt
- "Login with Google" → erwartet redirect zu Google → consent → callback an `fly.dev/auth/google/callback` → Session-Cookie gesetzt → PWA zeigt Approval-Queue
- Passkey-Enroll auf Coop-Origin (einmalig, falls Passkey-Pflicht aktiv)

## 4. Was NICHT geändert wird (bewusst)

- **`BASE_URL`** bleibt `https://mcp2.ai-toolhub.org`. Wird genutzt für:
  - OAuth-Issuer-Claim in DCR-Tokens (MCP-Clients erwarten **eine** stabile Issuer-URL — Cross-Origin-Tokens sind ein Audit-Albtraum)
  - Cron-Job-Trigger ohne Request-Kontext (kein resolveOrigin verfügbar)
  - WebAuthn-RP-ID-Fallback
- **`SELF_OAUTH_ISSUER`** bleibt `https://mcp2.ai-toolhub.org`. Gleiche Begründung — MCP-Token müssen einen einzigen Issuer haben, sonst verlieren wir die Audience-Trennung gegen v1.
- **Custom-Domain-Setup** unverändert. `mcp2.ai-toolhub.org` + `app2.ai-toolhub.org` bleiben primäre URLs für Mobile/Privat-Geräte.
- **MCP-Server-URL in Claude.ai** bleibt `https://mcp2.ai-toolhub.org/mcp`. Die fly.dev-URL ist explizit für Browser-PWA-Zugriff aus Coop, nicht für Claude.ai-Clients.

## 5. knowledge2 — separate Frage

Knowledge2 hat sein eigenes `mcp-knowledge2.fly.dev`. Für Coop-Bypass relevant ist v.a. die Approval-PWA (= approval2). Knowledge2 wird vom Browser nie direkt aufgerufen — nur via approval2's `/admin/kc-proxy/*` Route. Knowledge2 braucht also **keine** Coop-Bypass-Origin.

OAuth-Redirect-URI für knowledge2 sollte trotzdem morgen (mit dem `knowledge.` → `knowledge2.` Fix) auf die korrekte URL gestellt werden — fly.dev-Variante optional ergänzt für DCR-Test-Zwecke direkt gegen knowledge2.

## 6. Cost

Null. `*.fly.dev`-URLs sind im Fly-Free-Tier inklusive. Kein zusätzlicher TLS-Cert nötig (Fly managt automatisch). Keine neue Compute-Instanz.

## 7. Rollback

```bash
# Doppler zurück auf nur ai-toolhub.org-Origins:
doppler secrets set ALLOWED_ORIGINS --project mcp-approval2 --config fly --silent \
  --value "https://mcp2.ai-toolhub.org,https://app2.ai-toolhub.org"
# Same für WEBAUTHN_ORIGINS.
# Push to Fly + restart.
# GCP-Console: redirect URIs entfernen (oder einfach drin lassen, kein Risiko).
```

## 8. Akzeptanz-Kriterien

1. ✅ `curl -I https://mcp-approval2.fly.dev/health` → 200
2. ✅ Coop-Laptop kann `https://mcp-approval2.fly.dev/` öffnen (kein Zscaler-Block)
3. ✅ OAuth-Login von Coop-Laptop führt zu Session-Cookie auf `mcp-approval2.fly.dev`-Origin
4. ✅ Approval-Queue ist sichtbar + Approvals können (mit Passkey-Re-Enroll auf Coop-Origin oder Google-Session-only-Mode) bestätigt werden
5. ✅ Smoke aus Privat-Netz weiterhin via `mcp2.ai-toolhub.org` funktional (kein Regress)

## 9. Open Questions für User-Entscheidung

1. **WebAuthn-Re-Enroll vs Google-Session-only für Approvals:** willst du Passkey-Pflicht beibehalten (= Re-Enroll auf Coop-Origin nötig) oder lockerst du das auf "Google-Session reicht"?
2. **fly.dev-URL auch für Claude.ai-MCP-Client?** Aktuell empfohlen: nur Browser-PWA. Wenn auch MCP-Tools von Coop genutzt werden sollen (`https://mcp-approval2.fly.dev/mcp`), müssten wir den DCR-Issuer-Claim-Constraint überdenken (heute single-issuer `mcp2.ai-toolhub.org`).
3. **`app2.ai-toolhub.org`-Pendant:** brauchst du auch eine fly.dev-URL die der `app2.`-Origin entspricht (separate PWA-only Surface), oder reicht `mcp-approval2.fly.dev/` als unified PWA+API Surface?

## 10. Referenzen

- v1-Pattern: [mcp-approval CLAUDE.md "Multi-Domain-Mechanik"](https://github.com/axel-rogg/mcp-approval/blob/main/CLAUDE.md) — analoge Lösung mit `*.axelrogg.workers.dev`
- v1-Plan: [mcp-approval docs/plans/done/PLAN-multidomain.md](https://github.com/axel-rogg/mcp-approval/blob/main/docs/plans/done/PLAN-multidomain.md) — Sign-off vom 2026-05-07
- v2-Code: [apps/server/src/lib/config.ts:148](../../../apps/server/src/lib/config.ts#L148) `resolveOrigin`/`resolveRpId`
- v2-Status: [docs/STATUS.md](../../STATUS.md) "Pilot-Live 2026-05-17"
