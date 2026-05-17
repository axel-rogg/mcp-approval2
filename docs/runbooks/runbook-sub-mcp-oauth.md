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

## Anti-Pattern (was NICHT machen)

- ❌ **PWA-Hash-Route als redirect_uri** — RFC-incompliant, GitHub rejected
- ❌ **Query-Parameter in redirect_uri** (z.B. `?name=github`) — strict-string-Match-Provider rejecten
- ❌ **redirect_uri aus Client-Request übernehmen** ohne Sanitize — Open-Redirect-Vektor
- ❌ **Service-Worker ohne Cache-Bust-Plan deployen** — User stecken im alten Bundle fest, Debugging-Hell

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
