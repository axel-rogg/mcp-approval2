# PLAN — mcp-approval2 Architektur v1 (Decisions Complete)

> **Status: ✅ DECISIONS COMPLETE + IMPLEMENTATION-PHASEN 0-6 GESETZT (2026-05-13)**
>
> Codebase-Status: 4 Commits, 148 Tests grün, alle Workspaces tsc-clean.
> Detail-Stand: [docs/STATUS.md](../../STATUS.md). Verbleibende Lücken bis
> Pilot-Production dort dokumentiert (Approval-PWA-E2E, mcp-knowledge2-
> Service-Live, Sub-MCP-Migration, Cost-Controls, Production-Deploy).
>
> **Original-Status:** DECISIONS COMPLETE — Ready for Phase 0 (Skeleton)
>
> Erstellt: 2026-05-13. v0 (Decision-Document) abgeschlossen am 2026-05-13
> in einer Decision-Session (Bundle 1-6). Dieses File konsolidiert die
> 22 Entscheidungen aus der Session und ist die Implementation-Baseline.
>
> Begleitfile: [mcp-knowledge2 PLAN](https://github.com/axel-rogg/mcp-knowledge2)
> (paralleles Storage-Service-Repo, eigener Plan).
>
> ⚠️ **Konsolidierungs-Hinweis (2026-05-13):** Es arbeitet bereits ein
> paralleler Agent an mcp-knowledge2 mit einem eigenen Plan. Dieser
> mcp-approval2-Plan dokumentiert die mcp-knowledge2-Sektion (insb. §2.1
> Service-Boundary, §7 Storage-Service-Contract) NUR aus mcp-approval2-Sicht.
> Wenn der mcp-knowledge2-Plan finalisiert ist, muessen die Cross-Service-
> Stellen (JWT-Auth, GDPR-Erase-Cascade, Sharing-Schema) abgeglichen und
> konsolidiert werden. Bis dahin ist die hier dokumentierte mcp-knowledge2-
> Sicht ein **Soll-Zustand aus Caller-Perspektive**, nicht autoritativ
> fuer das Storage-Repo.
>
> v0-Vorgaenger: [PLAN-architecture-v0.md](./PLAN-architecture-v0.md) —
> Subagent-Recherche und Pattern-Optionen.

---

## 0. Decisions-Summary (Single-Source-of-Truth)

### Deployment & Tenancy

| Decision | Wahl |
|---|---|
| Primary-Deploy-Target | **Self-Host Postgres in EU** (spaeter GCP Cloud SQL EU-Region) |
| Cloudflare-Erlaubt | Ja (fuer Privat-Setup als sekundaerer Adapter) |
| Datenresidenz | **EU only** (DSGVO-Standard) |
| Tenancy-Modell | **Strikt Single-Tenant pro Instance** — eine Firma = eine Instance. Wenn 2. Firma dazukommt: zweite Instance forken (B-Pattern). Kein `tenant_id`-Column im Schema. |
| Multi-User innerhalb Tenant | Ja, 5-15 User pro Pilot-Instance. User-Isolation bleibt load-bearing. |

### Identity & Auth

> ⚠️ **AS-3-Update (2026-05-15):** `Identity-Provider` ist erweitert von
> "eigenes Google-OAuth" zu **AS-3 = Google OIDC als Authoritative IdP** (extern).
> mcp-approval2 ist Resource-Server, betreibt aber zusätzlich eine
> DCR-OAuth-2.1-Facade für Claude.ai-MCP-Clients (weil MCP-Spec DCR fordert).
> mcp-knowledge2 wird autonom und betreibt ihre eigene Facade. S2S via OBO-JWT.
> Details: [PLAN-as3-autonomous.md](./PLAN-as3-autonomous.md).

| Decision | Wahl |
|---|---|
| Identity-Provider | **Google OIDC (extern, AS-3)** — Eigene OAuth-Client-IDs für approval2 + KC2 |
| Bootstrap-Admin | **First-Login-First-Admin** — erster eingeloggter User wird Admin |
| Passkey-Anzahl | **1 Passkey** + Email-Recovery (Re-Enter-Akzeptanz fuer PRF-Credentials) |
| SCIM | **Phase 2 nichts** — spaeter wenn Enterprise-Customer nachfragt |
| WebAuthn-PRF | **Von Anfang an voll implementiert** — fuer alle sensitiven Credentials |

### Credentials & Crypto

| Decision | Wahl |
|---|---|
| KEK-Provider | **OpenBao Self-Hosted** (Transit-Engine, MPL2-Lizenz) |
| PRF-Layer | Von Anfang an aktiv |
| Credential-Storage | **Zentral in mcp-approval2** (Sub-MCP-Server holen JIT via interne API) |
| Sub-MCP-Auth-Strategien | **Pro Service entschieden** — OAuth wo verfuegbar (Atlassian/GitHub/Google), PAT/API-Token sonst (GitLab) |

### Storage & Sharing

| Decision | Wahl |
|---|---|
| Storage-Service | **Paralleles Greenfield-Repo mcp-knowledge2** (Multi-User-faehiger Storage) |
| Sharing-Logik-Location | **In mcp-knowledge2** (Storage-Service-Layer) |
| Sharing-Scope | **Docs + Skills + Apps** sind teilbar. **Credentials NIE teilbar** (owner-only-Garantie) |
| Service-Auth (mcp-approval2 → mcp-knowledge2) | **OBO-JWT (`X-On-Behalf-Of`) + `SERVICE_TOKEN`** (AS-3, 2026-05-15) — zwei-Faktor S2S. Vorher: JWT-signed-mit-user-Claim direkt. |

### Permissions

| Decision | Wahl |
|---|---|
| Admin-Rechte | **Admin sieht nur User-Liste + Audit-Log + Quotas** — keine User-Inhalte, kein Impersonation |
| User-Sharing | User koennen Docs/Skills/Apps teilen (Intra-Firma) |

### AI & Infrastructure

| Decision | Wahl |
|---|---|
| AI-Provider | **Google Vertex AI** (Gemini fuer Chat + text-embedding-005 fuer Embeddings, EU-Region) |
| Audit-Sink | **Schema ab Tag 1, Sink-Wahl mit Firma-IT spaeter** (OTel-export-faehig fuer SIEM-Integration) |

### Operativ

| Decision | Wahl |
|---|---|
| Engineering-Bandbreite | **Vollzeit ohne Pause** |
| Pilot-Start-Ziel | **12-14 Wochen** nach Phase-0-Start |
| Sub-MCP-Server | **Alle bestehenden uebernehmen** (cf, github, gws, gcloud, utils) |

---

## 1. Zweck & Anforderungen (aktualisiert)

### 1.1 Konkretisiert nach Decisions

1. **Solo-Greenfield-Engineering**, Vollzeit 12-14 Wochen bis Pilot-Start.
2. **Zwei parallele Repos**: mcp-approval2 (Auth/Approval/Tools) und
   mcp-knowledge2 (Storage/Sharing). Service-Boundary via JWT.
3. **Single-Tenant-Architektur** vereinfacht das Schema deutlich gegenueber
   v0: kein `tenant_id` als First-Class-Column, statt dessen Multi-User-
   Isolation via `owner_id`/`user_id`-Filter.
4. **Maximum-Hardening** bei Credentials: OpenBao + PRF + zentrale Storage.
   Operator-Compromise resistant.
5. **Portable Runtime** (Postgres-Self-Host primary, CF-Workers secondary
   fuer Privat). Adapter-Layer-Pattern beibehalten.
6. **Pro Firma eine Instance** (B-Pattern). Wenn weitere Firmen kommen:
   weitere Instances, nicht Multi-Tenant-Refactor.

### 1.2 Was sich gegen v0 vereinfacht

- **Kein RLS auf `tenant_id`** — RLS nur fuer `owner_id` und Sharing-Grants
- **Kein Tenant-Switcher in UI** — Single-Login, eine Firma
- **Kein SCIM-Stub** — Endpoints existieren nicht, koennen spaeter nachgeruestet
  werden
- **Vertex AI statt Multi-Provider** — eine Inference-API, weniger Komplexitaet
- **WorkOS nicht im Stack** — eigene Google-OAuth reicht fuer Pilot

### 1.3 Was sich gegen v0 verschaerft

- **PRF von Anfang an** statt schema-ready — mehr Engineering-Zeit (+1 Woche)
- **mcp-knowledge2 als eigener Service** statt Storage-Layer in mcp-approval2 —
  Service-Boundary kostet aber gibt klare Separation
- **Audit-Log ab Tag 1** mit voller Compliance-Story (immutable, exportable)

---

## 2. Architektur-Uebersicht (aktualisiert)

```
   MCP-Client (Claude.ai / Claude Code / Custom)
        │
        │ HTTPS, MCP-Streamable-HTTP, OAuth 2.1 + PKCE
        ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  mcp-approval2 (portable Hono.js)                            │
   │  Funktion: Auth, Approval-Flow, Tool-Surface, Credential-Vault│
   │                                                              │
   │  Request-Lifecycle:                                          │
   │  ┌──────────────────────────────────────────────────────┐    │
   │  │ 1. OAuth-2.1-Resource-Server: JWT validieren         │    │
   │  │ 2. Resolve user_id, sessions, role                   │    │
   │  │ 3. Rate-Limit pro User                               │    │
   │  │ 4. Tool-Dispatch via Registry, Permission-Check      │    │
   │  │ 5. Approval-Gate (WYSIWYS) fuer State-modifying      │    │
   │  │ 6. Credential-Resolver (Vault.unwrap + optional PRF) │    │
   │  │ 7. Tool-Execution (lokal ODER Sub-MCP-Forward)       │    │
   │  │ 8. IPI-Output-Filter                                 │    │
   │  │ 9. Audit-Log emit + Response                         │    │
   │  └──────────────────────────────────────────────────────┘    │
   │                                                              │
   │  Adapter-Layer (Runtime-agnostisch):                         │
   │   DbAdapter / BlobAdapter / KekProvider / AiAdapter          │
   │   AdapterImpls: Postgres+pgvector (Primary) / D1+Vec (CF)    │
   └──────────────────────────────────────────────────────────────┘
                              │
                              │ JWT (sub=user_id, signed by mcp-approval2)
                              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  mcp-knowledge2 (paralleles Greenfield-Repo)                 │
   │  Funktion: Storage-Service fuer Docs / Skills / Apps / Memos │
   │                                                              │
   │  • JWKS-Validation gegen mcp-approval2-Issuer                │
   │  • owner_id-Filter + Sharing-Grants                          │
   │  • Hybrid-Search (FTS + Vektor)                              │
   │  • Eigene Postgres / R2 / Vector-DB                          │
   │  • Eigenes Audit-Log                                         │
   └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Sub-MCP-Server (cf / github / gws / gcloud / utils)         │
   │  Funktion: spezielle Tools mit eigenen Backends              │
   │                                                              │
   │  • Holen User-Credentials JIT von mcp-approval2              │
   │  • Authn: Service-Account-Bearer + user-JWT                  │
   │  • Heute schon teilweise Multi-User-faehig (mcp-gws)         │
   └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌────────────────────────────────┐
              │ OpenBao (Vault-Fork, MPL2)    │
              │ Transit-Engine fuer KEK-Crypto │
              │ Audit-Trail aller Decrypts     │
              └────────────────────────────────┘
                              │
                              ▼
              ┌────────────────────────────────┐
              │ Google Vertex AI (EU-Region)   │
              │ Embeddings + Chat              │
              └────────────────────────────────┘
```

### 2.1 Service-Boundary mcp-approval2 ↔ mcp-knowledge2

**JWT-Pattern:**

```ts
// mcp-approval2 signt pro Storage-Operation einen kurzlebigen JWT:
const token = await sign({
  iss: 'mcp-approval2',
  aud: 'mcp-knowledge2',
  sub: user.id,                          // user_id, NICHT email
  scope: 'docs:write skills:read',       // optional fine-grained
  exp: now + 60                          // 60s lifetime, einmalig per Operation
}, signingKey);

// mcp-knowledge2 validiert:
const claims = await verify(token, jwks);
const userId = claims.sub;
// → owner_id-Filter mit userId
```

**Vorteile:**
- mcp-knowledge2 kann mcp-approval2 nicht imitieren (signed)
- Token-Replay-Window 60s, kein Refresh-Pfad noetig
- User-Identity kryptografisch durchgereicht — kein Trust-on-Trust

**Implementation:**
- mcp-approval2 exponiert `/.well-known/jwks.json` mit Rotating-Keys
- mcp-knowledge2 cached JWKS 24h, refresh-on-miss
- Beide Services: separate Postgres-Databases (kein Cross-DB-Zugriff)

---

## 3. Identity & Authentication (Single-Tenant-Variante)

### 3.1 User-Identity-Schema (vereinfacht)

```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY,
  external_id     TEXT NOT NULL,             -- Google-OAuth sub
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'invited' | 'suspended' | 'deleted'
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER,
  invited_by      UUID REFERENCES users(id),
  deleted_at      INTEGER
);

CREATE INDEX idx_users_external ON users(external_id);
```

**Kein `tenant_id`-Column.** Single-Tenant-Architektur. Wenn zweite Firma:
zweite Instance.

### 3.2 Invite-Flow (statt SCIM/Domain-Restriction)

```
Admin: POST /admin/invites { email }
  → DB-Row: users(email, status='invited', invited_by=admin.id)
  → Signed Magic-Link in Email (24h TTL)

User klickt Link → /accept-invite?token=...
  → Google-OAuth-Login (email MUSS match invitation)
  → users.status → 'active', external_id wird gesetzt
  → Passkey-Enrollment-Prompt
```

**Begruendung:** Single-Tenant + Eigene Google-OAuth heisst, dass JEDER mit
Gmail sich theoretisch registrieren koennte. Invite-Liste enforcet die
Membership. Alternative `@firma.de`-Domain-Restriction nicht moeglich, weil
User selbst entschieden: "jeder mit beliebiger Gmail".

### 3.3 First-Login-First-Admin Bootstrap

```ts
// Beim ersten /accept-invite ODER ersten direkten Login:
const userCount = await db.from('users').where(status='active').count();
if (userCount === 0) {
  newUser.role = 'admin';  // erster User wird Admin
  await auditLog('admin.bootstrap', { user_id: newUser.id });
}
```

Edge-Case: was wenn erste Person mit Gmail einfach `/auth/google/start`
aufruft, ohne Invite? Wir muessen einen Bootstrap-Gate haben:

- **Bootstrap-Mode:** wenn `users`-Tabelle leer ist, erster Google-Login wird
  akzeptiert + Admin-Status. Solange leer.
- **Steady-Mode:** wenn `users` >= 1, neue Logins muessen Invite-Token haben.
  Plain `/auth/google/start` ohne Invite-Token → 403.

### 3.4 Passkey-Enrollment

**1 Passkey Pflicht, Email-Recovery als Fallback.** PRF-Extension wird
bei Enrollment angefordert (`extensions: { prf: { eval: { first: salt } } }`).

```
Enrollment:
  1. WebAuthn-Register mit PRF-Extension
  2. PRF-Output wird waehrend Enrollment NICHT gespeichert (nur bei
     Login-PRF-Eval verfuegbar)
  3. credential_id, public_key in DB

Recovery (Passkey verloren):
  1. User klickt 'Forgot Passkey' → Email-Magic-Link (24h TTL)
  2. Link-Click + Google-Re-Auth → neuer Passkey-Enroll
  3. PRF-protected Credentials werden in DB markiert als 'invalidated'
     (nicht geloescht, nur read-only Status fuer Audit)
  4. User muss alle externen Tokens (Jira/GitLab/etc.) neu eintragen
  5. Audit-Log Event: 'passkey.recovery.completed'
```

### 3.5 Session-Management

- **Session-JWT**, 30 min TTL, signed by mcp-approval2
- **Refresh-Token** in HTTP-Only-Cookie, 30 Tage TTL, **rotation on use**
  (RFC 9700)
- **Replay-Detection:** alter Refresh-Token erneut benutzt → komplette
  User-Session-Familie revoked

---

## 4. Authorization (Permission-Model)

### 4.1 Roles

```
admin    — User-Verwaltung, Audit-Lese, Quotas, KEIN User-Daten-Zugriff
member   — Tools nutzen, eigene Daten + geteilte Daten lesen/schreiben
```

Kein Impersonation-Feature. Wenn Admin Support braucht: User-Email +
spezifischer Audit-Range, kein Live-Zugriff.

### 4.2 Sharing-Grants (in mcp-knowledge2 verwaltet)

```sql
-- IN mcp-knowledge2, nicht mcp-approval2:
CREATE TABLE share_grants (
  id           UUID PRIMARY KEY,
  resource_kind TEXT NOT NULL,        -- 'doc' | 'skill' | 'app'
  resource_id  UUID NOT NULL,
  granted_to   UUID NOT NULL,         -- user_id
  granted_by   UUID NOT NULL,         -- user_id (must be owner)
  scope        TEXT NOT NULL,         -- 'read' | 'write'
  granted_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX idx_grants_lookup
  ON share_grants(granted_to, revoked_at);
```

**RLS-Policy:**

```sql
CREATE POLICY user_can_read ON documents
  USING (
    owner_id = current_setting('app.current_user')::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user')::uuid
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > extract(epoch from now()))
    )
  );
```

**Credentials sind STRIKT owner-only** — kein share_grants-Eintrag fuer
`credentials`-Tabelle. RLS-Policy enforct das.

### 4.3 Sharing-Scope final

| Resource | Teilbar | Begruendung |
|---|---|---|
| `documents` (Wiki / Notizen) | ✅ Ja | Wissens-Sharing ist Kernfunktion |
| `skills` (Workflows / Prompts) | ✅ Ja | Team-Workflow-Reuse |
| `apps` (App-Instances) | ✅ Ja | Geteilte App-State (z.B. Team-Tracker) |
| `credentials` | ❌ Nein | Owner-only-Garantie, Compliance |
| `memos` (Personal Memory) | ❌ Nein | Default: persönlich. Spaeter ggf. opt-in shareable |
| `audit_log` | ❌ Nein | Admin liest, Owner sieht eigene Eintraege |

### 4.4 Defense-in-Depth

1. **App-Layer-Check:** vor jeder Storage-Operation `canAccess(user, action, resource)`-Helper aufrufen
2. **DB-Layer-RLS:** Postgres-Policy als Fallback
3. **Smoke-Test:** pro Endpoint Test "User A's Token darf nicht User B's Daten lesen"

---

## 5. Credentials & Crypto (KEK = OpenBao, PRF aktiv)

### 5.1 Schema

```sql
CREATE TABLE credentials (
  id              UUID PRIMARY KEY,
  owner_id        UUID NOT NULL REFERENCES users(id),
  provider        TEXT NOT NULL,             -- 'jira', 'gitlab', 'github', etc.
  kind            TEXT NOT NULL,             -- 'oauth_refresh' | 'api_token' | 'password' | 'service_account'
  label           TEXT NOT NULL,             -- 'work-jira', 'oss-github'

  -- Crypto-Material
  ciphertext      BYTEA NOT NULL,
  nonce           BYTEA NOT NULL,
  wrapped_dek     BYTEA NOT NULL,            -- vault.encrypt(dek, kek_ref)
  aad             TEXT NOT NULL,             -- 'creds|{owner}|{provider}|{kind}|{id}'
  kek_ref         TEXT NOT NULL,             -- 'vault://transit/keys/user-{id}'
  alg             TEXT NOT NULL DEFAULT 'A256GCM',

  -- PRF-Layer (immer Tag-1-Active)
  prf_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  prf_credential_id BYTEA,                   -- WebAuthn-credential-id

  -- Metadata (plaintext)
  meta_json       JSONB,                     -- scopes, host, expires_at-hint, etc.

  created_at      INTEGER NOT NULL,
  rotated_at      INTEGER,
  last_used_at    INTEGER,
  expires_at      INTEGER,

  UNIQUE (owner_id, provider, label)
);

CREATE POLICY owner_only_credentials ON credentials
  USING (owner_id = current_setting('app.current_user')::uuid);
```

### 5.2 OpenBao-Setup

**Deployment:**
- Eigener Service neben mcp-approval2 (Docker-Container im selben K8s/Compose)
- Eigene Postgres-DB (oder integrated SQLite-Backend)
- TLS zwischen mcp-approval2 ↔ OpenBao (interne PKI)
- **Per User ein Transit-Key:** `transit/keys/user-{user_id}` — ermoeglicht
  Crypto-Shredding bei User-Deletion (Key-Destroy)

**Auth-Flow mcp-approval2 → OpenBao:**
- AppRole-Auth: mcp-approval2 hat `role_id` (statisch) + `secret_id` (rotated)
- AppRole-Token TTL 1h, auto-renew
- Per-Request: kurzlebiger Token, kein langlebiges Bearer

**Operations:**
```
DEK-Wrap:   POST /v1/transit/encrypt/user-{id}  { plaintext: <dek-b64> }
DEK-Unwrap: POST /v1/transit/decrypt/user-{id}  { ciphertext: <wrapped-b64> }
Key-Destroy (GDPR-Erase): DELETE /v1/transit/keys/user-{id}
```

### 5.3 PRF-Layer (immer aktiv)

```ts
async function decryptCredential(cred: Credential, user: User, prfOutput: Uint8Array | null) {
  // Step 1: Vault-Unwrap DEK
  const rawDek = await vault.unwrap(cred.wrapped_dek, cred.kek_ref);

  // Step 2: PRF-XOR wenn aktiviert (alle Credentials in v1)
  let effectiveDek = rawDek;
  if (cred.prf_enabled) {
    if (!prfOutput) throw new Error('PRF_REQUIRED');
    effectiveDek = xor(rawDek, prfOutput);
  }

  // Step 3: AES-GCM-Decrypt mit AAD
  return aesGcmDecrypt(effectiveDek, cred.ciphertext, cred.nonce, cred.aad);
}
```

**UX-Flow pro Tool-Call der Credentials braucht:**

```
User → Tool-Call → Approval-Prompt in PWA →
  WebAuthn-Sign + PRF-Eval (gleicher Schritt!) →
  prfOutput zum Worker geleitet (in-memory, NICHT persisted) →
  Credential-Decrypt → API-Call → Tool-Result
```

Damit: PRF-Eval ist Teil des Approval-Flows. Tool ohne Approval kann keine
PRF-Credentials nutzen. Approval-Flow ist eh Pflicht fuer State-modifying
Tools (WYSIWYS). Konvergiert sauber.

**Sonderfall Cron-Tools (Background-Jobs):** koennen keine PRF-Credentials
nutzen. Mitigation:
- Cron-relevante Credentials werden im Onboarding als `prf_enabled=FALSE`
  markiert (User-opt-in pro Credential)
- Fuer Pilot: keine Cron-Tools → PRF kann fuer alle Credentials Default-on
  bleiben

### 5.4 Sub-MCP-Credential-Verteilung

Sub-MCP-Server (z.B. mcp-jira) holt JIT:

```
mcp-jira-Worker → 
  POST https://mcp-approval2/internal/v1/credentials/resolve
  Authorization: Bearer <service-account-token>
  X-User-JWT: <user-context-token>  (signed by mcp-approval2)
  Body: { provider: 'jira', label: 'work-jira' }
→
  mcp-approval2:
    1. Service-Account-Bearer validieren
    2. user-JWT validieren (sub = user_id)
    3. canAccess(user, 'read', credential) check
    4. Credential.decrypt (PRF-output muss bei vorhergehendem Approval
       schon eingeholt sein, kurzlebig im Session-Cache)
    5. Returns { access_token: '...', expires_at: ..., scope: '...' }
       (NUR access_token, NIE refresh_token oder PAT-Plaintext direkt)

mcp-jira-Worker speichert access_token request-scoped, NICHT persistent.
```

### 5.5 GDPR-Crypto-Shredding

```
User-Delete-Trigger (admin oder self):
  1. users.status → 'deleted', users.deleted_at → now
  2. 30-Tage-Grace-Period (UI zeigt 'Konto wird geloescht in X Tagen')
  3. Nach 30 Tagen, Cron triggert Hard-Delete:
     a. vault.destroyKey('transit/keys/user-{id}')
        → ALLE wrapped_deks fuer diesen User werden unrecoverable
     b. DELETE FROM credentials WHERE owner_id = ...
     c. DELETE FROM <user-content-tables> WHERE owner_id = ...
        (in mcp-knowledge2 via JWT-Delete-Call)
     d. audit_log Eintrag (PII pseudonymisiert)
```

**EDPB-konform:** Crypto-Key-Destroy + nachweisbar-unrecoverable Ciphertext
= Erasure-Erfuellung (Art. 17).

---

## 6. Audit-Logging (Schema-ready, Sink-Switch)

### 6.1 Schema

```sql
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY,
  ts            INTEGER NOT NULL,
  actor_user_id UUID,                       -- NULL fuer system events
  actor_type    TEXT NOT NULL,              -- 'user' | 'system' | 'admin'
  action        TEXT NOT NULL,              -- 'auth.login.success', 'credential.read', ...
  resource_kind TEXT,
  resource_id   UUID,
  before_hash   TEXT,
  after_hash    TEXT,
  ip            INET,
  user_agent    TEXT,
  request_id    UUID,
  result        TEXT NOT NULL,              -- 'success' | 'denied' | 'error'
  details       JSONB
);

CREATE INDEX idx_audit_actor_ts ON audit_log(actor_user_id, ts DESC);
CREATE INDEX idx_audit_action ON audit_log(action, ts DESC);
```

**Append-only:** DB-User der App hat NUR `INSERT`-Recht. Kein UPDATE, kein
DELETE. Selbst Operator-Admin kann nicht modifizieren (separate Read-Only-
User fuer Admin-View).

### 6.2 Sink-Adapter (Decision in Phase 1)

```ts
interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
  exportRange(from: Date, to: Date): AsyncIterator<AuditEvent>;
}

class PostgresAuditSink implements AuditSink { ... }
class GcsWormAuditSink implements AuditSink { ... }   // GCS Object-Lock
class OtelAuditSink implements AuditSink { ... }       // SIEM-Stream
class CombinedAuditSink implements AuditSink { ... }   // multi-sink
```

Default: `CombinedAuditSink(PostgresAuditSink, optional GcsWormAuditSink)`.
Konfigurierbar via Env-Var.

### 6.3 Pflicht-Events

- **Auth:** login.success/failed, logout, session.refresh, passkey.enrolled,
  passkey.recovered
- **Permission:** role.changed, share_grant.created/revoked, admin.bootstrap
- **Credential:** created, read (jeder Decrypt!), rotated, deleted
- **Data:** export, delete (GDPR)
- **Admin:** user.invited, user.suspended, user.deleted, settings.changed
- **Tool:** invoked (args-hash), approved, denied, completed (output-hash)

---

## 7. Storage-Service (mcp-knowledge2)

### 7.1 Service-Contract

mcp-knowledge2 ist ein eigener HTTP-Service mit JWKS-Validation gegen
mcp-approval2-Signer.

**Endpoints (REST):**
- `GET    /v1/documents`           — list eigene + geteilte
- `POST   /v1/documents`           — create
- `GET    /v1/documents/{id}`      — read
- `PATCH  /v1/documents/{id}`      — update
- `DELETE /v1/documents/{id}`      — owner-only
- `POST   /v1/documents/{id}/shares` — share with user
- (analog fuer skills, apps, memos)
- `POST   /v1/search`              — hybrid FTS + Vektor
- `POST   /v1/internal/erase-user` — Cascade-Delete bei GDPR-Erase

**Auth:** Per Request kurzlebiger JWT (60s) im Authorization-Header, signed
by mcp-approval2.

### 7.2 Schema (in mcp-knowledge2)

```sql
CREATE TABLE objects (
  id            UUID PRIMARY KEY,
  owner_id      UUID NOT NULL,
  kind          TEXT NOT NULL,         -- 'doc' | 'skill' | 'app' | 'memo'
  subtype       TEXT,
  
  title         TEXT,
  description   TEXT,
  keywords_json TEXT,
  
  body_inline   BYTEA,                 -- <=16 KB encrypted
  r2_key        TEXT,                  -- 'objects/<id>' im R2-Bucket
  body_hash     TEXT,
  
  visibility    TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'shared'
  
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE INDEX idx_objects_owner ON objects(owner_id, kind);

CREATE POLICY owner_or_shared ON objects
  USING (
    owner_id = current_setting('app.current_user')::uuid
    OR id IN (
      SELECT resource_id FROM share_grants
      WHERE granted_to = current_setting('app.current_user')::uuid
      AND revoked_at IS NULL
    )
  );
```

### 7.3 Vector-Storage (pgvector)

Pro Postgres-Instance ein `objects_vec`-Table mit `vector(768)` (Vertex AI
text-embedding-005-Dimension). RLS-Policy identisch zu objects-Tabelle.

**Migration auf Qdrant** wenn >5M Vektoren oder Performance-Probleme —
Adapter-Interface erlaubt Switch ohne Schema-Aenderung.

---

## 8. AI-Provider (Google Vertex AI)

### 8.1 Setup

- **Region:** EU (europe-west4 = Niederlande, oder europe-west3 = Frankfurt
  je nach Service-Availability)
- **Auth:** Workload-Identity-Federation (wenn auf GCP-Native) ODER
  Service-Account-JSON-Key (wenn Self-Host)
- **Service-Account-Key wird selbst als `credentials`-Row gespeichert,
  Vault-encrypted** (Bootstrap-Sonderfall — Master-Service-Account ist
  einer der Founder-Credentials)

### 8.2 AdapterImpl

```ts
class VertexAiAdapter implements AiAdapter {
  async embed(texts: string[]): Promise<Float32Array[]> {
    // POST /v1/projects/{p}/locations/{r}/publishers/google/models/text-embedding-005:predict
    return await this.callVertex('text-embedding-005', texts);
  }

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    // POST /v1/projects/{p}/locations/{r}/publishers/google/models/gemini-3-flash:streamGenerateContent
    return await this.callVertex('gemini-3-flash', messages);
  }
}
```

### 8.3 Cost-Controls

- Pro User Tages-USD-Budget (default $5)
- Pro Service Soft+Hard-Limits via Vertex AI Quotas
- Token-Counting pre-call, Refusal wenn Budget exhausted

---

## 9. Sub-MCP-Server (Re-Use bestehender)

### 9.1 Status quo

Alle 5 bestehende Sub-MCPs (cf, github, gws, gcloud, utils) werden
uebernommen, aber mit angepasster Auth zu mcp-approval2.

**Migration jedes Sub-MCP:**
1. Statt eigene `gws_tokens`-Tabelle: JIT-Lookup gegen mcp-approval2
2. Service-Account-Bearer vorhanden (Schicht 1)
3. User-Context via JWT in Header durchgereicht (Schicht 2)
4. Bei Tool-Call: Sub-MCP holt access_token per Request

### 9.2 Auth-Strategien pro Service (per Service entschieden)

| Service | Auth-Strategie |
|---|---|
| **Cloudflare-MCP** | OAuth 2.1 + DCR (heute schon) |
| **GitHub-MCP** | OAuth (pre-registered Client) ODER Fine-grained PAT |
| **GWS (Google Workspace)** | OAuth (heute schon eingerichtet) |
| **GCloud-MCP** | Service-Account-JSON (per-User-Eintrag in credentials) |
| **Utils-MCP** | Service-Account-Bearer (stateless, kein User-Credential) |
| **Atlassian (Jira/Confluence) — Phase 2** | OAuth wenn verfuegbar, PAT-Fallback |
| **GitLab — Phase 2** | PAT (kein verbreiteter OAuth-Flow) |

**Default-UI-Pattern pro Service:**
- "Connect via OAuth" wenn Service unterstuetzt → Redirect-Flow
- "Add API Token" als Fallback → Form mit Token-Input + Label

---

## 10. Open Decisions (Status nach Bundle 1-6)

| # | Decision | Status |
|---|---|---|
| §2-A | Primary Deploy-Target | ✅ Self-Host Postgres (spaeter GCP) |
| §3-A | Tenancy-Modell | ✅ Strikt Single-Tenant |
| §3-B | Bootstrap-Admin | ✅ First-Login-First-Admin |
| §4-A | Sharing-Modell | ✅ Docs+Skills+Apps in mcp-knowledge2 |
| §4-B | Admin-Impersonation | ✅ Nein, kein Impersonation |
| §5-A | PRF-Layer | ✅ Von Anfang an voll |
| §5-B | KEK-Provider | ✅ OpenBao Self-Hosted |
| §5-C | Credential-Storage zentral/dezentral | ✅ Zentral in mcp-approval2 |
| §6-A | SIEM-Integration | ⏳ Schema ab Tag 1, Sink-Wahl in Phase 1 mit IT |
| §11-A | SCIM Phase 1 stub | ✅ Phase 2 nichts |

| Operativ |  |
|---|---|
| Pilot-Cloud-Hosting | ✅ CF erlaubt (Privat-Setup, Sekundaer), Firma spaeter GCP |
| Datenresidenz | ✅ EU only |
| IdP-Wahl | ✅ Eigene Google-OAuth |
| Passkey-Strategie | ✅ 1 + Email-Recovery (PRF-Re-Enter akzeptiert) |
| Sub-MCP-Auth | ✅ Pro Service, OAuth-bevorzugt |
| Engineering-Bandbreite | ✅ Vollzeit ohne Pause |
| AI-Provider | ✅ Google Vertex AI (EU) |
| Storage-Service | ✅ mcp-knowledge2 parallel |
| Service-Auth | ✅ JWT signed by mcp-approval2 |

**Verbleibend (in Phase 1-2 zu klaeren):**
- Audit-Sink-Provider (mit Firma-IT, sobald bekannt)
- Memos: persönlich-only oder spaeter shareable?
- App-State Sharing-Granularitaet (read-only vs shared-edit)

---

## 11. Roll-Out-Phasen (12-14 Wochen)

### Phase 0 — Skeleton (Woche 1-2)

**mcp-approval2:**
- Repo-Init: package.json, tsconfig, monorepo-Layout (`packages/core`, `packages/adapters`, `apps/server`, `apps/web`)
- Hono.js + TypeScript strict
- Drizzle-Setup (Postgres + SQLite Dialect-Branches)
- CI: build, test, lint, RLS-Smoke (Tenant-Isolation-Tests)
- ADR-Records fuer alle 20 Decisions in `docs/adr/`
- Docker-Compose-Setup (Postgres + OpenBao + Hono-Dev-Server)

**mcp-knowledge2:**
- Repo-Init parallel
- HTTP-Service-Skeleton mit JWKS-Validation-Middleware
- Postgres-Schema (objects + share_grants + audit_log)
- pgvector-Setup
- Vertex-AI-Adapter Skeleton

### Phase 1 — Auth + User-Lifecycle (Woche 3-4)

- IdentityProvider-Interface + GoogleOAuthProvider
- Session-JWT-Issuer + Refresh-Rotation
- Invite-Flow + First-Login-First-Admin
- WebAuthn-Enrollment + Login (mit PRF-Extension)
- Email-Recovery-Pfad
- Audit-Schema + PostgresAuditSink
- Smoke-Tests fuer Auth-Flows

### Phase 2 — Credentials + Vault (Woche 5-7)

- OpenBao-Deployment + AppRole-Auth-Bootstrap
- KekProvider-Interface + VaultTransitKekProvider
- credentials-Schema + Envelope-Encryption
- PRF-Layer: Approval-Flow + PRF-Eval integriert
- credential.CRUD-Tools (mit Approval)
- GDPR-Erase-Path (Crypto-Shred)

### Phase 3 — mcp-knowledge2 Integration (Woche 8-9)

- JWT-Signing in mcp-approval2 (JWKS-Endpoint)
- mcp-knowledge2: Auth-Middleware, RLS-Policies fertig
- Hybrid-Search-Implementation (FTS + pgvector mit Vertex-Embeddings)
- Share-Grant-API
- Cross-Service-Smoke (mcp-approval2 ruft mcp-knowledge2)

### Phase 4 — MCP-Protocol + Tool-Surface (Woche 10-11)

- OAuth 2.1 + PKCE Endpoints (Discovery, DCR, Authorize, Token)
- MCP-Streamable-HTTP-Transport
- Tool-Registry mit ~10-15 Core-Tools
- Approval-Flow (WYSIWYS-PWA-View) mit PRF-Integration
- IPI-Output-Filter

### Phase 5 — Sub-MCP-Integration (Woche 11-12)

- Internal Credential-Resolver-API in mcp-approval2
- Migration mcp-gws auf JIT-Token-Pattern
- 1-2 weitere Sub-MCPs migriert (cf oder github als Start)
- End-to-End-Smoke

### Phase 6 — Pilot-Hardening (Woche 13-14)

- Rate-Limiting (Token-Bucket pro User)
- Cost-Controls (Vertex-AI-Budget pro User)
- GDPR-Export + Erase als Tools
- RLS-Audit (alle Endpoints durch)
- Doku + Runbook fuer Pilot-Onboarding
- Production-Deploy + Pilot-Start

---

## 12. Reuse-Mapping aus mcp-approval (Bestand)

| Domain | Quelle | Action |
|---|---|---|
| Crypto-Primitive (AES-GCM, HKDF, AAD) | `mcp-approval/src/crypto/` | Reuse direkt (lib/crypto/) |
| WebAuthn-Code | `mcp-approval/src/auth/webauthn.ts` | Reuse + PRF-Extension einbauen |
| Google-OAuth | `mcp-approval/src/auth/google.ts` | Reuse hinter IdP-Interface |
| Push-Notification VAPID | `mcp-approval/src/push/` | Reuse |
| Approval-Flow-Pattern | `mcp-approval/src/approve/*` | Re-Design mit PRF + user-scope |
| PWA-Approval-UI | `mcp-approval/assets/app.js` | Re-Theme + Login + neuer Flow |
| Migration-Patterns | `mcp-approval/migrations/` | Neu portieren als Drizzle-Migrations |
| Tools (~80 bestand) | `mcp-approval/src/tools/` | 10-15 portiert, rest wegwerfen |
| Storage-Layer | `mcp-approval/src/objects/` | Komplett neu in mcp-knowledge2 |
| MCP-Server-Logic | `mcp-approval/src/mcp/` | Neu (Spec-Update Nov 2025) |
| Gateway-Pattern | `mcp-approval/src/gateway/` | Reuse-Konzept, neue Auth-Mechanik |
| Sub-MCP-Server (cf/gh/gws/gcloud/utils) | eigene Repos | Bleiben separate Repos, Auth umstellen |
| knowledge-core | eigenes Repo | NICHT migriert → mcp-knowledge2 neu |

---

## 13. Tech-Stack-Confirmation

| Layer | Wahl | Confirmation-Status |
|---|---|---|
| Web-Framework | Hono.js | ✅ |
| Language | TypeScript (strict, noUncheckedIndexedAccess) | ✅ |
| ORM | Drizzle | ✅ (Postgres-RLS first-class) |
| Database Primary | Postgres 16+ | ✅ |
| Database CF-Adapter | D1 | ✅ |
| Vector-Store | pgvector (in Postgres) → Qdrant wenn >5M Vec | ✅ |
| Blob-Storage | S3-API (R2 / GCS / MinIO) | ✅ |
| Secrets-Vault | OpenBao | ✅ |
| AI-Provider | Google Vertex AI (Gemini + text-embedding-005) | ✅ |
| Identity | Eigene Google-OAuth, Phase-2-Optional WorkOS | ✅ |
| Authz | App-Layer-Helper + Postgres-RLS | ✅ |
| Audit-Sink | Postgres-append-only + optionale GCS-WORM/OTel | ⏳ |

---

## 14. Referenzen

- v0-File: [PLAN-architecture-v0.md](./PLAN-architecture-v0.md)
- Decision-Session: 2026-05-13 Bundle 1-6
- Bestand-Repo: [mcp-approval](https://github.com/axel-rogg/mcp-approval)
- Storage-Repo (parallel): [mcp-knowledge2](https://github.com/axel-rogg/mcp-knowledge2)
- Subagent-Recherche-Quellen siehe v0 §16

---

**Naechster Schritt:** Phase 0 starten (Skeleton-Setup) in beiden Repos
parallel. Decision-Phase abgeschlossen.
