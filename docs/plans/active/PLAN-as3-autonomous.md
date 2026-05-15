# PLAN — mcp-approval2 AS-3 Proxy-Mode-Migration

> **Status: ⚠️ SPEC — pre-implementation, 2026-05-15**
>
> Dieses Dokument beschreibt **was in mcp-approval2 umgestellt werden muss**, damit
> mcp-knowledge2 autonom betrieben werden kann und mcp-approval2 **optional als
> Approval-Proxy davor** funktioniert (statt der heutigen harten Trust-Beziehung).
>
> Schwester-Dokument: [mcp-knowledge2/docs/plans/active/PLAN-as3-autonomous.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-as3-autonomous.md)
>
> Master-Implementations-Plan (Ein-Wurf-Cutover): [mcp-knowledge2/docs/plans/active/PLAN-as3-bigbang.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-as3-bigbang.md)
>
> Vorgänger / Baseline: [PLAN-architecture-v1.md](./PLAN-architecture-v1.md) (§3 Identity-Modell wird in §3.2 erweitert, JWT-zu-KC2-Trust-Modell wird ersetzt)

---

## 0. Ziel-Architektur (AS-3)

```
                        Google OIDC (Authoritative IdP)
                                    ▲
                                    │  ID-Token-Verify via Google-JWKS
                                    │
              ┌─────────────────────┴───────────────────┐
              │                                         │
   ┌──────────┴──────────┐                ┌─────────────┴────────┐
   │  mcp-approval2      │                │   mcp-knowledge2     │
   │  (THIS REPO)        │                │   (autonom)          │
   │                     │                │                      │
   │ • DCR-OAuth-Facade  │                │ • DCR-OAuth-Facade   │
   │ • Approval-Flow     │                │ • MCP-Endpoint /mcp  │
   │ • WebAuthn / PRF    │                │ • REST /v1/*         │
   │ • Credentials-Vault │                │ • own KMS (OpenBao   │
   │ • Sub-MCP-Gateways  │                │   or hkdf_local)     │
   │ • Tool-Surface      │                │ • own users-Tabelle  │
   │ • PWA               │                │                      │
   │                     │ S2S signed     │                      │
   │                     │ X-On-Behalf-Of │                      │
   │                     ├───────────────►│                      │
   └─────────────────────┘ + SERVICE_TOKEN└──────────────────────┘
              ▲                                       ▲
              │                                       │
       Claude.ai-MCP                          Claude.ai-MCP (direkt)
       (Proxy-Pfad, mit                       (autonomer Pfad,
        Approval-Flow)                         ohne Approval)
```

**Was sich für approval2 ändert:**
- approval2 wird **Resource-Server** gegenüber Google OIDC (statt selbst Authorization-Server für KC2 zu sein).
- KC2-Anbindung wechselt von "approval2 signs JWT, KC2 trusts via JWKS" zu "approval2 sends OBO-JWT + SERVICE_TOKEN, KC2 verifies both".
- approval2's eigene DCR-OAuth-Facade (existiert bereits unter `apps/server/src/mcp/oauth/`) bleibt für Claude.ai-MCP-Clients, aber Token sind jetzt Google-OIDC-rooted (`idp=google`, `idp_sub=<google-sub>`).
- PWA spricht weiter `/admin/kc-proxy/*` same-origin, aber Backend baut OBO-JWT statt service-token-only.
- Sub-MCP-Gateways (cf, github, gws, gcloud, utils) bleiben unverändert.
- Welle-3-Style `kc_wrappers/*` (analog v1) werden auto-generiert aus KC2's `tools/list` — KC2 als optionales Tool-Inventar.

| Aspekt | Heute (v1-baseline) | AS-3 (Ziel) |
|---|---|---|
| approval2 → KC2 Auth | `JwtSigner.sign({sub})` → Bearer | OBO-JWT (`X-On-Behalf-Of`) + `Authorization: Bearer <SERVICE_TOKEN>` |
| approval2 als IdP | implizit (signiert JWTs für KC2) | nur Facade für Claude.ai-MCP; Google ist Root-IdP |
| KC2-Direkt-Pfad (Claude.ai) | nicht möglich | unterstützt (KC2 hat eigene Facade) |
| PWA-`/admin/kc-proxy/*` | n/a (v2-Pilot, kommt jetzt rein) | OBO-Forwarding aus Session-User |
| KC2-Auth-Trust | KC2 ist RS gegenüber approval2 | KC2 ist RS gegenüber Google + Self + OBO(approval2) |
| `KnowledgeAdapter` | `JwtSigner` für Calls | `JwtSigner` produziert OBO-Tokens, `serviceToken` Pflicht |

---

## 1. Was sich konkret ändert (file-by-file)

### 1.1 OAuth-Facade (vorhanden, anpassen)

#### `apps/server/src/mcp/oauth/` (existierend)

Bereits vorhanden: `discovery.ts`, `register.ts`, `authorize.ts`, `token.ts`, `jwks.ts`, `revoke.ts`. Anpassungen:

- **`authorize.ts`**: Authorize-Code-Flow muss Google-IdP-Step durchlaufen statt direkt Approval-PWA-Login. Pattern: Authorize-Request setzt internen `state`, redirected zu Google, Google-Callback redirected zurück mit Authorization-Code.
- **`token.ts`**: Issued Tokens enthalten `idp=google`, `idp_sub=<google-sub>`, `sub=<internal-users.id>`. Token-Type ist Reference-Token (opaque, in DB nachgehalten) ODER signed-JWT (lokal verifizierbar). Empfehlung: signed-JWT mit `iss=https://approval2.<domain>`.
- **`jwks.ts`**: JWKS bereits publiziert. Stelle sicher dass `kid`-Rotation supported ist.

#### `apps/server/src/auth/idp/google.ts` (existierend)

Aktuell Google-Login-Adapter. Anpassen:
- Plus `verifyIdToken(token)` für inbound Tokens (wenn KC2 Google-Tokens direkt akzeptiert für PWA-Pfad und approval2 später diese auch nutzen will).
- Multi-Audience-Support: ID-Token akzeptiert von eigener `GOOGLE_OAUTH_CLIENT_ID` und (optional) von KC2's eigenem.

### 1.2 KnowledgeAdapter — Auth-Pattern wechseln

#### `packages/adapters/src/knowledge/http-client.ts` (umstellen)

**Heute** (Pseudo-Code):
```ts
const token = await jwtSigner.sign({ sub: userId, ttlSec: 60 });
fetch(`${baseUrl}/v1/objects`, {
  headers: { authorization: `Bearer ${token}` }
});
```

**Neu (AS-3):**
```ts
const oboToken = await jwtSigner.signOBO({
  sub: userId,
  aud: 'mcp-knowledge2',
  on_behalf_of: userEmail,
  approval_id,                  // optional, bei state-changing Ops Pflicht
  request_id,
  ttlSec: 120,
});
fetch(`${baseUrl}/v1/objects`, {
  headers: {
    authorization: `Bearer ${serviceToken}`,           // shared S2S secret
    'x-on-behalf-of': oboToken,                        // signed user assertion
    'x-request-id': request_id,
  }
});
```

#### `packages/adapters/src/knowledge/interface.ts` (Type-Erweiterung)

```ts
export interface JwtSigner {
  // bestehend
  sign(args: { sub: string; scope?: string; ttlSec?: number }): Promise<string>;
  // NEU
  signOBO(args: {
    sub: string;
    aud: string;
    on_behalf_of: string;
    approval_id?: string;
    request_id?: string;
    ttlSec?: number;
  }): Promise<string>;
}
```

Beide Methoden nutzen denselben Signing-Key (aus `mcp/oauth/jwks.ts`), nur unterschiedliche Claim-Sets.

#### `packages/adapters/src/knowledge/http-client.test.ts` (anpassen)

Tests müssen jetzt OBO-Header validieren statt nur Bearer-JWT.

### 1.3 PWA-Sonderpfad — kc-proxy

#### `apps/server/src/routes/kc-proxy.ts` (NEU, analog v1)

```ts
// PWA spricht /admin/kc-proxy/* same-origin
// approval2 verifiziert Cookie-Session, baut OBO-Token, forwarded an KC2

router.all('/admin/kc-proxy/*', async (c) => {
  const session = await verifySession(c);
  if (!session) return c.json({ error: 'login_required' }, 401);

  const user = await users.byId(session.userId);
  const obo = await jwtSigner.signOBO({
    sub: session.userId,
    aud: 'mcp-knowledge2',
    on_behalf_of: user.email,
    request_id: c.req.header('x-request-id') ?? uuidV4(),
    ttlSec: 60,
  });

  const targetUrl = c.req.url.replace('/admin/kc-proxy', '');
  return fetch(`${env.MCP_KNOWLEDGE_URL}${targetUrl}`, {
    method: c.req.method,
    headers: {
      authorization: `Bearer ${env.MCP_KNOWLEDGE_SERVICE_TOKEN}`,
      'x-on-behalf-of': obo,
      'content-type': c.req.header('content-type') ?? 'application/json',
    },
    body: c.req.method === 'GET' ? undefined : await c.req.text(),
  });
});
```

Mounted vor allen anderen `/admin/*` Routes. Filter Response-Headers (kein `set-cookie`-Passthrough).

### 1.4 MCP-Tool-Surface — KC2-Wrapper auto-generieren

#### `apps/server/src/tools/kc_wrappers/` (NEU)

Pattern wie in v1 (`mcp-approval/src/_to_delete/2026-05-13/tools/kc_wrappers/*` historisch). Aber **auto-generiert** beim Server-Start:

1. approval2 ruft beim Boot KC2's `POST /mcp` mit `method=tools/list`.
2. Für jedes Tool: erzeuge `ToolDef` mit
   - originalem Name, Description, Schema
   - Approval-Layer wenn `annotations.write===true` oder `sensitivity===high`
   - IPI-Fence wenn `annotations.user_content===true`
   - Handler ruft KC2 `tools/call` mit OBO-Forwarding (siehe §1.2)
3. Manifest cached, refresh per `*/5 * * * *`-Cron.

#### `apps/server/src/tools/registry.ts` (erweitern)

Bei Start: nach native Tools auch `kc_wrappers/*` aus Manifest-Cache laden.

### 1.5 Approval-Flow-Integration

#### `apps/server/src/services/approval/handler.ts` (erweitern)

Approval-Resolver erhält im Approval-Manifest jetzt zusätzlich:
- `target_service: 'knowledge2' | 'native'` — wohin geht der Call nach Approve?
- Bei `knowledge2`: nach Approve generiert handler OBO-JWT mit `approval_id=<approval.id>` als trail.

KC2 logged dann `via_proxy=true, approval_id=<id>` im Audit — Cross-Service-Audit-Trail.

### 1.6 Token-Lifecycle bei Approval-Wait

**Knirschpunkt:** User triggert write-tool, Approval-PWA-Wait dauert 2 min, User-Token läuft ab.

#### `apps/server/src/services/approval/wait.ts` (NEU oder erweitern)

Pattern:
1. Approval-Handler queued `pending_approval`-Row mit Tool-Args + User-ID (NICHT mit User-Token, der könnte ablaufen).
2. Nach Approve: handler generiert frischen OBO-JWT aus aktueller User-Identity, callt KC2.
3. Token-Lifetime in OBO ist 120s — passt für sub-Sekunden-Call-Roundtrip.

Damit ist Token-Expiry während Approval kein Problem mehr.

### 1.7 Env-Updates

#### `apps/server/.env.example` (erweitern)

```ini
# ─── mcp-knowledge2 Anbindung (Proxy-Pfad) ─────────────────────────────
# Wenn nicht gesetzt: approval2 ist standalone ohne KC-Anbindung
MCP_KNOWLEDGE_URL=http://localhost:8080
MCP_KNOWLEDGE_SERVICE_TOKEN=replace-with-32-byte-hex
# JWKS-URL der OAuth-Facade — bekanntgegeben an KC2 für OBO-Verify
SELF_OAUTH_ISSUER=https://approval2.<domain>
```

#### `apps/server/src/schema/env.ts` (update)

- Optional `MCP_KNOWLEDGE_URL` + `MCP_KNOWLEDGE_SERVICE_TOKEN`. Wenn nicht gesetzt → approval2 läuft im "ohne KC" Modus (für Setups die nur approval2 wollen).

### 1.8 Was BLEIBT

- Eigene DCR-OAuth-Facade unter `apps/server/src/mcp/oauth/` (Claude.ai-MCP-Auth)
- WebAuthn + PRF + Recovery (unchanged)
- Approval-Flow + PWA (Display, Confirm, Audit) — unchanged
- Sub-MCP-Gateways cf/github/gws/gcloud/utils — unchanged
- Credentials-Vault + OpenBao Transit-Engine — unchanged
- IPI-Output-Filter — unchanged
- Native Tools (non-KC: cf-mgmt, prefs, capability_search etc.) — unchanged

---

## 2. Cross-Service-Verträge

### 2.1 OBO-JWT Format (approval2 → KC2)

```ts
{
  iss: 'https://approval2.<domain>',
  aud: 'mcp-knowledge2',
  sub: '<approval2-internal-users.id>',       // User-ID in approval2
  on_behalf_of: '<google-email>',             // KC2 nutzt das für eigenes users.email-Lookup
  approval_id: '<uuid>',                       // optional, bei state-changing Tool-Calls Pflicht
  request_id: '<uuid>',
  exp: now + 120,                             // 2min lifetime
  jti: '<uuid>',                              // replay-prevention
}
```

Signing-Algorithmus: EdDSA, JWKS publiziert unter `/.well-known/jwks.json` von approval2's Domain. KC2 cached die JWKS-Map 24h.

### 2.2 KC2 hat eigene users-Tabelle

approval2 und KC2 haben **getrennte users-Tabellen**. Mapping läuft über `email` (case-insensitive, citext).

Vorteil: KC2 kann auch ohne approval2 betrieben werden (Direkt-Pfad), bringt eigene User-Identität mit.
Nachteil: Sync — wenn approval2 einen User suspended, muss KC2 nachziehen.

**Sync-Pattern:** approval2 ruft KC2 `POST /v1/internal/users/sync` (service-token) bei jeder User-State-Änderung (create/suspend/erase). KC2 propagiert State.

Alternativ (Phase 5+): SCIM. Für Pilot zu komplex.

### 2.3 Token-Audience-Mapping

| Token-Quelle | `iss` | `aud` | wer verifiziert |
|---|---|---|---|
| approval2-DCR-Facade (Claude.ai gegen approval2) | `https://approval2.<domain>` | `mcp-approval2` | approval2 (für eigene Tool-Calls) |
| KC2-DCR-Facade (Claude.ai gegen KC2 direkt) | `https://knowledge.<domain>` | `mcp-knowledge2` | KC2 |
| approval2-OBO (S2S) | `https://approval2.<domain>` | `mcp-knowledge2` | KC2 |
| Google ID-Token (PWA-Login) | `https://accounts.google.com` | `<GOOGLE_OAUTH_CLIENT_ID>` | approval2 + (optional) KC2 |

KC2 akzeptiert in seinen `/v1/*`-Routen:
- Self-issued Tokens (`iss=knowledge.<domain>`)
- OBO-Tokens (`iss=approval2.<domain>`) **nur** wenn zusätzlich `SERVICE_TOKEN`-Bearer dabei

approval2 akzeptiert in seinen `/mcp`-Routen:
- Self-issued Tokens (`iss=approval2.<domain>`)
- **NICHT** KC2-Tokens — wenn jemand sich an KC2 angemeldet hat, soll er auch direkt mit KC2 reden, nicht über approval2 als Proxy

---

## 3. Migrations-Tasks (Code, in Reihenfolge)

> Detaillierte Reihenfolge im Big-Bang-Plan: [mcp-knowledge2/docs/plans/active/PLAN-as3-bigbang.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-as3-bigbang.md). Hier nur die Repo-internen Tasks.

| # | Task | Estimate | Blocker? |
|---|---|---|---|
| A1 | `JwtSigner.signOBO()` Implementation + Tests | 4h | nein |
| A2 | `KnowledgeAdapter` HTTP-Client umstellen auf OBO-Pattern | 4h | A1 |
| A3 | Adapter-Tests anpassen (alle bestehenden Tests, ~40 Cases) | 6h | A2 |
| A4 | `apps/server/src/routes/kc-proxy.ts` (NEU) | 1d | A1 |
| A5 | OAuth-Facade `token.ts` mit `idp=google`-Claims | 4h | nein |
| A6 | OAuth-Facade `authorize.ts` mit Google-IdP-Redirect-Flow | 1d | A5 |
| A7 | Google-Callback-Handler in `auth/idp/google.ts` erweitern | 4h | A6 |
| A8 | `apps/server/src/tools/kc_wrappers/` Auto-Generator | 2d | A2 |
| A9 | KC2-Manifest-Refresh-Cron (5min) | 4h | A8 |
| A10 | Approval-Handler erweitern um `approval_id` in OBO einzubinden | 4h | A1 |
| A11 | User-State-Sync to KC2 (`/v1/internal/users/sync`-Call) | 1d | KC2-side ready |
| A12 | Env-Schema + `.env.example` updates | 2h | parallel |
| A13 | E2E-Smoke: PWA → kc-proxy → KC2 mit echtem User-Token | 1d | A4, KC2-side ready |
| A14 | E2E-Smoke: Claude.ai → approval2 → KC2 mit Approval-Flow | 1d | A8, A10 |
| A15 | E2E-Smoke: Claude.ai → KC2 direkt (sanity, dass Proxy nicht blockt) | 4h | KC2-side ready |

**Summe:** ~10-12 Personen-Tage.

---

## 4. Open Decisions

| ID | Frage | Default-Vorschlag |
|---|---|---|
| A-D1 | KC-Tool-Wrapping: Manifest beim Boot ODER lazy-on-first-call? | Beim Boot. Plus 5min-Refresh-Cron. Boot-Failure wenn KC2 nicht erreichbar → graceful: ohne KC-Wrappers starten, log warning. |
| A-D2 | Approval-Pflicht: pro KC-Tool aus KC-Manifest-Annotation ODER aus approval2-Override-Liste? | Manifest-Annotation als Default, Override-Liste in approval2-Config möglich (override-up = restriktiver, override-down nicht erlaubt) |
| A-D3 | `SERVICE_TOKEN`-Rotation Frequency? | 30d, aktive + previous accepted für 7d Overlap |
| A-D4 | OBO-`jti`-Replay-Detection? | Phase 1: nein (Lifetime 120s reicht). Phase 2: KC2-side Redis-Cache wenn high-traffic |
| A-D5 | Wie verhalten wenn `MCP_KNOWLEDGE_URL` nicht gesetzt? | approval2 läuft ohne KC-Tools, native Tools + Gateways verfügbar |
| A-D6 | User-Sync: pull (KC2 fragt approval2) oder push (approval2 ruft KC2)? | Push, weil approval2 ist User-Owner |
| A-D7 | Welche Tools brauchen `approval_id` in OBO? | Alle mit `annotations.write===true`. Reads ohne approval_id ok. |

---

## 5. Akzeptanz-Kriterien

- [ ] `JwtSigner.signOBO()` produziert spec-konformen OBO-JWT
- [ ] `KnowledgeAdapter` sendet `X-On-Behalf-Of` + `Authorization: Bearer <service-token>` an KC2
- [ ] Alle bestehenden 148+ Tests grün nach Adapter-Umstellung
- [ ] `/admin/kc-proxy/*` PWA-Pfad funktioniert E2E (Session-User → KC2 sieht ihn als `app.current_user`)
- [ ] `kc_wrappers/*` werden beim Boot generiert aus KC2's `tools/list`
- [ ] Approval-Flow setzt `approval_id` in OBO, KC2-Audit zeigt Verbindung
- [ ] User-Sync funktioniert: User-Create in approval2 → erscheint in KC2-users
- [ ] Claude.ai kann sich gegen approval2 anmelden (DCR-Facade), Tools-Surface enthält KC-Wrappers
- [ ] Direkt-Pfad (Claude.ai → KC2) funktioniert parallel, ohne approval2-Beteiligung
- [ ] Wenn `MCP_KNOWLEDGE_URL` ungesetzt: approval2 startet sauber ohne KC-Wrappers

---

## 6. Was NICHT Teil von AS-3 ist (Scope-Fence)

- Token-Exchange (RFC 8693) — wir bleiben bei OBO-Pattern
- SCIM-User-Sync — push-pattern reicht für Pilot
- Multi-IdP-Support neben Google — Phase 5+
- KC2-Tool-Filter-UI (approval2-side override) — nice to have, nicht im Cutover
- Direct-PWA-zu-KC2-Calls aus Browser-JS — bleibt bei Proxy-Pattern
