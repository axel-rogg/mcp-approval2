# PLAN — Per-User MCP-Server-Store

> ⚠️ **Status:** Entwurf 2026-05-17 — wartet auf User-Approval.
> Zielarchitektur fuer per-User-Subscription, per-User-Config, User-Added-
> Servers + OAuth-Flow. Ersetzt den globalen-bearer-Token-Pattern fuer
> alle Sub-MCP-Server.

---

## Problem-Aussage

Aktueller Stand:
- `SUB_MCP_TOKEN_<NAME>` als operator-env-vars = global-shared, nicht user-specific.
- Sub-MCP-Worker (gws/gcloud) holen User-OAuth via approval2's `/internal/v1/credentials/resolve` — Schicht-2 ist also schon per-user, aber Schicht-1 (Server-Trust) ist global.
- Tools-Tab zeigt alle Server fuer alle User identisch — keine Subscription, keine Per-User-Config.
- User koennen keine eigenen MCP-Server hinzufuegen (nur via Doppler-Operator-Setup).

User-Wunsch (B-Variante, 2026-05-17):
> "Jeder User konfiguriert seinen eigenen Server. Wir koennen Defaults
> hinterlegen aber deaktiviert. User muss aktivieren + selber konfigurieren.
> Alle externen Configs und OAuth-Tokens speichern wir per User. Bearer-
> Token-Variante ist dirty — User soll seinen OAuth hinterlegen koennen.
> Wir brauchen einen Store fuer alle MCP-Server mit userspezifischen
> Daten und Configs."

---

## Architektur-Trennung

### Drei Schichten klar separiert

| Schicht | Was | Wo gespeichert | Lifecycle |
|---|---|---|---|
| **Server-Katalog** | Welche MCP-Server existieren (catalog defaults + user-added) | `sub_mcp_servers` Tabelle (global) | Operator pflegt defaults, User darf eigene hinzufuegen |
| **User-Subscription** | Welche Server hat User-X aktiviert | `user_sub_mcp_subscriptions` (per-user) | User toggle on/off |
| **User-Server-Config** | Pro-User pro-Server config + OAuth-Tokens | `user_sub_mcp_config` (per-user, KMS-encrypted) | User pflegt, KMS-verschluesselt |

### Schicht-1 vs Schicht-2 — was bleibt, was aendert sich

- **Schicht-1** (Bearer approval2 → Worker): bleibt operator-config (env). Ist Service-zu-Service-Trust, **nicht User-Facing**. UI verschleiert das komplett.
- **Schicht-2** (User-OAuth/PAT fuer External APIs): wandert von credentials-vault (global pro provider) in **per-user-per-server-config**. Damit kann ein User pro Server eigene Tokens pflegen statt ein global-shared "google-workspace"-Slot.

### Catalog-Defaults

Beim Boot seeded approval2 die bekannten Worker als Catalog-Defaults
(`is_catalog_default=TRUE, owner_user_id=NULL`):
- `utils` → `https://utils.ai-toolhub.org` (auth_mode='bearer', kein User-Config noetig)
- `gws` → `https://gws.ai-toolhub.org` (auth_mode='oauth-resolve' = user holt OAuth selbst, kein Bearer-Schicht-1)
- `gcloud` → `https://gcloud.ai-toolhub.org` (auth_mode='oauth-resolve')

Jeder User sieht diese Defaults als "Verfuegbar" im UI bis er sie aktiviert.

### KC2 Sonderfall

KC2 ist embedded (kc_wrappers) — nicht subscribable. UI zeigt's als
"Eingebaut" mit Disable nicht moeglich. Vorerst keine User-Config.

---

## Datenbank-Schema

### Migration 0015_user_sub_mcp_subscriptions.sql

```sql
CREATE TABLE user_sub_mcp_subscriptions (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name TEXT NOT NULL REFERENCES sub_mcp_servers(name) ON DELETE CASCADE,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name)
);
CREATE INDEX idx_subs_user ON user_sub_mcp_subscriptions(user_id);
CREATE INDEX idx_subs_enabled ON user_sub_mcp_subscriptions(user_id, enabled);
-- RLS: jeder User sieht nur eigene Subscriptions
ALTER TABLE user_sub_mcp_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ums_self ON user_sub_mcp_subscriptions
  USING (user_id::text = current_setting('app.current_user', true));
```

### Migration 0016_user_sub_mcp_config.sql

```sql
CREATE TABLE user_sub_mcp_config (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_mcp_name TEXT NOT NULL REFERENCES sub_mcp_servers(name) ON DELETE CASCADE,
  config_key   TEXT NOT NULL,  -- z.B. 'default_calendar', '_oauth_refresh_token', '_bearer_token'
  -- KMS-encrypted (analog credentials):
  wrapped_dek  BYTEA NOT NULL,
  kek_ref      TEXT NOT NULL,
  ciphertext   BYTEA NOT NULL,
  nonce        BYTEA NOT NULL,
  -- Metadata
  is_secret    BOOLEAN NOT NULL DEFAULT FALSE,  -- _-prefixed = secret, sonst plain
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sub_mcp_name, config_key)
);
CREATE INDEX idx_uconf_user ON user_sub_mcp_config(user_id);
ALTER TABLE user_sub_mcp_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY uconf_self ON user_sub_mcp_config
  USING (user_id::text = current_setting('app.current_user', true));
```

Konvention: `config_key` startet mit `_` wenn secret (z.B. `_oauth_refresh_token`,
`_bearer_token`). Sonst plain (z.B. `default_calendar`). UI rendert das anders
(password-input vs text-input, masked-display vs plain).

### Migration 0017_sub_mcp_servers_user_added.sql

```sql
ALTER TABLE sub_mcp_servers
  ADD COLUMN owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN is_catalog_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN config_schema JSONB;
-- config_schema kommt aus tools/list._meta.config_fields (siehe Worker-Section)
-- Beispiel:
-- {
--   "fields": [
--     { "key": "default_calendar", "label": "Default Kalender", "type": "text" },
--     { "key": "timezone", "label": "Timezone", "type": "select", "options": ["Europe/Berlin","UTC"] }
--   ],
--   "oauth": { "provider": "google-workspace", "scopes": [...], "kind": "dcr|pre" }
-- }

-- Existing Catalog-Defaults setzen:
UPDATE sub_mcp_servers SET is_catalog_default = TRUE
WHERE name IN ('utils', 'gws', 'gcloud');
```

---

## Backend-Services

### `services/user-subscriptions.ts`

```ts
interface UserSubscriptionsService {
  list(userId: string): Promise<UserSubscription[]>;
  setEnabled(userId: string, name: string, enabled: boolean): Promise<void>;
  isEnabled(userId: string, name: string): Promise<boolean>;
  bulkSubscribeDefaults(userId: string): Promise<void>; // bei first-login: defaults enabled=false einfuegen
}
```

### `services/user-server-config.ts`

```ts
interface UserServerConfigService {
  getAll(userId: string, serverName: string): Promise<Map<string, string>>; // decrypt-on-read
  get(userId: string, serverName: string, key: string): Promise<string | null>;
  set(userId: string, serverName: string, key: string, value: string): Promise<void>; // KMS-encrypt
  delete(userId: string, serverName: string, key: string): Promise<void>;
  // Helper: hole alle non-secret als plain-map fuer UI-Display
  getPublic(userId: string, serverName: string): Promise<Map<string, string>>;
}
```

KMS-Pattern analog `credentials.ts`: pro-Config-Eintrag ein DEK, gewrappt
mit user-KEK. Performance-Cache: in-memory pro-Request (kein cross-request-
Cache wegen Sicherheit).

### `services/user-added-servers.ts`

```ts
interface UserAddedServersService {
  addOwn(args: { userId, name, displayName, baseUrl, authMode }): Promise<SubMcpServerConfig>;
  removeOwn(userId: string, name: string): Promise<void>;
  // OAuth-Flow:
  startOAuth(userId: string, name: string): Promise<{ authorizeUrl: string; state: string }>;
  completeOAuth(userId: string, name: string, state: string, code: string): Promise<void>;
}
```

### `tools/kc_wrappers/forwarder.ts` Anpassung

ServiceTokenResolver wird per-user-aware:
```ts
async function resolveServiceToken(userId, serverName): Promise<string | null> {
  // 1. User-spezifisch (oauth-mode): hole _oauth_refresh_token aus
  //    user_sub_mcp_config + refresh wenn noetig
  // 2. User-spezifisch (bearer-mode): hole _bearer_token aus user-config
  // 3. Operator-fallback: env-var SUB_MCP_TOKEN_<NAME>
}
```

---

## HTTP-Endpoints

Alle unter `/v1/me/*` (auth required, NICHT admin-only):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v1/me/servers` | — | `{ subscribed: [], available: [] }` |
| POST | `/v1/me/servers` | `{ name, displayName, baseUrl, authMode }` | created server (user-added) |
| DELETE | `/v1/me/servers/:name` | — | 204 (nur fuer eigene) |
| PATCH | `/v1/me/servers/:name/subscription` | `{ enabled: bool }` | 204 |
| GET | `/v1/me/servers/:name/config` | — | `{ fields: { key: value } }` (secret-Werte als `***`) |
| PUT | `/v1/me/servers/:name/config/:key` | `{ value }` | 204 |
| DELETE | `/v1/me/servers/:name/config/:key` | — | 204 |
| POST | `/v1/me/servers/:name/oauth/start` | — | `{ authorizeUrl, state }` |
| POST | `/v1/me/servers/:name/oauth/callback` | `{ state, code }` | 204 (token gespeichert) |

### `/v1/inventory` aendert sich

- Filtert auf user-subscribed
- Plus `available`-Liste fuer catalog-defaults die User nicht aktiviert hat
- Pro Server: `configStatus: { authorized: bool, configComplete: bool, missingFields: string[] }`

### `/mcp tools/list` aendert sich

- Filtert auf user-subscribed-Server
- Native bleibt immer, KC2 bleibt immer

---

## OAuth-Flow im Detail

### DCR-Variante (Auto-Discovery)

User klickt "Aktivieren" auf einem Server mit `authMode='oauth-dcr'`:

1. PWA: `POST /v1/me/servers/:name/oauth/start`
2. Backend:
   - Fetch `<baseUrl>/.well-known/oauth-authorization-server`
   - DCR-Request gegen Server-`registration_endpoint`
   - Speichere `_client_id` + `_client_secret` (KMS) in `user_sub_mcp_config`
   - Generiere PKCE-`code_verifier` + `state`, store in temp-table (TTL 10 min)
   - Returnt `{ authorizeUrl: '<baseUrl>/oauth/authorize?...', state }`
3. PWA: `window.location.href = authorizeUrl`
4. User → Server-OAuth-Consent → redirect to `https://app2.ai-toolhub.org/#/tools/servers/:name/oauth/callback?code=...&state=...`
5. PWA `oauth-callback`-route: `POST /v1/me/servers/:name/oauth/callback { state, code }`
6. Backend:
   - Verify state (CSRF)
   - Token-Exchange `<baseUrl>/oauth/token` mit code + code_verifier
   - Store `_oauth_refresh_token` + `_oauth_access_token_expires_at` (KMS)
   - Set subscription.enabled=true
7. PWA toast "Authorisiert" + redirect zu `#/tools/servers`

### Pre-registered-Variante

User traegt selber `client_id` + `client_secret` ein → store als config → 
gleicher authorize-Flow nur ohne DCR.

### Bearer-Variante (legacy)

User traegt Plain-Token ein → store als `_bearer_token` (KMS) → 
ServiceTokenResolver liefert es bei Tool-Calls.

---

## Worker-Side (mcp-gws + mcp-gcloud)

Erweitere `tools/list`-Response um `_meta.config_fields` + `_meta.oauth`:

```ts
// mcp-gws server.ts
case 'tools/list': {
  const result = {
    tools: listTools().map(...),
    _meta: {
      config_fields: [
        { key: 'default_calendar', label: 'Default Kalender', type: 'text',
          required: false, placeholder: 'primary' },
        { key: 'default_timezone', label: 'Default Timezone', type: 'select',
          options: ['Europe/Berlin', 'UTC', 'America/New_York'],
          default: 'Europe/Berlin' },
      ],
      oauth: {
        provider: 'google-workspace',
        scopes: ['https://www.googleapis.com/auth/calendar',
                 'https://www.googleapis.com/auth/gmail.send'],
        // Wenn der Worker eigene OAuth-Authorize-URL macht (echtes DCR-Pattern):
        kind: 'dcr',
        // ODER pre-registered:
        // kind: 'pre', client_id: '...'
      },
    },
  };
  return { jsonrpc: '2.0', id, result };
}
```

approval2's Discovery (`refreshSubMcpToolCache`) liest `_meta` mit und
speichert in `sub_mcp_servers.config_schema`.

### Bonus: Worker-OAuth-Endpoint

Damit der Worker OAuth-DCR macht muss er einen OAuth-Authorization-Server
exposen (Standard `/oauth/authorize` + `/oauth/token`). Das ist im
Worker-Repo umzusetzen oder per externem Token-Service. **Wenn nicht
machbar**: bleibt's bei "bearer" fuer den gws-Worker, plus User-OAuth-
Token wandert in den per-user-config-Store (`_oauth_refresh_token`)
und der Worker holt es weiterhin via `/internal/v1/credentials/resolve`
(existing pattern). Heisst: User-Wert ist user-specific gespeichert,
auch wenn der Worker selbst kein OAuth-Server ist.

---

## PWA-Plan

### Routing

- `#/tools/servers` — Subscribed + Available
- `#/tools/servers/new` — Add-Server-Form
- `#/tools/servers/:name/config` — Per-Server-Config-Drawer
- `#/tools/servers/:name/oauth/callback` — OAuth-Redirect-Target

### Tools-Tab → Servers Sub-View

Zwei Sections:

**Section 1 — Aktiviert:**
- Card pro subscribed Server
- Header: name + tool-count + Status-Pill ("✓ Authorized" / "⚠ Config unvollstaendig")
- Actions: [Konfigurieren] [↻ Refresh] [✕ Deaktivieren]

**Section 2 — Verfuegbar (catalog defaults nicht aktiviert):**
- Card pro Server kompakter
- Beschreibung was der Server tut
- [Aktivieren] (= subscribe + redirect zu OAuth wenn noetig)

**Footer:** [+ Eigenen MCP-Server hinzufuegen]

### Per-Server-Config-Drawer

Eigene Hash-Route `#/tools/servers/:name/config`. Layout:
- Subscription-Toggle
- OAuth-Status mit [Re-Authorize] / [Revoke]
- Config-Felder dynamisch aus `config_schema.fields[]` gerendert
- [Speichern]
- (User-added only) [Komplett entfernen]

### Add-Server-Form

Eigene Hash-Route `#/tools/servers/new`. Felder:
- Name (slug)
- Display-Name
- MCP-URL
- Auth-Mode (Radio): Bearer / OAuth-DCR / OAuth-pre
- (bearer) Token-Input
- (oauth-pre) client_id + client_secret
- [Weiter] → bei OAuth: triggert oauth/start

---

## Implementierungs-Phasen

### Phase 1 (Foundation, ~3h)
- [ ] Migration 0015 (subscriptions)
- [ ] Migration 0016 (config)
- [ ] Migration 0017 (sub_mcp_servers extend)
- [ ] Service: UserSubscriptionsService
- [ ] HTTP: `GET /v1/me/servers` + `PATCH /v1/me/servers/:name/subscription`
- [ ] Inventory: per-user filtering basics
- [ ] PWA: Subscription-Toggle in Server-Card + "Verfuegbar"-Section

### Phase 2 (Per-User-Config, ~3h)
- [ ] Service: UserServerConfigService (KMS-encrypt)
- [ ] HTTP: config GET/PUT/DELETE
- [ ] PWA: Config-Drawer mit dynamischen Feldern
- [ ] Worker (gws/gcloud): `_meta.config_fields` in tools/list
- [ ] approval2 Discovery: persistiert `config_schema`

### Phase 3 (OAuth-Flow, ~3h)
- [ ] Service: OAuth-state-store (10-min-TTL)
- [ ] HTTP: oauth/start + oauth/callback
- [ ] PWA: oauth-callback-Route + Authorize-Button
- [ ] (Falls Worker DCR-fähig) Worker setup
- [ ] (Falls nicht) Token landet in user-config + Worker holt via existing resolve-Endpoint

### Phase 4 (User-Added-Servers, ~2h)
- [ ] Service: UserAddedServersService
- [ ] HTTP: POST + DELETE /v1/me/servers
- [ ] PWA: Add-Server-Form
- [ ] DCR-Discovery via well-known
- [ ] Tools-Forwarder: per-user-spezifische Server forwarden

### Phase 5 (Polish, ~1h)
- [ ] Tests
- [ ] Empty-States + Error-Handling
- [ ] Documentation in CLAUDE.md
- [ ] Migration-Smoke

**Total ~12h.**

---

## Risiken & Offene Fragen

1. **Race-Condition OAuth-Callback** — State CSRF protection muss strict sein.
   Mitigation: state in DB mit TTL 10 min + single-use.

2. **KMS-Encrypt Performance** — pro Tool-Call ein Decrypt fuer OAuth-Token.
   Mitigation: in-memory Cache mit kurzer TTL (60s) pro user/server.

3. **Worker-OAuth-Endpoint** — gws/gcloud expose heute KEINEN OAuth-Authorization-
   Server. Pre-registered-Modus reicht aber: User traegt Google-OAuth-client_id
   selbst ein (sein eigenes GCP-Projekt). Heisst: Phase 3 oauth-DCR ist evtl.
   nicht implementierbar fuer gws/gcloud; pre-registered + token-resolve via
   existing-credentials-pattern bleibt der praktikable Pfad.

4. **Default-Subscription bei First-Login** — soll fuer admin alle defaults auto-
   subscriben? Vorschlag: ja, single-user-pilot fuehlt sich sonst "leer" an.

5. **MCP-Tools/List-Filtering** — heutige `/mcp tools/list` ist nicht user-spezifisch.
   Multi-User-Pflicht: Filter on subscribed. Single-User aktuell egal.

6. **Migration-Aufwand bestehender Configs** — keine bestehenden user-configs
   heute. Greenfield, kein Migration-Pain.

7. **Bearer-Token-Legacy** — `SUB_MCP_TOKEN_*`-env-vars sollen bestehen bleiben
   als Operator-Fallback wenn kein per-user-token verfuegbar (z.B. fuer utils
   das stateless ist). Resolver-Pfad: user-config first, dann env-fallback.

---

## Approval-Required vom User

- [ ] Ist die Drei-Schichten-Trennung OK?
- [ ] Default-Subscription alle on (admin) oder alle off?
- [ ] OAuth-Modi: pre-registered reicht oder DCR auch noetig?
- [ ] KC2 als nicht-toggleable "embedded" oder doch subscribe-able?
- [ ] Phase-Reihenfolge OK oder andere Prioritaet?
