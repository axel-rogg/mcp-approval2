# Sub-MCP-Server Migration Guide — Single-User-Bearer → Multi-User-JWT

**Status:** Draft (Phase 7 Pilot-Readiness)
**Last update:** 2026-05-13
**Plan-Reference:** [PLAN-architecture-v1.md](../plans/active/PLAN-architecture-v1.md) §5.4, §9
**Audience:** Maintainer der externen Sub-MCP-Worker (`mcp-gws`, `mcp-utils`, `mcp-gcloud`, plus Cloudflare-/GitHub-Gateways)

---

## TL;DR

In `mcp-approval` (v1) liefert ein Sub-MCP-Worker Tool-Ergebnisse fuer **einen** User — der Service-Bearer
ist gleichzeitig User-Authority. In `mcp-approval2` ist das Setup multi-tenant: jeder Tool-Call traegt einen
**kurzlebigen User-JWT** (60s TTL, HS256-signed by mcp-approval2, `aud=<sub-mcp-name>`, `sub=<user-id>`) im
`X-User-JWT`-Header. Der Sub-MCP-Worker selbst haelt **keinen User-Token mehr** — er holt jeden Token JIT
ueber `POST mcp-approval2/internal/v1/credentials/resolve`.

| | v1 (heute) | v2 (Multi-User) |
|---|---|---|
| Auth zum Sub-MCP | `Authorization: Bearer ${MCP_BEARER_TOKEN}` (= User-Token) | `Authorization: Bearer ${SERVICE_TOKEN}` (pre-shared, statisch) + `X-User-JWT: <hs256-jwt>` |
| User-Identitaet | implizit (1 User pro Worker) | aus `JWT.sub` (mcp-approval2 signt) |
| OAuth-Refresh-Tokens | lokal im Sub-MCP-D1 (`gws_tokens`) | nur in mcp-approval2 (`credentials`); Sub-MCP wird stateless |
| Token-Verify | nichts | `jwtVerify(jwt, JWT_SECRET, { issuer: 'mcp-approval2', audience: '<sub-mcp-name>', algorithms: ['HS256'] })` |
| Credential-Resolve | direkter D1-Read | `POST mcp-approval2/internal/v1/credentials/resolve` mit `X-Service-Token` + `user_jwt`-Body |

Ergebnis: Sub-MCP-Worker werden **stateless** — keine D1, keine eigenen OAuth-Tokens, keine User-Tabellen.
Skalierbar auf N Pilot-Tenants ohne Code-Change am Sub-MCP.

---

## 1. Migration-Schritte (5 Phasen)

### Phase 1 — Konfig & Secrets

Pro Sub-MCP-Worker setze die folgenden Env-Variablen:

| Var | Wert | Quelle |
|---|---|---|
| `SERVICE_TOKEN` | 32+ char random, pre-shared | beim Registrieren im mcp-approval2-Admin via `POST /v1/admin/sub-mcp/register` ausgegeben |
| `MCP_APPROVAL_BASE_URL` | `https://mcp.<tenant>.example.com` | Pilot-spezifisch |
| `MCP_APPROVAL_JWT_SECRET` | gleicher String wie `JWT_SECRET` von mcp-approval2 | aus OpenBao / Secret-Manager (Pilot-spezifisch) |
| `MCP_APPROVAL_JWT_ISSUER` | `mcp-approval2` | Default-Konstante |
| `SUB_MCP_NAME` | z.B. `gws`, `utils`, `cf` | siehe Registry |

> **Sicherheit:** `JWT_SECRET` ist symmetrisch geteilt. Rotation: koordiniert mit mcp-approval2 (siehe
> [runbook-token-rotation.md](../runbooks/runbook-token-rotation.md)). In Phase 8 wechseln wir auf RS256 +
> JWKS-Discovery (siehe Abschnitt 6 unten).

### Phase 2 — Auth-Middleware einbauen

Ersetze die alte einfache `Bearer`-Validation im Sub-MCP-Worker durch die zweistufige Auth aus dem
Template (siehe [sub-mcp-worker-template/src/auth.ts](./sub-mcp-worker-template/src/auth.ts)).

Pflicht-Eigenschaften:

1. Service-Bearer-Check **vor** JWT-Check.
2. Konstant-Zeit-Vergleich beim Service-Token (`timingSafeEqual` o.ae.).
3. JWT verifizieren mit `audience: SUB_MCP_NAME` — andernfalls 401.
4. JWT-TTL maximal 60s — `clockTolerance: 5s` ist OK.
5. `user_id = payload.sub`, `user_jwt = raw-string` in den Hono-Context.

### Phase 3 — Credential-Resolver einbauen

Pro Tool, das ein Provider-Credential braucht (z.B. Google OAuth, GitHub-PAT, Cloudflare-API-Key):

```ts
// Vor jedem upstream-Call: JIT-Credential ziehen.
const cred = await resolveCredential(c, {
  provider: 'google-workspace',  // oder 'github', 'cloudflare', ...
  label: 'default',
});
// cred.access_token ist request-scoped — NICHT cachen.
const resp = await fetch(upstream, {
  headers: { Authorization: `Bearer ${cred.access_token}` },
});
```

Siehe [sub-mcp-worker-template/src/credentials.ts](./sub-mcp-worker-template/src/credentials.ts) fuer die
Helper-Funktion. Sie verwendet `X-Service-Token` (Bearer-Alternative) und reicht `user_jwt`/`prf_session_id`
unveraendert weiter.

**Errors:**

| HTTP | Bedeutung | Reaktion im Sub-MCP |
|---|---|---|
| 200 | OK | `access_token` extrahieren |
| 401 | service-token oder jwt invalid | 502 zu mcp-approval2-Caller (Sub-MCP-Config-Fehler) |
| 404 | User hat dieses Credential nicht | 200 mit `result.content="kein <provider>-Credential konfiguriert"` |
| 428 | `prf_required` (Credential ist WebAuthn-PRF-locked) | 200 mit `result.content="bitte erst Approval in PWA bestaetigen"` + `isError=false`; mcp-approval2 triggert separat den Approval-Flow |

### Phase 4 — Lokalen Token-Storage zurueckbauen

In v1 hatten die Sub-MCP-Worker eine eigene D1-Tabelle (`gws_tokens` bei mcp-gws, `gh_tokens` bei
mcp-github usw.). In v2 entfaellt das komplett.

Migration-Reihenfolge fuer Pilot-Cutover:

1. **T-7 Tage:** mcp-approval2 importiert alle OAuth-Tokens via einmaligem ETL-Script aus dem v1-D1 nach
   mcp-approval2 `credentials`-Tabelle (encrypted DEK). Siehe runbook-pilot-onboarding.md §3.4.
2. **T-1 Tag:** Sub-MCP-Worker geht in dual-mode (alt: lokaler Storage; neu: JIT-Resolve). Feature-Flag
   `USE_JIT_CREDENTIALS=1` per Env-Var.
3. **T-0:** Cutover. `USE_JIT_CREDENTIALS=1` ist Pflicht; alte Tabelle nur noch read-only.
4. **T+30 Tage:** `DROP TABLE gws_tokens` (oder analog) — Recovery-Window vorbei.

### Phase 5 — Health-Check + Smoke

Sub-MCP-Worker exposed weiter `GET /health` → 200 ok (auth-frei).

Smoke-Test (vom Operator, einmalig nach Cutover):

```bash
# Auf mcp-approval2-Seite Test-JWT bauen (HS256, aud=gws, sub=<user>, 60s TTL)
TOKEN_RES=$(curl -X POST https://mcp.example.com/internal/v1/test-jwt-mint \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -d '{"sub_mcp_name":"gws","user_id":"<uuid>"}')
USER_JWT=$(echo "$TOKEN_RES" | jq -r .jwt)

# Direkt am Sub-MCP-Worker testen
curl -X POST https://mcp-gws.example.com/mcp \
  -H "Authorization: Bearer $SUB_MCP_SERVICE_TOKEN" \
  -H "X-User-JWT: $USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gws:calendar.list","arguments":{}}}'
```

Erwartung: 200 mit `result.content` enthaelt eine Calendar-Liste. Bei 401 → Auth-Middleware pruefen; bei 502
→ Sub-MCP konnte mcp-approval2 nicht erreichen (Network / Service-Token); bei 200 + `isError=true` →
upstream-API-Fehler (z.B. expired refresh-token im mcp-approval2-credentials-store).

---

## 2. Vorher-/Nachher-Flow

### Vorher (v1)

```
Claude Code
  │ Authorization: Bearer <user-bearer-from-mcp-approval-pwa>
  ▼
mcp-approval (single-user)
  │ Authorization: Bearer ${MCP_BEARER_TOKEN}     ← derselbe Token-Wert
  ▼
mcp-gws
  └─ liest gws_tokens(user=ALLOWED_EMAILS[0])     ← single-user implizit
     └─ calendar.list()
```

### Nachher (v2)

```
Claude Code
  │ Authorization: Bearer <oauth-access-token von mcp-approval2 /oauth/token>
  ▼
mcp-approval2 (multi-user)
  │ 1. Identity aus access_token → user_id
  │ 2. SignJWT({sub: user_id, aud: 'gws', iss: 'mcp-approval2', exp: now+60}, JWT_SECRET, HS256)
  │ 3. Forward via SubMcpForwarder:
  │    POST mcp-gws.example.com/mcp
  │      Authorization: Bearer ${SERVICE_TOKEN}       ← pre-shared service-token
  │      X-User-JWT: <jwt>                            ← user-scope
  ▼
mcp-gws  (stateless!)
  │ 1. Bearer == SERVICE_TOKEN?            (Schicht 1)
  │ 2. jwtVerify(X-User-JWT, JWT_SECRET, { aud: 'gws' })   (Schicht 2)
  │ 3. user_id = jwt.sub
  │ 4. POST mcp-approval2/internal/v1/credentials/resolve
  │       X-Service-Token: ${SERVICE_TOKEN}
  │       Body: { user_jwt, provider: 'google-workspace', label: 'default' }
  │    →  { access_token, expires_at }
  │ 5. calendar.list({ Authorization: Bearer <access_token> })
  ▼
Google API
```

---

## 3. Code-Beispiel — Komplett-Auth in Hono

Siehe [sub-mcp-worker-template/src/index.ts](./sub-mcp-worker-template/src/index.ts) fuer die volle
Implementierung. Hier nur das Skelett:

```ts
import { Hono } from 'hono';
import { jwtVerify } from 'jose';

const app = new Hono();

const JWT_SECRET = new TextEncoder().encode(process.env.MCP_APPROVAL_JWT_SECRET!);
const SERVICE_TOKEN = process.env.SERVICE_TOKEN!;
const SUB_MCP_NAME = process.env.SUB_MCP_NAME ?? 'gws';
const APPROVAL_BASE = process.env.MCP_APPROVAL_BASE_URL!;

app.get('/health', (c) => c.json({ status: 'ok', service: SUB_MCP_NAME }));

app.use('/mcp', async (c, next) => {
  // Schicht 1 — Service-Bearer
  const auth = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!constantTimeEqual(auth, SERVICE_TOKEN)) {
    return c.json({ error: 'service-token invalid' }, 401);
  }
  // Schicht 2 — User-JWT
  const userJwt = c.req.header('x-user-jwt');
  if (!userJwt) return c.json({ error: 'x-user-jwt missing' }, 401);
  try {
    const { payload } = await jwtVerify(userJwt, JWT_SECRET, {
      issuer: 'mcp-approval2',
      audience: SUB_MCP_NAME,
      algorithms: ['HS256'],
      clockTolerance: 5,
    });
    c.set('userId', payload.sub as string);
    c.set('userJwt', userJwt);
  } catch (e) {
    return c.json({ error: 'user-jwt invalid' }, 401);
  }
  await next();
});

app.post('/mcp', async (c) => {
  const userId = c.get('userId');
  const userJwt = c.get('userJwt');
  const body = await c.req.json();
  if (body.method !== 'tools/call') {
    return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unsupported' } });
  }
  // JIT-Credential
  const credResp = await fetch(`${APPROVAL_BASE}/internal/v1/credentials/resolve`, {
    method: 'POST',
    headers: {
      'X-Service-Token': SERVICE_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_jwt: userJwt,
      provider: 'google-workspace',
      label: 'default',
      sub_mcp_name: SUB_MCP_NAME,
    }),
  });
  if (!credResp.ok) {
    return c.json({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32603, message: `credential resolve failed: ${credResp.status}` },
    });
  }
  const { access_token } = (await credResp.json()) as { access_token: string };
  // Tool ausfuehren (Beispiel: gws:calendar.list)
  const upstream = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const data = await upstream.json();
  return c.json({
    jsonrpc: '2.0',
    id: body.id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      isError: !upstream.ok,
    },
  });
});

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default app;
```

---

## 4. Tests die der Sub-MCP-Maintainer fahren muss

Nach der Migration soll jeder Sub-MCP-Worker mindestens diese Tests bestehen:

1. **`GET /health` ohne Auth → 200**
2. **`POST /mcp` ohne Authorization → 401**
3. **`POST /mcp` mit falschem Service-Token → 401**
4. **`POST /mcp` mit gueltigem Service-Token, ohne `X-User-JWT` → 401**
5. **`POST /mcp` mit gueltigem Service-Token + abgelaufener JWT → 401**
6. **`POST /mcp` mit gueltigem Service-Token + JWT (wrong `aud`) → 401**
7. **`POST /mcp` mit voller Auth + `tools/list` → 200 mit `result.tools[]`**
8. **`POST /mcp` mit voller Auth + `tools/call` (echo-tool) → 200 mit Echo-Result**
9. **Credential-Resolve-Failure → graceful Error im Tool-Result**

Vitest-Beispiele liegen in [sub-mcp-worker-template/src/auth.ts](./sub-mcp-worker-template/src/auth.ts)
mit accompanying Test-Hooks.

---

## 5. Kein User-Token mehr in der PWA des Sub-MCP

In v1 hatten manche Sub-MCP-Worker eine eigene OAuth-Consent-Page (z.B. mcp-gws fuer Google-Workspace). In
v2 ist die Consent-Page **nur noch in mcp-approval2** — pro Provider und User wird dort der Refresh-Token
gespeichert. Der Sub-MCP-Worker hat **keinen User-Login mehr**, keine Cookies, keine WebAuthn-Surface.

Falls dein Sub-MCP-Worker einen alten OAuth-Callback-Endpoint hatte (`/auth/google/callback`,
`/auth/github/callback`): den **entfernen**. Stattdessen ruft mcp-approval2 den OAuth-Code direkt vom
Identity-Provider ab.

---

## 6. Roadmap: HS256 → RS256 + JWKS (Phase 8)

Aktuell laeuft die User-JWT-Validierung gegen ein shared `JWT_SECRET` (HS256). In Phase 8 wechseln wir auf
**RS256 + JWKS-Discovery**:

- Sub-MCP-Worker liest `MCP_APPROVAL_JWKS_URL=https://mcp.example.com/.well-known/jwks.json`
- `createRemoteJWKSet(jwksUrl)` cached die Keys 5 min
- JWT-Verify mit `algorithms: ['RS256']`
- Rotation in mcp-approval2 via env-Tausch der RSA-Keys ist transparent fuer den Sub-MCP — kein Re-Deploy

Der JWKS-Endpoint existiert heute schon (siehe `apps/server/src/mcp/oauth/jwks.ts`), aber er liefert NUR
den **Service-Boundary-Key** fuer mcp-knowledge2 — nicht den User-JWT-Signing-Key. Phase 8 fuegt einen
zweiten `kid` hinzu (`user-jwt-rs256`) und der Sub-MCP-Worker filtert per `kid`.

Der Code im Template ist schon RS256-ready (kommentiert) — bei Phase-8-Cutover nur
`MCP_APPROVAL_JWKS_URL`-Env-Var setzen und Code-Switch aktivieren.

---

## 7. Troubleshooting

| Symptom | Ursache | Fix |
|---|---|---|
| `401 service-token invalid` | Sub-MCP `SERVICE_TOKEN` != registriertem Hash | mcp-approval2-Admin re-register, neuen Token deployen |
| `401 user-jwt invalid` | `JWT_SECRET` mismatch oder `aud` falsch | beide Worker auf gleichen `JWT_SECRET` setzen, `SUB_MCP_NAME` checken |
| `401 jwt expired` | Clock-Skew zwischen Workern > 5s | NTP-sync auf beiden, `clockTolerance: 10` erhoehen |
| `502 credential resolve failed: 401` | Service-Token-Hash in `sub_mcp_servers` veraltet | mcp-approval2-Admin: re-register mit gleichem Plain-Token |
| `428 prf_required` | Credential hat `prf_enabled=true` ohne Approval | mcp-approval2 triggert PWA-Approval; Sub-MCP soll `isError=false` zurueck mit instruction-text |
| `200` aber `result.isError=true` | upstream-Provider-Error (expired refresh-token o.ae.) | mcp-approval2-Admin: re-link Credential im Settings-Tab |

---

## 8. Referenzen

- Template: [docs/migration/sub-mcp-worker-template/](./sub-mcp-worker-template/)
- Pilot-Smoke-Runbook: [docs/runbooks/runbook-pilot-smoke.md](../runbooks/runbook-pilot-smoke.md)
- ADR-0001 (DEK-Resolution-Strategy): [docs/adr/0001-...](../adr/) — context fuer Cross-Service-Auth
- mcp-approval2-Source:
  - `apps/server/src/mcp/gateway/forwarder.ts` — wie der Hub den JWT setzt
  - `apps/server/src/routes/internal/credentials.ts` — wie der JIT-Resolver verifiziert
  - `apps/server/src/mcp/gateway/registry.ts` — wie Service-Tokens gehasht + verifiziert werden
