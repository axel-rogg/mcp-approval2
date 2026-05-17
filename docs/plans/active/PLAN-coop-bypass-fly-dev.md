# PLAN — Coop-Zscaler-Bypass via fly.dev URLs

> **Status:** ⚠️ Entwurf 2026-05-17 — wartet auf User-Decisions (§9), dann Implementierung morgen mit der Token-Rotation zusammen.
> **Owner:** Axel
> **Auslöser:** Coop-Firmen-Zscaler blockt `*.ai-toolhub.org` ("newly registered domain"). User braucht alternative Origin-URLs für Approval-PWA + MCP-Smoke + Claude.ai-MCP-Test vom Coop-Laptop. Parallel-Pattern zum v1-Setup (`mcp-approval.axelrogg.workers.dev` als Coop-Bypass, dokumentiert in v1-CLAUDE.md "Multi-Domain-Mechanik").
>
> **Scope-Korrektur 2026-05-17 (Pilot-Deploy-Day):** Erstentwurf scoppte nur approval2; User-Hinweis korrigierte: knowledge2 hat seit AS-3 seinen eigenen MCP-Server (eigene DCR-Facade unter `src/auth/oauth_facade/`, eigener `/mcp`-Endpoint, autonom betreibbar). Beide Services brauchen Coop-Bypass, sonst kann KC2-Direct nicht von Coop getestet werden.

## 1. Was schon da ist (nichts neu bauen nötig)

**Fly-Hostnames sind bereits live** (auto-managed seit Fly-App-Erstellung 2026-05-17):
- `https://mcp-approval2.fly.dev` → approval2-App (shared-IPv4 + dediziertes IPv6, TLS-Cert auto-managed)
- `https://mcp-knowledge2.fly.dev` → knowledge2-App (gleich)

Beide URLs antworten heute schon. Aktueller Stand vom Coop-Laptop:
- ✅ DNS-Auflösung + TLS-Handshake gehen durch Zscaler (allowlist `*.fly.dev`)
- ❌ Server lehnt Origin ab, weil nicht in `ALLOWED_ORIGINS` whitelisted

## 2. Code-Stand pro Service

| Aspekt | approval2 | knowledge2 |
|---|---|---|
| Multi-Origin `resolveOrigin`/`resolveRpId` | ✅ in [lib/config.ts:148](../../../apps/server/src/lib/config.ts#L148) | ❌ — `SELF_OAUTH_ISSUER` ist single-value, `ALLOWED_ORIGINS` env existiert nicht |
| WebAuthn | ja (`WEBAUTHN_ORIGINS` CSV, RP-ID per-origin) | nein |
| OAuth-Redirect (Google-IdP) | dynamisch via `BASE_URL` + `/auth/google/callback` | **statisch** via `GOOGLE_OAUTH_REDIRECT_URI` env (single-value) |
| `GOOGLE_OAUTH_REDIRECT_URI` aktuell | nicht in [env] (BASE_URL-Pattern) | `https://mcp-knowledge2.fly.dev/auth/google/callback` (in [fly.toml:45](https://github.com/axel-rogg/mcp-knowledge2/blob/main/fly.toml#L45)) |
| GCP-Console registered URIs | `mcp2.ai-toolhub.org` + `app2.ai-toolhub.org` ✓ | `knowledge.ai-toolhub.org` ❌ (Drift — sollte `knowledge2.ai-toolhub.org`) |

**Diagnose knowledge2-OAuth heute:** Der Service schickt `mcp-knowledge2.fly.dev/...` als `redirect_uri` an Google, Google hat aber nur `knowledge.ai-toolhub.org/...` registriert → OAuth-Flow scheitert mit `redirect_uri_mismatch`. Der Drift ist heute schon load-bearing für KC2-Direct-Login.

## 3. Schritte — beide Services symmetrisch

### 3.1 approval2 — Doppler/Fly-Secrets erweitern
```bash
doppler secrets set ALLOWED_ORIGINS \
  --project mcp-approval2 --config fly --silent \
  --value "https://mcp2.ai-toolhub.org,https://app2.ai-toolhub.org,https://mcp-approval2.fly.dev"

doppler secrets set WEBAUTHN_ORIGINS \
  --project mcp-approval2 --config fly --silent \
  --value "https://mcp2.ai-toolhub.org,https://mcp-approval2.fly.dev"

# Doppler→Fly-Sync triggert rolling restart
FLY_API_TOKEN=$(doppler secrets get FLY_API_TOKEN --plain --project mcp-approval2 --config fly)
export FLY_API_TOKEN
for k in ALLOWED_ORIGINS WEBAUTHN_ORIGINS; do
  v=$(doppler secrets get $k --plain --project mcp-approval2 --config fly)
  fly secrets set --app mcp-approval2 "${k}=${v}" >/dev/null
done
```

### 3.2 approval2 — `fly.toml` `[env]` kosmetisch sync (Audit-Trail)
```toml
[env]
  ALLOWED_ORIGINS  = "https://mcp2.ai-toolhub.org,https://app2.ai-toolhub.org,https://mcp-approval2.fly.dev"
  WEBAUTHN_ORIGINS = "https://mcp2.ai-toolhub.org,https://mcp-approval2.fly.dev"
```
Commit + push (kein `[deploy]`-Tag — Doppler-Sync hat schon umgestellt).

### 3.3 knowledge2 — Multi-Origin-Code ergänzen (kleiner Code-Change)

knowledge2 hat heute **kein** `ALLOWED_ORIGINS`-Konzept. Optionen:

**Option A (minimal):** statisches `GOOGLE_OAUTH_REDIRECT_URI` umstellen + GCP-Console registriert beide URLs. Vom Coop-Laptop muss man dann immer **dieselbe** fly.dev-URL nutzen (nicht mischen). Privat-Gerät weiterhin via `knowledge2.ai-toolhub.org`. Wenn man von Privat aus `mcp-knowledge2.fly.dev` aufruft, geht der OAuth-Flow trotzdem zur ai-toolhub.org-Origin (kein Schaden, nur verwirrend).

**Option B (sauber):** `redirect_uri` aus Request-Origin ableiten, wie approval2 es macht. Code-Change in [src/auth/oauth_facade/authorize.ts] — `redirect_uri = ${request.origin}/auth/google/callback`. Setzt `ALLOWED_ORIGINS`-Validation voraus (Open-Redirect-Schutz), die heute noch fehlt.

**Empfehlung:** Option B. Aufwand: ~30 LOC + 1-2 Tests. Kann mit dem Token-Rotation-Sprint morgen zusammen.

```ts
// src/auth/oauth_facade/authorize.ts (Skizze)
const origin = resolveOrigin(c.req.raw, env); // analog approval2
const redirectUri = `${origin}/auth/google/callback`;
// ... existing Google-redirect-Build mit dem dynamischen redirectUri
```

```ts
// src/types/env.ts (env-Schema)
ALLOWED_ORIGINS: z.string()
  .default('')
  .transform((s) => s ? s.split(',').map(o => o.trim()) : [])
  .refine(arr => arr.every(o => /^https:\/\//.test(o)), 'must be https URLs'),
```

### 3.4 knowledge2 — Doppler/Fly-Secrets setzen
```bash
doppler secrets set ALLOWED_ORIGINS \
  --project mcp-knowledge2 --config fly --silent \
  --value "https://knowledge2.ai-toolhub.org,https://mcp-knowledge2.fly.dev"

# GOOGLE_OAUTH_REDIRECT_URI in fly.toml ENTFERNEN — dynamisch aus Origin
# (oder leerstring lassen + Code-Fallback)

FLY_API_TOKEN=$(doppler secrets get FLY_API_TOKEN --plain --project mcp-knowledge2 --config fly)
export FLY_API_TOKEN
fly secrets set --app mcp-knowledge2 \
  "ALLOWED_ORIGINS=$(doppler secrets get ALLOWED_ORIGINS --plain --project mcp-knowledge2 --config fly)" >/dev/null
fly secrets unset --app mcp-knowledge2 GOOGLE_OAUTH_REDIRECT_URI  # oder env in fly.toml weg
```

### 3.5 GCP-Console — beide OAuth-Clients editieren (User-Hand, 2 × ~1 Min)

[console.cloud.google.com/apis/credentials?project=axelrogg-ai-tools](https://console.cloud.google.com/apis/credentials?project=axelrogg-ai-tools)

**approval2-OAuth-Client (jenes mit `mcp2.ai-toolhub.org` Redirects):**
- **Authorized redirect URIs** hinzufügen:
  - `https://mcp-approval2.fly.dev/auth/google/callback`
- **Authorized JavaScript origins** hinzufügen:
  - `https://mcp-approval2.fly.dev`

**knowledge2-OAuth-Client (jenes mit `knowledge.ai-toolhub.org` Redirect — der falsche aus deinem Drift):**
- **Authorized redirect URIs**:
  - Entfernen: `https://knowledge.ai-toolhub.org/auth/google/callback`
  - Hinzufügen: `https://knowledge2.ai-toolhub.org/auth/google/callback`
  - Hinzufügen: `https://mcp-knowledge2.fly.dev/auth/google/callback`
- **Authorized JavaScript origins**:
  - Hinzufügen: `https://knowledge2.ai-toolhub.org`
  - Hinzufügen: `https://mcp-knowledge2.fly.dev`

### 3.6 Smoke-Test (vom Codespace, simuliert Coop-Browser)

```bash
# approval2 — health + OAuth-Auth-Redirect
curl -4 -s -m 5 https://mcp-approval2.fly.dev/health
curl -4 -sI -H 'accept: text/html' \
  "https://mcp-approval2.fly.dev/oauth/authorize?client_id=...&response_type=code&..."
# Erwartet: 302 zu /auth/google/start mit return-URL fly.dev-Variante

# knowledge2 — health + DCR + Authorize
curl -4 -s -m 5 https://mcp-knowledge2.fly.dev/health/ready
curl -4 -s -X POST https://mcp-knowledge2.fly.dev/oauth/register \
  -H 'content-type: application/json' \
  -d '{"client_name":"coop-smoke","redirect_uris":["https://example.com/cb"],"grant_types":["authorization_code"],"response_types":["code"],"token_endpoint_auth_method":"none"}'
# Erwartet: HTTP 201 mit client_id

# Beide MCP-Endpoints gateway-401
curl -4 -s https://mcp-approval2.fly.dev/mcp
curl -4 -s https://mcp-knowledge2.fly.dev/mcp
```

Vom **Coop-Laptop** danach:
- `https://mcp-approval2.fly.dev/` öffnen → PWA lädt → Google-Login → Approval-Queue
- Claude.ai direct-MCP-Test: connect zu `https://mcp-knowledge2.fly.dev/mcp` → DCR + OAuth-Flow → Tool-Liste

## 4. WebAuthn-Realität (nur approval2)

Passkeys binden an die **RP-ID** = eTLD+1 der Origin. Ein Passkey enrolled auf `mcp2.ai-toolhub.org` funktioniert nicht auf `mcp-approval2.fly.dev`. Konsequenz: Coop-Laptop bekommt einen **eigenen** Passkey-Enroll (einmalig, ~30s Touch-ID/PIN-Klick). Privat-Gerät behält den alten Passkey. Saubereres Modell als WebAuthn auf Google-Session zu lockern.

knowledge2 hat heute keinen WebAuthn-Flow → kein Issue.

## 5. Was NICHT geändert wird (bewusst)

- **`BASE_URL`** approval2 bleibt `https://mcp2.ai-toolhub.org` — OAuth-Issuer-Claim in DCR-Tokens muss stabil sein
- **`SELF_OAUTH_ISSUER`** beider Services bleibt auf der ai-toolhub.org-Variante — MCP-Token müssen single-issuer haben für Audience-Trennung gegen v1
- **Custom-Domain-Setup** unverändert — Mobile/Privat-Geräte nutzen weiter ai-toolhub.org
- **MCP-Server-URL in Claude.ai**: User-Wahl — entweder ai-toolhub.org-Variante (Privat-Netz) oder fly.dev-Variante (Coop-Netz). Identisch konfigurierte DCR-Facade auf beiden Origins.

## 6. Cost

Null. `*.fly.dev`-URLs sind im Fly-Free-Tier inklusive. Kein zusätzlicher TLS-Cert nötig. Keine neue Compute-Instanz. Code-Change in knowledge2 ist ~30 LOC + Tests.

## 7. Rollback

```bash
# Doppler zurück auf ai-toolhub.org-only:
for svc in mcp-approval2 mcp-knowledge2; do
  doppler secrets set ALLOWED_ORIGINS --project $svc --config fly --silent \
    --value "https://${svc/mcp-/}.ai-toolhub.org"  # adjust per Service
done
# GCP-Console: redirect URIs einfach drin lassen (kein Risiko), oder entfernen.
# Code-Change in knowledge2: git revert wenn Option B umgesetzt.
```

## 8. Akzeptanz-Kriterien

1. ✅ `curl -I https://mcp-approval2.fly.dev/health` → 200
2. ✅ `curl -I https://mcp-knowledge2.fly.dev/health/ready` → 200 `{status:ready}`
3. ✅ Coop-Laptop kann beide URLs öffnen (kein Zscaler-Block)
4. ✅ OAuth-Login von Coop-Laptop auf approval2 + knowledge2 erfolgreich (Session-Cookie auf fly.dev-Origin)
5. ✅ Claude.ai-MCP-Connect via fly.dev gegen knowledge2 → DCR + OAuth + Tool-Liste sichtbar
6. ✅ Smoke aus Privat-Netz weiterhin via ai-toolhub.org-URLs funktional (kein Regress)
7. ✅ `terraform plan` clean (keine TF-Resources angefasst)

## 9. Open Questions für User-Entscheidung

1. **WebAuthn-Re-Enroll auf Coop-Origin** (approval2): saubere Lösung mit einmaligem Touch-ID-Setup, ODER WebAuthn-Pflicht auf Google-Session-only lockern? — **Empfehlung: Re-Enroll**, ist einmalig + audit-trail-clean.
2. **knowledge2-Code-Change (Option A vs B):** statisches `GOOGLE_OAUTH_REDIRECT_URI` umstellen (= Coop-Origin-only) ODER dynamisch aus Request-Origin (= beide Origins). — **Empfehlung: Option B (~30 LOC)**, sonst läuft `knowledge2.ai-toolhub.org`-Flow von Privat-Netz auf das Coop-Redirect-URI.
3. **DCR-Issuer-Claim bei MCP-Clients:** wenn Claude.ai auf `mcp-knowledge2.fly.dev/mcp` connectet, erwartet es `iss` Claim = `https://mcp-knowledge2.fly.dev`? Heute steht `SELF_OAUTH_ISSUER=https://knowledge2.ai-toolhub.org`. Behebung wäre `SELF_OAUTH_ISSUER` dynamisch aus Origin oder akzeptieren dass MCP-Clients von Coop-Netz immer den ai-toolhub.org-Issuer im Token haben (kein praktischer Block — Audience-Validation interessiert sich nur dafür wer das Token konsumiert, nicht von welchem Origin der Browser kommt). — **Empfehlung: erstmal so lassen** (stabiler Issuer ist Feature, nicht Bug).

## 10. Reihenfolge — wann was

**Heute (kann ich jetzt machen):**
- (kein Code-Change ohne User-Entscheidung zu §9.2)

**Morgen (Token-Rotation-Sprint, ~30 min Operator):**
1. GCP-Console-Edits (§3.5) — User-Hand, 2 Klicks
2. Doppler-Updates beide Services (§3.1 + §3.4) — Skripten
3. fly.toml-Sync (§3.2) — Commit
4. knowledge2-Code-Change Option B (§3.3) — Edit + Commit + Deploy
5. Smoke beide Origins (§3.6)
6. WebAuthn-Re-Enroll auf Coop-Laptop (§4)

## 11. Referenzen

- v1-Pattern: [mcp-approval CLAUDE.md "Multi-Domain-Mechanik"](https://github.com/axel-rogg/mcp-approval/blob/main/CLAUDE.md) — analoge Lösung mit `*.axelrogg.workers.dev`
- v1-Plan: [mcp-approval docs/plans/done/PLAN-multidomain.md](https://github.com/axel-rogg/mcp-approval/blob/main/docs/plans/done/PLAN-multidomain.md) — Sign-off vom 2026-05-07
- v2-Code (approval2): [apps/server/src/lib/config.ts:148](../../../apps/server/src/lib/config.ts#L148) `resolveOrigin`/`resolveRpId`
- v2-Code (knowledge2): [src/auth/oauth_facade/authorize.ts](https://github.com/axel-rogg/mcp-knowledge2/blob/main/src/auth/oauth_facade/authorize.ts) (Multi-Origin-Patch ausstehend)
- v2-Status: [docs/STATUS.md](../../STATUS.md) "Pilot-Live 2026-05-17"
