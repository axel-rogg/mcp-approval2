# PLAN: Multi-User Sub-MCP Auth (gws + gcloud per-User)

> **Status:** ✅ V2 + Worker-Patches code-complete 2026-05-17.
> **Datum:** 2026-05-17
> **Trigger:** User: "Jeder user muss bei gws seinen eigenen oauth client und secrets bringen. Meinen darf nur für Axel Rogg gelten."
> **Threat-Modell:** siehe [THREAT-MODEL.md](../../../THREAT-MODEL.md) — Audit-Trail-basiertes Modell, Operator-Trust akzeptiert für Pilot.

## Problem (vorher)

- **mcp-gws** war **single-user**: alle Tool-Calls nutzten `env.ALLOWED_EMAILS[0]` (= Axel) als User-Identity. Refresh-Tokens lagen im Worker D1 (`gws_tokens`-Tabelle) zentral. Alle V1+V2-User würden Axel's Google-Account benutzen.
- **mcp-gcloud** war **single-Service-Account**: alle Tool-Calls nutzten `env.GCP_SERVICE_ACCOUNT_JSON` zentral. Kein per-User-Konzept.

## Lösung — Pfad B (V2-Hub als OAuth-Authority)

V2 hält pro-User die OAuth-Credentials (Client-ID, Client-Secret, Refresh-Token) bzw. SA-JSON in `user_sub_mcp_config` (KMS-encrypted, RLS-protected). Vor jedem Sub-MCP-Forward refreshed V2 den Google-Access-Token und sendet ihn als HTTP-Header an den Worker. Der Worker nutzt den Header bevorzugt; fehlt er, fällt er auf seinen Legacy-D1-Lookup zurück (V1-Compat).

```
PWA User: Tools → gws → Auth-Tab
  [Client-ID]    (eigene Google-OAuth-App vom User)
  [Client-Secret]
  [▶ Authorize]  → Google-Consent für eigenen Account
                  → Refresh-Token KMS-encrypted in V2 user_sub_mcp_config
                    AAD = "generic|user_sub_mcp_config|<userId>/gws/_oauth_refresh_token"

PWA User: Tools → gcloud → Auth-Tab
  [Service-Account-JSON] (textarea, ~1.6 KB)
  [Speichern]    → KMS-encrypted in user_sub_mcp_config[_service_account_json]

V2-Hub-Forwarder:
  Bei jedem gws-Tool-Call:
    1. config.getAllValues(userId, 'gws') → {_oauth_client_id, _oauth_client_secret, _oauth_refresh_token}
    2. POST oauth2.googleapis.com/token (grant_type=refresh_token) → access_token (TTL 1h)
    3. In-Memory-Cache 50min pro (userId, 'gws')
    4. Forward: Header X-Google-Access-Token + X-User-Email

  Bei jedem gcloud-Tool-Call:
    1. config.getAllValues(userId, 'gcloud') → {_service_account_json}
    2. Decrypt → plaintext SA-JSON
    3. Forward: Header X-GCP-SA-JSON

mcp-gws Worker:
  Wenn X-Google-Access-Token vorhanden → SCHNELLPFAD: Header-Token direkt nutzen,
    KEIN gws_tokens-D1-Lookup, KEIN eigener Refresh.
  Wenn fehlt → LEGACY: ALLOWED_EMAILS[0] + gws_tokens-Lookup (V1).

mcp-gcloud Worker:
  Wenn X-GCP-SA-JSON vorhanden → SCHNELLPFAD: Parse Header-JSON, Token-Refresh
    mit dem Per-User-SA.
  Wenn fehlt → LEGACY: env.GCP_SERVICE_ACCOUNT_JSON (V1 / single-SA).
```

## Implementation-Status

### V2-Hub (mcp-approval2)
- [x] `apps/server/src/services/sub-mcp-auth-enricher.ts` — neue Service-Klasse
- [x] `apps/server/src/mcp/gateway/types.ts` — `ForwardToolCallArgs.extraHeaders` Field
- [x] `apps/server/src/mcp/gateway/forwarder.ts` — merged extraHeaders in HTTP-Request
- [x] `apps/server/src/mcp/gateway/wrapper_tools.ts` — calls enricher pro tool-execute
- [x] `apps/server/src/app-factory.ts` — wire enricher early (vor buildSubMcpWrapperTools)
- [x] V2 Auth-Tab (Phase C aus PLAN-tools-tab-ux-refactor.md) — bereits OAuth-Flow-fähig

### Worker: mcp-gws (axel-rogg/mcp-gws)
- [x] `src/mcp/server.ts` — extract X-Google-Access-Token + X-User-Email aus Request
- [x] `src/gws/client.ts` — `gwsCall()` bevorzugt passed-token, fallback gws_tokens
- [x] `src/gws/client.ts` — `currentUserEmail()` bevorzugt passed-email, fallback ALLOWED_EMAILS[0]
- [x] `_meta.oauth` in `tools/list` deklariert (provider=google-workspace, scopes, URLs) — bereits da, wartet auf Re-Deploy

### Worker: mcp-gcloud (axel-rogg/mcp-gcloud)
- [x] `src/mcp/server.ts` — extract X-GCP-SA-JSON + X-GCP-Project-ID aus Request
- [x] `src/auth/credentials.ts` — `resolveAiCredentials()` bevorzugt passed-SA-JSON
- [ ] `_meta` in tools/list mit `auth_mode='service-account'` deklarieren (TODO Phase 2)

### PWA Auth-Tab Erweiterung (mcp-approval2)
- [ ] **TODO:** gcloud-Mode: Textarea für SA-JSON-Upload + Test-Button (validiert JSON-Format)
- [ ] **TODO:** Provider-spezifische Help-Texte ("So legst Du eine Google-OAuth-App an" für gws, "GCP-IAM Service-Account-Key herunterladen" für gcloud)

## Security-Modell

Sieh [THREAT-MODEL.md](../../../THREAT-MODEL.md) für Threat-Modell-Details. Kurzfassung:

- **Cross-User-Schutz:** RLS + KMS-DEK mit user-bound AAD (3 Schichten)
- **External Attacker:** OAuth+JWT-Auth gates everything; Worker prüft Bearer
- **Operator (Axel) mit DB+KMS-Access:** kann technisch decrypten, aber jeder Decrypt im GCP Audit-Log
- **Compromised Worker:** sieht plaintext nur im Memory zur Call-Zeit, kein Persistieren

Hardening-Roadmap (separat in THREAT-MODEL.md): Per-User-KEK, KMS-Decrypt-Alerts, optional PRF-Wrap auf Client-Secret.

## Migration-Pfad für `axelrogg@gmail.com`

1. Re-deploy mcp-gws Worker (mit X-Google-Access-Token-Reader)
2. Re-deploy mcp-gcloud Worker (mit X-GCP-SA-JSON-Reader)
3. V2 deploy (Auth-Enricher live)
4. In V2 PWA: Tools → gws → Auth-Tab → Client-ID + Client-Secret eigene OAuth-App eintragen → Authorize
5. In V2 PWA: Tools → gcloud → Auth-Tab → SA-JSON Upload (UI-Erweiterung Phase 2)
6. Bis Schritt 4/5 erfolgt: V1-Compat-Pfad greift, alles funktioniert für Axel wie bisher

## Open Questions / Future Work

1. **gcloud SA-JSON Project-ID inferieren** — heute aus separatem Header. SA-JSON enthält `project_id` field, könnten wir daraus lesen statt extra Header
2. **Per-User-Scopes** — User könnte minimale Scopes selbst wählen (vs heute fix in `_meta.scopes`)
3. **Token-Cache-Persistence** — heute in-memory pro V2-Instance, bei Fly-Multi-Machine inkonsistent. Spätere Optimierung: Redis/DB-Cache mit kurzer TTL
4. **Worker-Auth-Strictification** — Worker könnte erzwingen: "wenn X-User-Email != ALLOWED_EMAILS-csv → reject". Heute ist's nur ein Check in currentUserEmail. Wenn `gws_tokens` later removed: ALLOWED_EMAILS wird obsolet
5. **mcp-gws gws_tokens-Tabelle deprecieren** — sobald V2 alle gws-User versorgt mit X-Google-Access-Token UND V1 vollständig retired ist, gws_tokens-D1-Tabelle + /auth/gws-Endpoint im Worker entfernen
