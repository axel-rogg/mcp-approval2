# PLAN: Per-User OAuth-Pipeline für Sub-MCP-Gateways

> **Status: ✅ Code-Complete 2026-05-18.** Multi-User OAuth-Roundtrip
> live für `cf` (Cloudflare-MCP, DCR), `gws` (Google Workspace,
> shared-app), `gcloud` (GCP, shared-app + SA-Hybrid). `github` bleibt
> bewusst user-managed (existing per-User Setup; nicht Catalog).

## Motivation

User-Anliegen 2026-05-18:
- "Cloudflare-MCP funktioniert in v2 gar nicht — total falsch implementiert."
- "GWS auch falsch implementiert" (User musste refresh-token manuell aus
  GCP-Console kopieren, kein OAuth-Flow vom PWA aus).
- "GCloud katastrophal unbrauchbar" (Service-Account-JSON wurde bei
  jedem Tool-Call als `x-gcp-sa-json`-Header durch die Leitung geschickt
  — Private-Key in Plain).
- "Jeder Anwender muss seine eigenen MCP-Tools konfigurieren können,
  mehrere User müssen separate OAuth-Pfade durchlaufen."

## Architektur (3 Schichten)

### Schicht 1 — Boot-time Catalog-Seeds

| Datei | Was |
|---|---|
| `seed_satellites.ts` | Eigene Worker (utils/gws/gcloud) mit Bearer outer-auth. `innerOAuth`-Block deklariert pro Server den Inner-Auth-Modus (gws + gcloud: `kind='shared-app'`, scopes-Bundle). |
| `seed_oauth_catalog.ts` | Externe MCPs mit auth_mode='oauth' (cf: DCR). github bewusst NICHT — User behält manuell die Kontrolle. |

Beide schreiben `sub_mcp_servers.config_schema` mit top-level `oauth` +
`config_fields` (gelesen von `UserServerOAuthService.getOAuthSchema()`
und der PWA).

### Schicht 2 — Per-User OAuth-Flow

Tabellen:
- `user_sub_mcp_subscriptions` (0018) — per-User Server-Aktivierung
- `user_sub_mcp_config` (0019) — per-User OAuth-Credentials, AES-GCM mit user-AAD
- `user_sub_mcp_oauth_state` (0023) — PKCE-State 10min TTL
- `user_sub_mcp_tool_cache` (**0026 NEU**) — per-User Tool-Set für OAuth-Server

Route `/v1/me/servers/:name/oauth/start` + `/callback` (existing):
- `kind='pre'` (Legacy, github): client_id/secret manuell in user_sub_mcp_config
- `kind='dcr'` (cf): approval2 macht POST an `registration_endpoint`,
  speichert client_id+secret KMS-encrypted
- `kind='shared-app'` (NEU, gws/gcloud): client_id/secret aus env
  (`GOOGLE_WORKSPACE_CLIENT_ID/SECRET` → Fallback `GOOGLE_CLIENT_ID/SECRET`),
  refresh-token bleibt per-User

### Schicht 3 — Discovery + Forwarding

Discovery (`discovery.ts`):
- `refreshSubMcpToolCache` — global cache (service_bearer-Server) + alter
  operatorUserId-Pfad für `oauth-bearer`-Strategie
- `refreshUserSubMcpToolCache` (NEU) — per-User-Pfad, schreibt in
  `user_sub_mcp_tool_cache`

Live-Refresh (`refresh.ts:applyGatewayDiscovery`):
- Wird nach jedem OAuth-callback aufgerufen → globaler tools_cache +
  ToolRegistry de-/re-register + per-User-cache als Bonus
- Wird auch vom admin-rediscover + Cron-Discovery genutzt

Forwarding (`wrapper_tools.ts`):
- `MakeForwardingToolArgs.subscriptionCheck` (NEU) — Defense-in-Depth
  pre-flight (403 wenn nicht subscribed, statt 401 vom Worker)
- `SubMcpAuthEnricher` injiziert inner-auth Header pro Server:
  - `gws`, `gcloud-oauth-pfad`: `x-google-access-token`
  - `gcloud-SA-pfad`: `x-google-access-token` + `x-gcp-project-id`
    (lokal JWT-Bearer-Grant via `services/google/sa-jwt-bearer.ts` —
    Private-Key verlässt approval2 nicht mehr)
  - `github` (oauth-bearer): `authorization: Bearer <token>`

`tools/list`-Filter (`transport.ts`):
- Per-User Subscription-Filter: pro Request wird `user_sub_mcp_subscriptions`
  geladen, Wrapper-Tools werden gefiltert.
- Native Tools (kein `.`) + KC-Wrapper (`kc.*`) immer sichtbar.

Cron (`sweep-oauth-state.ts`):
- Räumt pending oauth_state-Rows >10min
- Räumt stale tool_cache-Eintraege >30 Tage

## PWA (server-config.ts)

`OAuth-Schema.kind` erweitert um `'shared-app'`. Status-Hint + Button-Text
passen sich an:
- `pre`: "OAuth starten" + Hinweis "Trage zuerst _oauth_client_id ein"
- `dcr`: "OAuth starten" + Hinweis "approval2 registriert dynamisch einen Client"
- `shared-app+google`: "Verbinden mit Google" (direkt klickbar)

## Operator-Setup einmalig

| Action | Wert |
|---|---|
| OAuth-Consent-Screen in GCP-Console | Workspace-Scopes als Sensitive deklarieren (Calendar/Drive/Gmail/...) |
| Doppler `GOOGLE_WORKSPACE_CLIENT_ID` | OAuth-Client-ID der oben angelegten App (optional — Fallback auf GOOGLE_CLIENT_ID) |
| Doppler `GOOGLE_WORKSPACE_CLIENT_SECRET` | OAuth-Client-Secret (analog) |
| Worker mcp-gcloud Deploy | Push der `x-google-access-token`-Erweiterung (Commit cd83fb2 — kein wrangler-Auto-Deploy konfiguriert, manueller Push nötig) |

## Worker-Side Changes (mcp-gcloud)

Commit `cd83fb2` im `axel-rogg/mcp-gcloud`-Repo: zusätzliche Header-
Priorität `x-google-access-token` (preferred) > `x-gcp-sa-json` (legacy) >
env. Backwards-kompatibel.

## Status der Commits

1. `8da929d` — Naming-Cleanup: seedCfGateways → seedSatelliteWorkers
2. `c9d5933` — Catalog-Seed cf (+github, später entfernt)
3. `3141b47` — SA-JWT-Bearer lokal + `services/google/sa-jwt-bearer.ts`
4. `6c71044` — shared-app OAuth für gws + gcloud (innerOAuth in seed_satellites)
5. `a2283f7` — github raus aus Catalog + config_schema top-level
6. `dfb5c09` — Per-User Tool-Cache + Migration 0026 + discovery.ts
7. `0fcc431` — post-OAuth-callback ruft applyGatewayDiscovery (live re-register)
8. `04223ac` — tools/list-Subscription-Filter + Wrapper-Owner-Check
9. `895845b` — Cron sweep-oauth-state
10. `9105c85` — PWA shared-app + dcr UI-Hints

## Offen / Nicht im Sprint

- Multi-Tenant: per-User Tool-Set Filter (heute global cache + globaler
  wrapper-build; per-User cache wird zwar geschrieben aber tools/list-
  Filter nur per-Server, nicht per-Tool). Family-Mode reicht.
- mcp-gws Worker: shared-app schickt user-OAuth access_token an gws-
  Worker via `x-google-access-token` — Worker akzeptiert das bereits
  (kein Worker-Change nötig).
- Service-Account Worker-Phase-Out: `x-gcp-sa-json` bleibt im gcloud-
  Worker als Legacy-Pfad. Sobald alle Deploys den access_token-Pfad
  nutzen, kann der SA-JSON-Header entfernt werden.
- GitHub-MCP Catalog: bewusst weggelassen (User-Decision 2026-05-18).
