# Sub-MCP-OAuth — Setup, Konventionen, Lessons-Learned

> **Status: Live seit 2026-05-17** mit Commit `4604ca7`. GitHub-MCP via GitHub-App
> als erster Konsument verifiziert (Refresh-Token KMS-encrypted in
> `user_sub_mcp_config[_oauth_refresh_token]`).

Diese Doku beschreibt **wie OAuth-basierte Sub-MCP-Gateways** (GitHub-MCP,
Cloudflare-MCP, Notion-MCP, etc.) in mcp-approval2 angebunden werden, plus die
Hard-Knocks-Lessons aus der Inbetriebnahme.

## Architektur

```
PWA-Click "Authorize" für Server X
  ↓
POST /v1/me/servers/X/oauth/start
  ↓
Server:
  - sucht config_schema.oauth in sub_mcp_servers.config_schema._meta
  - generiert state + PKCE-code_verifier
  - persistiert in user_sub_mcp_oauth_state (TTL 10 min)
  - canonical redirect_uri = "${origin}/oauth/sub-mcp-callback" (KONSTANT pro origin)
  - returnt authorizeUrl (GitHub-OAuth-URL mit code_challenge etc.)
  ↓
Browser-Redirect zu authorizeUrl (= GitHub-Authorize)
  ↓
User-Consent
  ↓
GitHub-Callback → /oauth/sub-mcp-callback?code=...&state=...  (= Bridge)
  ↓
Bridge:
  - liest state aus Query
  - DB-Lookup user_sub_mcp_oauth_state.state → sub_mcp_name (server-vouched!)
  - 302-Redirect zu PWA-Hash-Route /#/tools/servers/<name>/oauth/callback?code=...&state=...
  ↓
PWA:
  - parsed code+state aus Hash
  - POST /v1/me/servers/<name>/oauth/callback {code, state}
  ↓
Server (Code-Exchange):
  - validiert state aus DB
  - tauscht code+code_verifier gegen access+refresh-Token gegen GitHub
  - encrypted refresh_token mit per-User-KEK
  - speichert in user_sub_mcp_config._oauth_refresh_token
  - loescht state-Row
  ↓
Discovery-Cron pickt es beim naechsten Tick (oder Manual-Refresh):
  - tausch refresh→access
  - tools/list-Call gegen GitHub-MCP
  - cached in sub_mcp_servers.tools_cache
```

## Setup für einen neuen OAuth-Sub-MCP-Server

### 1. Provider-OAuth-App registrieren

**GitHub:** github.com/settings/apps → "New GitHub App"
- Callback URL: `https://<origin>/oauth/sub-mcp-callback` (**eine pro Origin** — siehe Multi-Origin unten)
- "Request user authorization (OAuth) during installation": ✓
- "Expire user authorization tokens": ✓ (Default)
- Webhook "Active": **off** (nicht gebraucht)
- Client-ID + Client-Secret kopieren (Secret nur einmalig sichtbar!)

**Andere OAuth-Apps:** analog — eine konstante Callback-URL pro Origin.

### 2. Sub-MCP-Server in v2 registrieren

PWA Tools-Tab → "+ Add MCP-Server" oder via `/internal/v1/servers/import`. Body
mit `config_schema._meta.oauth`:

```json
{
  "config_schema": {
    "_meta": {
      "oauth": {
        "kind": "pre",
        "provider": "github",
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "scopes": []
      }
    }
  }
}
```

### 3. Client-Credentials eintragen (PWA)

Tools-Tab → Server-Detail → "Client-Daten eintragen":
- Client-ID (`Iv23li...` bei GitHub-App, `Ov23li...` bei OAuth-App — App
  bevorzugen wegen Refresh-Token-Support)
- Client-Secret (eingegeben, KMS-encrypted persistiert)

### 4. Authorize klicken

Browser geht zu GitHub → Consent → kommt zurück → "Authorisiert ✓".

### 5. Tools-Discovery

Manueller Refresh oder Cron-Tick → tools/list läuft → Tools tauchen auf.

## Multi-Origin

mcp-approval2 läuft auf mehreren Origins parallel:
- `https://mcp-approval2.fly.dev` (Fly-Default)
- `https://mcp2.ai-toolhub.org` (CF-Custom-Domain)
- `https://app2.ai-toolhub.org` (PWA-Standalone-Domain)

In der GitHub-App müssen **alle 3 Callback-URLs registriert** sein:
```
https://mcp-approval2.fly.dev/oauth/sub-mcp-callback
https://mcp2.ai-toolhub.org/oauth/sub-mcp-callback
https://app2.ai-toolhub.org/oauth/sub-mcp-callback
```

(Die Server-Side `canonicalRedirectUri` wird aus den `x-forwarded-host`/`-proto`-
Headern des Edge-Requests gebaut → matcht die Origin auf der der User die PWA
gerade nutzt.)

## Lessons-Learned (Iterationen 2026-05-17)

Dokumentation der Bauphasen damit künftige Sub-MCP-OAuth-Integrationen nicht
wieder dieselben Bugs durchlaufen.

| # | Problem | Symptom | Fix-Commit |
|---|---|---|---|
| 1 | PWA generierte redirectUri als Hash-Route `/#/tools/servers/<name>/oauth/callback` | "Url must be a valid URL" beim Save in GitHub-App-Settings + "redirect_uri is not associated" beim Authorize. RFC 6749 §3.1.2 verbietet Fragments. | `0dd7d54` — Server-Side Bridge-Endpoint `/oauth/sub-mcp-callback` |
| 2 | Bridge-Location-Header mit `http://` statt `https://` | OAuth-Code-Stripping + Mixed-Content-Warnings. Hono `c.req.url` zeigt internen Fly-Proxy-Hostname. | `1029a7c` — `x-forwarded-proto`-Header als Scheme-Quelle |
| 3 | User-Browser servierte alten PWA-Bundle aus Service-Worker-Cache | Authorize-URL hatte trotz Deploy weiter `%23` (`#`) im redirect_uri. | `3a2ca7d` — SW-CACHE_VERSION-Bump zur Re-Activation |
| 4 | SW v4 cached den sw.js-Request selber → neuer SW kommt nie ins "installing" | `Clear site data` als einzige zuverlässige Workaround → User-Frustration | `04e2b58` — Server-Side Override: redirect_uri aus body wird ignoriert, server-side aus Request-Origin gebaut |
| 5 | GitHub-App strict-string-Match: `redirect_uri=…/oauth/sub-mcp-callback?name=github` matched NICHT die registrierte `…/oauth/sub-mcp-callback`-URL (ohne Query) | "redirect_uri is not associated" trotz korrekter Registration | `4604ca7` — Stateless Bridge: `sub_mcp_name` kommt aus DB-Lookup auf state, nicht aus Query-Param. redirect_uri ist KONSTANT pro Origin. |

### Iterationen 2026-05-18 (Sub-MCP-OAuth-Saga: cf + github tools/list + gws + gcloud)

| # | Problem | Symptom | Fix-Commit |
|---|---|---|---|
| 6 | `cf` baseUrl `/sse` (legacy SSE-Transport, GET subscribe) | POST mit JSON-RPC body → HTTP 404 | `cc1e29c` — baseUrl auf `/mcp` (Streamable HTTP). `buildMcpUrl()`-Helper unverändert (path-aware) |
| 7 | CF DCR-Endpoint geraten als `/oauth/register`, real ist `/register` | "DCR-Register fehlgeschlagen: HTTP 404" | `d063f31` — `.well-known/oauth-authorization-server` discovery-verified. Same für `/token` (NICHT `/oauth/token`) |
| 8 | CF MCP requires `Mcp-Session-Id`-Header (Streamable-HTTP-Spec) | `HTTP 400 body={"error":{"code":-32000,"message":"Bad Request: Mcp-Session-Id header is required"}}` | `787bd46` — `initialize`-Handshake auf 400+session-required (discovery + forwarder). Stateless Server zahlen keinen Overhead (1. Versuch klappt). |
| 9 | `response.json()` konsumiert Body → SSE-Fallback wirft "body already read" | "tools/list body not parseable" ohne body-Detail | `dfb5c09` — body EINMAL als text lesen, beide Parser auf String. Error-Message enthält content-type + snippet. |
| 10 | GitHub macht ROTATING refresh-tokens — wir verwarfen das neue `refresh_token` aus der Response | OAuth-Callback klappt, 8s später `bad_refresh_token` | `92b95c7` — enricher persistiert rotated refresh_token via `config.set(userId, sub, '_oauth_refresh_token', new)` |
| 11 | v1 mcp-gws Worker liefert in `tools/list._meta.oauth.scopes` nur 3 Scopes (Stub). Discovery überschrieb unsere Seed-16-Scope-Liste | Google-Consent zeigte nur 3 Berechtigungen statt 16 (gws) | `4053a61` — `registry.updateConfigSchema` MERGE statt REPLACE; `mergePreserveOperatorScopes()` schützt längere Seed-Listen |
| 12 | `shared-app` Branch in `UserServerOAuthService.start/callback` überschrieb per-User `_oauth_client_id` IMMER mit env-Wert | User trägt eigenen OAuth-Client ein → server nutzt trotzdem Doppler-Fallback → redirect_uri_mismatch | `e37b817` — `if (kind === 'shared-app' && !clientId)` — env nur als Fallback |
| 13 | External-MCP-Tool-Description > 1024 chars (z.B. github `pull_request_review_write`) → `validateToolDefinition` rejected | "tool 'github.pull_request_review_write': description > 1024 chars" — kompletter github-Import scheitert | `f5559ca` — `buildForwardedToolDefs` truncate auf 1021 + "..." |
| 14 | PWA renderte DCR-Server (cf) mit Pre-registered Client-ID/Secret-Form | Verwirrung: "Pre-registered OAuth 2.0: trage Client-ID + Secret ein" — aber DCR registriert auto | `e62fae3` — `renderOAuthFlow` branched auf `oauth.kind`: dcr → nur Authorize-Button; pre → Form; shared-app → Form |
| 15 | PWA `requiredCredentials.length > 0` zeigte "⚠ 1 fehlt" für OAuth-Gateways obwohl Flow erfolgreich war | Tool-Annotations deklarieren `provider='google-workspace'` (v1-credentials-Tabelle-Lookup), aber v2 speichert refresh_token in `user_sub_mcp_config` | `df55157` — `mapGateways` returnt `requiredCredentials: []` wenn `auth_mode='oauth' \|\| schema.oauth \|\| schema.innerOAuth` |
| 16 | gcloud-Auth-Tab zeigte nur OAuth-Form, keine `_service_account_json`/`_gcp_project_id`-Felder | User: "Wie konfiguriere ich gcloud? In den Setting-Menüs sollte drinstehen was ich konfigurieren muss." | `58a9c15` — `renderConfigFieldsForm` rendert server-deklarierte `config_fields[]`. Bei `_service_account_json` vorhanden: "Pfad A: Service-Account" + "Pfad B: User-OAuth" sections |
| 17 | PWA `help_url` mit ganzem Satz inkl. URL → kaputter `<a href="halber Satz">` | Mcp-gws Worker setzt `help_url='https://console... — OAuth-Client-ID erzeugen, Type "Web", Redirect-URI...'` | `dbeb7ea` — `renderHelpUrl` validiert mit `/^https?:\/\/\S+$/.test()` + `new URL()`. Plain-text-fallback wenn ungültig |
| 18 | `https://www.googleapis.com/auth/generative-language` (ohne Suffix) existiert nicht bei Google | "Some requested scopes cannot be shown — Fehler 400: invalid_scope" | `2d0d2f0` — nur `.tuning` + `.retriever` Sub-Scopes. Doku in [terraform/environments/privat/google-oauth-consent.md](../../terraform/environments/privat/google-oauth-consent.md) korrigiert |
| 19 | Google OAuth-Consent-Screen-Scope-Liste ist NICHT TF-managbar (kein Provider, keine API) | Bei neuem GCP-Projekt müssen alle ~17 Scopes manuell in Console eingetragen werden | `8cacb1a` — [terraform/environments/privat/google-oauth-consent.md](../../terraform/environments/privat/google-oauth-consent.md) als Source-of-Truth |

## Anti-Pattern (was NICHT machen)

- ❌ **PWA-Hash-Route als redirect_uri** — RFC-incompliant, GitHub rejected
- ❌ **Query-Parameter in redirect_uri** (z.B. `?name=github`) — strict-string-Match-Provider rejecten
- ❌ **redirect_uri aus Client-Request übernehmen** ohne Sanitize — Open-Redirect-Vektor
- ❌ **Service-Worker ohne Cache-Bust-Plan deployen** — User stecken im alten Bundle fest, Debugging-Hell
- ❌ **`response.json()` vor SSE-Fallback** — Body wird konsumiert, Fallback wirft. Pattern: `const text = await response.text(); try { JSON.parse(text) } catch { SSE-Parse(text) }`
- ❌ **Refresh-Token-Response ignorieren** — viele Provider rotieren (GitHub, Auth0, ...). `_oauth_refresh_token` IMMER persistieren wenn `response.refresh_token !== current`
- ❌ **Worker-`_meta`-Stub als Source-of-Truth nehmen** — Discovery liefert oft Mini-Bundle, Seed setzt operative Full-Bundle. `updateConfigSchema` MERGE statt REPLACE
- ❌ **Externe MCP-Tool-Descriptions ungeprüft registrieren** — Provider können > 1024 chars liefern. `buildForwardedToolDefs` truncated für externe, lokale Tools bleiben strict
- ❌ **`shared-app`-Branch ignoriert per-User-Override** — User mit eigenem OAuth-Client gewinnt vs Operator-env. `if (kind === 'shared-app' && !clientId)`
- ❌ **`help_url` als beliebige String-Annotation rendern** — defensiv mit `new URL()` + `/^https?:\/\/\S+$/` validieren, sonst plain-text fallback

## Provider-spezifische Quirks

Bekanntes Verhalten der unterstützten MCP-Server. Wichtig für neue Integrationen.

### Cloudflare-MCP (`bindings.mcp.cloudflare.com`)
- **DCR** (RFC 7591): kein User-Setup, auto-Registrierung beim ersten Authorize
- Endpoints (verified via `.well-known/oauth-authorization-server`):
  - `authorization_endpoint = /oauth/authorize`
  - `token_endpoint = /token` (NICHT `/oauth/token`)
  - `registration_endpoint = /register` (NICHT `/oauth/register`)
- **Streamable HTTP only**: POST `/mcp` mit JSON-RPC body. `/sse` ist legacy SSE (GET subscribe only) → POST liefert 404
- **Session-Pflicht**: jeder Call braucht `Mcp-Session-Id` aus `initialize`-Response
- **token_endpoint_auth_methods**: `client_secret_basic` + `client_secret_post` + `none` (public client möglich)
- **Scope-Default**: `mcp:tools`

### GitHub-MCP (`api.githubcopilot.com/mcp/`)
- **Pre-registered**: User muss eigene GitHub-App anlegen (NICHT OAuth-App)
- **Rotating refresh-tokens**: jede `/access_token`-Response enthält NEUEN `refresh_token`, alter wird nach 5min-Overlap invalidated. Persistenz Pflicht
- **baseUrl mit Pfad**: `/mcp/` → `buildMcpUrl()` muss path-aware sein (kein `/mcp`-Append)
- **Stateless Streamable HTTP**: kein Session-Handshake nötig
- **Tool-Description-Overflow**: einige Tools (z.B. `pull_request_review_write`) > 1024 chars → Truncate Pflicht
- **NICHT** im Catalog-Seed (a2283f7) — bleibt per-User managed um existing User-Setup nicht zu überschreiben

### Google Workspace + GCP (`accounts.google.com` AS)
- **`shared-app`-Strategy** + per-User-Override-Pattern: User kann eigene OAuth-App in PWA hinterlegen, sonst env-Fallback
- **OAuth Consent Screen Scope-Liste** ist Console-UI-only (kein TF, kein gcloud). Bei neuem Projekt manuell pflegen — Source-of-Truth: [terraform/environments/privat/google-oauth-consent.md](../../terraform/environments/privat/google-oauth-consent.md)
- **Test-User-Modus**: für Solo/Family ausreichend. Du selbst + max 100 Test-User. Production-Mode → Google-Verifikation (4-6 Wochen Prozess für restricted/sensitive Scopes wie `gmail.modify`, `drive`, `contacts`)
- **`prompt=consent`** Pflicht — sonst zeigt Google bei Re-Authorize nur den Delta zu schon-gewährten Scopes
- **`access_type=offline`** Pflicht — sonst kein `refresh_token` in der Callback-Response
- **Scope-Suffix-Trap**: `auth/calendar` existiert (full), `auth/generative-language` NICHT (nur `.tuning` + `.retriever`). Vor Scope-Add gegen Google's offizielle Liste verifizieren: https://developers.google.com/identity/protocols/oauth2/scopes
- **API-Aktivierung**: scope reicht nicht — API muss im Projekt unter https://console.cloud.google.com/apis/library aktiviert sein, sonst 403 `SERVICE_DISABLED`

## Drei-Schicht-Modell (für OAuth-Diagnose)

Bei jedem 401/403/`access_denied`-Fehler systematisch durchchecken:

| Schicht | Was | Wo konfigurieren | Symptom bei Fehlen |
|---|---|---|---|
| **OAuth-Scope** | Was das Access-Token *darf* | OAuth Consent Screen → Scopes (Console) | Scope erscheint nicht im Consent-Screen / silent gedroppt |
| **API enabled** | Welche APIs das Projekt *zulässt* | Console → APIs & Services → Library | HTTP 403 `SERVICE_DISABLED` beim Call |
| **IAM-Rolle** | Was der Account auf Ressource *darf* | Console → IAM | HTTP 403 `permission denied` beim Call |

Alle drei müssen für jeden API-Call passen. Project-Owner haben implizit alle IAM-Rollen — bei Sub-User explizit zuweisen.

## Solo-Operator-Checkliste für neuen Sub-MCP

Wenn du einen neuen externen MCP-Server in den Catalog-Seed aufnehmen willst (cf+github+...):

1. **Discovery prüfen**: `curl https://<host>/.well-known/oauth-authorization-server` — gibt es die Datei? Welche Endpoints?
2. **Transport prüfen**: `curl -X POST https://<host>/mcp -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":"1","method":"tools/list"}'` ohne Auth — gibt's 401 oder 404? 401 = Streamable HTTP OK, 404 = falscher Pfad
3. **Session-Verhalten**: bei 401 mit valid Bearer → ist `Mcp-Session-Id` requested? (Body-Check)
4. **Refresh-Token-Rotation**: bei 2× refresh-grant mit demselben token nacheinander — failt der zweite mit `bad_refresh_token`? Dann Persistenz nötig
5. **Scope-Liste**: existieren alle Scopes? Per `https://developers.google.com/identity/protocols/oauth2/scopes` o.ä. cross-checken
6. **Tool-Description-Längen**: nach erstem `tools/list` prüfen — gibt's Tools > 1024 chars? Truncate ist schon drin (`buildForwardedToolDefs`), aber dokumentieren
7. **Seed-Eintrag**: `seed_oauth_catalog.ts` (extern) oder `seed_satellites.ts` (eigene Worker). `kind: 'dcr' | 'pre' | 'shared-app'`
8. **Enricher-Strategy**: `DEFAULT_AUTH_STRATEGIES` Map in `sub-mcp-auth-enricher.ts` ergänzen. Token-URL in `OAUTH_BEARER_TOKEN_ENDPOINTS`
9. **Redirect-URIs**: in Provider-Consent-Screen 3 URIs eintragen (fly.dev + mcp2 + app2)
10. **Smoke-Test**: PWA → Authorize → Re-Discover → tool-count > 0 → ein read-tool aus Claude.ai ausführen

## DB-Schema-Anker

Migration `0023_user_sub_mcp_oauth_state.sql`:
```sql
CREATE TABLE user_sub_mcp_oauth_state (
  state          TEXT PRIMARY KEY,    -- CSRF + state-Token (base64url)
  user_id        UUID NOT NULL,
  sub_mcp_name   TEXT NOT NULL,       -- Bridge-Lookup-Key
  code_verifier  TEXT NOT NULL,       -- PKCE
  redirect_uri   TEXT NOT NULL,       -- canonical, ohne Query
  created_at     BIGINT NOT NULL,
  expires_at     BIGINT NOT NULL      -- TTL 10 min
);
```

## Code-Anker

- Bridge: [`apps/server/src/routes/oauth-bridge.ts`](../../apps/server/src/routes/oauth-bridge.ts)
- OAuth-Start: [`apps/server/src/routes/me/servers.ts:365`](../../apps/server/src/routes/me/servers.ts) — `canonicalRedirectUri`-Bau
- OAuth-Service: [`apps/server/src/services/user-server-oauth.ts`](../../apps/server/src/services/user-server-oauth.ts)
- PWA-Authorize-Button: [`apps/web/src/server-config.ts:327`](../../apps/web/src/server-config.ts)
- PWA-Hash-Callback-Handler: [`apps/web/src/server-detail.ts`](../../apps/web/src/server-detail.ts) (Phase 3)
